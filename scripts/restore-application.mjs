import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import pg from "../loader/node_modules/pg/lib/index.js";
import copyStreams from "../loader/node_modules/pg-copy-streams/index.js";

import {
  APPLICATION_BACKUP_FORMAT_VERSION,
  APPLICATION_SCHEMAS,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  resolveArtifactPath,
  validateBackupManifest,
  verifyBackupDirectory,
} from "./lib/application-backup.mjs";
import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const { from: copyFrom } = copyStreams;
const project = resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage:",
    "  node --env-file=<empty-target.env> scripts/restore-application.mjs \\",
    "    <backup-directory> --expected-manifest-sha256 <sha256> \\",
    "    --confirm-empty-target",
    "",
    "The target must already contain the matching migrations and every",
    "application table must be empty. The command never truncates existing data.",
  ].join("\n");
}

function parseArguments(argumentsList) {
  const options = {
    backupDirectory: null,
    expectedManifestSha256: null,
    confirmEmptyTarget: false,
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--confirm-empty-target") {
      options.confirmEmptyTarget = true;
      continue;
    }
    if (argument === "--expected-manifest-sha256") {
      const value = argumentsList[index + 1];
      if (!value || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(
          "--expected-manifest-sha256 requires a lowercase SHA-256.",
        );
      }
      if (options.expectedManifestSha256) {
        throw new Error(
          "--expected-manifest-sha256 may be supplied only once.",
        );
      }
      options.expectedManifestSha256 = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (options.backupDirectory) {
      throw new Error("Pass exactly one backup directory.");
    }
    options.backupDirectory = resolve(argument);
  }
  if (
    !options.help &&
    (
      !options.backupDirectory ||
      !options.expectedManifestSha256 ||
      !options.confirmEmptyTarget
    )
  ) {
    throw new Error(
      "Backup directory, --expected-manifest-sha256, and " +
        "--confirm-empty-target are required.",
    );
  }
  return options;
}

async function targetTableInventory(client) {
  const result = await client.query(
    `
      select
        n.nspname schema_name,
        c.relname table_name,
        array_agg(a.attname::text order by a.attnum)::text[] columns
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a
        on a.attrelid = c.oid
       and a.attnum > 0
       and not a.attisdropped
      where n.nspname = any($1::text[])
        and c.relkind in ('r', 'p')
      group by n.nspname, c.relname
      order by n.nspname, c.relname
    `,
    [APPLICATION_SCHEMAS],
  );
  return result.rows;
}

async function assertCompatibleEmptyTarget(client, manifest) {
  const target = await targetTableInventory(client);
  const targetMap = new Map(
    target.map((table) => [
      `${table.schema_name}\0${table.table_name}`,
      table,
    ]),
  );
  const backupKeys = manifest.tables
    .map((table) => `${table.schema}\0${table.table}`)
    .sort();
  const targetKeys = [...targetMap.keys()].sort();
  if (JSON.stringify(backupKeys) !== JSON.stringify(targetKeys)) {
    throw new Error(
      "Target application-table inventory differs from the backup. Apply " +
        "the exact matching migration set before restore.",
    );
  }
  for (const table of manifest.tables) {
    const key = `${table.schema}\0${table.table}`;
    const targetTable = targetMap.get(key);
    const expectedColumns = table.columns.map((column) => column.name);
    if (
      JSON.stringify(targetTable.columns) !== JSON.stringify(expectedColumns)
    ) {
      throw new Error(
        `Target columns differ for ${table.schema}.${table.table}: ` +
          `${JSON.stringify({
            expected: expectedColumns,
            observed: targetTable.columns,
          })}`,
      );
    }
    const qualified = quoteQualifiedIdentifier(table.schema, table.table);
    const occupied = await client.query(
      `select exists(select 1 from only ${qualified} limit 1) occupied`,
    );
    if (occupied.rows[0].occupied) {
      throw new Error(
        `Restore target is not empty: ${table.schema}.${table.table}.`,
      );
    }
  }
}

async function restoreTable(client, backupRoot, table) {
  const qualified = quoteQualifiedIdentifier(table.schema, table.table);
  const columns = table.columns
    .map((column) => quoteIdentifier(column.name))
    .join(", ");
  const destination = client.query(
    copyFrom(
      `copy ${qualified} (${columns}) from stdin with ` +
        "(format csv, header true, encoding 'UTF8')",
    ),
  );
  await pipeline(
    createReadStream(resolveArtifactPath(backupRoot, table.file)),
    createGunzip(),
    destination,
  );
  const count = await client.query(
    `select count(*)::text row_count from only ${qualified}`,
  );
  if (count.rows[0].row_count !== String(table.row_count)) {
    throw new Error(
      `Restored row count differs for ${table.schema}.${table.table}.`,
    );
  }
}

async function restoreSequence(client, sequence) {
  const qualifiedText =
    `${quoteIdentifier(sequence.schema)}.${quoteIdentifier(sequence.sequence)}`;
  const ownerCheck = await client.query(
    `
      select
        tn.nspname owner_schema,
        t.relname owner_table,
        a.attname owner_column
      from pg_catalog.pg_class s
      join pg_catalog.pg_namespace sn on sn.oid = s.relnamespace
      join pg_catalog.pg_depend d
        on d.classid = 'pg_class'::regclass
       and d.objid = s.oid
       and d.deptype in ('a', 'i')
      join pg_catalog.pg_class t on t.oid = d.refobjid
      join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
      join pg_catalog.pg_attribute a
        on a.attrelid = t.oid
       and a.attnum = d.refobjsubid
      where sn.nspname = $1 and s.relname = $2 and s.relkind = 'S'
    `,
    [sequence.schema, sequence.sequence],
  );
  const owner = ownerCheck.rows[0];
  if (
    !owner ||
    owner.owner_schema !== sequence.owner_schema ||
    owner.owner_table !== sequence.owner_table ||
    owner.owner_column !== sequence.owner_column
  ) {
    throw new Error(
      `Target sequence ownership differs for ` +
        `${sequence.schema}.${sequence.sequence}.`,
    );
  }
  await client.query(
    "select pg_catalog.setval($1::regclass, $2::bigint, $3::boolean)",
    [qualifiedText, sequence.last_value, sequence.is_called],
  );
}

async function apiSmoke(client) {
  const first = await client.query(
    `
      select ssl_normalized
      from core.property_account_current
      where not is_deleted
      order by account_id
      limit 1
    `,
  );
  const ssl = first.rows[0]?.ssl_normalized;
  if (!ssl) throw new Error("Restored database has no current property account.");
  const checks = {};
  for (const [name, sql, parameters] of [
    [
      "resolve_property",
      "select api_v1.resolve_property($1, null, false, 10) result",
      [ssl],
    ],
    [
      "get_property_snapshot",
      "select api_v1.get_property_snapshot($1, null) result",
      [ssl],
    ],
    [
      "get_permit_history",
      "select api_v1.get_permit_history($1, null, '{\"limit\":1}'::jsonb) result",
      [ssl],
    ],
  ]) {
    const result = await client.query(sql, parameters);
    const payload = result.rows[0]?.result;
    if (!payload || !["resolved", "ok"].includes(payload.status)) {
      throw new Error(`Post-restore API smoke failed for ${name}.`);
    }
    checks[name] = payload.status;
  }
  return { ssl, checks };
}

export async function restoreApplication(options, environment = process.env) {
  const verification = await verifyBackupDirectory(options.backupDirectory);
  if (
    verification.manifest_sha256 !== options.expectedManifestSha256
  ) {
    throw new Error(
      `Backup approval mismatch: observed ${verification.manifest_sha256}; ` +
        `approved ${options.expectedManifestSha256}.`,
    );
  }
  const manifest = validateBackupManifest(
    JSON.parse(
      await readFile(
        resolve(options.backupDirectory, "manifest.json"),
        "utf8",
      ),
    ),
  );
  if (manifest.format_version !== APPLICATION_BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Restore requires backup format ${APPLICATION_BACKUP_FORMAT_VERSION} ` +
        "with sequence state.",
    );
  }

  const config = adminDatabaseConfig(environment);
  const client = new pg.Client({
    ...config,
    statement_timeout: 0,
    query_timeout: 0,
    connectionTimeoutMillis: 30_000,
    application_name: "dc-property-application-restore",
  });
  const startedAt = new Date().toISOString();
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query("begin");
    transactionOpen = true;
    await client.query("set local row_security = off");
    await client.query("set local session_replication_role = replica");
    await assertCompatibleEmptyTarget(client, manifest);
    for (const [index, table] of manifest.tables.entries()) {
      process.stdout.write(
        `Restoring ${index + 1}/${manifest.tables.length}: ` +
          `${table.schema}.${table.table}\n`,
      );
      await restoreTable(client, options.backupDirectory, table);
    }
    for (const sequence of manifest.sequences) {
      await restoreSequence(client, sequence);
    }
    await client.query("commit");
    transactionOpen = false;

    const smoke = await apiSmoke(client);
    const completedAt = new Date().toISOString();
    const report = {
      success: true,
      backup_directory: options.backupDirectory,
      backup_name: basename(options.backupDirectory),
      manifest_sha256: verification.manifest_sha256,
      backup_format_version: manifest.format_version,
      restored_table_count: manifest.tables.length,
      restored_row_count: manifest.summary.row_count,
      restored_sequence_count: manifest.sequences.length,
      started_at: startedAt,
      completed_at: completedAt,
      api_smoke: smoke,
      target: {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
      },
    };
    const reportDirectory = resolve(project, "db", "reports", "generated");
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = resolve(
      reportDirectory,
      `restore-${verification.manifest_sha256.slice(0, 16)}-` +
        `${Date.now()}.json`,
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { ...report, report_path: reportPath };
  } catch (error) {
    if (transactionOpen) {
      await client.query("rollback").catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await restoreApplication(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Restore failed.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
