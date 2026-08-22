import assert from "node:assert/strict";
import test from "node:test";

import { countyKind, sqlText } from "../generate-national-geography-seed.mjs";

test("national geography seed escapes names and classifies county equivalents", () => {
  assert.equal(sqlText("O'Brien"), "'O''Brien'");
  assert.equal(countyKind("51", "Alexandria city"), "independent_city");
  assert.equal(countyKind("24", "Baltimore city"), "independent_city");
  assert.equal(countyKind("06", "Los Angeles County"), "county");
  assert.equal(countyKind("22", "Orleans Parish"), "county_equivalent");
});
