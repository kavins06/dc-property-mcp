import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { countyKind, sqlText } from "../generate-national-geography-seed.mjs";

test("national geography seed escapes names and classifies county equivalents", () => {
  assert.equal(sqlText("O'Brien"), "'O''Brien'");
  assert.equal(countyKind("51", "Alexandria city"), "independent_city");
  assert.equal(countyKind("24", "Baltimore city"), "independent_city");
  assert.equal(countyKind("06", "Los Angeles County"), "county");
  assert.equal(countyKind("22", "Orleans Parish"), "county_equivalent");
});

test("generator pins both archives and extracted Census text", async () => {
  const source = await readFile(
    new URL("../generate-national-geography-seed.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /stateText\) !== EXPECTED\.states\.textSha256/);
  assert.match(source, /countyText\) !== EXPECTED\.counties\.textSha256/);

  const migration = await readFile(
    new URL("../../db/production-migrations/0002_national_geography_2025.sql", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(migration).digest("hex"),
    "04c01e855b78a43e78ef6c43b48f9d52937bd188451f0178c4063d9942a3e87d",
  );
});
