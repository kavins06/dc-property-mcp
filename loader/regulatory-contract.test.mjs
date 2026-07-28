import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REGULATORY_ARTIFACTS,
  REQUIRED_REGULATORY_SOURCE_FAMILIES,
  REQUIRED_REGULATORY_SOURCE_IDS,
  validateRegulatoryManifest,
} from "./regulatory-contract.mjs";

const sha = "a".repeat(64);

function completeManifest() {
  const sources = [...REQUIRED_REGULATORY_SOURCE_IDS].map((source_id) => ({
    source_id,
    family: REQUIRED_REGULATORY_SOURCE_FAMILIES[source_id],
    release_key: `arcgis-${sha}`,
    input_rows: 10,
    served_records: 8,
    exact_records: 5,
    contextual_records: 3,
    ambiguous_records: 1,
    unlinked_records: 1,
    account_links: 9,
  }));
  const sourceCount = sources.length;
  const totals = sources.reduce(
    (sum, source) => {
      for (const key of [
        "input_rows",
        "served_records",
        "exact_records",
        "contextual_records",
        "ambiguous_records",
        "unlinked_records",
        "account_links",
      ]) {
        sum[key] += source[key];
      }
      return sum;
    },
    {
      input_rows: 0,
      served_records: 0,
      exact_records: 0,
      contextual_records: 0,
      ambiguous_records: 0,
      unlinked_records: 0,
      account_links: 0,
    },
  );
  const contextRows = sources
    .filter(({ family }) =>
      family.startsWith("building_profile_") ||
      [
        "energy_benchmark",
        "energy_beps",
        "vacant_blighted",
      ].includes(family)
    )
    .reduce((sum, source) => sum + source.served_records, 0);
  const regulatoryRows = totals.served_records - contextRows;
  return {
    manifest_kind: "dc-property-regulatory-normalized",
    manifest_version: 1,
    run_id: "fixture",
    generated_from_snapshot_at: "2026-07-28T00:00:00Z",
    account_input: {
      file: "property_account_current.csv.gz",
      rows: 221263,
      sha256: sha,
    },
    archive_policy: {
      status: "verified",
      scheme: "s3_content_addressed_sha256",
      provider: "hetzner_object_storage",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      archive_id: sha,
      bucket: "dc-property-private",
      receipt_object_key: `releases/fixture/receipts/${sha}.json`,
      receipt_sha256: sha,
    },
    acquisition_runs: [
      {
        run_id: "base",
        status: "failed",
        manifest_file: "run.manifest.json",
        manifest_sha256: sha,
      },
      {
        run_id: "patch",
        status: "complete",
        manifest_file: "run.manifest.json",
        manifest_sha256: sha,
      },
    ],
    safe_max_accounts_per_address: 64,
    linking_policy: { fuzzy_matching: false },
    source_count: sourceCount,
    sources,
    totals,
    artifacts: {
      "source_assets.csv.gz": {
        rows: sourceCount,
        bytes: 100,
        sha256: sha,
        canonical_rows_sha256: sha,
      },
      "source_releases.csv.gz": {
        rows: sourceCount,
        bytes: 100,
        sha256: sha,
        canonical_rows_sha256: sha,
      },
      "regulatory_records.csv.gz": {
        rows: regulatoryRows,
        bytes: 100,
        sha256: sha,
        canonical_rows_sha256: sha,
      },
      "property_context_records.csv.gz": {
        rows: contextRows,
        bytes: 100,
        sha256: sha,
        canonical_rows_sha256: sha,
      },
      "source_record_links.csv.gz": {
        rows: totals.account_links,
        bytes: 100,
        sha256: sha,
        canonical_rows_sha256: sha,
      },
    },
  };
}

test("regulatory load contract covers every official source and artifact", () => {
  assert.equal(REQUIRED_REGULATORY_SOURCE_IDS.size, 38);
  assert.deepEqual(
    REGULATORY_ARTIFACTS.map(({ fileName }) => fileName),
    [
      "source_assets.csv.gz",
      "source_releases.csv.gz",
      "regulatory_records.csv.gz",
      "property_context_records.csv.gz",
      "source_record_links.csv.gz",
    ],
  );
  assert.doesNotThrow(() => validateRegulatoryManifest(completeManifest()));
});

test("patched acquisition runs are accepted only when the final source set is complete", () => {
  const manifest = completeManifest();
  manifest.sources = manifest.sources.filter(
    ({ source_id }) => source_id !== "dob_building_permits_2019",
  );
  manifest.source_count -= 1;
  assert.throws(
    () => validateRegulatoryManifest(manifest),
    /missing required source dob_building_permits_2019/,
  );
});

test("manifest source IDs and family labels must match the exact registry", () => {
  const extra = completeManifest();
  extra.sources.push({
    ...extra.sources[0],
    source_id: "unexpected_official_source",
  });
  extra.source_count += 1;
  assert.throws(
    () => validateRegulatoryManifest(extra),
    /unexpected source unexpected_official_source/,
  );

  const mislabeled = completeManifest();
  mislabeled.sources[0].family = "business_license";
  assert.throws(
    () => validateRegulatoryManifest(mislabeled),
    /has family business_license; expected/,
  );
});

test("manifest gates reject fuzzy matching, link-count drift, and unsafe artifacts", () => {
  const fuzzy = completeManifest();
  fuzzy.linking_policy.fuzzy_matching = true;
  assert.throws(
    () => validateRegulatoryManifest(fuzzy),
    /fuzzy matching must be disabled/,
  );

  const drift = completeManifest();
  drift.artifacts["source_record_links.csv.gz"].rows -= 1;
  assert.throws(
    () => validateRegulatoryManifest(drift),
    /source-record link row count/,
  );

  const unsafe = completeManifest();
  unsafe.artifacts["regulatory_records.csv.gz"].sha256 = "not-a-hash";
  assert.throws(
    () => validateRegulatoryManifest(unsafe),
    /invalid sha256/,
  );

  const localOnly = completeManifest();
  localOnly.archive_policy = {
    status: "local_test_fixture",
    scheme: "local_path",
  };
  assert.throws(
    () => validateRegulatoryManifest(localOnly),
    /verified content-addressed S3 archive/,
  );
});

test("production loader materializes every typed regulatory projection", () => {
  const loader = readFileSync(
    new URL("./load-regulatory.mjs", import.meta.url),
    "utf8",
  );
  for (const table of [
    "regulatory.building_permit",
    "regulatory.business_license",
    "regulatory.certificate_of_occupancy",
    "regulatory.inspection",
  ]) {
    assert.match(loader, new RegExp(`insert into ${table.replace(".", "\\.")}`));
  }
  for (const gate of [
    "typed_permit_records",
    "expected_typed_permit_records",
    "typed_license_records",
    "expected_typed_license_records",
    "typed_occupancy_records",
    "expected_typed_occupancy_records",
    "typed_inspection_records",
    "expected_typed_inspection_records",
  ]) {
    assert.match(loader, new RegExp(gate));
  }
  assert.match(
    loader,
    /0024_regulatory_release_lifecycle\.sql/,
  );
});
