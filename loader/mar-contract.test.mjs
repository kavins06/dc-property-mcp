import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarReleaseRows,
  validateMarManifest,
} from "./mar-contract.mjs";

const sha = (character) => character.repeat(64);

function manifest() {
  return {
    manifest_kind: "dc-property-mar-normalized",
    manifest_version: 1,
    source_count: 3,
    sources: [
      ["mar_address_current", "a"],
      ["mar_address_ssl_current", "b"],
      ["mar_residential_unit_current", "c"],
    ].map(([source_id, character]) => ({
      source_id,
      release_key: `arcgis-${sha(character)}`,
      retrieved_at: "2026-08-05T12:00:00Z",
      rows: 1,
      bytes: 10,
      gzip_sha256: sha(character),
      canonical_rows_sha256: sha("d"),
      schema_sha256: sha("e"),
      source: {
        source_id,
        publisher: "DC GIS",
        dataset_name: source_id,
        layer_url: `https://example.test/${source_id}`,
        landing_url: "https://opendata.dc.gov/",
        source_limitations: "Official current snapshot.",
      },
    })),
    artifacts: Object.fromEntries([
      "mar_addresses.csv.gz",
      "mar_address_ssls.csv.gz",
      "mar_residential_units.csv.gz",
    ].map((name, index) => [name, {
      rows: 1,
      bytes: 10 + index,
      sha256: sha(String(index + 1)),
      canonical_rows_sha256: sha(String(index + 4)),
    }])),
  };
}

test("accepts only the exact three-source MAR release", () => {
  const value = manifest();
  assert.equal(validateMarManifest(value), value);
  value.sources.pop();
  assert.throws(() => validateMarManifest(value), /source set/i);
});

test("builds published releases bound to one verified archive receipt", () => {
  const rows = buildMarReleaseRows(manifest(), {
    status: "verified",
    receipt_object_key: `dc-property/mar/receipts/${sha("f")}.json`,
    receipt_sha256: sha("9"),
  });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.archive_object_key.includes("/receipts/")));
  assert.ok(rows.every((row) => row.release_status === "published"));
  assert.ok(rows.every((row) => row.quality_status === "passed"));
});

test("rejects an unverified archive receipt", () => {
  assert.throws(
    () => buildMarReleaseRows(manifest(), {
      status: "pending",
      receipt_object_key: "pending",
      receipt_sha256: sha("9"),
    }),
    /verified archive/i,
  );
});
