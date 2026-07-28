import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_LOADS,
  DATABASE_SIZE_HARD_LIMIT_BYTES,
  DATABASE_SIZE_WARNING_BYTES,
  databaseSizeLevel,
} from "./pipeline-contract.mjs";


test("active loads include current, tax, and sales but no assessment artifact", () => {
  assert.deepEqual(
    ACTIVE_LOADS.map(({ table, fileName }) => [table, fileName]),
    [
      ["core.property_account_current", "property_account_current.csv.gz"],
      ["history.tax_series", "tax_series.csv.gz"],
      ["history.sale_series", "sale_series.csv.gz"],
    ],
  );
});

test("database storage preserves shared Hetzner volume headroom", () => {
  assert.equal(DATABASE_SIZE_WARNING_BYTES, 25_000_000_000);
  assert.equal(DATABASE_SIZE_HARD_LIMIT_BYTES, 40_000_000_000);
  assert.equal(databaseSizeLevel(24_999_999_999), "ok");
  assert.equal(databaseSizeLevel(25_000_000_000), "warning");
  assert.equal(databaseSizeLevel(39_999_999_999), "warning");
  assert.equal(databaseSizeLevel(40_000_000_000), "hard_limit");
});
