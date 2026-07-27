import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

const project = resolve(import.meta.dirname, "..");
const migrations = resolve(project, "db", "migrations");
const tests = resolve(project, "db", "tests");
const generated = resolve(project, "data", "generated");

function readEnv(path) {
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function applySql(client, relativePath) {
  const path = resolve(project, relativePath);
  process.stdout.write(`Applying ${relativePath}\n`);
  await client.query(readFileSync(path, "utf8"));
}

async function copyGzip(client, table, fileName) {
  const path = resolve(generated, fileName);
  process.stdout.write(`Loading ${fileName} -> ${table}\n`);
  const destination = client.query(
    copyFrom(`COPY ${table} FROM STDIN WITH (FORMAT CSV, HEADER TRUE)`),
  );
  await pipeline(createReadStream(path), createGunzip(), destination);
}

async function tableCount(client, table) {
  const result = await client.query(`select count(*)::bigint as rows from ${table}`);
  return Number(result.rows[0].rows);
}

const env = readEnv(resolve(project, ".env.hosted"));
const projectRef = env.SUPABASE_PROJECT_REF;
const adminPassword = process.env.SUPABASE_LOAD_PASSWORD ?? env.SUPABASE_DB_PASSWORD;
const runtimePassword = env.DC_PROPERTY_RUNTIME_PASSWORD;
if (!projectRef || !adminPassword || !runtimePassword) {
  throw new Error("Missing Supabase project or deployment password metadata.");
}

const client = new pg.Client({
  host: `db.${projectRef}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: adminPassword,
  // Equivalent to PostgreSQL sslmode=require: encrypted transport for this
  // one-time loader. Hyperdrive manages the hosted runtime TLS connection.
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
  statement_timeout: 0,
  application_name: "dc-property-bulk-loader",
});

try {
  process.stdout.write("Connecting to Supabase direct PostgreSQL endpoint\n");
  await client.connect();
  await client.query("set statement_timeout = 0");

  const state = await client.query(`
    select
      to_regclass('meta.source_asset') is not null as initial_applied,
      exists (
        select 1
        from pg_roles
        where rolname = 'mcp_runtime'
      ) and pg_get_userbyid(
        (
          select proowner
          from pg_proc
          where oid = to_regprocedure(
            'api_v1.resolve_property(text,text,boolean,integer)'
          )
        )
      ) = 'api_owner' as runtime_role_applied,
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'history'
          and table_name = 'tax_series'
          and column_name = 'values_cents'
      ) as compact_tax_applied,
      not exists (
        select 1
        from information_schema.columns
        where table_schema = 'history'
          and table_name = 'assessment_snapshot_record'
          and column_name = 'source_objectid'
      ) as compact_core_applied
  `);

  if (!state.rows[0].initial_applied) {
    await applySql(client, "db/migrations/0001_initial.sql");
  } else {
    process.stdout.write("Skipping db/migrations/0001_initial.sql (already applied)\n");
  }
  if (!state.rows[0].runtime_role_applied) {
    await applySql(client, "db/migrations/0002_runtime_role.sql");
  } else {
    process.stdout.write("Skipping db/migrations/0002_runtime_role.sql (already applied)\n");
  }
  for (const [table, fileName, expectedRows] of [
    ["core.property_account_current", "property_account_current.csv.gz", 221263],
    ["history.assessment_snapshot_record", "assessment_snapshot_record.csv.gz", 652131],
    ["history.tax_series", "tax_series.csv.gz", 221263],
  ]) {
    const existingRows = await tableCount(client, table);
    if (existingRows === 0) {
      await copyGzip(client, table, fileName);
    } else if (existingRows === expectedRows) {
      process.stdout.write(`Skipping ${fileName} (${existingRows} rows already loaded)\n`);
    } else {
      throw new Error(
        `${table} contains ${existingRows} rows; expected 0 or ${expectedRows}.`,
      );
    }
  }

  if (!state.rows[0].compact_tax_applied) {
    await applySql(client, "db/migrations/0006_compact_tax.sql");
  } else {
    process.stdout.write("Skipping db/migrations/0006_compact_tax.sql (already applied)\n");
  }
  if (!state.rows[0].compact_core_applied) {
    await applySql(client, "db/migrations/0007_compact_core_history.sql");
  } else {
    process.stdout.write(
      "Skipping db/migrations/0007_compact_core_history.sql (already applied)\n",
    );
  }
  await applySql(client, "db/migrations/0003_api_functions.sql");
  await applySql(client, "db/migrations/0004_semantic_seed.sql");
  await applySql(client, "db/migrations/0005_postload.sql");
  for (const migration of [
    "db/migrations/0008_resolve_performance.sql",
    "db/migrations/0009_runtime_timeout.sql",
    "db/migrations/0010_search_plan.sql",
    "db/migrations/0011_human_verification_portals.sql",
    "db/migrations/0012_dedicated_sale_and_deed_tool.sql",
  ]) {
    await applySql(client, migration);
  }
  await client.query(
    `alter role mcp_runtime login password ${sqlLiteral(runtimePassword)}`,
  );

  const counts = await client.query(`
    select
      (select count(*)::bigint from core.property_account_current) current_rows,
      (select count(*)::bigint from history.assessment_snapshot_record) assessment_rows,
      (select count(*)::bigint from history.tax_series) tax_rows,
      pg_database_size(current_database())::bigint database_size_bytes
  `);
  const summary = counts.rows[0];
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (
    Number(summary.current_rows) !== 221263 ||
    Number(summary.assessment_rows) !== 652131 ||
    Number(summary.tax_rows) !== 221263
  ) {
    throw new Error("Post-load row-count gate failed.");
  }
  if (Number(summary.database_size_bytes) > 450_000_000) {
    throw new Error("PostgreSQL 450 MB no-go size gate failed.");
  }

  await applySql(client, "db/tests/postload_checks.sql");
  process.stdout.write("All post-load database gates passed.\n");
} finally {
  await client.end().catch(() => {});
}
