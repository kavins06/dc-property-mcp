import assert from "node:assert/strict";
import test from "node:test";

import {
  REGULATORY_PURGE_VACUUM_TABLES,
} from "./purge-contract.mjs";

test("failed-batch purge vacuums every cascaded typed and context child", () => {
  for (const table of [
    "regulatory.building_permit",
    "regulatory.business_license",
    "regulatory.certificate_of_occupancy",
    "regulatory.inspection",
    "regulatory.enforcement_action",
    "property_context.energy_benchmark_property_link",
    "property_context.beps_property_link",
    "property_context.land_designation_property_link",
  ]) {
    assert.ok(REGULATORY_PURGE_VACUUM_TABLES.includes(table), table);
  }
  assert.equal(
    new Set(REGULATORY_PURGE_VACUUM_TABLES).size,
    REGULATORY_PURGE_VACUUM_TABLES.length,
  );
});
