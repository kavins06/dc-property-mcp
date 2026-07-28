import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGzip, constants as zlibConstants } from "node:zlib";

import pg from "../loader/node_modules/pg/lib/index.js";
import copyStreams from "../loader/node_modules/pg-copy-streams/index.js";

import {
  APPLICATION_SCHEMAS,
  buildBackupManifest,
  inspectGzipCsv,
  quoteQualifiedIdentifier,
  resolveArtifactPath,
  sha256File,
  tableArtifactPath,
  verifyBackupDirectory,
} from "./lib/application-backup.mjs";
import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const { to: copyTo } = copyStreams;
const project = resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage:",
    "  node --env-file=.env.hosted scripts/backup-application.mjs",
    "  node --env-file=.env.hosted scripts/backup-application.mjs --output-dir <directory>",
    "",
    "The destination must not already exist. The default is a timestamped",
    "directory below application-backups/.",
  ].join("\n");
}

function timestampSlug(date = new Date()) {
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "")
    .replace("Z", "Z");
}

function parseArguments(argumentsList) {
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    return { help: true };
  }
  let outputDirectory;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--output-dir") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output-dir requires a directory path.");
      }
      if (outputDirectory) {
        throw new Error("--output-dir may be supplied only once.");
      }
      outputDirectory = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return {
    help: false,
    outputDirectory:
      outputDirectory ??
      resolve(
        project,
        "application-backups",
        `dc-property-${timestampSlug()}`,
      ),
  };
}

function safeNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} exceeds the supported safe-integer range.`);
  }
  return parsed;
}

function assertChildPath(parentDirectory, candidate, label) {
  const pathFromParent = relative(parentDirectory, candidate);
  if (
    !pathFromParent ||
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw new Error(`${label} must be a child of its selected parent directory.`);
  }
}

async function assertDestinationAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Backup destination already exists: ${path}`);
}

async function syncFile(path) {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function byteMeter({ digest } = {}) {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      digest?.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    bytes: () => bytes,
  };
}

async function applicationInventory(client) {
  const schemas = await client.query(
    `
      select nspname
      from pg_catalog.pg_namespace
      where nspname = any($1::text[])
      order by nspname
    `,
    [APPLICATION_SCHEMAS],
  );
  const foundSchemas = schemas.rows.map((row) => row.nspname).sort();
  const expectedSchemas = [...APPLICATION_SCHEMAS].sort();
  if (JSON.stringify(foundSchemas) !== JSON.stringify(expectedSchemas)) {
    const missing = expectedSchemas.filter(
      (schema) => !foundSchemas.includes(schema),
    );
    throw new Error(
      `Application backup cannot continue; missing schemas: ${missing.join(", ")}`,
    );
  }

  const relations = await client.query(
    `
      select
        c.oid::text oid,
        n.nspname schema_name,
        c.relname table_name,
        case
          when c.relispartition then 'partition'
          when c.relkind = 'p' then 'partitioned_table'
          else 'base_table'
        end relation_kind,
        c.relispartition is_partition,
        case
          when pn.nspname is null then null
          else pn.nspname || '.' || pc.relname
        end parent_table,
        pg_catalog.pg_relation_size(c.oid)::text relation_size_bytes,
        pg_catalog.pg_total_relation_size(c.oid)::text total_relation_size_bytes
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_inherits i on i.inhrelid = c.oid
      left join pg_catalog.pg_class pc on pc.oid = i.inhparent
      left join pg_catalog.pg_namespace pn on pn.oid = pc.relnamespace
      where n.nspname = any($1::text[])
        and c.relkind in ('r', 'p')
      order by n.nspname, c.relname
    `,
    [APPLICATION_SCHEMAS],
  );
  if (relations.rows.length === 0) {
    throw new Error("Application backup found no base or partition tables.");
  }

  const columns = await client.query(
    `
      select
        a.attrelid::text oid,
        a.attnum::integer ordinal_position,
        a.attname name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) data_type,
        a.attnotnull not_null,
        pg_catalog.pg_get_expr(d.adbin, d.adrelid) default_expression,
        nullif(a.attidentity, '') identity_kind,
        nullif(a.attgenerated, '') generated_kind
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_attrdef d
        on d.adrelid = a.attrelid
       and d.adnum = a.attnum
      where n.nspname = any($1::text[])
        and c.relkind in ('r', 'p')
        and a.attnum > 0
        and not a.attisdropped
      order by a.attrelid, a.attnum
    `,
    [APPLICATION_SCHEMAS],
  );
  const columnsByOid = new Map();
  for (const column of columns.rows) {
    const tableColumns = columnsByOid.get(column.oid) ?? [];
    tableColumns.push({
      ordinal_position: tableColumns.length + 1,
      name: column.name,
      data_type: column.data_type,
      not_null: column.not_null,
      default_expression: column.default_expression,
      identity_kind: column.identity_kind,
      generated_kind: column.generated_kind,
    });
    columnsByOid.set(column.oid, tableColumns);
  }

  return relations.rows.map((relation) => {
    const tableColumns = columnsByOid.get(relation.oid) ?? [];
    if (tableColumns.length === 0) {
      throw new Error(
        `Application table ${relation.schema_name}.${relation.table_name} has no exportable columns.`,
      );
    }
    return {
      oid: relation.oid,
      schema: relation.schema_name,
      table: relation.table_name,
      relation_kind: relation.relation_kind,
      is_partition: relation.is_partition,
      parent_table: relation.parent_table,
      relation_size_bytes: safeNumber(
        relation.relation_size_bytes,
        `${relation.schema_name}.${relation.table_name} relation size`,
      ),
      total_relation_size_bytes: safeNumber(
        relation.total_relation_size_bytes,
        `${relation.schema_name}.${relation.table_name} total relation size`,
      ),
      columns: tableColumns,
    };
  });
}

async function sequenceInventory(client) {
  const result = await client.query(
    `
      select
        sn.nspname schema_name,
        s.relname sequence_name,
        tn.nspname owner_schema,
        t.relname owner_table,
        a.attname owner_column,
        pg_catalog.format_type(q.seqtypid, null) data_type,
        q.seqstart::text start_value,
        q.seqmin::text minimum_value,
        q.seqmax::text maximum_value,
        q.seqincrement::text increment_by,
        q.seqcache::text cache_size,
        q.seqcycle cycle
      from pg_catalog.pg_class s
      join pg_catalog.pg_namespace sn on sn.oid = s.relnamespace
      join pg_catalog.pg_sequence q on q.seqrelid = s.oid
      join pg_catalog.pg_depend d
        on d.classid = 'pg_class'::regclass
       and d.objid = s.oid
       and d.deptype in ('a', 'i')
      join pg_catalog.pg_class t on t.oid = d.refobjid
      join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
      join pg_catalog.pg_attribute a
        on a.attrelid = t.oid
       and a.attnum = d.refobjsubid
      where sn.nspname = any($1::text[])
        and tn.nspname = any($1::text[])
      order by sn.nspname, s.relname
    `,
    [APPLICATION_SCHEMAS],
  );
  const sequences = [];
  for (const row of result.rows) {
    const qualified = quoteQualifiedIdentifier(
      row.schema_name,
      row.sequence_name,
    );
    const state = await client.query(
      `select last_value::text last_value, is_called from ${qualified}`,
    );
    sequences.push({
      schema: row.schema_name,
      sequence: row.sequence_name,
      owner_schema: row.owner_schema,
      owner_table: row.owner_table,
      owner_column: row.owner_column,
      data_type: row.data_type,
      start_value: row.start_value,
      minimum_value: row.minimum_value,
      maximum_value: row.maximum_value,
      increment_by: row.increment_by,
      cache_size: row.cache_size,
      cycle: row.cycle,
      last_value: state.rows[0].last_value,
      is_called: state.rows[0].is_called,
    });
  }
  return sequences;
}

async function exportTable(client, stagingDirectory, table) {
  const qualifiedTable = quoteQualifiedIdentifier(table.schema, table.table);
  await client.query(
    `lock table only ${qualifiedTable} in access share mode`,
  );
  const countResult = await client.query(
    `select count(*)::text row_count from only ${qualifiedTable}`,
  );
  const rowCount = safeNumber(
    countResult.rows[0]?.row_count,
    `${table.schema}.${table.table} row count`,
  );

  const relativeFile = tableArtifactPath(table.schema, table.table);
  const finalFile = resolveArtifactPath(stagingDirectory, relativeFile);
  const partialFile = `${finalFile}.partial`;
  const uncompressed = byteMeter();
  const gzipDigest = createHash("sha256");
  const compressed = byteMeter({ digest: gzipDigest });
  const copyQuery =
    `copy (select * from only ${qualifiedTable}) ` +
    "to stdout with (format csv, header true, encoding 'UTF8')";

  await pipeline(
    client.query(copyTo(copyQuery)),
    uncompressed.stream,
    createGzip({
      level: zlibConstants.Z_BEST_COMPRESSION,
    }),
    compressed.stream,
    createWriteStream(partialFile, {
      flags: "wx",
      mode: 0o600,
    }),
  );
  await syncFile(partialFile);
  await rename(partialFile, finalFile);

  const gzipBytes = compressed.bytes();
  const sha256 = gzipDigest.digest("hex");
  const inspection = await inspectGzipCsv(finalFile);
  if (inspection.row_count !== rowCount) {
    throw new Error(
      `${table.schema}.${table.table} exported ${inspection.row_count} rows; expected ${rowCount}.`,
    );
  }
  const expectedColumns = table.columns.map((column) => column.name);
  if (JSON.stringify(inspection.columns) !== JSON.stringify(expectedColumns)) {
    throw new Error(
      `${table.schema}.${table.table} CSV header differs from the database catalog.`,
    );
  }
  if (inspection.uncompressed_bytes !== uncompressed.bytes()) {
    throw new Error(
      `${table.schema}.${table.table} uncompressed byte count is inconsistent.`,
    );
  }
  if ((await sha256File(finalFile)) !== sha256) {
    throw new Error(
      `${table.schema}.${table.table} SHA-256 changed after export.`,
    );
  }

  return {
    schema: table.schema,
    table: table.table,
    relation_kind: table.relation_kind,
    is_partition: table.is_partition,
    parent_table: table.parent_table,
    file: relativeFile,
    columns: table.columns,
    row_count: rowCount,
    relation_size_bytes: table.relation_size_bytes,
    total_relation_size_bytes: table.total_relation_size_bytes,
    uncompressed_bytes: uncompressed.bytes(),
    gzip_bytes: gzipBytes,
    sha256,
  };
}

export async function createBackup(
  outputDirectory,
  environment = process.env,
) {
  const finalDirectory = resolve(outputDirectory);
  const parentDirectory = dirname(finalDirectory);
  const outputName = basename(finalDirectory);
  if (!outputName || outputName === "." || outputName === "..") {
    throw new Error("Backup destination must name a new child directory.");
  }
  await mkdir(parentDirectory, { recursive: true });
  await assertDestinationAbsent(finalDirectory);

  const stagingDirectory = resolve(
    parentDirectory,
    `.${outputName}.partial-${randomUUID()}`,
  );
  assertChildPath(parentDirectory, stagingDirectory, "Staging directory");
  if (!basename(stagingDirectory).startsWith(`.${outputName}.partial-`)) {
    throw new Error("Generated staging directory failed its safety check.");
  }
  await assertDestinationAbsent(stagingDirectory);

  let client;
  let connected = false;
  let transactionOpen = false;
  const startedAt = new Date().toISOString();
  try {
    await mkdir(stagingDirectory, { mode: 0o700 });
    await mkdir(resolve(stagingDirectory, "tables"), { mode: 0o700 });
    client = new pg.Client({
      ...adminDatabaseConfig(environment),
      statement_timeout: 0,
      query_timeout: 0,
      connectionTimeoutMillis: 30_000,
      application_name: "dc-property-application-backup",
    });
    await client.connect();
    connected = true;
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    transactionOpen = true;
    // Match pg_dump's fail-closed posture: if a policy would filter rows for
    // this administrative connection, PostgreSQL raises instead of producing
    // a silently incomplete backup.
    await client.query("set local row_security = off");

    const databaseResult = await client.query(`
      select
        current_database() name,
        current_setting('server_version') server_version,
        current_setting('transaction_isolation') transaction_isolation,
        pg_catalog.pg_database_size(current_database())::text
          database_size_bytes,
        pg_catalog.pg_current_snapshot()::text snapshot
    `);
    const databaseRow = databaseResult.rows[0];
    if (databaseRow?.transaction_isolation !== "repeatable read") {
      throw new Error("Database did not establish repeatable read isolation.");
    }

    const inventory = await applicationInventory(client);
    const sequences = await sequenceInventory(client);
    const tables = [];
    for (const [index, table] of inventory.entries()) {
      process.stdout.write(
        `Exporting ${index + 1}/${inventory.length} ` +
          `${table.schema}.${table.table}\n`,
      );
      tables.push(await exportTable(client, stagingDirectory, table));
    }

    await client.query("commit");
    transactionOpen = false;

    const manifest = buildBackupManifest({
      startedAt,
      completedAt: new Date().toISOString(),
      database: {
        name: databaseRow.name,
        server_version: databaseRow.server_version,
        database_size_bytes: safeNumber(
          databaseRow.database_size_bytes,
          "database size",
        ),
        transaction_isolation: databaseRow.transaction_isolation,
        snapshot: databaseRow.snapshot,
      },
      tables,
      sequences,
    });
    const manifestPath = resolve(stagingDirectory, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await syncFile(manifestPath);
    const manifestSha256 = await sha256File(manifestPath);
    const checksumPath = resolve(stagingDirectory, "manifest.sha256");
    await writeFile(
      checksumPath,
      `${manifestSha256}  manifest.json\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await syncFile(checksumPath);

    const verification = await verifyBackupDirectory(stagingDirectory);
    await rename(stagingDirectory, finalDirectory);
    return {
      success: true,
      backup_directory: finalDirectory,
      manifest_sha256: verification.manifest_sha256,
      table_count: verification.table_count,
      row_count: verification.row_count,
      gzip_bytes: verification.gzip_bytes,
      created_at: startedAt,
      completed_at: manifest.completed_at,
    };
  } catch (error) {
    if (transactionOpen && connected && client) {
      await client.query("rollback").catch(() => undefined);
    }
    await rm(stagingDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
    throw error;
  } finally {
    if (connected && client) await client.end().catch(() => undefined);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await createBackup(options.outputDirectory);
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
        error: error instanceof Error ? error.message : "Backup failed.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
