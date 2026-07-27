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
const trophySsl = "0107    0075";
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
  const resolveExactAddress = await call(
    "resolve_exact_address",
    "select api_v1.resolve_property(null, $1, false, 10) result",
    ["1100 15th St NW"],
  );
  const resolveFullPostal = await call(
    "resolve_full_postal",
    "select api_v1.resolve_property(null, $1, false, 10) result",
    ["1000 16TH ST NW WASHINGTON DC 20036"],
  );
  const batch = await call(
    "resolve_properties_batch",
    "select api_v1.resolve_properties_batch($1::jsonb) result",
    [JSON.stringify([
      { client_id: "asset-1", ssl: trophySsl },
      { client_id: "asset-2", address: "555 12th St NW" },
    ])],
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
  const trophyOwnership = await call(
    "quality_flags",
    "select api_v1.get_ownership_and_sale($1, null) result",
    [trophySsl],
  );
  const sale = await call(
    "get_latest_sale_and_deed",
    "select api_v1.get_latest_sale_and_deed($1, null) result",
    [saleSsl],
  );
  const search = await call(
    "search_properties",
    "select api_v1.search_properties($1::jsonb) result",
    [JSON.stringify({
      property_type: "commercial-office (large)",
      tax_class: "2",
      sort_by: "assessment_desc",
      limit: 3,
    })],
  );
  const describe = await call(
    "describe_data",
    "select api_v1.describe_data($1) result",
    ["What property_type values can I use in search_properties?"],
  );

  const sourceRefs = [
    snapshot?.valuation?.current_total_value_dollars?.source_refs?.[0],
    sale?.latest_assessor_deed?.instrument_number?.source_refs?.[0],
    sale?.sale_history?.[0]?.sale_price_dollars?.source_refs?.[0],
  ].filter((value) => typeof value === "string");
  const evidence = await call(
    "get_source_evidence",
    "select api_v1.get_source_evidence($1::text[]) result",
    [sourceRefs],
  );
  const invalidEvidence = await call(
    "invalid_source_evidence",
    "select api_v1.get_source_evidence($1::text[]) result",
    [["nonsense|nonsense|x|y"]],
  );
  const trophySale = await call(
    "trophy_sale",
    "select api_v1.get_latest_sale_and_deed($1, null) result",
    [trophySsl],
  );
  const trophyInstrumentRef =
    trophySale?.latest_assessor_deed?.instrument_number?.source_refs?.[0];
  const trophyEvidence = await call(
    "bare_instrument_evidence",
    "select api_v1.get_source_evidence($1::text[]) result",
    [[trophyInstrumentRef]],
  );

  const serializedEvidence = JSON.stringify(evidence);
  const serializedTax = JSON.stringify(taxes);
  const checks = {
    resolve_property: resolve?.status === "resolved",
    exact_address_resolution:
      resolveExactAddress?.status === "resolved" &&
      resolveExactAddress?.candidates?.[0]?.similarity_score === 1,
    full_postal_normalization:
      ["resolved", "ambiguous", "no_exact_match", "not_found"].includes(
        resolveFullPostal?.status,
      ) &&
      resolveFullPostal?.input_normalized?.address === "1000 16TH ST NW",
    batch_resolution:
      batch?.status === "ok" &&
      batch?.results?.length === 2,
    property_snapshot:
      snapshot?.status === "resolved" &&
      typeof snapshot?.valuation?.current_total_value_dollars?.value === "number" &&
      snapshot?.ownership?.owner_occupancy_flag === undefined,
    assessment_history:
      assessments?.status === "resolved" &&
      JSON.stringify(assessments).includes("source_refs"),
    tax_and_balance_history:
      taxes?.status === "resolved" &&
      taxes?.current_summary?.total_due_cents === undefined &&
      typeof taxes?.current_summary?.total_liabilities_reported_cents?.value ===
        "number" &&
      taxes?.slot_provenance?.example?.includes("tax.slot.penalty.PY4") &&
      serializedTax.length < 30000,
    ownership_and_sale:
      ownership?.status === "resolved" &&
      JSON.stringify(ownership).includes("source_refs") &&
      ownership?.latest_reported_transfer === undefined,
    quality_flags:
      trophyOwnership?.status === "resolved" &&
      trophyOwnership?.quality_flags?.includes(
        "mailing_jurisdiction_conflict",
      ) &&
      JSON.stringify(trophyOwnership).includes("NORTH KOREA"),
    latest_sale_and_deed:
      sale?.status === "resolved" &&
      sale?.sale_history?.[0]?.sale_price_dollars?.value === 745000 &&
      sale?.sale_history?.[0]?.sale_date?.value === "2026-06-15" &&
      sale?.latest_assessor_deed?.instrument_number?.value === "2026058413",
    search_properties:
      search?.status === "ok" &&
      Array.isArray(search?.results) &&
      search.results.length === 3 &&
      search?.total_count >= 3 &&
      typeof search?.has_more === "boolean" &&
      search.results.every((item) => item.tax_class === "2") &&
      search.results[0].current_total_value_dollars >=
        search.results[1].current_total_value_dollars,
    source_evidence:
      evidence?.status === "ok" &&
      evidence?.evidence?.length === 3 &&
      evidence.evidence.every((item) =>
        typeof item?.human_verification?.portal_url === "string"
      ) &&
      !serializedEvidence.includes("services.arcgis.com") &&
      !serializedEvidence.includes("/_/Retrieve/"),
    invalid_source_evidence:
      invalidEvidence?.status === "invalid_input" &&
      invalidEvidence?.error?.code === "malformed_source_ref",
    bare_instrument_safety:
      trophyEvidence?.status === "ok" &&
      trophyEvidence?.evidence?.[0]?.human_verification?.search_inputs
        ?.instrument_number === undefined &&
      trophyEvidence?.evidence?.[0]?.human_verification
        ?.instrument_search_note?.includes("not year-prefixed"),
    describe_data:
      describe?.status === "ok" &&
      describe?.best_next_tool === "search_properties" &&
      describe?.filter_vocabulary?.property_types?.length > 1 &&
      JSON.stringify(describe).length < 20000,
    latency_ceiling:
      Object.values(timings).every((duration) => duration <= 4000),
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
          sale?.sale_history?.[0]?.sale_price_dollars?.value,
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
