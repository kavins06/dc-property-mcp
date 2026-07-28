import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCamaYear,
  safeCamaYearSql,
} from "./sql-projection.mjs";

test("CAMA years project only the database-supported 1600-2200 range", () => {
  for (const [raw, expected] of [
    ["1600", 1600],
    ["2020", 2020],
    ["2020.0", 2020],
    ["2200", 2200],
    ["0", null],
    ["20", null],
    ["20212", null],
    ["1987024", null],
    ["20142013", null],
    ["2201", null],
    ["1599", null],
    ["not-a-year", null],
  ]) {
    assert.equal(normalizeCamaYear(raw), expected, raw);
  }
});

test("generated CAMA year SQL guards range before the smallint cast", () => {
  const sql = safeCamaYearSql("s.facts_json", "AYB");
  assert.match(sql, /\^\[0-9\]\{4\}/);
  assert.equal(sql.includes("(?:\\.0+)?"), true);
  assert.equal(sql.includes("(?:\\\\.0+)?"), false);
  assert.match(sql, /between 1600 and 2200/);
  assert.match(sql, /::numeric::smallint/);
  assert.throws(
    () => safeCamaYearSql("s.facts_json; drop table x", "AYB"),
    /Unsafe/,
  );
});
