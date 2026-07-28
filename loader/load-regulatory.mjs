import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  readFileSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { parseEnv } from "node:util";
import { createGunzip } from "node:zlib";
import { parse as parseCsv } from "csv-parse";
import { stringify as stringifyCsv } from "csv-stringify";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";
import {
  databaseAccountMappingFingerprint,
  localAccountMappingFingerprint,
} from "./core-artifact-fingerprint.mjs";
import {
  REGULATORY_ARTIFACTS,
  validateRegulatoryManifest,
} from "./regulatory-contract.mjs";
import { databaseSizeLevel } from "./pipeline-contract.mjs";
import { safeCamaYearSql } from "./sql-projection.mjs";
import {
  verifyContextProjectionCompatibility,
} from "./verify-context-projections.mjs";

const project = resolve(import.meta.dirname, "..");
const generatedRoot = resolve(
  project,
  "data",
  "regulatory",
  "generated",
);

function containedPath(root, requested) {
  const candidate = relative(root, requested);
  return (
    candidate &&
    !candidate.startsWith("..") &&
    !isAbsolute(candidate)
  );
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function verifyArtifact(directory, fileName, contract) {
  const path = resolve(directory, fileName);
  if (!containedPath(directory, path)) {
    throw new Error(`Artifact path escaped the run directory: ${fileName}`);
  }
  const stats = statSync(path);
  if (!stats.isFile() || stats.size !== contract.bytes) {
    throw new Error(`${fileName} byte size does not match its manifest.`);
  }
  const observed = await sha256(path);
  if (observed !== contract.sha256) {
    throw new Error(`${fileName} sha256 does not match its manifest.`);
  }
  return path;
}

async function verifyCanonicalArtifacts(directory) {
  const python = process.env.PYTHON ?? "python";
  const pythonPath = resolve(project, "etl", "src");
  const output = [];
  const errors = [];
  const child = spawn(
    python,
    [
      "-m",
      "dc_property_etl.regulatory_verify",
      directory,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        PYTHONPATH: [
          pythonPath,
          process.env.PYTHONPATH,
        ].filter(Boolean).join(delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const exitCode = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  if (exitCode !== 0) {
    const detail = Buffer.concat(errors).toString("utf8").trim();
    throw new Error(
      "Independent decompressed artifact verification failed" +
        (detail ? `: ${detail.slice(0, 4000)}` : "."),
    );
  }
  const verifierOutput = Buffer.concat(output).toString("utf8").trim();
  if (!verifierOutput) {
    throw new Error(
      "Independent decompressed artifact verifier returned no result.",
    );
  }
  process.stdout.write(
    "Independent gzip, CSV-header, row-count, and canonical-row " +
      "SHA-256 verification passed.\n",
  );
}

async function copyGzip(client, table, path) {
  process.stdout.write(`Loading ${path} -> ${table}\n`);
  const destination = client.query(
    copyFrom(
      `copy ${table} from stdin with ` +
        `(format csv, header true, null '')`,
    ),
  );
  await pipeline(
    createReadStream(path),
    createGunzip(),
    destination,
  );
}

function releaseMapKey(sourceId, releaseKey) {
  return `${sourceId}\u0000${releaseKey}`;
}

function nullable(value) {
  return value === "" || value === undefined ? null : value;
}

function regulatoryCopyRow(row, releaseIds) {
  const sourceReleaseId = releaseIds.get(
    releaseMapKey(row.source_id, row.release_key),
  );
  if (sourceReleaseId === undefined) {
    throw new Error(
      `No staged release for ${row.source_id}/${row.release_key}.`,
    );
  }
  const facts = JSON.parse(row.facts_json);
  for (const [key, value] of [
    ["_event_date", nullable(row.event_date)],
    ["_expiration_date", nullable(row.expiration_date)],
    ["_ubid", nullable(row.ubid)],
  ]) {
    if (value !== null) facts[key] = value;
  }
  return {
    source_id: row.source_id,
    source_release_id: sourceReleaseId,
    source_record_id: row.source_record_id,
    source_row_number: nullable(row.source_row_number),
    source_row_sha256: row.source_row_sha256,
    record_kind: row.record_type,
    source_record_key:
      nullable(row.record_number) ?? row.source_record_id,
    record_number: nullable(row.record_number),
    record_status: nullable(row.record_status),
    record_status_date: nullable(row.record_status_date),
    premise_address: nullable(row.premise_address),
    address_normalized: nullable(row.address_normalized),
    ssl_raw: nullable(row.ssl_raw),
    ssl_normalized: nullable(row.ssl_normalized),
    mar_id: nullable(row.mar_id),
    latitude: nullable(row.latitude),
    longitude: nullable(row.longitude),
    source_created_at: nullable(row.event_date),
    extra_attributes: JSON.stringify(facts),
  };
}

function sourceRecordLinkCopyRow(row, releaseIds) {
  const sourceReleaseId = releaseIds.get(
    releaseMapKey(row.source_id, row.release_key),
  );
  if (sourceReleaseId === undefined) {
    throw new Error(
      `No staged release for ${row.source_id}/${row.release_key}.`,
    );
  }
  return {
    source_id: row.source_id,
    source_release_id: sourceReleaseId,
    source_record_id: row.source_record_id,
    account_id: row.account_id,
    link_status: row.link_status,
    link_scope: row.link_scope,
    link_method: row.link_method,
    match_quality: row.match_quality,
    link_confidence: row.link_confidence,
    match_basis: row.match_basis_json,
  };
}

async function copyTransformedGzip(
  client,
  table,
  columns,
  path,
  transformRow,
) {
  process.stdout.write(`Streaming ${path} -> ${table}\n`);
  const destination = client.query(
    copyFrom(
      `copy ${table} (${columns.join(", ")}) from stdin with ` +
        `(format csv, header true, null '')`,
    ),
  );
  let rows = 0;
  const transform = async function* (source) {
    for await (const row of source) {
      rows += 1;
      yield transformRow(row);
    }
  };
  await pipeline(
    createReadStream(path),
    createGunzip(),
    parseCsv({
      bom: true,
      columns: true,
      skip_empty_lines: true,
    }),
    transform,
    stringifyCsv({
      header: true,
      columns,
    }),
    destination,
  );
  return rows;
}

async function scalarCount(client, table) {
  const result = await client.query(
    `select count(*)::bigint rows from ${table}`,
  );
  return Number(result.rows[0].rows);
}

const argumentsList = process.argv.slice(2);
let preflightOnly = false;
let approvedManifestSha256 = null;
const pathArguments = [];
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === "--stage-only") {
    throw new Error(
      "--stage-only was removed because it misleadingly implied an offline " +
        "operation. Use --preflight-only; it still verifies the live " +
        "database/core-artifact binding but writes no rows.",
    );
  }
  if (argument === "--preflight-only") {
    if (preflightOnly) {
      throw new Error("--preflight-only may be supplied only once.");
    }
    preflightOnly = true;
    continue;
  }
  if (argument === "--manifest-sha256") {
    const value = argumentsList[index + 1];
    if (!value || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(
        "--manifest-sha256 requires the operator-approved lowercase " +
          "64-character SHA-256.",
      );
    }
    if (approvedManifestSha256 !== null) {
      throw new Error("--manifest-sha256 may be supplied only once.");
    }
    approvedManifestSha256 = value;
    index += 1;
    continue;
  }
  if (argument.startsWith("-")) {
    throw new Error(`Unknown option: ${argument}`);
  }
  pathArguments.push(argument);
}
if (pathArguments.length !== 1 || approvedManifestSha256 === null) {
  throw new Error(
    "Pass one normalized run directory under data/regulatory/generated/ " +
      "and the operator-approved --manifest-sha256 <sha256>; " +
      "--preflight-only is optional.",
  );
}
const requestedDirectory = pathArguments[0];
const runDirectory = resolve(project, requestedDirectory);
if (!containedPath(generatedRoot, runDirectory)) {
  throw new Error(
    "Normalized run directory must be under data/regulatory/generated/.",
  );
}

const manifestPath = resolve(runDirectory, "manifest.json");
const manifestBytes = readFileSync(manifestPath);
const manifest = validateRegulatoryManifest(
  JSON.parse(manifestBytes.toString("utf8")),
);
const manifestSha256 = createHash("sha256")
  .update(manifestBytes)
  .digest("hex");
if (manifestSha256 !== approvedManifestSha256) {
  throw new Error(
    `Manifest approval mismatch: observed ${manifestSha256}; ` +
      `approved ${approvedManifestSha256}.`,
  );
}

const artifactPaths = new Map(
  await Promise.all(
    REGULATORY_ARTIFACTS.map(async ({ fileName }) => [
      fileName,
      await verifyArtifact(
        runDirectory,
        fileName,
        manifest.artifacts[fileName],
      ),
    ]),
  ),
);
await verifyCanonicalArtifacts(runDirectory);
const contextProjectionCheck = await verifyContextProjectionCompatibility(
  artifactPaths.get("property_context_records.csv.gz"),
);
process.stdout.write(
  `Context projection compatibility passed: ` +
    `${JSON.stringify(contextProjectionCheck)}\n`,
);
const accountInputPath = resolve(
  project,
  "data",
  "generated",
  manifest.account_input.file,
);
if (
  !containedPath(resolve(project, "data", "generated"), accountInputPath) ||
  await sha256(accountInputPath) !== manifest.account_input.sha256
) {
  throw new Error(
    "The normalized regulatory run is not bound to the local canonical " +
      "property-account artifact.",
  );
}

const env = {
  ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
  ...process.env,
};
const client = new pg.Client({
  ...adminDatabaseConfig(env),
  statement_timeout: 0,
  connectionTimeoutMillis: 30_000,
  application_name: "dc-property-regulatory-loader",
});

const metadataStagingSql = `
  create temporary table stage_source_asset (
    source_id text not null,
    family text not null,
    publisher text not null,
    dataset_name text not null,
    item_id text,
    source_system text not null,
    source_dataset_identifier text,
    source_layer_identifier bigint,
    source_record_id_field text not null,
    landing_url text not null,
    human_portal_url text not null,
    human_portal_name text not null,
    machine_layer_url text not null,
    snapshot_policy text not null,
    source_limitations text not null,
    source_metadata_json jsonb not null
  ) on commit drop;

  create temporary table stage_source_release (
    source_id text not null,
    release_key text not null,
    snapshot_retrieved_at timestamptz not null,
    source_updated_at timestamptz,
    archive_object_key text not null,
    content_type text not null,
    bytes bigint not null,
    row_count bigint not null,
    sha256 text not null,
    schema_sha256 text not null,
    canonical_rows_sha256 text not null,
    release_metadata_json jsonb not null
  ) on commit drop;
`;

const contextStagingSql = `
  create temporary table stage_property_context_record (
    source_id text not null,
    release_key text not null,
    source_record_id bigint not null,
    source_row_number bigint not null,
    source_row_sha256 text not null,
    record_type text not null,
    record_number text,
    record_status text,
    record_status_date date,
    premise_address text,
    address_normalized text,
    ssl_raw text,
    ssl_normalized text,
    mar_id bigint,
    ubid text,
    event_date date,
    expiration_date date,
    latitude numeric,
    longitude numeric,
    facts_json jsonb not null
  ) on commit drop;
`;

const metadataLoadSql = `
  insert into meta.source_asset (
    source_id,
    publisher,
    dataset_name,
    source_class,
    official_landing_url,
    official_download_url,
    r2_object_key,
    bytes,
    sha256,
    row_count,
    dataset_retrieved_at,
    limitations,
    source_system,
    source_dataset_identifier,
    source_layer_identifier,
    source_record_id_field,
    snapshot_policy,
    source_metadata
  )
  select
    a.source_id,
    a.publisher,
    a.dataset_name,
    'official_snapshot',
    a.landing_url,
    a.machine_layer_url,
    r.archive_object_key,
    r.bytes,
    r.sha256,
    r.row_count::integer,
    r.snapshot_retrieved_at,
    a.source_limitations,
    a.source_system,
    a.source_dataset_identifier,
    a.source_layer_identifier,
    a.source_record_id_field,
    a.snapshot_policy,
    a.source_metadata_json || jsonb_build_object(
      'family', a.family,
      'item_id', a.item_id,
      'human_portal_url', a.human_portal_url,
      'human_portal_name', a.human_portal_name
    )
  from stage_source_asset a
  join stage_source_release r using (source_id)
  on conflict (source_id) do nothing;

  insert into meta.source_release (
    source_id,
    ingest_batch_id,
    release_key,
    release_status,
    quality_status,
    snapshot_retrieved_at,
    source_updated_at,
    official_download_url,
    archive_object_key,
    content_type,
    bytes,
    row_count,
    sha256,
    schema_sha256,
    release_metadata
  )
  select
    r.source_id,
    current_setting('dc_property.batch_id')::bigint,
    r.release_key,
    'validated',
    'passed',
    r.snapshot_retrieved_at,
    r.source_updated_at,
    a.machine_layer_url,
    r.archive_object_key,
    r.content_type,
    r.bytes,
    r.row_count,
    r.sha256,
    r.schema_sha256,
    r.release_metadata_json || jsonb_build_object(
      'canonical_rows_sha256', r.canonical_rows_sha256
    )
  from stage_source_release r
  join stage_source_asset a using (source_id);
`;

const sourceAssetPublishSql = `
  insert into meta.source_asset (
    source_id,
    publisher,
    dataset_name,
    source_class,
    official_landing_url,
    official_download_url,
    r2_object_key,
    bytes,
    sha256,
    row_count,
    dataset_retrieved_at,
    limitations,
    source_system,
    source_dataset_identifier,
    source_layer_identifier,
    source_record_id_field,
    snapshot_policy,
    source_metadata
  )
  select
    a.source_id,
    a.publisher,
    a.dataset_name,
    'official_snapshot',
    a.landing_url,
    a.machine_layer_url,
    r.archive_object_key,
    r.bytes,
    r.sha256,
    r.row_count::integer,
    r.snapshot_retrieved_at,
    a.source_limitations,
    a.source_system,
    a.source_dataset_identifier,
    a.source_layer_identifier,
    a.source_record_id_field,
    a.snapshot_policy,
    a.source_metadata_json || jsonb_build_object(
      'family', a.family,
      'item_id', a.item_id,
      'human_portal_url', a.human_portal_url,
      'human_portal_name', a.human_portal_name
    )
  from stage_source_asset a
  join stage_source_release r using (source_id)
  on conflict (source_id) do update
  set
    publisher = excluded.publisher,
    dataset_name = excluded.dataset_name,
    source_class = excluded.source_class,
    official_landing_url = excluded.official_landing_url,
    official_download_url = excluded.official_download_url,
    r2_object_key = excluded.r2_object_key,
    bytes = excluded.bytes,
    sha256 = excluded.sha256,
    row_count = excluded.row_count,
    dataset_retrieved_at = excluded.dataset_retrieved_at,
    limitations = excluded.limitations,
    source_system = excluded.source_system,
    source_dataset_identifier =
      excluded.source_dataset_identifier,
    source_layer_identifier = excluded.source_layer_identifier,
    source_record_id_field = excluded.source_record_id_field,
    snapshot_policy = excluded.snapshot_policy,
    source_metadata = excluded.source_metadata;
`;

const regulatoryTypedLoadSql = `
  with permit_source as (
    select
      r.record_id,
      r.record_kind,
      r.source_id,
      r.source_created_at,
      r.extra_attributes j
    from regulatory.record r
    join meta.source_release rel
      on rel.release_id = r.source_release_id
    where rel.ingest_batch_id =
        current_setting('dc_property.batch_id')::bigint
      and r.record_kind in (
        'building_permit',
        'public_space_construction_permit',
        'public_space_occupancy_permit',
        'home_occupancy_permit',
        'special_tree_permit',
        'public_space_rental_permit',
        'emergency_work_request',
        'well_permit'
      )
  )
  insert into regulatory.building_permit (
    record_id,
    record_kind,
    permit_type,
    permit_subtype,
    work_type,
    work_description,
    application_date,
    issue_date,
    expiration_date,
    finaled_date,
    estimated_cost_dollars,
    permit_fee_cents,
    owner_name,
    applicant_name,
    contractor_name,
    contractor_license_number,
    proposed_use,
    existing_use,
    number_of_stories,
    number_of_units,
    floor_area_square_feet
  )
  select
    p.record_id,
    p.record_kind,
    coalesce(
      nullif(p.j->>'PERMIT_TYPE_NAME', ''),
      nullif(p.j->>'PermitType', ''),
      nullif(p.j->>'EventTypeDescription', ''),
      nullif(p.j->>'EMERGENCYTYPEDESC', ''),
      nullif(p.j->>'TYPEOFWELLS', ''),
      initcap(replace(p.record_kind, '_', ' '))
    ),
    coalesce(
      nullif(p.j->>'PERMIT_SUBTYPE_NAME', ''),
      nullif(p.j->>'TypeDetailNames', ''),
      nullif(p.j->>'OtherEventType', ''),
      nullif(p.j->>'FACILITY_TYPE', '')
    ),
    coalesce(
      nullif(p.j->>'PERMIT_CATEGORY_NAME', ''),
      nullif(p.j->>'TypeDetailNames', ''),
      nullif(p.j->>'EMERGENCYCAUSE', ''),
      nullif(p.j->>'TYPEOFWELLS', '')
    ),
    coalesce(
      nullif(p.j->>'DESC_OF_WORK', ''),
      nullif(p.j->>'WorkDetail', ''),
      nullif(p.j->>'DESCRIPTION', ''),
      nullif(p.j->>'LOCATIONDESCRIPTION', ''),
      nullif(p.j->>'TreeLocation', ''),
      nullif(p.j->>'WorkLocationFullAddress', '')
    ),
    case
      when coalesce(
        p.j->>'APPLICATION_DATE',
        p.j->>'ApplicationDate',
        p.j->>'APPLICATIONDATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          coalesce(
            p.j->>'APPLICATION_DATE',
            p.j->>'ApplicationDate',
            p.j->>'APPLICATIONDATE'
          )::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
    end,
    case
      when coalesce(
        p.j->>'ISSUE_DATE',
        p.j->>'IssueDate',
        p.j->>'ISSUEDDATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          coalesce(
            p.j->>'ISSUE_DATE',
            p.j->>'IssueDate',
            p.j->>'ISSUEDDATE'
          )::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
    end,
    case
      when coalesce(
        p.j->>'EXPIRATION_DATE',
        p.j->>'ExpirationDate',
        p.j->>'EXPIRATIONDATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          coalesce(
            p.j->>'EXPIRATION_DATE',
            p.j->>'ExpirationDate',
            p.j->>'EXPIRATIONDATE'
          )::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
      when p.j->>'_expiration_date' ~
        '^\\d{4}-\\d{2}-\\d{2}$'
      then (p.j->>'_expiration_date')::date
    end,
    case
      when coalesce(
        p.j->>'FINAL_DATE',
        p.j->>'FinaledDate',
        p.j->>'FINALIZEDDATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          coalesce(
            p.j->>'FINAL_DATE',
            p.j->>'FinaledDate',
            p.j->>'FINALIZEDDATE'
          )::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
    end,
    case
      when coalesce(
        p.j->>'ESTIMATED_COST',
        p.j->>'EstimatedCost',
        p.j->>'COST_ESTIMATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then coalesce(
        p.j->>'ESTIMATED_COST',
        p.j->>'EstimatedCost',
        p.j->>'COST_ESTIMATE'
      )::numeric
    end,
    case
      when coalesce(
        p.j->>'FEES_PAID',
        p.j->>'PermitFee',
        p.j->>'TotalPermitFee',
        p.j->>'TotalFee'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then round(
        coalesce(
          p.j->>'FEES_PAID',
          p.j->>'PermitFee',
          p.j->>'TotalPermitFee',
          p.j->>'TotalFee'
        )::numeric * 100
      )::bigint
    end,
    coalesce(
      nullif(p.j->>'OWNER_NAME', ''),
      nullif(p.j->>'OwnerName', ''),
      nullif(p.j->>'PERMISSION_GRANTED_TO', '')
    ),
    coalesce(
      nullif(p.j->>'APPLICANT_NAME', ''),
      nullif(p.j->>'ApplicantName', ''),
      nullif(p.j->>'BUSINESS_ENTITY', '')
    ),
    coalesce(
      nullif(p.j->>'CONTRACTOR_NAME', ''),
      nullif(p.j->>'ContractorName', '')
    ),
    coalesce(
      nullif(p.j->>'CONTRACTOR_LICENSE_NUMBER', ''),
      nullif(p.j->>'ContractorLicenseNumber', '')
    ),
    coalesce(
      nullif(p.j->>'PROPOSED_USE', ''),
      nullif(p.j->>'PROPOSEDUSE', '')
    ),
    coalesce(
      nullif(p.j->>'EXISTING_USE', ''),
      nullif(p.j->>'EXISTINGUSE', '')
    ),
    case
      when coalesce(
        p.j->>'NUMBER_OF_STORIES',
        p.j->>'Stories'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then coalesce(
        p.j->>'NUMBER_OF_STORIES',
        p.j->>'Stories'
      )::numeric
    end,
    case
      when coalesce(
        p.j->>'NUMBER_OF_UNITS',
        p.j->>'Units'
      ) ~ '^[0-9]+(?:\\.0+)?$'
      then coalesce(
        p.j->>'NUMBER_OF_UNITS',
        p.j->>'Units'
      )::numeric::integer
    end,
    case
      when coalesce(
        p.j->>'FLOOR_AREA',
        p.j->>'TOTAL_SQUARE_FOOTAGE',
        p.j->>'OCCUPIED_SQ_FOOTAGE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then coalesce(
        p.j->>'FLOOR_AREA',
        p.j->>'TOTAL_SQUARE_FOOTAGE',
        p.j->>'OCCUPIED_SQ_FOOTAGE'
      )::numeric
    end
  from permit_source p;

  with license_source as (
    select
      r.record_id,
      r.record_kind,
      r.record_status,
      r.extra_attributes j
    from regulatory.record r
    join meta.source_release rel
      on rel.release_id = r.source_release_id
    where rel.ingest_batch_id =
        current_setting('dc_property.batch_id')::bigint
      and r.record_kind in (
        'business_license',
        'alcohol_license',
        'cannabis_license'
      )
  )
  insert into regulatory.business_license (
    record_id,
    record_kind,
    license_category,
    license_type,
    entity_name,
    trade_name,
    applicant_name,
    activity_description,
    issue_date,
    start_date,
    expiration_date,
    is_active
  )
  select
    l.record_id,
    l.record_kind,
    coalesce(
      nullif(l.j->>'LICENSESUBTYPE', ''),
      nullif(l.j->>'CLASS', ''),
      nullif(l.j->>'FACILITY_TYPE', ''),
      nullif(l.j->>'LICENSE_TYPE', '')
    ),
    coalesce(
      nullif(l.j->>'LICENSETYPE', ''),
      nullif(l.j->>'TYPE', ''),
      nullif(l.j->>'LICENSE_TYPE', '')
    ),
    coalesce(
      nullif(l.j->>'ENTITYNAME', ''),
      nullif(l.j->>'ENTITY_NAME', ''),
      nullif(l.j->>'APPLICANT', '')
    ),
    coalesce(
      nullif(l.j->>'ENTITYTRADENAME', ''),
      nullif(l.j->>'TRADE_NAME', ''),
      nullif(l.j->>'NAME', ''),
      nullif(l.j->>'FACILITY_NAME', '')
    ),
    nullif(l.j->>'APPLICANT', ''),
    coalesce(
      nullif(l.j->>'BUSINESSACTIVITY', ''),
      nullif(l.j->>'PRIMARYACTIVITY', ''),
      nullif(l.j->>'FACILITY_TYPE', ''),
      nullif(l.j->>'TYPE', '')
    ),
    case
      when coalesce(
        l.j->>'INITIALISSUEDATE',
        l.j->>'ISSUE_DATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          coalesce(
            l.j->>'INITIALISSUEDATE',
            l.j->>'ISSUE_DATE'
          )::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
    end,
    case
      when l.j->>'LICENSESTARTDATE' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          (l.j->>'LICENSESTARTDATE')::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
    end,
    case
      when coalesce(
        l.j->>'LICENSEENDDATE',
        l.j->>'EXPIRATION_DATE'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          coalesce(
            l.j->>'LICENSEENDDATE',
            l.j->>'EXPIRATION_DATE'
          )::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
      when l.j->>'_expiration_date' ~
        '^\\d{4}-\\d{2}-\\d{2}$'
      then (l.j->>'_expiration_date')::date
    end,
    case
      when lower(coalesce(l.record_status, '')) in (
        'active',
        'current',
        'issued',
        'permit issued'
      ) then true
      when lower(coalesce(l.record_status, '')) in (
        'cancelled',
        'canceled',
        'expired',
        'inactive',
        'revoked',
        'suspended'
      ) then false
    end
  from license_source l;

  with occupancy_source as (
    select
      r.record_id,
      r.record_kind,
      r.record_number,
      r.extra_attributes j
    from regulatory.record r
    join meta.source_release rel
      on rel.release_id = r.source_release_id
    where rel.ingest_batch_id =
        current_setting('dc_property.batch_id')::bigint
      and r.record_kind = 'certificate_of_occupancy'
  )
  insert into regulatory.certificate_of_occupancy (
    record_id,
    record_kind,
    certificate_number,
    related_building_permit_number,
    occupancy_use,
    proposed_use,
    existing_use,
    occupancy_load,
    floors_occupied,
    dwelling_units,
    issue_date,
    expiration_date
  )
  select
    o.record_id,
    o.record_kind,
    coalesce(
      nullif(o.j->>'PERMIT_NUMBER', ''),
      o.record_number
    ),
    coalesce(
      nullif(o.j->>'BUILDING_PERMIT_NUMBER', ''),
      nullif(o.j->>'RELATED_BUILDING_PERMIT', '')
    ),
    coalesce(
      nullif(o.j->>'DESCRIPTION_OF_OCCUPANCY', ''),
      nullif(o.j->>'APPROVED_BUILDING_CODE_USE', ''),
      nullif(o.j->>'APPROVED_ZONING_USE', ''),
      nullif(o.j->>'APPROVED_ZONING_GENERAL_USE', '')
    ),
    nullif(o.j->>'PROPOSED_USE', ''),
    nullif(o.j->>'EXISTING_USE', ''),
    case
      when o.j->>'OCCUPANCY_LOAD' ~
        '^[0-9]+(?:\\.0+)?$'
      then (o.j->>'OCCUPANCY_LOAD')::numeric::integer
    end,
    nullif(o.j->>'FLOORS_OCCUPIED', ''),
    case
      when o.j->>'OCCPNT_TOT_NUM_OF_DWELL_UNITS' ~
        '^[0-9]+(?:\\.0+)?$'
      then (
        o.j->>'OCCPNT_TOT_NUM_OF_DWELL_UNITS'
      )::numeric::integer
    end,
    case
      when o.j->>'ISSUE_DATE' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          (o.j->>'ISSUE_DATE')::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
    end,
    case
      when o.j->>'EXPIRATION_DATE' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
      then (
        to_timestamp(
          (o.j->>'EXPIRATION_DATE')::double precision / 1000.0
        ) at time zone 'UTC'
      )::date
      when o.j->>'_expiration_date' ~
        '^\\d{4}-\\d{2}-\\d{2}$'
      then (o.j->>'_expiration_date')::date
    end
  from occupancy_source o;

  with inspection_source as (
    select
      r.record_id,
      r.record_kind,
      r.source_id,
      r.record_status,
      r.extra_attributes j
    from regulatory.record r
    join meta.source_release rel
      on rel.release_id = r.source_release_id
    where rel.ingest_batch_id =
        current_setting('dc_property.batch_id')::bigint
      and r.record_kind = 'inspection'
  )
  insert into regulatory.inspection (
    record_id,
    record_kind,
    inspection_type,
    inspection_result,
    scheduled_at,
    completed_at,
    inspector_unit,
    inspection_score,
    violation_count,
    notes
  )
  select
    i.record_id,
    i.record_kind,
    coalesce(
      nullif(i.j->>'APPLICATIONTYPE', ''),
      nullif(i.j->>'PROBELMDESCRIPTION', ''),
      nullif(i.j->>'PROBLEMCODE', '')
    ),
    coalesce(
      nullif(i.j->>'INSPECTIONSTATUSDESC', ''),
      nullif(i.j->>'INCIDENTSTATUSDESC', ''),
      i.record_status
    ),
    null::timestamptz,
    case
      when i.j->>'INSPECTIONDATE' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
      then to_timestamp(
        (i.j->>'INSPECTIONDATE')::double precision / 1000.0
      )
    end,
    'DDOT Public Space Inspections',
    null::numeric,
    null::integer,
    nullif(i.j->>'NOTESFORPERMITTEE', '')
  from inspection_source i;
`;

const contextLoadSql = `
  insert into property_context.cama_building_profile (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_record_link_id,
    account_id,
    ssl_raw,
    ssl_normalized,
    mar_id,
    premise_address,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence,
    link_context,
    building_ordinal,
    building_type,
    use_description,
    year_built,
    year_renovated,
    stories,
    bedrooms,
    full_bathrooms,
    half_bathrooms,
    gross_building_area_square_feet,
    living_area_square_feet,
    grade,
    condition,
    exterior_wall,
    roof_type,
    heat_type,
    air_conditioning_type,
    extra_attributes
  )
  select
    s.source_id,
    r.release_id,
    s.source_record_id,
    s.source_row_number,
    s.source_row_sha256,
    l.source_record_link_id,
    l.account_id,
    s.ssl_raw,
    s.ssl_normalized,
    s.mar_id,
    s.premise_address,
    'linked',
    'tax_account',
    'exact_ssl',
    'exact',
    1,
    l.match_basis,
    case
      when s.facts_json->>'BLDG_NUM' ~ '^[0-9]+(?:\\.0+)?$'
        then (s.facts_json->>'BLDG_NUM')::numeric::integer
    end,
    coalesce(
      s.facts_json->>'STRUCT_CL_D',
      s.facts_json->>'STYLE_D',
      s.facts_json->>'STRUCTURE_D'
    ),
    s.facts_json->>'USECODE',
    ${safeCamaYearSql("s.facts_json", "AYB")},
    ${safeCamaYearSql("s.facts_json", "YR_RMDL")},
    case
      when s.facts_json->>'STORIES' ~ '^[0-9]+(?:\\.[0-9]+)?$'
        then (s.facts_json->>'STORIES')::numeric
    end,
    case
      when s.facts_json->>'BED_RMS' ~ '^[0-9]+(?:\\.0+)?$'
        then (s.facts_json->>'BED_RMS')::numeric::integer
    end,
    case
      when s.facts_json->>'BATHRM' ~ '^[0-9]+(?:\\.0+)?$'
        then (s.facts_json->>'BATHRM')::numeric::integer
    end,
    case
      when s.facts_json->>'HF_BATHRM' ~ '^[0-9]+(?:\\.0+)?$'
        then (s.facts_json->>'HF_BATHRM')::numeric::integer
    end,
    case
      when coalesce(
        s.facts_json->>'GBA',
        s.facts_json->>'LIVING_GBA'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
        then coalesce(
          s.facts_json->>'GBA',
          s.facts_json->>'LIVING_GBA'
        )::numeric
    end,
    case
      when s.facts_json->>'LIVING_GBA' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (s.facts_json->>'LIVING_GBA')::numeric
    end,
    s.facts_json->>'GRADE_D',
    s.facts_json->>'CNDITION_D',
    s.facts_json->>'EXTWALL_D',
    s.facts_json->>'ROOF_D',
    s.facts_json->>'HEAT_D',
    s.facts_json->>'AC',
    s.facts_json
  from stage_property_context_record s
  join meta.source_release r
    on r.source_id = s.source_id
   and r.release_key = s.release_key
  join meta.source_record_link l
    on l.source_id = s.source_id
   and l.source_release_id = r.release_id
   and l.source_record_id = s.source_record_id
  where s.record_type = 'cama_building_profile'
    and l.link_scope = 'exact_property'
    and l.link_method = 'ssl'
    and l.match_quality = 'exact';

  insert into property_context.energy_benchmark (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_building_id,
    mar_id,
    premise_address,
    address_normalized,
    reporting_year,
    reporting_status,
    property_name,
    primary_property_type,
    gross_floor_area_square_feet,
    energy_star_score,
    site_eui_kbtu_per_square_foot,
    source_eui_kbtu_per_square_foot,
    weather_normalized_site_eui,
    total_ghg_emissions_metric_tons,
    electricity_kwh,
    natural_gas_therms,
    water_gallons,
    extra_attributes
  )
  select
    s.source_id,
    r.release_id,
    s.source_record_id,
    s.source_row_number,
    s.source_row_sha256,
    coalesce(
      nullif(s.ubid, ''),
      nullif(s.facts_json->>'PID', ''),
      nullif(s.facts_json->>'PMPROPERTYID', '')
    ),
    s.mar_id,
    s.premise_address,
    s.address_normalized,
    (s.facts_json->>'REPORTINGYEAR')::numeric::smallint,
    s.facts_json->>'REPORTSTATUS',
    s.facts_json->>'PROPERTYNAME',
    coalesce(
      s.facts_json->>'PRIMARYPROPERTYTYPE_EPACALC',
      s.facts_json->>'PRIMARYPROPERTYTYPE_SELFSELECT'
    ),
    case
      when coalesce(
        s.facts_json->>'REPORTEDBUILDINGGROSSFLOORAREA',
        s.facts_json->>'TAXRECORDFLOORAREA'
      ) ~ '^[0-9]+(?:\\.[0-9]+)?$'
        then coalesce(
          s.facts_json->>'REPORTEDBUILDINGGROSSFLOORAREA',
          s.facts_json->>'TAXRECORDFLOORAREA'
        )::numeric
    end,
    case
      when s.facts_json->>'ENERGYSTARSCORE' ~
        '^[0-9]+(?:\\.0+)?$'
        then (s.facts_json->>'ENERGYSTARSCORE')::numeric::smallint
    end,
    case
      when s.facts_json->>'SITEEUI_KBTU_FT' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (s.facts_json->>'SITEEUI_KBTU_FT')::numeric
    end,
    case
      when s.facts_json->>'SOURCEEUI_KBTU_FT' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (s.facts_json->>'SOURCEEUI_KBTU_FT')::numeric
    end,
    case
      when s.facts_json->>'WEATHERNORMALZEDSITEEUI_KBTUFT' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (
          s.facts_json->>'WEATHERNORMALZEDSITEEUI_KBTUFT'
        )::numeric
    end,
    case
      when s.facts_json->>'TOTGHGEMISSIONS_METRICTONSCO2E' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (
          s.facts_json->>'TOTGHGEMISSIONS_METRICTONSCO2E'
        )::numeric
    end,
    case
      when coalesce(
        s.facts_json->>'ELECTRICITYUSE_GRID_KWH',
        s.facts_json->>'ELECTRICITYUSE_RENEWABLE_KWH'
      ) is not null
        then coalesce(
          case when s.facts_json->>'ELECTRICITYUSE_GRID_KWH' ~
            '^[0-9]+(?:\\.[0-9]+)?$'
            then (
              s.facts_json->>'ELECTRICITYUSE_GRID_KWH'
            )::numeric end,
          0
        ) + coalesce(
          case when s.facts_json->>'ELECTRICITYUSE_RENEWABLE_KWH' ~
            '^[0-9]+(?:\\.[0-9]+)?$'
            then (
              s.facts_json->>'ELECTRICITYUSE_RENEWABLE_KWH'
            )::numeric end,
          0
        )
    end,
    case
      when s.facts_json->>'NATURALGASUSE_THERMS' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (s.facts_json->>'NATURALGASUSE_THERMS')::numeric
    end,
    case
      when s.facts_json->>'WATERUSE_ALLWATERSOURCES_KGAL' ~
        '^[0-9]+(?:\\.[0-9]+)?$'
        then (
          s.facts_json->>'WATERUSE_ALLWATERSOURCES_KGAL'
        )::numeric * 1000
    end,
    s.facts_json
  from stage_property_context_record s
  join meta.source_release r
    on r.source_id = s.source_id
   and r.release_key = s.release_key
  where s.record_type = 'energy_benchmark';

  insert into property_context.energy_benchmark_property_link (
    source_record_link_id,
    energy_benchmark_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence,
    link_context
  )
  select
    l.source_record_link_id,
    e.energy_benchmark_id,
    l.account_id,
    'linked',
    case l.link_scope
      when 'proximity_context' then 'address_only'
      when 'multi_parcel' then 'shared_premise'
      else 'building'
    end,
    case l.link_method
      when 'mar_id' then 'mar_crosswalk'
      when 'normalized_address' then 'unique_exact_address'
      when 'point_in_parcel' then 'spatial_intersection'
      when 'polygon_overlap' then 'spatial_intersection'
      when 'proximity' then 'spatial_intersection'
      else 'multiple_ssl_context'
    end,
    'contextual',
    l.link_confidence,
    l.match_basis
  from property_context.energy_benchmark e
  join meta.source_record_link l
    on l.source_id = e.source_id
   and l.source_release_id = e.source_release_id
   and l.source_record_id = e.source_record_id;

  insert into property_context.beps_compliance (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_building_id,
    mar_id,
    premise_address,
    address_normalized,
    compliance_cycle,
    compliance_status,
    compliance_pathway,
    baseline_metric,
    target_metric,
    reported_metric,
    extra_attributes
  )
  select
    s.source_id,
    r.release_id,
    s.source_record_id,
    s.source_row_number,
    s.source_row_sha256,
    coalesce(
      nullif(s.ubid, ''),
      nullif(s.facts_json->>'PID', ''),
      nullif(s.facts_json->>'PMPROPERTYID', '')
    ),
    s.mar_id,
    s.premise_address,
    s.address_normalized,
    coalesce(
      nullif(s.facts_json->>'PROPERTY_BEPS_METRIC_YEAR', ''),
      'current'
    ),
    coalesce(
      s.facts_json->>'MEETS_BEPS',
      s.facts_json->>'BEPS'
    ),
    s.facts_json->>'APPROVED_COMPLIANCE_PATHWAY',
    case
      when s.facts_json->>'PROPERTY_BEPS_METRIC' ~
        '^-?[0-9]+(?:\\.[0-9]+)?$'
        then (s.facts_json->>'PROPERTY_BEPS_METRIC')::numeric
    end,
    case
      when s.facts_json->>'PERFORMANCE_REQUIREMENT_EST' ~
        '^-?[0-9]+(?:\\.[0-9]+)?$'
        then (
          s.facts_json->>'PERFORMANCE_REQUIREMENT_EST'
        )::numeric
    end,
    case
      when s.facts_json->>'DISTANCE_FROM_BEPS_ESTIMATED' ~
        '^-?[0-9]+(?:\\.[0-9]+)?$'
        then (
          s.facts_json->>'DISTANCE_FROM_BEPS_ESTIMATED'
        )::numeric
    end,
    s.facts_json
  from stage_property_context_record s
  join meta.source_release r
    on r.source_id = s.source_id
   and r.release_key = s.release_key
  where s.record_type = 'beps';

  insert into property_context.beps_property_link (
    source_record_link_id,
    beps_compliance_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence,
    link_context
  )
  select
    l.source_record_link_id,
    b.beps_compliance_id,
    l.account_id,
    'linked',
    case l.link_scope
      when 'proximity_context' then 'address_only'
      when 'multi_parcel' then 'shared_premise'
      else 'building'
    end,
    case l.link_method
      when 'mar_id' then 'mar_crosswalk'
      when 'normalized_address' then 'unique_exact_address'
      when 'point_in_parcel' then 'spatial_intersection'
      when 'polygon_overlap' then 'spatial_intersection'
      when 'proximity' then 'spatial_intersection'
      else 'multiple_ssl_context'
    end,
    'contextual',
    l.link_confidence,
    l.match_basis
  from property_context.beps_compliance b
  join meta.source_record_link l
    on l.source_id = b.source_id
   and l.source_release_id = b.source_release_id
   and l.source_record_id = b.source_record_id;

  insert into property_context.vacant_blighted_status (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_record_link_id,
    account_id,
    ssl_raw,
    ssl_normalized,
    mar_id,
    premise_address,
    address_normalized,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence,
    link_context,
    classification,
    source_classification,
    status,
    effective_date,
    expiration_date,
    extra_attributes
  )
  select
    s.source_id,
    r.release_id,
    s.source_record_id,
    s.source_row_number,
    s.source_row_sha256,
    l.source_record_link_id,
    l.account_id,
    s.ssl_raw,
    s.ssl_normalized,
    s.mar_id,
    s.premise_address,
    s.address_normalized,
    'linked',
    case l.link_scope
      when 'exact_property' then 'tax_account'
      when 'shared_building' then 'building'
      when 'multi_parcel' then 'shared_premise'
      else 'address_only'
    end,
    case l.link_method
      when 'ssl' then
        case when l.match_quality = 'exact'
          then 'exact_ssl' else 'multiple_ssl_context' end
      when 'mar_id' then 'mar_crosswalk'
      when 'normalized_address' then 'unique_exact_address'
      when 'point_in_parcel' then 'spatial_intersection'
      when 'polygon_overlap' then 'spatial_intersection'
      when 'proximity' then 'spatial_intersection'
      else 'multiple_ssl_context'
    end,
    l.match_quality,
    l.link_confidence,
    l.match_basis,
    case
      when lower(coalesce(s.facts_json->>'STATUS', '')) like
        '%blight%' then 'blighted'
      when lower(coalesce(s.facts_json->>'STATUS', '')) like
        '%vacant%' then 'vacant'
      else 'unknown'
    end,
    s.facts_json->>'STATUS',
    s.record_status,
    s.event_date,
    s.expiration_date,
    s.facts_json
  from stage_property_context_record s
  join meta.source_release r
    on r.source_id = s.source_id
   and r.release_key = s.release_key
  join lateral (
    select candidate.*
    from meta.source_record_link candidate
    where candidate.source_id = s.source_id
      and candidate.source_release_id = r.release_id
      and candidate.source_record_id = s.source_record_id
    order by
      case candidate.link_scope
        when 'exact_property' then 0
        else 1
      end,
      candidate.account_id
    limit 1
  ) l on true
  where s.record_type = 'vacant_blighted';
`;

const summaryAndQualitySql = `
  -- This table is a current-snapshot cache, not immutable history.  Rebuild
  -- it only inside the same transaction that rotates the current pointers.
  delete from core.property_public_record_summary;

  with batch_releases as materialized (
    select release_id
    from meta.source_release
    where ingest_batch_id =
      current_setting('dc_property.batch_id')::bigint
  ),
  regulatory_counts as (
    select
      l.account_id,
      array_agg(distinct r.source_release_id) release_ids,
      count(*) filter (
        where r.record_kind in (
          'building_permit',
          'public_space_construction_permit',
          'public_space_occupancy_permit',
          'home_occupancy_permit',
          'special_tree_permit',
          'public_space_rental_permit',
          'emergency_work_request',
          'well_permit'
        )
      ) building_permits,
      count(*) filter (
        where r.record_kind in (
          'business_license',
          'alcohol_license',
          'cannabis_license'
        )
      ) business_licenses,
      count(*) filter (
        where r.record_kind = 'certificate_of_occupancy'
      ) occupancy_permits,
      count(*) filter (
        where r.record_kind = 'inspection'
      ) inspections,
      max((r.extra_attributes->>'_event_date')::date) filter (
        where r.record_kind in (
          'building_permit',
          'public_space_construction_permit',
          'public_space_occupancy_permit',
          'home_occupancy_permit',
          'special_tree_permit',
          'public_space_rental_permit',
          'emergency_work_request',
          'well_permit'
        )
      ) latest_building_permit,
      max((r.extra_attributes->>'_expiration_date')::date) filter (
        where r.record_kind in (
          'business_license',
          'alcohol_license',
          'cannabis_license'
        )
      ) latest_license_expiration,
      max((r.extra_attributes->>'_event_date')::date) filter (
        where r.record_kind = 'certificate_of_occupancy'
      ) latest_occupancy,
      max((r.extra_attributes->>'_event_date')::date) filter (
        where r.record_kind = 'inspection'
      ) latest_inspection
    from meta.source_record_link l
    join regulatory.record r
      on r.source_id = l.source_id
     and r.source_release_id = l.source_release_id
     and r.source_record_id = l.source_record_id
    where r.source_release_id in (
      select release_id from batch_releases
    )
    and r.record_kind in (
      'building_permit',
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'home_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'well_permit',
      'business_license',
      'alcohol_license',
      'cannabis_license',
      'certificate_of_occupancy',
      'inspection',
      'enforcement_action'
    )
    group by l.account_id
  ),
  context_counts as (
    select
      keys.account_id,
      array_agg(distinct keys.source_release_id) release_ids,
      count(*) filter (
        where keys.kind = 'cama'
      ) cama_profiles,
      max(keys.reporting_year) filter (
        where keys.kind = 'energy'
      ) energy_year,
      max(keys.energy_star_score) filter (
        where keys.kind = 'energy'
          and keys.reporting_year = keys.max_reporting_year
      ) energy_star_score,
      max(keys.beps_status) filter (
        where keys.kind = 'beps'
      ) beps_status,
      max(keys.vacancy) filter (
        where keys.kind = 'vacant'
      ) vacancy
    from (
      select
        c.account_id,
        c.source_release_id,
        'cama' kind,
        null::smallint reporting_year,
        null::smallint max_reporting_year,
        null::smallint energy_star_score,
        null::text beps_status,
        null::text vacancy
      from property_context.cama_building_profile c
      where c.account_id is not null
        and c.source_release_id in (
          select release_id from batch_releases
        )
      union all
      select
        l.account_id,
        e.source_release_id,
        'energy',
        e.reporting_year,
        max(e.reporting_year) over (
          partition by l.account_id
        ),
        e.energy_star_score,
        null,
        null
      from property_context.energy_benchmark e
      join property_context.energy_benchmark_property_link l
        on l.energy_benchmark_id = e.energy_benchmark_id
      where l.account_id is not null
        and e.source_release_id in (
          select release_id from batch_releases
        )
      union all
      select
        l.account_id,
        b.source_release_id,
        'beps',
        null,
        null,
        null,
        b.compliance_status,
        null
      from property_context.beps_compliance b
      join property_context.beps_property_link l
        on l.beps_compliance_id = b.beps_compliance_id
      where l.account_id is not null
        and b.source_release_id in (
          select release_id from batch_releases
        )
      union all
      select
        l.account_id,
        v.source_release_id,
        'vacant',
        null,
        null,
        null,
        null,
        v.classification
      from property_context.vacant_blighted_status v
      join meta.source_record_link l
        on l.source_id = v.source_id
       and l.source_release_id = v.source_release_id
       and l.source_record_id = v.source_record_id
      where l.account_id is not null
        and v.source_release_id in (
          select release_id from batch_releases
        )
    ) keys
    group by keys.account_id
  ),
  accounts as (
    select account_id from regulatory_counts
    union
    select account_id from context_counts
  )
  insert into core.property_public_record_summary (
    account_id,
    source_release_ids,
    building_permit_count,
    latest_building_permit_issue_date,
    business_license_count,
    latest_business_license_expiration_date,
    occupancy_permit_count,
    latest_occupancy_permit_issue_date,
    inspection_count,
    latest_inspection_date,
    cama_building_profile_count,
    latest_energy_benchmark_year,
    latest_energy_star_score,
    beps_compliance_status,
    vacant_blighted_classification,
    data_as_of,
    summary_row_sha256
  )
  select
    a.account_id,
    (
      select array_agg(distinct release_id order by release_id)
      from unnest(
        coalesce(r.release_ids, '{}'::bigint[]) ||
        coalesce(c.release_ids, '{}'::bigint[])
      ) release_id
    ),
    r.building_permits,
    r.latest_building_permit,
    r.business_licenses,
    r.latest_license_expiration,
    r.occupancy_permits,
    r.latest_occupancy,
    r.inspections,
    r.latest_inspection,
    c.cama_profiles,
    c.energy_year,
    c.energy_star_score,
    c.beps_status,
    c.vacancy,
    current_setting('dc_property.snapshot_at')::timestamptz,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          jsonb_build_object(
            'version', 2,
            'account_id', a.account_id,
            'source_release_ids', (
              select array_agg(
                distinct release_id
                order by release_id
              )
              from unnest(
                coalesce(r.release_ids, '{}'::bigint[]) ||
                coalesce(c.release_ids, '{}'::bigint[])
              ) release_id
            ),
            'building_permit_count', r.building_permits,
            'latest_building_permit_issue_date',
              r.latest_building_permit,
            'business_license_count', r.business_licenses,
            'latest_business_license_expiration_date',
              r.latest_license_expiration,
            'occupancy_permit_count', r.occupancy_permits,
            'latest_occupancy_permit_issue_date',
              r.latest_occupancy,
            'inspection_count', r.inspections,
            'latest_inspection_date', r.latest_inspection,
            'cama_building_profile_count', c.cama_profiles,
            'latest_energy_benchmark_year', c.energy_year,
            'latest_energy_star_score', c.energy_star_score,
            'beps_compliance_status', c.beps_status,
            'vacant_blighted_classification', c.vacancy,
            'data_as_of',
              current_setting(
                'dc_property.snapshot_at'
              )::timestamptz
          )::text,
          'UTF8'
        )
      ),
      'hex'
    )
  from accounts a
  left join regulatory_counts r using (account_id)
  left join context_counts c using (account_id);

  insert into meta.ingest_quality_result (
    batch_id,
    release_id,
    check_scope,
    check_name,
    severity,
    outcome,
    expected_value,
    observed_value,
    affected_row_count,
    detail
  )
  select
    current_setting('dc_property.batch_id')::bigint,
    r.release_id,
    'release',
    'source_disposition_and_linking',
    'info',
    'passed',
    jsonb_build_object('input_rows', s.input_rows),
    to_jsonb(s),
    s.unlinked_records + s.ambiguous_records,
    jsonb_build_object(
      'policy',
      'Only exact or explicitly contextual linked records are served; raw unresolved rows remain in immutable local acquisitions.'
    )
  from jsonb_to_recordset(
    current_setting('dc_property.source_stats')::jsonb
  ) as s(
    source_id text,
    input_rows bigint,
    served_records bigint,
    exact_records bigint,
    contextual_records bigint,
    ambiguous_records bigint,
    unlinked_records bigint,
    account_links bigint
  )
  join meta.source_release r
    on r.source_id = s.source_id
   and r.ingest_batch_id =
     current_setting('dc_property.batch_id')::bigint;
`;

const REGULATORY_COPY_COLUMNS = Object.freeze([
  "source_id",
  "source_release_id",
  "source_record_id",
  "source_row_number",
  "source_row_sha256",
  "record_kind",
  "source_record_key",
  "record_number",
  "record_status",
  "record_status_date",
  "premise_address",
  "address_normalized",
  "ssl_raw",
  "ssl_normalized",
  "mar_id",
  "latitude",
  "longitude",
  "source_created_at",
  "extra_attributes",
]);

const LINK_COPY_COLUMNS = Object.freeze([
  "source_id",
  "source_release_id",
  "source_record_id",
  "account_id",
  "link_status",
  "link_scope",
  "link_method",
  "match_quality",
  "link_confidence",
  "match_basis",
]);

const expectedContextByType = {
  cama_building_profile: 0,
  energy_benchmark: 0,
  beps: 0,
  vacant_blighted: 0,
};
for (const source of manifest.sources) {
  if (source.family.startsWith("building_profile_")) {
    expectedContextByType.cama_building_profile += source.served_records;
  } else if (source.family === "energy_benchmark") {
    expectedContextByType.energy_benchmark += source.served_records;
  } else if (source.family === "energy_beps") {
    expectedContextByType.beps += source.served_records;
  } else if (source.family === "vacant_blighted") {
    expectedContextByType.vacant_blighted += source.served_records;
  }
}
const expectedContext = Object.values(expectedContextByType).reduce(
  (sum, value) => sum + value,
  0,
);
const expectedRegulatory =
  manifest.totals.served_records - expectedContext;

async function runLoader() {
  await client.connect();
  let advisoryLocked = false;
  let inTransaction = false;
  let batchId = null;
  let currentPhase = "metadata";
  let published = false;

  const beginPhase = async () => {
    await client.query("begin");
    inTransaction = true;
    await client.query("set local statement_timeout = 0");
    if (batchId !== null) {
      await client.query(
        "select set_config('dc_property.batch_id', $1, true)",
        [String(batchId)],
      );
    }
  };

  const commitPhase = async () => {
    await client.query("commit");
    inTransaction = false;
  };

  const checkpoint = async (
    phaseName,
    rowCount,
    artifactSha256,
    detail = {},
  ) => {
    await client.query(
      `
        insert into meta.ingest_phase_checkpoint (
          batch_id,
          phase_name,
          phase_status,
          observed_row_count,
          artifact_sha256,
          detail
        ) values ($1, $2, 'completed', $3, $4, $5::jsonb)
        on conflict (batch_id, phase_name) do update
        set
          phase_status = excluded.phase_status,
          observed_row_count = excluded.observed_row_count,
          artifact_sha256 = excluded.artifact_sha256,
          detail = excluded.detail,
          completed_at = now()
      `,
      [
        batchId,
        phaseName,
        rowCount,
        artifactSha256,
        JSON.stringify(detail),
      ],
    );
  };

  const requireCheckpoint = async (
    phaseName,
    rowCount,
    artifactSha256,
  ) => {
    const result = await client.query(
      `
        select phase_status, observed_row_count, artifact_sha256
        from meta.ingest_phase_checkpoint
        where batch_id = $1 and phase_name = $2
      `,
      [batchId, phaseName],
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0].phase_status !== "completed" ||
      Number(result.rows[0].observed_row_count) !== rowCount ||
      result.rows[0].artifact_sha256 !== artifactSha256
    ) {
      throw new Error(
        `Hidden phase ${phaseName} has data but no exact completed ` +
          "artifact checkpoint; refusing an unsafe resume.",
      );
    }
  };

  try {
    await client.query(
      "select pg_advisory_lock(hashtext('dc-property-regulatory-load-v2'))",
    );
    advisoryLocked = true;

    const prerequisites = await client.query(`
      select
        to_regclass('meta.source_release') is not null schema_ready,
        to_regclass('regulatory.record') is not null regulatory_ready,
        to_regclass('property_context.energy_benchmark') is not null
          context_ready,
        to_regclass('meta.ingest_phase_checkpoint') is not null
          lifecycle_ready,
        to_regclass('regulatory.property_link') is null
          redundant_link_removed,
        exists (
          select 1
          from pg_catalog.pg_constraint c
          where c.conrelid =
              to_regclass('regulatory.building_permit')
            and c.conname =
              'building_permit_record_kind_check'
            and pg_catalog.pg_get_constraintdef(c.oid) like
              '%public_space_construction_permit%'
        ) typed_kinds_ready,
        exists (
          select 1
          from pg_catalog.pg_constraint c
          where c.conrelid = to_regclass('regulatory.record')
            and c.conname =
              'regulatory_record_release_identity_key'
        ) release_identity_ready
    `);
    if (Object.values(prerequisites.rows[0]).some((value) => !value)) {
      throw new Error(
        "Apply regulatory schema migrations through " +
          "db/migrations/0024_regulatory_release_lifecycle.sql " +
          "before loading.",
      );
    }
    const accountBinding = await client.query(
      `
        select
          artifact_sha256,
          artifact_row_count,
          mapping_sha256,
          verification_method
        from meta.loaded_artifact_binding
        where artifact_key = 'property_account_current'
          and relation_name = 'core.property_account_current'
      `,
    );
    if (
      accountBinding.rows.length !== 1 ||
      accountBinding.rows[0].artifact_sha256 !==
        manifest.account_input.sha256 ||
      Number(accountBinding.rows[0].artifact_row_count) !==
        manifest.account_input.rows ||
      !accountBinding.rows[0].mapping_sha256 ||
      accountBinding.rows[0].verification_method !==
        "full_ordered_identity_mapping_sha256_v1"
    ) {
      throw new Error(
        "Core property accounts are not cryptographically bound to the " +
          "exact account artifact used by this regulatory manifest. Run " +
        "npm run bind:core-artifact after applying migration 0024.",
      );
    }
    const [localAccountMapping, databaseAccountMapping] =
      await Promise.all([
        localAccountMappingFingerprint(accountInputPath),
        databaseAccountMappingFingerprint(client),
      ]);
    if (
      localAccountMapping.rows !== manifest.account_input.rows ||
      databaseAccountMapping.rows !== manifest.account_input.rows ||
      localAccountMapping.sha256 !==
        accountBinding.rows[0].mapping_sha256 ||
      databaseAccountMapping.sha256 !==
        accountBinding.rows[0].mapping_sha256
    ) {
      throw new Error(
        "The live core property-account identity mapping changed after " +
          "binding or differs from the regulatory linker input. Refusing " +
          "to stream any source-record links.",
      );
    }

    if (preflightOnly) {
      process.stdout.write(
        `Live-bound preflight passed for ${manifest.run_id}: the approved ` +
          "manifest, compressed bytes, decompressed CSV headers, row counts, " +
          "canonical row hashes, and core-account mapping are valid; no " +
          "database rows were written.\n",
      );
      return;
    }

    const existing = await client.query(
      `
        select
          r.source_id,
          r.release_key,
          r.release_id,
          r.release_status,
          r.ingest_batch_id,
          b.status batch_status,
          b.input_manifest_sha256
        from meta.source_release r
        join meta.ingest_batch b
          on b.batch_id = r.ingest_batch_id
        where (r.source_id, r.release_key) in (
          select source_id, release_key
          from jsonb_to_recordset($1::jsonb)
            as x(source_id text, release_key text)
        )
        order by r.source_id
      `,
      [JSON.stringify(manifest.sources)],
    );

    if (existing.rows.length > 0) {
      const batchIds = new Set(
        existing.rows.map((row) => String(row.ingest_batch_id)),
      );
      if (
        existing.rows.length !== manifest.sources.length ||
        batchIds.size !== 1 ||
        existing.rows.some(
          (row) => row.input_manifest_sha256 !== manifestSha256,
        )
      ) {
        throw new Error(
          "Release-key collision or partial metadata state does not match " +
            "this manifest; refusing an unsafe resume.",
        );
      }
      batchId = existing.rows[0].ingest_batch_id;
      if (
        existing.rows.every((row) => row.release_status === "published")
      ) {
        const currentPointers = await client.query(
          `
            select count(*)::integer rows
            from meta.source_release_pointer p
            join meta.source_release r on r.release_id = p.release_id
            where p.pointer_name = 'current'
              and r.ingest_batch_id = $1
          `,
          [batchId],
        );
        if (currentPointers.rows[0].rows === manifest.sources.length) {
          published = true;
          process.stdout.write(
            `Regulatory run ${manifest.run_id} is already published as ` +
              `batch ${batchId}; no changes were made.\n`,
          );
          return;
        }
      }
      await client.query(
        `
          update meta.ingest_batch
          set status = 'loading', quality_status = 'pending'
          where batch_id = $1
            and status in ('loading', 'rejected')
        `,
        [batchId],
      );
      process.stdout.write(
        `Resuming hidden regulatory batch ${batchId} for ` +
          `${manifest.run_id}.\n`,
      );
    } else {
      const currentRows = await client.query(
        `
          select count(*)::integer rows
          from meta.source_release_pointer
          where pointer_name = 'current'
            and source_id = any($1::text[])
        `,
        [manifest.sources.map((source) => source.source_id)],
      );
      if (currentRows.rows[0].rows > 0) {
        throw new Error(
          "This capacity-bounded loader is for an empty/blue-green target. " +
            "An existing current release requires the documented blue-green " +
            "refresh workflow, not an in-place double snapshot.",
        );
      }

      await beginPhase();
      await client.query(metadataStagingSql);
      for (const [fileName, table] of [
        ["source_assets.csv.gz", "stage_source_asset"],
        ["source_releases.csv.gz", "stage_source_release"],
      ]) {
        await copyGzip(
          client,
          table,
          artifactPaths.get(fileName),
        );
        const observed = await scalarCount(client, table);
        if (observed !== manifest.artifacts[fileName].rows) {
          throw new Error(
            `${fileName} staged ${observed} rows; expected ` +
              `${manifest.artifacts[fileName].rows}.`,
          );
        }
      }
      const metadataGate = await client.query(`
        select
          (
            select count(*) = count(distinct source_id)
            from stage_source_asset
          ) assets_unique,
          (
            select count(*) =
              count(distinct (source_id, release_key))
            from stage_source_release
          ) releases_unique,
          not exists (
            select source_id from stage_source_asset
            except
            select source_id from stage_source_release
          ) every_asset_has_release,
          not exists (
            select source_id from stage_source_release
            except
            select source_id from stage_source_asset
          ) every_release_has_asset
      `);
      if (
        Object.values(metadataGate.rows[0]).some((value) => !value)
      ) {
        throw new Error(
          `Regulatory metadata gate failed: ` +
            JSON.stringify(metadataGate.rows[0]),
        );
      }
      const batch = await client.query(
        `
          insert into meta.ingest_batch (
            status,
            input_manifest_sha256,
            etl_version,
            migration_version,
            quality_status
          ) values ($1, $2, $3, $4, $5)
          returning batch_id
        `,
        [
          "loading",
          manifestSha256,
          "regulatory-normalizer-v1",
          "0024-regulatory-release-lifecycle",
          "pending",
        ],
      );
      batchId = batch.rows[0].batch_id;
      await client.query(
        "select set_config('dc_property.batch_id', $1, true)",
        [String(batchId)],
      );
      await client.query(metadataLoadSql);
      await checkpoint(
        "metadata",
        manifest.sources.length,
        manifestSha256,
        { run_id: manifest.run_id },
      );
      await commitPhase();
      process.stdout.write(
        `Created hidden regulatory batch ${batchId}.\n`,
      );
    }

    const releaseRows = await client.query(
      `
        select source_id, release_key, release_id
        from meta.source_release
        where ingest_batch_id = $1
      `,
      [batchId],
    );
    if (releaseRows.rows.length !== manifest.sources.length) {
      throw new Error(
        `Batch ${batchId} has ${releaseRows.rows.length} releases; ` +
          `expected ${manifest.sources.length}.`,
      );
    }
    const releaseIds = new Map(
      releaseRows.rows.map((row) => [
        releaseMapKey(row.source_id, row.release_key),
        row.release_id,
      ]),
    );

    currentPhase = "source_record_links";
    const existingLinks = await client.query(
      `
        select count(*)::bigint rows
        from meta.source_record_link l
        join meta.source_release r
          on r.release_id = l.source_release_id
        where r.ingest_batch_id = $1
      `,
      [batchId],
    );
    const linkCount = Number(existingLinks.rows[0].rows);
    if (linkCount === 0) {
      await beginPhase();
      const copied = await copyTransformedGzip(
        client,
        "meta.source_record_link",
        LINK_COPY_COLUMNS,
        artifactPaths.get("source_record_links.csv.gz"),
        (row) => sourceRecordLinkCopyRow(row, releaseIds),
      );
      if (copied !== manifest.totals.account_links) {
        throw new Error(
          `source_record_links.csv.gz streamed ${copied} rows; ` +
            `expected ${manifest.totals.account_links}.`,
        );
      }
      await checkpoint(
        currentPhase,
        copied,
        manifest.artifacts["source_record_links.csv.gz"].sha256,
      );
      await commitPhase();
    } else if (linkCount !== manifest.totals.account_links) {
      throw new Error(
        `Hidden link phase has ${linkCount} rows; expected ` +
          `${manifest.totals.account_links}. Refusing a partial resume.`,
      );
    }
    await requireCheckpoint(
      currentPhase,
      manifest.totals.account_links,
      manifest.artifacts["source_record_links.csv.gz"].sha256,
    );
    const linkSourceCounts = await client.query(
      `
        select r.source_id, count(l.*)::bigint rows
        from meta.source_release r
        left join meta.source_record_link l
          on l.source_release_id = r.release_id
        where r.ingest_batch_id = $1
        group by r.source_id
      `,
      [batchId],
    );
    const observedLinkCounts = new Map(
      linkSourceCounts.rows.map((row) => [
        row.source_id,
        Number(row.rows),
      ]),
    );
    for (const source of manifest.sources) {
      if (
        observedLinkCounts.get(source.source_id) !==
        source.account_links
      ) {
        throw new Error(
          `Source-link count mismatch for ${source.source_id}.`,
        );
      }
    }
    process.stdout.write(
      `Source-link phase complete: ${manifest.totals.account_links} rows.\n`,
    );

    currentPhase = "regulatory_records";
    const existingRegulatory = await client.query(
      `
        select count(*)::bigint rows
        from regulatory.record r
        join meta.source_release rel
          on rel.release_id = r.source_release_id
        where rel.ingest_batch_id = $1
      `,
      [batchId],
    );
    const regulatoryCount = Number(existingRegulatory.rows[0].rows);
    if (regulatoryCount === 0) {
      await beginPhase();
      const copied = await copyTransformedGzip(
        client,
        "regulatory.record",
        REGULATORY_COPY_COLUMNS,
        artifactPaths.get("regulatory_records.csv.gz"),
        (row) => regulatoryCopyRow(row, releaseIds),
      );
      if (copied !== expectedRegulatory) {
        throw new Error(
          `regulatory_records.csv.gz streamed ${copied} rows; ` +
            `expected ${expectedRegulatory}.`,
        );
      }
      await client.query(regulatoryTypedLoadSql);
      await checkpoint(
        currentPhase,
        copied,
        manifest.artifacts["regulatory_records.csv.gz"].sha256,
      );
      await commitPhase();
    } else if (regulatoryCount !== expectedRegulatory) {
      throw new Error(
        `Hidden regulatory phase has ${regulatoryCount} rows; expected ` +
          `${expectedRegulatory}. Refusing a partial resume.`,
      );
    }
    await requireCheckpoint(
      currentPhase,
      expectedRegulatory,
      manifest.artifacts["regulatory_records.csv.gz"].sha256,
    );
    const regulatorySourceCounts = await client.query(
      `
        select r.source_id, count(record.*)::bigint rows
        from meta.source_release r
        left join regulatory.record record
          on record.source_release_id = r.release_id
        where r.ingest_batch_id = $1
        group by r.source_id
      `,
      [batchId],
    );
    const observedRegulatoryCounts = new Map(
      regulatorySourceCounts.rows.map((row) => [
        row.source_id,
        Number(row.rows),
      ]),
    );
    for (const source of manifest.sources) {
      const isContext =
        source.family.startsWith("building_profile_") ||
        [
          "energy_benchmark",
          "energy_beps",
          "vacant_blighted",
        ].includes(source.family);
      const expected = isContext ? 0 : source.served_records;
      if (observedRegulatoryCounts.get(source.source_id) !== expected) {
        throw new Error(
          `Regulatory-record count mismatch for ${source.source_id}.`,
        );
      }
    }
    const typedResumeGate = await client.query(
      `
        select
          (
            select count(*)
            from regulatory.building_permit p
            join regulatory.record r on r.record_id = p.record_id
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
          ) = (
            select count(*)
            from regulatory.record r
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
              and r.record_kind in (
                'building_permit',
                'public_space_construction_permit',
                'public_space_occupancy_permit',
                'home_occupancy_permit',
                'special_tree_permit',
                'public_space_rental_permit',
                'emergency_work_request',
                'well_permit'
              )
          ) permits_complete,
          (
            select count(*)
            from regulatory.business_license l
            join regulatory.record r on r.record_id = l.record_id
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
          ) = (
            select count(*)
            from regulatory.record r
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
              and r.record_kind in (
                'business_license',
                'alcohol_license',
                'cannabis_license'
              )
          ) licenses_complete,
          (
            select count(*)
            from regulatory.certificate_of_occupancy c
            join regulatory.record r on r.record_id = c.record_id
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
          ) = (
            select count(*)
            from regulatory.record r
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
              and r.record_kind = 'certificate_of_occupancy'
          ) occupancy_complete,
          (
            select count(*)
            from regulatory.inspection i
            join regulatory.record r on r.record_id = i.record_id
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
          ) = (
            select count(*)
            from regulatory.record r
            join meta.source_release rel
              on rel.release_id = r.source_release_id
            where rel.ingest_batch_id = $1
              and r.record_kind = 'inspection'
          ) inspections_complete
      `,
      [batchId],
    );
    if (
      Object.values(typedResumeGate.rows[0]).some((value) => !value)
    ) {
      throw new Error(
        `Typed regulatory projections are incomplete: ` +
          JSON.stringify(typedResumeGate.rows[0]),
      );
    }
    process.stdout.write(
      `Regulatory-record phase complete: ${expectedRegulatory} rows.\n`,
    );

    currentPhase = "property_context";
    const contextCounts = await client.query(
      `
        select
          (
            select count(*) from property_context.cama_building_profile c
            join meta.source_release r
              on r.release_id = c.source_release_id
            where r.ingest_batch_id = $1
          ) +
          (
            select count(*) from property_context.energy_benchmark e
            join meta.source_release r
              on r.release_id = e.source_release_id
            where r.ingest_batch_id = $1
          ) +
          (
            select count(*) from property_context.beps_compliance b
            join meta.source_release r
              on r.release_id = b.source_release_id
            where r.ingest_batch_id = $1
          ) +
          (
            select count(*) from property_context.vacant_blighted_status v
            join meta.source_release r
              on r.release_id = v.source_release_id
            where r.ingest_batch_id = $1
          ) as rows
      `,
      [batchId],
    );
    const contextCount = Number(contextCounts.rows[0].rows);
    if (contextCount === 0) {
      await beginPhase();
      await client.query(contextStagingSql);
      await copyGzip(
        client,
        "stage_property_context_record",
        artifactPaths.get("property_context_records.csv.gz"),
      );
      const observed = await scalarCount(
        client,
        "stage_property_context_record",
      );
      if (observed !== expectedContext) {
        throw new Error(
          `property_context_records.csv.gz staged ${observed} rows; ` +
            `expected ${expectedContext}.`,
        );
      }
      const contextGate = await client.query(`
        select
          count(*) = count(
            distinct (source_id, release_key, source_record_id)
          ) records_unique,
          not exists (
            select 1
            from stage_property_context_record c
            left join meta.source_release r
              on r.source_id = c.source_id
             and r.release_key = c.release_key
             and r.ingest_batch_id =
               current_setting('dc_property.batch_id')::bigint
            where r.release_id is null
          ) releases_valid,
          not exists (
            select 1
            from stage_property_context_record c
            join meta.source_release r
              on r.source_id = c.source_id
             and r.release_key = c.release_key
            left join meta.source_record_link l
              on l.source_id = c.source_id
             and l.source_release_id = r.release_id
             and l.source_record_id = c.source_record_id
            where l.source_record_link_id is null
          ) records_have_links,
          not exists (
            select 1
            from stage_property_context_record c
            join meta.source_release r
              on r.source_id = c.source_id
             and r.release_key = c.release_key
            join meta.source_record_link l
              on l.source_id = c.source_id
             and l.source_release_id = r.release_id
             and l.source_record_id = c.source_record_id
            where c.record_type in ('energy_benchmark', 'beps')
              and l.match_quality = 'exact'
          ) building_context_valid
        from stage_property_context_record
      `);
      if (
        Object.values(contextGate.rows[0]).some((value) => !value)
      ) {
        throw new Error(
          `Property-context gate failed: ` +
            JSON.stringify(contextGate.rows[0]),
        );
      }
      await client.query(contextLoadSql);
      await checkpoint(
        currentPhase,
        observed,
        manifest.artifacts["property_context_records.csv.gz"].sha256,
      );
      await commitPhase();
    } else if (contextCount !== expectedContext) {
      throw new Error(
        `Hidden context phase has ${contextCount} rows; expected ` +
          `${expectedContext}. Refusing a partial resume.`,
      );
    }
    await requireCheckpoint(
      currentPhase,
      expectedContext,
      manifest.artifacts["property_context_records.csv.gz"].sha256,
    );
    const contextSourceCounts = await client.query(
      `
        with context_records as (
          select source_release_id
          from property_context.cama_building_profile
          union all
          select source_release_id
          from property_context.energy_benchmark
          union all
          select source_release_id
          from property_context.beps_compliance
          union all
          select source_release_id
          from property_context.vacant_blighted_status
        )
        select r.source_id, count(c.*)::bigint rows
        from meta.source_release r
        left join context_records c
          on c.source_release_id = r.release_id
        where r.ingest_batch_id = $1
        group by r.source_id
      `,
      [batchId],
    );
    const observedContextCounts = new Map(
      contextSourceCounts.rows.map((row) => [
        row.source_id,
        Number(row.rows),
      ]),
    );
    for (const source of manifest.sources) {
      const isContext =
        source.family.startsWith("building_profile_") ||
        [
          "energy_benchmark",
          "energy_beps",
          "vacant_blighted",
        ].includes(source.family);
      const expected = isContext ? source.served_records : 0;
      if (observedContextCounts.get(source.source_id) !== expected) {
        throw new Error(
          `Property-context count mismatch for ${source.source_id}.`,
        );
      }
    }
    process.stdout.write(
      `Property-context phase complete: ${expectedContext} rows.\n`,
    );

    currentPhase = "publication";
    await beginPhase();
    await client.query(
      "lock table core.property_account_current in share mode",
    );
    const finalDatabaseAccountMapping =
      await databaseAccountMappingFingerprint(client);
    if (
      finalDatabaseAccountMapping.rows !== manifest.account_input.rows ||
      finalDatabaseAccountMapping.sha256 !==
        accountBinding.rows[0].mapping_sha256 ||
      await sha256(accountInputPath) !== manifest.account_input.sha256
    ) {
      throw new Error(
        "The core account relation or canonical account artifact changed " +
          "during the hidden load; refusing publication.",
      );
    }
    const finalAccountBinding = await client.query(
      `
        select count(*)::integer rows
        from meta.loaded_artifact_binding
        where artifact_key = 'property_account_current'
          and relation_name = 'core.property_account_current'
          and artifact_sha256 = $1
          and artifact_row_count = $2
          and mapping_sha256 = $3
      `,
      [
        manifest.account_input.sha256,
        manifest.account_input.rows,
        accountBinding.rows[0].mapping_sha256,
      ],
    );
    if (finalAccountBinding.rows[0].rows !== 1) {
      throw new Error(
        "The core account binding was invalidated during the hidden load; " +
          "refusing publication.",
      );
    }
    await client.query(metadataStagingSql);
    await copyGzip(
      client,
      "stage_source_asset",
      artifactPaths.get("source_assets.csv.gz"),
    );
    await copyGzip(
      client,
      "stage_source_release",
      artifactPaths.get("source_releases.csv.gz"),
    );
    await client.query(sourceAssetPublishSql);
    await client.query(
      "select set_config('dc_property.snapshot_at', $1, true)",
      [manifest.generated_from_snapshot_at],
    );
    await client.query(
      "select set_config('dc_property.source_stats', $1, true)",
      [JSON.stringify(manifest.sources)],
    );
    await client.query(summaryAndQualitySql);

    const productionGate = await client.query(`
      with batch_releases as materialized (
        select release_id
        from meta.source_release
        where ingest_batch_id =
          current_setting('dc_property.batch_id')::bigint
      )
      select
        (
          select count(*) from regulatory.record
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint regulatory_records,
        (
          select count(*) from regulatory.building_permit p
          join regulatory.record r on r.record_id = p.record_id
          where r.source_release_id in (
            select release_id from batch_releases
          )
        )::bigint typed_permit_records,
        (
          select count(*) from regulatory.record
          where record_kind in (
            'building_permit',
            'public_space_construction_permit',
            'public_space_occupancy_permit',
            'home_occupancy_permit',
            'special_tree_permit',
            'public_space_rental_permit',
            'emergency_work_request',
            'well_permit'
          )
          and source_release_id in (
            select release_id from batch_releases
          )
        )::bigint expected_typed_permit_records,
        (
          select count(*) from regulatory.business_license l
          join regulatory.record r on r.record_id = l.record_id
          where r.source_release_id in (
            select release_id from batch_releases
          )
        )::bigint typed_license_records,
        (
          select count(*) from regulatory.record
          where record_kind in (
            'business_license', 'alcohol_license', 'cannabis_license'
          )
          and source_release_id in (
            select release_id from batch_releases
          )
        )::bigint expected_typed_license_records,
        (
          select count(*) from regulatory.certificate_of_occupancy c
          join regulatory.record r on r.record_id = c.record_id
          where r.source_release_id in (
            select release_id from batch_releases
          )
        )::bigint typed_occupancy_records,
        (
          select count(*) from regulatory.record
          where record_kind = 'certificate_of_occupancy'
            and source_release_id in (
              select release_id from batch_releases
            )
        )::bigint expected_typed_occupancy_records,
        (
          select count(*) from regulatory.inspection i
          join regulatory.record r on r.record_id = i.record_id
          where r.source_release_id in (
            select release_id from batch_releases
          )
        )::bigint typed_inspection_records,
        (
          select count(*) from regulatory.record
          where record_kind = 'inspection'
            and source_release_id in (
              select release_id from batch_releases
            )
        )::bigint expected_typed_inspection_records,
        (
          select count(*) from regulatory.enforcement_action e
          join regulatory.record r on r.record_id = e.record_id
          where r.source_release_id in (
            select release_id from batch_releases
          )
        )::bigint typed_enforcement_records,
        (
          select count(*) from regulatory.record
          where record_kind = 'enforcement_action'
            and source_release_id in (
              select release_id from batch_releases
            )
        )::bigint expected_typed_enforcement_records,
        (
          select count(*) from property_context.cama_building_profile
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint cama_records,
        (
          select count(*) from property_context.energy_benchmark
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint energy_records,
        (
          select count(*) from property_context.beps_compliance
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint beps_records,
        (
          select count(*) from property_context.vacant_blighted_status
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint vacant_records,
        (
          select count(*)
          from meta.source_record_link
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint account_links,
        (
          select count(*) from meta.source_record_link
          where link_scope = 'exact_property'
            and source_release_id in (
              select release_id from batch_releases
            )
        )::bigint exact_links,
        (
          select count(*) from meta.source_record_link
          where link_scope <> 'exact_property'
            and source_release_id in (
              select release_id from batch_releases
            )
        )::bigint contextual_links,
        not exists (
          select 1
          from meta.source_record_link l
          where l.source_release_id in (
              select release_id from batch_releases
            )
            and not (
              exists (
                select 1 from regulatory.record r
                where r.source_id = l.source_id
                  and r.source_release_id = l.source_release_id
                  and r.source_record_id = l.source_record_id
              )
              or exists (
                select 1
                from property_context.cama_building_profile c
                where c.source_id = l.source_id
                  and c.source_release_id = l.source_release_id
                  and c.source_record_id = l.source_record_id
              )
              or exists (
                select 1
                from property_context.energy_benchmark e
                where e.source_id = l.source_id
                  and e.source_release_id = l.source_release_id
                  and e.source_record_id = l.source_record_id
              )
              or exists (
                select 1
                from property_context.beps_compliance b
                where b.source_id = l.source_id
                  and b.source_release_id = l.source_release_id
                  and b.source_record_id = l.source_record_id
              )
              or exists (
                select 1
                from property_context.vacant_blighted_status v
                where v.source_id = l.source_id
                  and v.source_release_id = l.source_release_id
                  and v.source_record_id = l.source_record_id
              )
            )
        ) links_reference_served_records,
        not exists (
          select 1
          from (
            select source_id, source_release_id, source_record_id
            from regulatory.record
            where source_release_id in (
              select release_id from batch_releases
            )
            union all
            select source_id, source_release_id, source_record_id
            from property_context.cama_building_profile
            where source_release_id in (
              select release_id from batch_releases
            )
            union all
            select source_id, source_release_id, source_record_id
            from property_context.energy_benchmark
            where source_release_id in (
              select release_id from batch_releases
            )
            union all
            select source_id, source_release_id, source_record_id
            from property_context.beps_compliance
            where source_release_id in (
              select release_id from batch_releases
            )
            union all
            select source_id, source_release_id, source_record_id
            from property_context.vacant_blighted_status
            where source_release_id in (
              select release_id from batch_releases
            )
          ) s
          where not exists (
            select 1
            from meta.source_record_link l
            where l.source_id = s.source_id
              and l.source_release_id = s.source_release_id
              and l.source_record_id = s.source_record_id
          )
        ) served_records_have_links,
        (
          select count(*) from core.property_public_record_summary
        )::bigint summary_rows,
        (
          select count(distinct account_id)
          from meta.source_record_link
          where source_release_id in (
            select release_id from batch_releases
          )
        )::bigint expected_summary_rows,
        pg_database_size(current_database())::bigint database_size_bytes
    `);
    const gateRow = productionGate.rows[0];
    const booleanGateNames = [
      "links_reference_served_records",
      "served_records_have_links",
    ];
    if (booleanGateNames.some((name) => !gateRow[name])) {
      throw new Error(
        `Regulatory relationship gate failed: ${JSON.stringify(
          Object.fromEntries(
            booleanGateNames.map((name) => [name, gateRow[name]]),
          ),
        )}`,
      );
    }
    const counts = Object.fromEntries(
      Object.entries(gateRow)
        .filter(([key]) => !booleanGateNames.includes(key))
        .map(([key, value]) => [key, Number(value)]),
    );
    if (
      counts.regulatory_records !== expectedRegulatory ||
      counts.typed_permit_records !==
        counts.expected_typed_permit_records ||
      counts.typed_license_records !==
        counts.expected_typed_license_records ||
      counts.typed_occupancy_records !==
        counts.expected_typed_occupancy_records ||
      counts.typed_inspection_records !==
        counts.expected_typed_inspection_records ||
      counts.typed_enforcement_records !==
        counts.expected_typed_enforcement_records ||
      counts.cama_records !==
        expectedContextByType.cama_building_profile ||
      counts.energy_records !== expectedContextByType.energy_benchmark ||
      counts.beps_records !== expectedContextByType.beps ||
      counts.vacant_records !== expectedContextByType.vacant_blighted ||
      counts.account_links !== manifest.totals.account_links ||
      counts.summary_rows !== counts.expected_summary_rows ||
      counts.exact_links < 1 ||
      counts.contextual_links < 1
    ) {
      throw new Error(
        `Regulatory production row-count gate failed: ${JSON.stringify({
          observed: counts,
          expected: {
            regulatory_records: expectedRegulatory,
            ...expectedContextByType,
            account_links: manifest.totals.account_links,
          },
        })}`,
      );
    }
    const storageLevel = databaseSizeLevel(counts.database_size_bytes);
    if (storageLevel === "hard_limit") {
      throw new Error(
        `Database is ${counts.database_size_bytes} bytes; ` +
          "the configured 40 GB shared-volume safety limit has been reached.",
      );
    }
    if (storageLevel === "warning") {
      process.stderr.write(
        `WARNING: database is ${counts.database_size_bytes} bytes; ` +
          "the 25 GB shared-volume warning threshold has been reached.\n",
      );
    }

    await client.query(`
      update meta.source_release
      set
        release_status = 'published',
        quality_status = 'passed',
        published_at = now()
      where ingest_batch_id =
        current_setting('dc_property.batch_id')::bigint;

      delete from meta.source_release_pointer p
      using meta.source_release r
      where p.release_id = r.release_id
        and r.ingest_batch_id =
          current_setting('dc_property.batch_id')::bigint
        and p.pointer_name in ('candidate', 'previous');
    `);
    await client.query(
      `
        insert into meta.source_release_pointer (
          source_id,
          pointer_name,
          release_id,
          set_by_batch_id,
          pointer_metadata
        )
        select
          source_id,
          'current',
          release_id,
          current_setting('dc_property.batch_id')::bigint,
          jsonb_build_object(
            'normalized_run_id', $1::text,
            'manifest_sha256', $2::text
          )
        from meta.source_release
        where ingest_batch_id =
          current_setting('dc_property.batch_id')::bigint
        on conflict (source_id, pointer_name) do update
        set
          release_id = excluded.release_id,
          set_by_batch_id = excluded.set_by_batch_id,
          set_at = now(),
          pointer_metadata = excluded.pointer_metadata
      `,
      [manifest.run_id, manifestSha256],
    );
    await checkpoint(
      "publication",
      manifest.totals.served_records,
      manifestSha256,
      { database_size_bytes: counts.database_size_bytes },
    );
    await client.query(`
      update meta.ingest_batch
      set
        status = 'published',
        quality_status = 'passed',
        quality_check_count = (
          select count(*)
          from meta.ingest_quality_result
          where batch_id =
            current_setting('dc_property.batch_id')::bigint
        ),
        quality_warning_count = 0,
        quality_error_count = 0,
        validated_at = now(),
        published_at = now(),
        database_size_bytes = pg_database_size(current_database())
      where batch_id =
        current_setting('dc_property.batch_id')::bigint;
    `);
    await commitPhase();
    published = true;

    process.stdout.write(
      `Published regulatory run ${manifest.run_id}: ` +
        `${JSON.stringify(counts)}\n`,
    );
    for (const table of [
      "meta.source_record_link",
      "regulatory.record",
      "regulatory.building_permit",
      "regulatory.business_license",
      "regulatory.certificate_of_occupancy",
      "regulatory.inspection",
      "regulatory.enforcement_action",
      "property_context.cama_building_profile",
      "property_context.energy_benchmark",
      "property_context.energy_benchmark_property_link",
      "property_context.beps_compliance",
      "property_context.beps_property_link",
      "property_context.vacant_blighted_status",
    ]) {
      await client.query(`analyze ${table}`).catch((error) => {
        process.stderr.write(
          `WARNING: analyze ${table} failed after publication: ` +
            `${error.message}\n`,
        );
      });
    }
    process.stdout.write("Regulatory serving tables analyzed.\n");
  } catch (error) {
    if (inTransaction) {
      await client.query("rollback").catch(() => undefined);
      inTransaction = false;
    }
    if (batchId !== null && !published) {
      await client.query(
        `
          update meta.ingest_batch
          set status = 'rejected', quality_status = 'failed'
          where batch_id = $1 and status <> 'published'
        `,
        [batchId],
      ).catch(() => undefined);
      await client.query(
        `
          insert into meta.ingest_phase_checkpoint (
            batch_id,
            phase_name,
            phase_status,
            detail
          ) values ($1, $2, 'failed', $3::jsonb)
          on conflict (batch_id, phase_name) do update
          set
            phase_status = 'failed',
            detail = excluded.detail,
            completed_at = now()
        `,
        [
          batchId,
          currentPhase,
          JSON.stringify({
            error: String(error.message).slice(0, 2000),
            retry_policy:
              "Fix the cause and rerun the identical manifest; completed " +
              "hidden phases are verified and resumed.",
          }),
        ],
      ).catch(() => undefined);
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
}

await runLoader();
