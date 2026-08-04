import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCurrencyCents,
  parseDetailText,
  parseSearchRow,
  stableJson,
  validateManifest,
} from "../src/contract.mjs";

test("parses a Recorder result row without inventing lender or loan facts", () => {
  const record = parseSearchRow(
    [
      "",
      "",
      "",
      "2026073741",
      "OPR/--/--",
      "VEALENCIS JOSEPH JEAN",
      "NEWTEK BANK, NATIONAL ASSOCIATION",
      "TRUST",
      "7/24/2026",
      "0992",
      "0055",
      "N/A",
    ],
    "Document 322021542, not selected, checkbox",
  );
  assert.equal(record.document_id, "322021542");
  assert.equal(record.recorded_date, "2026-07-24");
  assert.equal(record.consideration_cents, null);
  assert.deepEqual(record.legals, [
    { square: "0992", low_lot: "0055", high_lot: "0055" },
  ]);
});

test("parses detail metadata and full party roles", () => {
  const base = parseSearchRow(
    [
      "2026073741",
      "OPR/--/--",
      "VEALENCIS JOSEPH JEAN",
      "NEWTEK BANK, NATIONAL ASSOCIATION",
      "TRUST",
      "7/24/2026",
      "0992",
      "0055",
      "N/A",
    ],
    "Document 322021542",
  );
  const detail = parseDetailText(
    [
      "TRUST",
      "Document Number:",
      "2026073741",
      "Book Type/Roll or Frame/Page:",
      "OPR/--/--",
      "Recorded Date:",
      "7/24/2026 4:50 PM",
      "Consideration:",
      "$973,398.00",
      "Number of Pages:",
      "11",
      "Parties",
      "VEALENCIS JOSEPH JEAN",
      "GRANTOR",
      "FINK TIMOTHY RYAN",
      "GRANTOR",
      "NEWTEK BANK, NATIONAL ASSOCIATION",
      "GRANTEE",
      "Related Instrument Number",
      "No related instrument number found.",
      "legals",
    ].join("\n"),
    base,
  );
  assert.equal(detail.consideration_cents, "97339800");
  assert.equal(detail.recorded_at_local, "2026-07-24T16:50:00");
  assert.equal(detail.page_count, 11);
  assert.equal(detail.parties.length, 3);
  assert.equal(detail.detail_status, "complete");
});

test("currency parser preserves exact cents", () => {
  assert.equal(parseCurrencyCents("$1,234.05"), "123405");
  assert.equal(parseCurrencyCents(null), null);
});

test("stable JSON is key-order independent", () => {
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
});

test("manifest validation rejects row-count drift", () => {
  assert.throws(
    () =>
      validateManifest({
        manifest_kind: "dc-recorder-normalized-index",
        manifest_version: 1,
        date_from: "2026-07-24",
        date_to: "2026-07-24",
        authorization_ref: "DC Recorder written authorization",
        source_origin: "https://washington.dc.publicsearch.us",
        collection_policy: {
          detail_mode: "secured",
          delay_ms: 1500,
          document_images_requested: false,
          paid_orders_placed: false,
        },
        row_count: 2,
        pages: [
          {
            path: "2026-07-24/page-0001.jsonl",
            rows: 1,
            sha256: "a".repeat(64),
          },
        ],
      }),
    /row count/,
  );
});
