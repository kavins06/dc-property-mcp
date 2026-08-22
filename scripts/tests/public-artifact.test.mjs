import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("public README and registry metadata match the current MCP contract", async () => {
  const [readme, registryText, workerPackageText] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("server.json", root), "utf8"),
    readFile(new URL("worker/package.json", root), "utf8"),
  ]);
  const registry = JSON.parse(registryText);
  const workerPackage = JSON.parse(workerPackageText);

  const publicTools = [
    "resolve_property",
    "resolve_properties_batch",
    "search_properties",
    "get_complete_property_record",
    "get_property_snapshot",
    "get_assessment_history",
    "get_tax_and_balance_history",
    "get_ownership_and_sale",
    "get_latest_sale_and_deed",
    "get_permit_history",
    "get_license_history",
    "get_inspection_and_enforcement_history",
    "get_building_and_land_profile",
    "get_source_evidence",
    "describe_data",
    "list_national_jurisdictions",
    "list_national_subjurisdictions",
    "get_national_jurisdiction_availability",
    "resolve_national_property",
    "get_national_property",
    "get_national_building",
    "search_national_properties",
  ];

  assert.match(readme, /22 read-only tools/);
  assert.equal(publicTools.length, 22);
  for (const tool of publicTools) assert.match(readme, new RegExp(`\\b${tool}\\b`));
  assert.doesNotMatch(readme, /get_recorder_instrument_history/);
  assert.match(readme, /consumer-facing API access is by request/i);
  assert.match(readme, /OAuth/i);
  assert.equal(registry.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(registry.name, "io.github.kavins06/dc-property-records");
  assert.equal(registry.version, workerPackage.version);
  assert.deepEqual(registry.icons, [{
    src: "https://quoindata.com/assets/mcp-logo.png",
    mimeType: "image/png",
    sizes: ["1179x1179"],
  }]);
  assert.equal(registry.websiteUrl, "https://quoindata.com/mcp");
  assert.deepEqual(registry.remotes, [{
    type: "streamable-http",
    url: "https://mcp.quoindata.com/mcp",
  }]);
  assert.deepEqual(registry.repository, {
    url: "https://github.com/kavins06/dc-property-mcp",
    source: "github",
  });
  assert.ok(registry.description.length <= 100);
  assert.equal(registry.packages, undefined);
});
