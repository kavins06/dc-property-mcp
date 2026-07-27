import pg from "../loader/node_modules/pg/lib/index.js";

const client = new pg.Client({
  connectionString:
    `postgresql://mcp_runtime:${encodeURIComponent(process.env.DC_PROPERTY_RUNTIME_PASSWORD)}` +
    `@db.${process.env.SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 8000,
  application_name: "dc-property-runtime-verification",
});

const propertySsl = "5576    0001";
const saleSsl = "3562    0059";
const timings = {};

async function call(name, text, values) {
  const started = performance.now();
  const response = await client.query(text, values);
  timings[name] = Math.round((performance.now() - started) * 10) / 10;
  return response.rows[0]?.result;
}

await client.connect();
try {
  const resolve = await call(
    "resolve_property",
    "select api_v1.resolve_property($1, null, false, 10) result",
    [propertySsl],
  );
  const snapshot = await call(
    "get_property_snapshot",
    "select api_v1.get_property_snapshot($1, null) result",
    [propertySsl],
  );
  const assessments = await call(
    "get_assessment_history",
    "select api_v1.get_assessment_history($1, null) result",
    [propertySsl],
  );
  const taxes = await call(
    "get_tax_and_balance_history",
    "select api_v1.get_tax_and_balance_history($1, null) result",
    [propertySsl],
  );
  const ownership = await call(
    "get_ownership_and_sale",
    "select api_v1.get_ownership_and_sale($1, null) result",
    [propertySsl],
  );
  const sale = await call(
    "get_latest_sale_and_deed",
    "select api_v1.get_latest_sale_and_deed($1, null) result",
    [saleSsl],
  );
  const search = await call(
    "search_properties",
    "select api_v1.search_properties($1::jsonb) result",
    [JSON.stringify({ ward: "8", limit: 3 })],
  );
  const describe = await call(
    "describe_data",
    "select api_v1.describe_data($1) result",
    ["assessment history"],
  );

  const sourceRefs = [
    snapshot?.valuation?.current_total_value_dollars?.source_refs?.[0],
    sale?.latest_sale_and_deed?.instrument_number?.source_refs?.[0],
  ].filter((value) => typeof value === "string");
  const evidence = await call(
    "get_source_evidence",
    "select api_v1.get_source_evidence($1::text[]) result",
    [sourceRefs],
  );

  const serializedEvidence = JSON.stringify(evidence);
  const checks = {
    resolve_property: resolve?.status === "resolved",
    property_snapshot:
      snapshot?.status === "resolved" &&
      typeof snapshot?.valuation?.current_total_value_dollars?.value === "number",
    assessment_history:
      assessments?.status === "resolved" &&
      JSON.stringify(assessments).includes("source_refs"),
    tax_and_balance_history:
      taxes?.status === "resolved" &&
      JSON.stringify(taxes).includes("source_refs"),
    ownership_and_sale:
      ownership?.status === "resolved" &&
      JSON.stringify(ownership).includes("source_refs"),
    latest_sale_and_deed:
      sale?.status === "resolved" &&
      sale?.latest_sale_and_deed?.sale_price_dollars?.value === 745000 &&
      sale?.latest_sale_and_deed?.sale_date?.value === "2026-06-15" &&
      sale?.latest_sale_and_deed?.instrument_number?.value === "2026058413",
    search_properties:
      search?.status === "ok" &&
      Array.isArray(search?.results) &&
      search.results.length === 3,
    source_evidence:
      evidence?.status === "ok" &&
      evidence?.evidence?.length === 2 &&
      evidence.evidence.every((item) =>
        typeof item?.human_verification?.portal_url === "string"
      ) &&
      !serializedEvidence.includes("services.arcgis.com") &&
      !serializedEvidence.includes("/_/Retrieve/"),
    describe_data:
      describe &&
      JSON.stringify(describe).toLowerCase().includes("assessment"),
    latency_ceiling:
      Object.values(timings).every((duration) => duration <= 3000),
  };
  const passed = Object.values(checks).every(Boolean);

  process.stdout.write(
    `${JSON.stringify({
      passed,
      checks,
      timings_ms: timings,
      samples: {
        property_ssl: "5576--0001",
        sale_ssl: "3562--0059",
        sale_price_dollars:
          sale?.latest_sale_and_deed?.sale_price_dollars?.value,
        evidence_portals: evidence?.evidence?.map(
          (item) => item?.human_verification?.portal_url,
        ),
      },
    }, null, 2)}\n`,
  );
  if (!passed) process.exitCode = 1;
} finally {
  await client.end();
}
