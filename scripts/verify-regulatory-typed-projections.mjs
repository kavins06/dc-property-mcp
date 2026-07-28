import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import pg from "../loader/node_modules/pg/lib/index.js";

import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const project = resolve(import.meta.dirname, "..");
const loaderSource = readFileSync(
  resolve(project, "loader", "load-regulatory.mjs"),
  "utf8",
);
const sqlMatch = loaderSource.match(
  /const regulatoryTypedLoadSql = `([\s\S]*?)`;\r?\n\r?\nconst contextLoadSql/,
);
assert.ok(sqlMatch, "Typed loader SQL block was not found.");
// The loader stores SQL in a JavaScript template literal. Reproduce the
// literal's runtime escaping without evaluating arbitrary source text.
const typedSql = sqlMatch[1].replaceAll("\\\\", "\\");

const correctiveMigration = readFileSync(
  resolve(
    project,
    "db",
    "migrations",
    "0023_regulatory_typed_record_kinds.sql",
  ),
  "utf8",
)
  .replace(/^\s*begin;\s*/i, "")
  .replace(/\s*commit;\s*$/i, "");

const client = new pg.Client({
  ...adminDatabaseConfig(process.env),
  statement_timeout: 0,
  application_name: "dc-property-regulatory-typed-verifier",
});

await client.connect();
try {
  await client.query("begin");
  await client.query(correctiveMigration);

  const token = `typed_smoke_${Date.now()}`;
  const batchResult = await client.query(`
    insert into meta.ingest_batch (
      status,
      input_manifest_sha256,
      etl_version,
      migration_version,
      quality_status
    ) values (
      'loading',
      repeat('d', 64),
      'typed-smoke',
      '0023',
      'pending'
    )
    returning batch_id
  `);
  const batchId = batchResult.rows[0].batch_id;
  await client.query(
    "select set_config('dc_property.batch_id', $1, true)",
    [String(batchId)],
  );

  await client.query(
    `
      insert into meta.source_asset (
        source_id,
        publisher,
        dataset_name,
        source_class,
        official_landing_url,
        bytes,
        sha256,
        row_count,
        dataset_retrieved_at,
        source_system,
        snapshot_policy
      ) values (
        $1,
        'District of Columbia',
        'Typed smoke fixture',
        'official_snapshot',
        'https://scout.dob.dc.gov/',
        0,
        repeat('e', 64),
        4,
        clock_timestamp(),
        'typed_smoke',
        'one_time_archive'
      )
    `,
    [token],
  );

  const releaseResult = await client.query(
    `
      insert into meta.source_release (
        source_id,
        ingest_batch_id,
        release_key,
        release_status,
        quality_status,
        snapshot_retrieved_at,
        archive_object_key,
        bytes,
        row_count,
        sha256,
        schema_sha256
      ) values (
        $1,
        $2,
        'typed-smoke',
        'validated',
        'passed',
        clock_timestamp(),
        'typed-smoke',
        0,
        4,
        repeat('f', 64),
        repeat('a', 64)
      )
      returning release_id
    `,
    [token, batchId],
  );
  const releaseId = releaseResult.rows[0].release_id;

  const fixtures = [
    [
      1,
      "public_space_construction_permit",
      "PA-1",
      "Permit Issued",
      {
        PermitType: "Construction",
        TypeDetailNames: "Excavation",
        WorkDetail: "Utility cut",
        ApplicationDate: 1767225600000,
        IssueDate: 1767312000000,
        ExpirationDate: 1769904000000,
        PermitFee: 12.34,
      },
    ],
    [
      2,
      "alcohol_license",
      "ABCA-1",
      "ACTIVE",
      {
        TYPE: "Retailer",
        CLASS: "C",
        APPLICANT: "Fixture LLC",
        TRADE_NAME: "Fixture",
        EXPIRATION_DATE: 1798693200000,
      },
    ],
    [
      3,
      "certificate_of_occupancy",
      "CO-1",
      "Issued",
      {
        PERMIT_NUMBER: "CO-1",
        DESCRIPTION_OF_OCCUPANCY: "Office",
        OCCUPANCY_LOAD: 25,
        FLOORS_OCCUPIED: "1",
        ISSUE_DATE: 1767312000000,
      },
    ],
    [
      4,
      "inspection",
      "INSP-1",
      "Project Complete",
      {
        APPLICATIONTYPE: "Occupancy Permit Application",
        INSPECTIONSTATUSDESC: "Project Complete",
        INSPECTIONDATE: 1767398400000,
        NOTESFORPERMITTEE: "Public space restored.",
      },
    ],
  ];

  for (const [id, kind, number, status, facts] of fixtures) {
    await client.query(
      `
        insert into regulatory.record (
          source_id,
          source_release_id,
          source_record_id,
          source_row_number,
          source_row_sha256,
          record_kind,
          source_record_key,
          record_number,
          record_status,
          premise_address,
          extra_attributes
        ) values (
          $1,
          $2,
          $3::bigint,
          $3::integer,
          repeat(substr(md5($3::text), 1, 32), 2),
          $4,
          $5,
          $5,
          $6,
          '1100 4TH ST SW',
          $7::jsonb
        )
      `,
      [
        token,
        releaseId,
        id,
        kind,
        number,
        status,
        JSON.stringify(facts),
      ],
    );
  }

  await client.query(typedSql);
  const result = await client.query(`
    select
      (
        select jsonb_build_object(
          'kind', typed.record_kind,
          'type', permit_type,
          'subtype', permit_subtype,
          'description', work_description,
          'application_date', application_date,
          'issue_date', issue_date,
          'expiration_date', expiration_date,
          'fee_cents', permit_fee_cents
        )
        from regulatory.building_permit typed
        join regulatory.record source using (record_id)
        where source.source_id = $1
      ) permit,
      (
        select jsonb_build_object(
          'kind', typed.record_kind,
          'category', license_category,
          'type', license_type,
          'entity', entity_name,
          'trade', trade_name,
          'expiration_date', expiration_date,
          'active', is_active
        )
        from regulatory.business_license typed
        join regulatory.record source using (record_id)
        where source.source_id = $1
      ) license,
      (
        select jsonb_build_object(
          'number', certificate_number,
          'use', occupancy_use,
          'load', occupancy_load,
          'floors', floors_occupied,
          'issue_date', issue_date
        )
        from regulatory.certificate_of_occupancy typed
        join regulatory.record source using (record_id)
        where source.source_id = $1
      ) occupancy,
      (
        select jsonb_build_object(
          'type', inspection_type,
          'result', inspection_result,
          'unit', inspector_unit,
          'notes', notes,
          'completed_at', completed_at at time zone 'UTC'
        )
        from regulatory.inspection typed
        join regulatory.record source using (record_id)
        where source.source_id = $1
      ) inspection
  `, [token]);

  const row = result.rows[0];
  assert.equal(
    row.permit.kind,
    "public_space_construction_permit",
  );
  assert.equal(row.permit.type, "Construction");
  assert.equal(row.permit.subtype, "Excavation");
  assert.equal(row.permit.fee_cents, 1234);
  assert.equal(row.license.kind, "alcohol_license");
  assert.equal(row.license.entity, "Fixture LLC");
  assert.equal(row.license.active, true);
  assert.equal(row.occupancy.number, "CO-1");
  assert.equal(row.occupancy.load, 25);
  assert.equal(row.inspection.result, "Project Complete");
  assert.equal(
    row.inspection.unit,
    "DDOT Public Space Inspections",
  );

  await client.query("rollback");
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      projections: row,
    })}\n`,
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
