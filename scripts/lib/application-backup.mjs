import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

export const APPLICATION_BACKUP_KIND = "dc-property-application";
export const APPLICATION_BACKUP_FORMAT_VERSION = 4;
export const APPLICATION_SCHEMAS = Object.freeze([
  "meta",
  "core",
  "history",
  "semantic",
  "regulatory",
  "property_context",
  "recorder",
]);
const REGULATORY_APPLICATION_SCHEMAS = Object.freeze([
  "meta",
  "core",
  "history",
  "semantic",
  "regulatory",
  "property_context",
]);
const LEGACY_APPLICATION_SCHEMAS = Object.freeze([
  "meta",
  "core",
  "history",
  "semantic",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_TEXT_PATTERN = /^-?[0-9]+$/;
const ALLOWED_RELATION_KINDS = new Set([
  "base_table",
  "partitioned_table",
  "partition",
]);

function assertPlainObject(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonemptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a nonempty string.`);
  }
}

function assertSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
}

function assertIsoTimestamp(value, label) {
  assertNonemptyString(value, label);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-compatible timestamp.`);
  }
}

function assertSafeArtifactPath(file) {
  assertNonemptyString(file, "table.file");
  if (
    isAbsolute(file) ||
    file.includes("\\") ||
    file.includes("\0") ||
    !file.startsWith("tables/") ||
    !file.endsWith(".csv.gz")
  ) {
    throw new Error(`unsafe artifact path: ${file}`);
  }
  const segments = file.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe artifact path: ${file}`);
  }
}

function sumSafeIntegers(values, label) {
  let total = 0;
  for (const value of values) {
    assertSafeInteger(value, label);
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`${label} total exceeds JavaScript safe-integer range.`);
    }
  }
  return total;
}

export function quoteIdentifier(identifier) {
  assertNonemptyString(identifier, "PostgreSQL identifier");
  if (identifier.includes("\0")) {
    throw new Error("PostgreSQL identifiers cannot contain a null byte.");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quoteQualifiedIdentifier(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function tableArtifactPath(schema, table) {
  assertNonemptyString(schema, "schema");
  assertNonemptyString(table, "table");
  const encodedSchema = Buffer.from(schema, "utf8").toString("base64url");
  const encodedTable = Buffer.from(table, "utf8").toString("base64url");
  return `tables/${encodedSchema}--${encodedTable}.csv.gz`;
}

export function resolveArtifactPath(backupRoot, file) {
  assertSafeArtifactPath(file);
  const root = resolve(backupRoot);
  const candidate = resolve(root, ...file.split("/"));
  const pathFromRoot = relative(root, candidate);
  if (
    !pathFromRoot ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Artifact path must remain inside the backup directory: ${file}`);
  }
  return candidate;
}

function validateColumn(column, expectedOrdinal, tableLabel) {
  assertPlainObject(column, `${tableLabel} column`);
  if (column.ordinal_position !== expectedOrdinal) {
    throw new Error(
      `${tableLabel} columns must have contiguous one-based ordinal positions.`,
    );
  }
  assertNonemptyString(column.name, `${tableLabel} column name`);
  assertNonemptyString(column.data_type, `${tableLabel} column data_type`);
  if (typeof column.not_null !== "boolean") {
    throw new Error(`${tableLabel} column not_null must be boolean.`);
  }
  if (
    column.default_expression !== null &&
    typeof column.default_expression !== "string"
  ) {
    throw new Error(
      `${tableLabel} column default_expression must be text or null.`,
    );
  }
}

function validateTable(table) {
  assertPlainObject(table, "manifest table");
  assertNonemptyString(table.schema, "table.schema");
  assertNonemptyString(table.table, "table.table");
  if (!APPLICATION_SCHEMAS.includes(table.schema)) {
    throw new Error(`unsupported application schema: ${table.schema}`);
  }
  if (!ALLOWED_RELATION_KINDS.has(table.relation_kind)) {
    throw new Error(
      `unsupported relation kind for ${table.schema}.${table.table}`,
    );
  }
  if (typeof table.is_partition !== "boolean") {
    throw new Error(
      `${table.schema}.${table.table} is_partition must be boolean.`,
    );
  }
  if (table.parent_table !== null && typeof table.parent_table !== "string") {
    throw new Error(
      `${table.schema}.${table.table} parent_table must be text or null.`,
    );
  }
  assertSafeArtifactPath(table.file);
  if (!Array.isArray(table.columns) || table.columns.length === 0) {
    throw new Error(
      `${table.schema}.${table.table} must contain at least one column.`,
    );
  }
  const columnNames = new Set();
  for (const [index, column] of table.columns.entries()) {
    validateColumn(
      column,
      index + 1,
      `${table.schema}.${table.table}`,
    );
    if (columnNames.has(column.name)) {
      throw new Error(
        `${table.schema}.${table.table} contains duplicate column ${column.name}.`,
      );
    }
    columnNames.add(column.name);
  }
  for (const field of [
    "row_count",
    "relation_size_bytes",
    "total_relation_size_bytes",
    "uncompressed_bytes",
    "gzip_bytes",
  ]) {
    assertSafeInteger(table[field], `${table.schema}.${table.table}.${field}`);
  }
  if (
    table.total_relation_size_bytes < table.relation_size_bytes
  ) {
    throw new Error(
      `${table.schema}.${table.table} total size is below relation size.`,
    );
  }
  if (typeof table.sha256 !== "string" || !SHA256_PATTERN.test(table.sha256)) {
    throw new Error(
      `${table.schema}.${table.table} must contain a lowercase SHA-256.`,
    );
  }
}

function validateSequence(sequence) {
  assertPlainObject(sequence, "manifest sequence");
  for (const field of [
    "schema",
    "sequence",
    "owner_schema",
    "owner_table",
    "owner_column",
    "data_type",
  ]) {
    assertNonemptyString(sequence[field], `sequence.${field}`);
  }
  for (const field of [
    "start_value",
    "minimum_value",
    "maximum_value",
    "increment_by",
    "cache_size",
    "last_value",
  ]) {
    if (
      typeof sequence[field] !== "string" ||
      !INTEGER_TEXT_PATTERN.test(sequence[field])
    ) {
      throw new Error(`sequence.${field} must be integer text.`);
    }
  }
  if (
    typeof sequence.cycle !== "boolean" ||
    typeof sequence.is_called !== "boolean"
  ) {
    throw new Error("sequence cycle/is_called must be boolean.");
  }
}

function manifestSummary(tables) {
  return {
    table_count: tables.length,
    row_count: sumSafeIntegers(
      tables.map((table) => table.row_count),
      "row_count",
    ),
    relation_size_bytes: sumSafeIntegers(
      tables.map((table) => table.relation_size_bytes),
      "relation_size_bytes",
    ),
    total_relation_size_bytes: sumSafeIntegers(
      tables.map((table) => table.total_relation_size_bytes),
      "total_relation_size_bytes",
    ),
    uncompressed_bytes: sumSafeIntegers(
      tables.map((table) => table.uncompressed_bytes),
      "uncompressed_bytes",
    ),
    gzip_bytes: sumSafeIntegers(
      tables.map((table) => table.gzip_bytes),
      "gzip_bytes",
    ),
  };
}

export function buildBackupManifest({
  startedAt,
  completedAt,
  database,
  tables,
  sequences = [],
}) {
  assertPlainObject(database, "database");
  if (!Array.isArray(tables)) {
    throw new Error("tables must be an array.");
  }
  if (!Array.isArray(sequences)) {
    throw new Error("sequences must be an array.");
  }
  const sortedTables = tables
    .map((table) => structuredClone(table))
    .sort((left, right) =>
      left.schema.localeCompare(right.schema) ||
      left.table.localeCompare(right.table)
    );
  const manifest = {
    backup_kind: APPLICATION_BACKUP_KIND,
    format_version: APPLICATION_BACKUP_FORMAT_VERSION,
    status: "complete",
    created_at: startedAt,
    completed_at: completedAt,
    schemas: [...APPLICATION_SCHEMAS],
    database: structuredClone(database),
    summary: manifestSummary(sortedTables),
    tables: sortedTables,
    sequences: sequences
      .map((sequence) => structuredClone(sequence))
      .sort((left, right) =>
        left.schema.localeCompare(right.schema) ||
        left.sequence.localeCompare(right.sequence)
      ),
  };
  return validateBackupManifest(manifest);
}

export function validateBackupManifest(manifest) {
  assertPlainObject(manifest, "manifest");
  if (
    manifest.backup_kind !== APPLICATION_BACKUP_KIND ||
    ![1, 2, 3, APPLICATION_BACKUP_FORMAT_VERSION].includes(
      manifest.format_version,
    )
  ) {
    throw new Error("Unsupported application-backup manifest format.");
  }
  if (manifest.status !== "complete") {
    throw new Error("Manifest does not describe a complete backup.");
  }
  assertIsoTimestamp(manifest.created_at, "manifest.created_at");
  assertIsoTimestamp(manifest.completed_at, "manifest.completed_at");
  const expectedSchemas =
    manifest.format_version === 1
      ? LEGACY_APPLICATION_SCHEMAS
      : manifest.format_version < 4
        ? REGULATORY_APPLICATION_SCHEMAS
        : APPLICATION_SCHEMAS;
  if (JSON.stringify(manifest.schemas) !== JSON.stringify(expectedSchemas)) {
    throw new Error("Manifest application-schema list is incomplete.");
  }

  assertPlainObject(manifest.database, "manifest.database");
  assertNonemptyString(manifest.database.name, "database.name");
  assertNonemptyString(
    manifest.database.server_version,
    "database.server_version",
  );
  assertSafeInteger(
    manifest.database.database_size_bytes,
    "database.database_size_bytes",
  );
  if (manifest.database.transaction_isolation !== "repeatable read") {
    throw new Error("Backup was not captured under repeatable read isolation.");
  }

  if (!Array.isArray(manifest.tables) || manifest.tables.length === 0) {
    throw new Error("A complete application backup must contain tables.");
  }
  const tableKeys = new Set();
  const files = new Set();
  for (const table of manifest.tables) {
    validateTable(table);
    const key = `${table.schema}\0${table.table}`;
    if (tableKeys.has(key)) {
      throw new Error(`Manifest contains duplicate table ${table.schema}.${table.table}.`);
    }
    if (files.has(table.file)) {
      throw new Error(`Manifest contains duplicate artifact path ${table.file}.`);
    }
    tableKeys.add(key);
    files.add(table.file);
  }
  if (manifest.format_version >= 3) {
    if (!Array.isArray(manifest.sequences)) {
      throw new Error("Format-v3 backup must contain a sequence inventory.");
    }
    const sequenceKeys = new Set();
    for (const sequence of manifest.sequences) {
      validateSequence(sequence);
      if (!APPLICATION_SCHEMAS.includes(sequence.schema)) {
        throw new Error(`unsupported sequence schema: ${sequence.schema}`);
      }
      const key = `${sequence.schema}\0${sequence.sequence}`;
      if (sequenceKeys.has(key)) {
        throw new Error(
          `Manifest contains duplicate sequence ${sequence.schema}.${sequence.sequence}.`,
        );
      }
      sequenceKeys.add(key);
      if (!tableKeys.has(`${sequence.owner_schema}\0${sequence.owner_table}`)) {
        throw new Error(
          `Sequence owner table is absent: ` +
            `${sequence.owner_schema}.${sequence.owner_table}.`,
        );
      }
    }
  } else if (manifest.sequences !== undefined) {
    throw new Error("Legacy backup formats cannot declare sequences.");
  }

  assertPlainObject(manifest.summary, "manifest.summary");
  const expectedSummary = manifestSummary(manifest.tables);
  if (JSON.stringify(manifest.summary) !== JSON.stringify(expectedSummary)) {
    throw new Error("Manifest summary does not match its table entries.");
  }
  return manifest;
}

class CsvInspector {
  constructor() {
    this.inQuotes = false;
    this.pendingQuote = false;
    this.atFieldStart = true;
    this.recordHasContent = false;
    this.currentField = "";
    this.currentFields = [];
    this.header = null;
    this.recordCount = 0;
  }

  appendHeader(value) {
    if (this.recordCount === 0) this.currentField += value;
  }

  finishField() {
    if (this.recordCount === 0) {
      this.currentFields.push(this.currentField);
      this.currentField = "";
    }
    this.atFieldStart = true;
    this.recordHasContent = true;
  }

  finishRecord() {
    this.finishField();
    if (this.recordCount === 0) {
      this.header = this.currentFields;
      this.currentFields = [];
    }
    this.recordCount += 1;
    this.recordHasContent = false;
    this.atFieldStart = true;
  }

  processOutsideQuote(character) {
    if (character === '"' && this.atFieldStart) {
      this.inQuotes = true;
      this.atFieldStart = false;
      this.recordHasContent = true;
      return;
    }
    if (character === ",") {
      this.finishField();
      return;
    }
    if (character === "\n") {
      this.finishRecord();
      return;
    }
    if (character === "\r") return;
    this.appendHeader(character);
    this.atFieldStart = false;
    this.recordHasContent = true;
  }

  write(text) {
    for (const character of text) {
      if (this.pendingQuote) {
        if (character === '"') {
          this.appendHeader('"');
          this.pendingQuote = false;
          continue;
        }
        this.pendingQuote = false;
        this.inQuotes = false;
        this.processOutsideQuote(character);
        continue;
      }
      if (this.inQuotes) {
        if (character === '"') {
          this.pendingQuote = true;
        } else {
          this.appendHeader(character);
        }
        continue;
      }
      this.processOutsideQuote(character);
    }
  }

  finish() {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) {
      throw new Error("CSV contains an unterminated quoted field.");
    }
    if (
      this.recordHasContent ||
      !this.atFieldStart ||
      this.currentFields.length > 0
    ) {
      this.finishRecord();
    }
    if (!this.header || this.header.length === 0) {
      throw new Error("CSV is missing its header record.");
    }
    return {
      columns: this.header,
      record_count: this.recordCount,
      row_count: Math.max(0, this.recordCount - 1),
    };
  }
}

export function inspectCsvText(text) {
  const inspector = new CsvInspector();
  inspector.write(text);
  return inspector.finish();
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function inspectGzipCsv(path) {
  const inspector = new CsvInspector();
  const decoder = new StringDecoder("utf8");
  let uncompressedBytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      try {
        uncompressedBytes += chunk.byteLength;
        inspector.write(decoder.write(chunk));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    final(callback) {
      try {
        inspector.write(decoder.end());
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  await pipeline(createReadStream(path), createGunzip(), sink);
  return {
    ...inspector.finish(),
    uncompressed_bytes: uncompressedBytes,
  };
}

function ensureRealPathInside(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    !pathFromRoot ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} resolves outside the backup directory.`);
  }
}

export async function verifyBackupDirectory(backupDirectory) {
  const backupRoot = resolve(backupDirectory);
  const rootInfo = await lstat(backupRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Backup path must be a real directory, not a symlink.");
  }
  const realRoot = await realpath(backupRoot);

  const rootEntries = await readdir(realRoot, { withFileTypes: true });
  const rootNames = rootEntries.map((entry) => entry.name).sort();
  const expectedRootNames = ["manifest.json", "manifest.sha256", "tables"];
  if (JSON.stringify(rootNames) !== JSON.stringify(expectedRootNames)) {
    throw new Error(
      "Backup directory must contain only manifest.json, manifest.sha256, and tables/.",
    );
  }
  const tablesEntry = rootEntries.find((entry) => entry.name === "tables");
  if (!tablesEntry?.isDirectory() || tablesEntry.isSymbolicLink()) {
    throw new Error("Backup tables path must be a real directory.");
  }
  for (const fileName of ["manifest.json", "manifest.sha256"]) {
    const entry = rootEntries.find((candidate) => candidate.name === fileName);
    if (!entry?.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${fileName} must be a regular file.`);
    }
  }

  const manifestPath = resolve(realRoot, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.size > 16 * 1024 * 1024) {
    throw new Error("manifest.json exceeds the 16 MiB verification limit.");
  }
  const checksumInfo = await lstat(resolve(realRoot, "manifest.sha256"));
  if (checksumInfo.size > 256) {
    throw new Error("manifest.sha256 exceeds the verification limit.");
  }
  const manifestText = await readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = validateBackupManifest(JSON.parse(manifestText));
  } catch (error) {
    throw new Error(`Backup manifest validation failed: ${error.message}`, {
      cause: error,
    });
  }

  const checksumText = await readFile(
    resolve(realRoot, "manifest.sha256"),
    "utf8",
  );
  const checksumMatch = checksumText.match(
    /^([0-9a-f]{64})  manifest\.json\r?\n?$/,
  );
  if (!checksumMatch) {
    throw new Error("manifest.sha256 has an invalid format.");
  }
  const manifestSha256 = await sha256File(manifestPath);
  if (manifestSha256 !== checksumMatch[1]) {
    throw new Error("manifest.json SHA-256 does not match manifest.sha256.");
  }

  const tableDirectory = resolve(realRoot, "tables");
  const tableEntries = await readdir(tableDirectory, { withFileTypes: true });
  if (
    tableEntries.some(
      (entry) => !entry.isFile() || entry.isSymbolicLink(),
    )
  ) {
    throw new Error("Backup tables directory contains a non-file entry.");
  }
  const actualArtifacts = tableEntries.map((entry) => entry.name).sort();
  const expectedArtifacts = manifest.tables
    .map((table) => table.file.slice("tables/".length))
    .sort();
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("Backup artifact set does not match the manifest.");
  }

  for (const table of manifest.tables) {
    const artifactPath = resolveArtifactPath(realRoot, table.file);
    const artifactInfo = await lstat(artifactPath);
    if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink()) {
      throw new Error(`${table.file} is not a regular backup artifact.`);
    }
    const realArtifact = await realpath(artifactPath);
    ensureRealPathInside(realRoot, realArtifact, table.file);
    if (artifactInfo.size !== table.gzip_bytes) {
      throw new Error(`${table.file} gzip byte size does not match the manifest.`);
    }
    const artifactSha256 = await sha256File(realArtifact);
    if (artifactSha256 !== table.sha256) {
      throw new Error(`${table.file} SHA-256 does not match the manifest.`);
    }
    const inspection = await inspectGzipCsv(realArtifact);
    if (
      JSON.stringify(inspection.columns) !==
      JSON.stringify(table.columns.map((column) => column.name))
    ) {
      throw new Error(`${table.file} CSV header does not match the manifest.`);
    }
    if (inspection.row_count !== table.row_count) {
      throw new Error(`${table.file} CSV row count does not match the manifest.`);
    }
    if (inspection.uncompressed_bytes !== table.uncompressed_bytes) {
      throw new Error(
        `${table.file} uncompressed byte size does not match the manifest.`,
      );
    }
  }

  const directoryInfo = await stat(realRoot);
  return {
    passed: true,
    backup_directory: realRoot,
    manifest_sha256: manifestSha256,
    table_count: manifest.summary.table_count,
    row_count: manifest.summary.row_count,
    gzip_bytes: manifest.summary.gzip_bytes,
    verified_at: new Date().toISOString(),
    directory_modified_at: directoryInfo.mtime.toISOString(),
  };
}
