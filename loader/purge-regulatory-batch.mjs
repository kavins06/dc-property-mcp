import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";
import {
  REGULATORY_PURGE_VACUUM_TABLES,
} from "./purge-contract.mjs";

const project = resolve(import.meta.dirname, "..");

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

const args = process.argv.slice(2);
const batchText = args.find((arg) => /^\d+$/.test(arg));
if (!batchText || !args.includes("--confirm") || args.length !== 2) {
  throw new Error(
    "Usage: node purge-regulatory-batch.mjs <batch_id> --confirm",
  );
}
const batchId = Number(batchText);
if (!Number.isSafeInteger(batchId) || batchId < 1) {
  throw new Error("batch_id must be a positive safe integer.");
}

const env = {
  ...readEnv(resolve(project, ".env.hosted")),
  ...process.env,
};
const client = new pg.Client({
  ...adminDatabaseConfig(env),
  statement_timeout: 0,
  connectionTimeoutMillis: 30_000,
  application_name: "dc-property-regulatory-batch-purge",
});

await client.connect();
let inTransaction = false;
let advisoryLocked = false;
try {
  await client.query(
    "select pg_advisory_lock(hashtext('dc-property-regulatory-load-v2'))",
  );
  advisoryLocked = true;
  await client.query("begin");
  inTransaction = true;
  const state = await client.query(
    `
      select
        b.status,
        (
          select count(*)::integer
          from meta.source_release r
          where r.ingest_batch_id = b.batch_id
        ) releases,
        (
          select count(*)::integer
          from meta.source_release_pointer p
          join meta.source_release r on r.release_id = p.release_id
          where r.ingest_batch_id = b.batch_id
        ) pointers,
        (
          select count(*)::integer
          from meta.source_release r
          where r.ingest_batch_id = b.batch_id
            and r.release_status in ('published', 'superseded')
        ) published_releases
      from meta.ingest_batch b
      where b.batch_id = $1
      for update
    `,
    [batchId],
  );
  if (state.rows.length !== 1) {
    throw new Error(`Batch ${batchId} does not exist.`);
  }
  const row = state.rows[0];
  if (
    row.status === "published" ||
    row.published_releases > 0 ||
    row.pointers > 0
  ) {
    throw new Error(
      `Batch ${batchId} is or was published/referenced; purge refused.`,
    );
  }

  await client.query(
    `
      delete from property_context.cama_building_profile
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from property_context.energy_benchmark
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from property_context.beps_compliance
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from property_context.vacant_blighted_status
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from property_context.land_designation
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from regulatory.record
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from meta.source_record_link
      where source_release_id in (
        select release_id
        from meta.source_release
        where ingest_batch_id = $1
      );
      delete from meta.source_release where ingest_batch_id = $1;
      delete from meta.ingest_batch where batch_id = $1;
    `,
    [batchId],
  );
  await client.query("commit");
  inTransaction = false;

  for (const table of REGULATORY_PURGE_VACUUM_TABLES) {
    await client.query(`vacuum (analyze) ${table}`);
  }
  process.stdout.write(
    `Purged unpublished regulatory batch ${batchId}; affected tables ` +
      "were vacuumed for safe space reuse. This operation is not " +
      "recoverable from PostgreSQL; retain the canonical artifacts.\n",
  );
} catch (error) {
  if (inTransaction) {
    await client.query("rollback").catch(() => undefined);
  }
  throw error;
} finally {
  if (advisoryLocked) {
    await client.query(
      "select pg_advisory_unlock(hashtext('dc-property-regulatory-load-v2'))",
    ).catch(() => undefined);
  }
  await client.end().catch(() => undefined);
}
