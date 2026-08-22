import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import pg from "../loader/node_modules/pg/lib/index.js";
import { adminDatabaseConfig, databaseSslMode } from "./lib/hosted-db.mjs";
import { isDmvRollbackDatabaseName } from "./lib/dmv-rollback-target.mjs";
import { DMV_REHEARSAL_TARGET_CONTRACT } from "../loader/dmv-rehearsal-target.contract.mjs";

const project = resolve(import.meta.dirname, "..");
const migrationRoot = resolve(project, "db", "migrations");
const rollbackRoot = resolve(project, "db", "rollbacks");
const committedFlag = "--committed-disposable";
const committed = process.argv.includes(committedFlag);
const requestedPaths = process.argv.slice(2).filter((value) => value !== committedFlag);

if (requestedPaths.length < 2 || requestedPaths.length % 2 !== 0) {
  throw new Error(
    "Pass migration/rollback path pairs in dependency order.",
  );
}

function sqlFile(root, requestedPath, label) {
  const path = resolve(project, requestedPath || "");
  const candidate = relative(root, path);
  if (
    !requestedPath ||
    !candidate ||
    candidate.startsWith("..") ||
    isAbsolute(candidate) ||
    !candidate.toLowerCase().endsWith(".sql")
  ) {
    throw new Error(
      `Pass a SQL ${label} under ${relative(project, root)}/.`,
    );
  }
  return readFileSync(path, "utf8")
    .replace(/^\s*begin;\s*/i, "")
    .replace(/\s*commit;\s*$/i, "");
}

const pairs = [];
for (let index = 0; index < requestedPaths.length; index += 2) {
  const requestedMigration = requestedPaths[index];
  const requestedRollback = requestedPaths[index + 1];
  pairs.push({
    requestedMigration,
    requestedRollback,
    migration: sqlFile(migrationRoot, requestedMigration, "migration"),
    rollback: sqlFile(rollbackRoot, requestedRollback, "rollback"),
  });
}

const validatesCheckpointNamespaceRollback = pairs.some(
  ({ requestedRollback }) => basename(requestedRollback) === "0042_md_local_context_checkpoint_namespace.sql",
);
const validatesDmvSql = pairs.some(({ requestedMigration, requestedRollback }) =>
  /^\d{4}_/.test(basename(requestedMigration)) &&
  (Number(basename(requestedMigration).slice(0, 4)) >= 35 || Number(basename(requestedRollback).slice(0, 4)) >= 35)
);

const database = adminDatabaseConfig(process.env);
const pgSslMode = databaseSslMode(process.env);
const isDisposableRollback = isDmvRollbackDatabaseName(database.database);
const isFixedRehearsal = database.database === "dc_property_dmv_rehearsal_20260819";
if (validatesDmvSql && !committed && !isFixedRehearsal) {
  throw new Error(
    "Uncommitted DMV migration/rollback validation requires the exact isolated DMV rehearsal database.",
  );
}
if (committed && !isDisposableRollback) {
  throw new Error(
    "Committed rollback validation requires a narrowly named dc_property_dmv_rollback_<suffix> database.",
  );
}

function schemaSnapshot() {
  return execFileSync(
    "pg_dump",
    [
      "-h", database.host,
      "-p", String(database.port),
      "-U", database.user,
      "-d", database.database,
      "--schema-only",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PGPASSWORD: database.password,
        PGSSLMODE: pgSslMode,
      },
      maxBuffer: 50 * 1024 * 1024,
    },
  ).split(/\r?\n/)
    .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict "))
    .join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

let beforeSchema = null;
const client = new pg.Client({
  ...database,
  statement_timeout: 15 * 60_000,
  lock_timeout: 5_000,
  application_name: "dc-property-rollback-validator",
});
let namespacedRowsAfterRollback = 0;

async function assertDatabaseIdentity() {
  if (!validatesDmvSql && !committed) return;
  const identity = (await client.query(`
    select current_database() database_name,
           (select oid from pg_database where datname=current_database()) database_oid,
           (pg_control_system()).system_identifier::text system_identifier
  `)).rows[0];
  if (isFixedRehearsal) {
    if (
      database.host !== DMV_REHEARSAL_TARGET_CONTRACT.host
      || Number(database.port) !== DMV_REHEARSAL_TARGET_CONTRACT.port
      || identity.database_name !== DMV_REHEARSAL_TARGET_CONTRACT.database_name
      || String(identity.database_oid) !== DMV_REHEARSAL_TARGET_CONTRACT.database_oid
      || identity.system_identifier !== DMV_REHEARSAL_TARGET_CONTRACT.system_identifier
    ) throw new Error("DMV rollback validation requires the exact repository-local rehearsal fingerprint.");
    return;
  }
  if (!isDisposableRollback || !process.env.PRODUCTION_DATABASE_OID || !process.env.PRODUCTION_SYSTEM_IDENTIFIER) {
    throw new Error("Committed disposable rollback validation requires production fingerprints for fail-closed targeting.");
  }
  if (
    String(identity.database_oid) === String(process.env.PRODUCTION_DATABASE_OID)
    && identity.system_identifier === process.env.PRODUCTION_SYSTEM_IDENTIFIER
  ) throw new Error("Rollback validation cannot target the production database fingerprint.");
}

await client.connect();
try {
  await assertDatabaseIdentity();
  beforeSchema = committed ? schemaSnapshot() : null;
  await client.query("begin");
  if (committed) {
    // 0042's SQL guard accepts this only for the narrowly named disposable
    // target. Bind the marker to this transaction ID; a stale session token
    // cannot authorize a later rollback. It is never used by apply-migration.
    await client.query("select set_config('quoin.committed_disposable_rollback', 'DMV_COMMITTED_DISPOSABLE_ROLLBACK:' || txid_current()::text, true)");
  }
  for (const pair of pairs) {
    process.stdout.write(`Applying ${pair.requestedMigration}\n`);
    await client.query("reset role");
    await client.query(pair.migration);
    await client.query("reset role");
  }
  for (const pair of pairs.toReversed()) {
    process.stdout.write(`Applying ${pair.requestedRollback}\n`);
    await client.query(pair.rollback);
    await client.query("reset role");
  }
  await client.query(committed ? "commit" : "rollback");
  if (committed && validatesCheckpointNamespaceRollback) {
    const checkpointRelation = (await client.query(
      "select to_regclass('meta.generation_load_checkpoint') is not null present",
    )).rows[0]?.present;
    if (checkpointRelation) {
      namespacedRowsAfterRollback = Number((await client.query(`
        select count(*)::bigint rows
        from meta.generation_load_checkpoint
        where phase_name like 'md_local_context:%'
      `)).rows[0]?.rows ?? 0);
    }
  }
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

const pairSummary = pairs.map((pair) =>
  `${pair.requestedMigration} -> ${pair.requestedRollback}`
).join(", ");
if (!committed) {
  process.stdout.write(`Validated ${pairSummary}; transaction rolled back.\n`);
} else if (validatesCheckpointNamespaceRollback && namespacedRowsAfterRollback > 0) {
  process.stdout.write(
    `Validated ${pairSummary}; retained ${namespacedRowsAfterRollback} namespaced checkpoint row(s), so exact schema equality is intentionally not claimed.\n`,
  );
} else {
  const afterSchema = schemaSnapshot();
  if (beforeSchema !== afterSchema) {
    throw new Error(
      `Committed rollback changed the schema (${sha256(beforeSchema)} -> ${sha256(afterSchema)}).`,
    );
  }
  process.stdout.write(
    `Validated ${pairSummary}; committed schema restored exactly (${sha256(afterSchema)}).\n`,
  );
}
