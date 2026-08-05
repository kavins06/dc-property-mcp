import { createReadStream, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseEnv } from "node:util";
import { createGunzip } from "node:zlib";

import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";
import {
  sha256File,
  validateArchiveReceipt,
} from "../scripts/lib/s3-archive.mjs";
import {
  buildMarReleaseRows,
  MAR_ARTIFACTS,
  validateMarManifest,
} from "./mar-contract.mjs";

const project = resolve(import.meta.dirname, "..");
const generatedRoot = resolve(project, "data", "parcel", "generated");
const archiveRoot = resolve(project, "archive-receipts");

function contained(root, path) {
  const candidate = relative(root, path);
  return candidate && !candidate.startsWith("..") && !isAbsolute(candidate);
}

function parseArguments(values) {
  if (values.length !== 3 || values[1] !== "--archive-receipt") {
    throw new Error(
      "Usage: node load-mar.mjs <normalized-directory> --archive-receipt <receipt.json>",
    );
  }
  const directory = resolve(project, values[0]);
  const receipt = resolve(project, values[2]);
  if (!contained(generatedRoot, directory)) {
    throw new Error("Normalized MAR directory must be under data/parcel/generated/.");
  }
  if (!contained(archiveRoot, receipt)) {
    throw new Error("Archive receipt must be under archive-receipts/.");
  }
  return { directory, receipt };
}

async function copyGzip(client, table, path) {
  const destination = client.query(
    copyFrom(`COPY ${table} FROM STDIN WITH (FORMAT CSV, HEADER TRUE)`),
  );
  await pipeline(createReadStream(path), createGunzip(), destination);
}

const { directory, receipt: receiptPath } = parseArguments(process.argv.slice(2));
const manifest = validateMarManifest(JSON.parse(
  readFileSync(resolve(directory, "manifest.json"), "utf8"),
));
for (const name of MAR_ARTIFACTS) {
  const observed = await sha256File(resolve(directory, name));
  if (observed !== manifest.artifacts[name].sha256) {
    throw new Error(`MAR artifact hash mismatch: ${name}`);
  }
}
const receipt = validateArchiveReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
const releases = buildMarReleaseRows(manifest, {
  ...receipt,
  receipt_sha256: await sha256File(receiptPath),
});

const fileByName = new Map([
  ["mar_addresses.csv.gz", "stage_mar_address"],
  ["mar_address_ssls.csv.gz", "stage_mar_address_ssl"],
  ["mar_residential_units.csv.gz", "stage_mar_residential_unit"],
]);
const environment = {
  ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
  ...process.env,
};
const client = new pg.Client({
  ...adminDatabaseConfig(environment),
  statement_timeout: 0,
  application_name: "dc-property-mar-loader",
});

await client.connect();
let locked = false;
try {
  const lock = await client.query(
    "select pg_try_advisory_lock(hashtext('dc-property-mar-loader')) locked",
  );
  if (!lock.rows[0].locked) throw new Error("Another MAR load is active.");
  locked = true;
  await client.query("begin");
  await client.query(`
    do $gate$
    begin
      if to_regclass('core.mar_address_current') is null then
        raise exception 'Migration 0031 must be applied before loading MAR data';
      end if;
    end;
    $gate$;

    create temporary table stage_mar_address (
      source_id text, release_key text, source_record_id bigint,
      source_row_sha256 text, mar_id bigint, address_source_value text,
      status text, base_ssl_normalized text
    ) on commit drop;
    create temporary table stage_mar_address_ssl (
      source_id text, release_key text, source_record_id bigint,
      source_row_sha256 text, mar_id bigint, ssl_normalized text,
      square text, suffix text, lot text, lot_type text,
      common_ownership_lot text, parcel text, reservation text
    ) on commit drop;
    create temporary table stage_mar_residential_unit (
      source_id text, release_key text, source_record_id bigint,
      source_row_sha256 text, unit_id bigint, mar_id bigint,
      full_address text, primary_address text, unit_number text,
      unit_type text, condo_ssl_normalized text, status text
    ) on commit drop;
  `);
  for (const [name, table] of fileByName) {
    await copyGzip(client, table, resolve(directory, name));
  }

  const releaseIdBySource = new Map();
  const previousBySource = new Map();
  for (const release of releases) {
    const source = manifest.sources.find((item) => item.source_id === release.source_id);
    await client.query(`
      update meta.source_asset set
        publisher = $2,
        dataset_name = $3,
        source_class = 'live_official',
        official_landing_url = $4,
        official_download_url = $5,
        bytes = $6,
        sha256 = $7,
        row_count = $8,
        dataset_retrieved_at = $9,
        limitations = $10
      where source_id = $1
    `, [
      source.source_id,
      source.source.publisher,
      source.source.dataset_name,
      source.source.landing_url,
      source.source.layer_url,
      source.bytes,
      source.gzip_sha256,
      source.rows,
      source.retrieved_at,
      source.source.source_limitations,
    ]);
    const prior = await client.query(`
      select release_id
      from meta.source_release_pointer
      where source_id = $1 and pointer_name = 'current'
    `, [release.source_id]);
    previousBySource.set(release.source_id, prior.rows[0]?.release_id ?? null);
    const inserted = await client.query(`
      insert into meta.source_release (
        source_id, release_key, release_status, quality_status,
        snapshot_retrieved_at, archive_object_key, content_type,
        bytes, row_count, sha256, schema_sha256, release_metadata, published_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12::jsonb, now()
      )
      on conflict (source_id, release_key) do update set
        release_status = 'published',
        quality_status = 'passed',
        archive_object_key = excluded.archive_object_key,
        release_metadata = excluded.release_metadata,
        published_at = now()
      returning release_id
    `, [
      release.source_id,
      release.release_key,
      release.release_status,
      release.quality_status,
      release.snapshot_retrieved_at,
      release.archive_object_key,
      release.content_type,
      release.bytes,
      release.row_count,
      release.sha256,
      release.schema_sha256,
      JSON.stringify(release.release_metadata),
    ]);
    releaseIdBySource.set(release.source_id, inserted.rows[0].release_id);
  }

  await client.query(`
    truncate table
      core.mar_address_ssl_current,
      core.mar_residential_unit_current,
      core.mar_address_current;

    insert into core.mar_address_current (
      mar_id, address_source_value, address_normalized, status,
      base_ssl_normalized, source_id, source_release_id,
      source_record_id, source_row_sha256
    )
    select
      s.mar_id, s.address_source_value,
      api_v1._normalize_address_query(s.address_source_value),
      s.status, s.base_ssl_normalized, s.source_id, r.release_id,
      s.source_record_id, s.source_row_sha256
    from stage_mar_address s
    join meta.source_release r
      on r.source_id = s.source_id and r.release_key = s.release_key;

    insert into core.mar_address_ssl_current (
      mar_id, ssl_normalized, square, suffix, lot, lot_type,
      common_ownership_lot, parcel, reservation, source_id,
      source_release_id, source_record_id, source_row_sha256
    )
    select
      s.mar_id, s.ssl_normalized, s.square, s.suffix, s.lot, s.lot_type,
      s.common_ownership_lot, s.parcel, s.reservation, s.source_id,
      r.release_id, s.source_record_id, s.source_row_sha256
    from stage_mar_address_ssl s
    join meta.source_release r
      on r.source_id = s.source_id and r.release_key = s.release_key;

    insert into core.mar_residential_unit_current (
      unit_id, mar_id, full_address, full_address_normalized,
      primary_address, unit_number, unit_type, condo_ssl_normalized,
      status, source_id, source_release_id, source_record_id,
      source_row_sha256
    )
    select
      s.unit_id, s.mar_id, s.full_address,
      api_v1._normalize_address_query(s.full_address),
      s.primary_address, s.unit_number, s.unit_type,
      s.condo_ssl_normalized, s.status, s.source_id,
      r.release_id, s.source_record_id, s.source_row_sha256
    from stage_mar_residential_unit s
    join meta.source_release r
      on r.source_id = s.source_id and r.release_key = s.release_key;
  `);
  await client.query(`
    analyze core.mar_address_current;
    analyze core.mar_address_ssl_current;
    analyze core.mar_residential_unit_current;
  `);

  for (const [sourceId, releaseId] of releaseIdBySource) {
    const previous = previousBySource.get(sourceId);
    await client.query(
      "delete from meta.source_release_pointer where source_id = $1",
      [sourceId],
    );
    if (previous && previous !== releaseId) {
      await client.query(`
        update meta.source_release
        set release_status = 'superseded'
        where release_id = $1
      `, [previous]);
      await client.query(`
        insert into meta.source_release_pointer (
          source_id, pointer_name, release_id
        ) values ($1, 'previous', $2)
      `, [sourceId, previous]);
    }
    await client.query(`
      insert into meta.source_release_pointer (
        source_id, pointer_name, release_id
      ) values ($1, 'current', $2)
    `, [sourceId, releaseId]);
  }

  const counts = await client.query(`
    select
      (select count(*) from core.mar_address_current)::integer addresses,
      (select count(*) from core.mar_address_ssl_current)::integer address_ssls,
      (select count(*) from core.mar_residential_unit_current)::integer units
  `);
  if (
    counts.rows[0].addresses !== manifest.artifacts["mar_addresses.csv.gz"].rows ||
    counts.rows[0].address_ssls !== manifest.artifacts["mar_address_ssls.csv.gz"].rows ||
    counts.rows[0].units !== manifest.artifacts["mar_residential_units.csv.gz"].rows
  ) {
    throw new Error(`Published MAR counts drifted: ${JSON.stringify(counts.rows[0])}`);
  }
  await client.query("commit");
  process.stdout.write(`${JSON.stringify({ success: true, ...counts.rows[0] })}\n`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  if (locked) {
    await client.query(
      "select pg_advisory_unlock(hashtext('dc-property-mar-loader'))",
    ).catch(() => undefined);
  }
  await client.end();
}
