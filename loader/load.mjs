import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";
import {
  ACTIVE_LOADS,
  EXPECTED_LINKED_SALE_ROWS,
  databaseSizeLevel,
} from "./pipeline-contract.mjs";

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
const adminPassword =
  process.env.DATABASE_LOAD_PASSWORD ?? env.DATABASE_ADMIN_PASSWORD;
const runtimePassword = env.DC_PROPERTY_RUNTIME_PASSWORD;
if (!env.DATABASE_HOST || !adminPassword || !runtimePassword) {
  throw new Error("Missing PostgreSQL host or deployment password metadata.");
}

const client = new pg.Client({
  ...adminDatabaseConfig({
    ...env,
    ...process.env,
    DATABASE_ADMIN_PASSWORD: adminPassword,
  }),
  // Equivalent to PostgreSQL sslmode=require: encrypted transport for this
  // one-time loader. Hyperdrive manages the hosted runtime TLS connection.
  connectionTimeoutMillis: 30_000,
  statement_timeout: 0,
  application_name: "dc-property-bulk-loader",
});

try {
  process.stdout.write("Connecting to the configured PostgreSQL endpoint\n");
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
      ) = 'api_owner' as runtime_role_applied
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
  // Source metadata is referenced by every core/history artifact and must be
  // present before the first COPY on a genuinely empty PostgreSQL cluster.
  await applySql(client, "db/migrations/0004_semantic_seed.sql");
  for (const { table, fileName, expectedRows } of ACTIVE_LOADS.filter(
    ({ phase }) => phase === "initial",
  )) {
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

  // Re-read compaction state after an empty project has received 0001 and its
  // initial artifacts. Checking before 0001 would mistake missing tables for
  // already-compacted tables and skip the required transformations.
  const compactState = await client.query(`
    select
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
        where table_schema = 'core'
          and table_name = 'property_account_current'
          and column_name = 'raw_objectid'
      ) as compact_core_applied
  `);
  if (!compactState.rows[0].compact_tax_applied) {
    await applySql(client, "db/migrations/0006_compact_tax.sql");
  } else {
    process.stdout.write("Skipping db/migrations/0006_compact_tax.sql (already applied)\n");
  }
  if (!compactState.rows[0].compact_core_applied) {
    await applySql(client, "db/migrations/0007_compact_core_history.sql");
  } else {
    process.stdout.write(
      "Skipping db/migrations/0007_compact_core_history.sql (already applied)\n",
    );
  }
  await applySql(client, "db/migrations/0003_api_functions.sql");
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
  await applySql(
    client,
    "db/migrations/0013_sale_history_and_semantics.sql",
  );
  const saleLoad = ACTIVE_LOADS.find(({ phase }) => phase === "sale");
  if (!saleLoad) throw new Error("Missing sale-series load contract.");
  const existingSaleRows = await tableCount(client, saleLoad.table);
  if (existingSaleRows === 0) {
    await copyGzip(client, saleLoad.table, saleLoad.fileName);
  } else if (existingSaleRows === saleLoad.expectedRows) {
    process.stdout.write(
      `Skipping ${saleLoad.fileName} (${existingSaleRows} rows already loaded)\n`,
    );
  } else {
    throw new Error(
      `${saleLoad.table} contains ${existingSaleRows} rows; ` +
        `expected 0 or ${saleLoad.expectedRows}.`,
    );
  }
  for (const migration of [
    "db/migrations/0014_resolution_and_quality.sql",
    "db/migrations/0015_lender_api.sql",
    "db/migrations/0016_evidence_and_dictionary.sql",
    "db/migrations/0017_free_tier_headroom.sql",
    "db/migrations/0018_search_runtime_hardening.sql",
    "db/migrations/0019_screening_indexes.sql",
    "db/migrations/0020_current_assessment_scope.sql",
  ]) {
    await applySql(client, migration);
  }
  await client.query(
    `alter role mcp_runtime login password ${sqlLiteral(runtimePassword)}`,
  );

  const counts = await client.query(`
    select
      (select count(*)::bigint from core.property_account_current) current_rows,
      (select count(*)::bigint from history.tax_series) tax_rows,
      (select count(*)::bigint from history.sale_series) sale_account_rows,
      (
        select coalesce(sum(cardinality(source_objectids)), 0)::bigint
        from history.sale_series
      ) sale_source_rows,
      pg_database_size(current_database())::bigint database_size_bytes
  `);
  const summary = counts.rows[0];
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const expectedRowsByTable = Object.fromEntries(
    ACTIVE_LOADS.map(({ table, expectedRows }) => [table, expectedRows]),
  );
  if (
    Number(summary.current_rows) !==
      expectedRowsByTable["core.property_account_current"] ||
    Number(summary.tax_rows) !== expectedRowsByTable["history.tax_series"] ||
    Number(summary.sale_account_rows) !==
      expectedRowsByTable["history.sale_series"] ||
    Number(summary.sale_source_rows) !== EXPECTED_LINKED_SALE_ROWS
  ) {
    throw new Error("Post-load row-count gate failed.");
  }
  const databaseBytes = Number(summary.database_size_bytes);
  const storageLevel = databaseSizeLevel(databaseBytes);
  if (storageLevel === "hard_limit") {
    throw new Error(
      `PostgreSQL database is ${databaseBytes} bytes; ` +
        "the 40 GB shared-volume release limit has been reached.",
    );
  }
  if (storageLevel === "warning") {
    process.stderr.write(
      `WARNING: PostgreSQL database is ${databaseBytes} bytes; ` +
        "the 25 GB shared-volume warning threshold has been reached.\n",
    );
  }

  await applySql(client, "db/tests/postload_checks.sql");
  await applySql(client, "db/tests/reviewer_regressions.sql");
  await applySql(client, "db/tests/v04_contract.sql");
  process.stdout.write("All post-load database gates passed.\n");
} finally {
  await client.end().catch(() => {});
}
