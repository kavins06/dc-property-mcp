import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createBackup } from "../backup-application.mjs";
import {
  APPLICATION_BACKUP_FORMAT_VERSION,
  APPLICATION_SCHEMAS,
  buildBackupManifest,
  inspectCsvText,
  quoteQualifiedIdentifier,
  resolveArtifactPath,
  tableArtifactPath,
  validateBackupManifest,
  verifyBackupDirectory,
} from "../lib/application-backup.mjs";

const SHA256 = "a".repeat(64);

function sampleTable(overrides = {}) {
  return {
    schema: "meta",
    table: "source_asset",
    relation_kind: "base_table",
    is_partition: false,
    parent_table: null,
    file: tableArtifactPath("meta", "source_asset"),
    columns: [
      {
        ordinal_position: 1,
        name: "source_id",
        data_type: "text",
        not_null: true,
        default_expression: null,
      },
    ],
    row_count: 2,
    relation_size_bytes: 1024,
    total_relation_size_bytes: 2048,
    uncompressed_bytes: 64,
    gzip_bytes: 48,
    sha256: SHA256,
    ...overrides,
  };
}

function sampleSequence(overrides = {}) {
  return {
    schema: "meta",
    sequence: "source_asset_id_seq",
    owner_schema: "meta",
    owner_table: "source_asset",
    owner_column: "source_asset_id",
    data_type: "bigint",
    start_value: "1",
    minimum_value: "1",
    maximum_value: "9223372036854775807",
    increment_by: "1",
    cache_size: "1",
    cycle: false,
    last_value: "38",
    is_called: true,
    ...overrides,
  };
}

test("qualified PostgreSQL identifiers are quoted without permitting injection", () => {
  assert.equal(
    quoteQualifiedIdentifier("meta", 'source"asset'),
    '"meta"."source""asset"',
  );
});

test("table artifact paths are deterministic, unique, and traversal-safe", () => {
  const first = tableArtifactPath("meta", "../source/asset");
  const second = tableArtifactPath("core", "../source/asset");

  assert.match(first, /^tables\/[A-Za-z0-9_-]+--[A-Za-z0-9_-]+\.csv\.gz$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(".."));
  assert.ok(!first.includes("\\"));
});

test("artifact paths resolve only beneath the selected backup directory", () => {
  const backupRoot = resolve("application-backups", "test-backup");
  const safe = resolveArtifactPath(backupRoot, "tables/example.csv.gz");

  assert.equal(safe, join(backupRoot, "tables", "example.csv.gz"));
  assert.throws(
    () => resolveArtifactPath(backupRoot, "../outside.csv.gz"),
    /unsafe artifact path|inside the backup directory/,
  );
  assert.throws(
    () => resolveArtifactPath(backupRoot, resolve("outside.csv.gz")),
    /unsafe artifact path|relative path/,
  );
});

test("backup manifests contain deterministic totals and validate successfully", () => {
  const manifest = buildBackupManifest({
    startedAt: "2026-07-28T01:00:00.000Z",
    completedAt: "2026-07-28T01:01:00.000Z",
    database: {
      name: "postgres",
      server_version: "17.4",
      database_size_bytes: 4096,
      transaction_isolation: "repeatable read",
    },
    tables: [
      sampleTable(),
      sampleTable({
        schema: "core",
        table: "property_account_current",
        file: tableArtifactPath("core", "property_account_current"),
        row_count: 3,
        relation_size_bytes: 4096,
        total_relation_size_bytes: 8192,
        uncompressed_bytes: 128,
        gzip_bytes: 80,
        sha256: "b".repeat(64),
      }),
    ],
    sequences: [sampleSequence()],
  });

  assert.deepEqual(manifest.summary, {
    table_count: 2,
    row_count: 5,
    relation_size_bytes: 5120,
    total_relation_size_bytes: 10240,
    uncompressed_bytes: 192,
    gzip_bytes: 128,
  });
  assert.equal(manifest.format_version, APPLICATION_BACKUP_FORMAT_VERSION);
  assert.deepEqual(manifest.schemas, [
    "meta",
    "core",
    "history",
    "semantic",
    "regulatory",
    "property_context",
    "recorder",
  ]);
  assert.deepEqual(manifest.schemas, [...APPLICATION_SCHEMAS]);
  assert.deepEqual(manifest.sequences, [sampleSequence()]);
  assert.equal(validateBackupManifest(manifest), manifest);
});

test("manifest validation fails closed for incomplete, duplicate, or unsafe entries", () => {
  const valid = buildBackupManifest({
    startedAt: "2026-07-28T01:00:00.000Z",
    completedAt: "2026-07-28T01:01:00.000Z",
    database: {
      name: "postgres",
      server_version: "17.4",
      database_size_bytes: 4096,
      transaction_isolation: "repeatable read",
    },
    tables: [sampleTable()],
  });

  assert.throws(
    () => validateBackupManifest({ ...valid, status: "incomplete" }),
    /complete backup/,
  );
  assert.throws(
    () =>
      validateBackupManifest({
        ...valid,
        tables: [sampleTable(), sampleTable()],
        summary: { ...valid.summary, table_count: 2, row_count: 4 },
      }),
    /duplicate table/,
  );
  assert.throws(
    () =>
      validateBackupManifest({
        ...valid,
        tables: [sampleTable({ file: "../escape.csv.gz" })],
      }),
    /unsafe artifact path/,
  );
  assert.throws(
    () =>
      validateBackupManifest({
        ...valid,
        sequences: [
          sampleSequence({
            owner_table: "missing_owner",
          }),
        ],
      }),
    /Sequence owner table is absent/,
  );
});

test("CSV inspection counts quoted newlines as field content and returns the header", () => {
  const inspection = inspectCsvText(
    'id,description,note\n1,"line one\nline two","a ""quoted"" value"\n2,plain,\n',
  );

  assert.deepEqual(inspection.columns, ["id", "description", "note"]);
  assert.equal(inspection.row_count, 2);
  assert.equal(inspection.record_count, 3);
});

test("CSV inspection rejects unterminated quoted fields", () => {
  assert.throws(
    () => inspectCsvText('id,value\n1,"unterminated\n'),
    /unterminated quoted field/,
  );
});

test("backup verification accepts a complete backup and rejects a changed artifact", async (context) => {
  const backupRoot = await mkdtemp(join(tmpdir(), "dc-property-backup-test-"));
  context.after(async () => {
    await rm(backupRoot, { recursive: true, force: true });
  });

  const relativeFile = tableArtifactPath("meta", "source_asset");
  const artifactPath = resolveArtifactPath(backupRoot, relativeFile);
  const csv = Buffer.from("source_id\none\ntwo\n", "utf8");
  const gzip = gzipSync(csv);
  await mkdir(join(backupRoot, "tables"));
  await writeFile(artifactPath, gzip);

  const manifest = buildBackupManifest({
    startedAt: "2026-07-28T01:00:00.000Z",
    completedAt: "2026-07-28T01:01:00.000Z",
    database: {
      name: "postgres",
      server_version: "17.4",
      database_size_bytes: 4096,
      transaction_isolation: "repeatable read",
    },
    tables: [
      sampleTable({
        file: relativeFile,
        uncompressed_bytes: csv.byteLength,
        gzip_bytes: gzip.byteLength,
        sha256: createHash("sha256").update(gzip).digest("hex"),
      }),
    ],
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(backupRoot, "manifest.json"), manifestText);
  await writeFile(
    join(backupRoot, "manifest.sha256"),
    `${createHash("sha256").update(manifestText).digest("hex")}  manifest.json\n`,
  );

  const result = await verifyBackupDirectory(backupRoot);
  assert.equal(result.passed, true);
  assert.equal(result.table_count, 1);
  assert.equal(result.row_count, 2);

  await appendFile(artifactPath, Buffer.from("tampered"));
  await assert.rejects(
    () => verifyBackupDirectory(backupRoot),
    /gzip byte size does not match|SHA-256 does not match/,
  );
});

test("backup creation removes its staging directory when database configuration fails", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "dc-property-backup-failure-"));
  const target = join(parent, "new-backup");
  context.after(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  await assert.rejects(
    () => createBackup(target, {}),
    /DATABASE_HOST is required/,
  );
  assert.deepEqual(await readdir(parent), []);
});
