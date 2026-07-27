import pg from "../loader/node_modules/pg/lib/index.js";

function connectionString(user, password) {
  return (
    `postgresql://${user}:${encodeURIComponent(password)}` +
    `@db.${process.env.SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`
  );
}

const admin = new pg.Client({
  connectionString: connectionString(
    "postgres",
    process.env.SUPABASE_DB_PASSWORD,
  ),
  ssl: { rejectUnauthorized: false },
});

await admin.connect();
try {
  const size = await admin.query(
    "select pg_database_size(current_database())::bigint as bytes",
  );
  const indexes = await admin.query(`
    select indexname
    from pg_indexes
    where schemaname = 'core'
      and tablename = 'property_account_current'
      and indexname in (
        'property_account_current_ssl_normalized_key',
        'property_account_address_trgm_idx',
        'property_account_screen_type_tax_idx',
        'property_account_screen_ward_tax_idx'
      )
    order by indexname
  `);
  if (Number(size.rows[0].bytes) > 480_000_000) {
    throw new Error("PostgreSQL 480 MB free-tier safety gate failed.");
  }
  if (indexes.rowCount < 4) {
    throw new Error("Required resolver indexes are missing.");
  }
  console.log(JSON.stringify({
    database_size_bytes: Number(size.rows[0].bytes),
    resolver_indexes: indexes.rows.map((row) => row.indexname),
  }));
} finally {
  await admin.end();
}

const runtime = new pg.Client({
  connectionString: connectionString(
    "mcp_runtime",
    process.env.DC_PROPERTY_RUNTIME_PASSWORD,
  ),
  ssl: { rejectUnauthorized: false },
  statement_timeout: 5_000,
});

const probes = [
  {
    name: "exact_common_address",
    sql: "select api_v1.resolve_property(null, $1, false, 10) as value",
    values: ["1100 15th St NW"],
    expectedStatus: "resolved",
    maxMs: 2_000,
  },
  {
    name: "full_postal_address",
    sql: "select api_v1.resolve_property(null, $1, false, 10) as value",
    values: ["1000 16TH ST NW WASHINGTON DC 20036"],
    allowedStatuses: ["resolved", "ambiguous", "no_exact_match", "not_found"],
    maxMs: 2_000,
  },
  {
    name: "unit_exact",
    sql: "select api_v1.resolve_property(null, $1, false, 10) as value",
    values: ["1010 Massachusetts Ave NW Unit 402"],
    expectedStatus: "resolved",
    expectedUnit: "402",
    maxMs: 2_000,
  },
  {
    name: "fuzzy_only",
    sql: "select api_v1.resolve_property(null, $1, false, 10) as value",
    values: ["1425 15th St NW"],
    expectedStatus: "no_exact_match",
    maxMs: 2_000,
  },
  {
    name: "named_asset_batch",
    sql: "select api_v1.resolve_properties_batch($1::jsonb) as value",
    values: [JSON.stringify([
      { client_id: "asset-1", ssl: "01070075" },
      { client_id: "asset-2", address: "555 12th St NW" },
    ])],
    expectedStatus: "ok",
    expectedCount: 2,
    maxMs: 3_000,
  },
  {
    name: "lender_screen",
    sql: "select api_v1.search_properties($1::jsonb) as value",
    values: [JSON.stringify({
      ward: "2",
      tax_class: "2",
      sort_by: "assessment_desc",
      limit: 3,
    })],
    expectedStatus: "ok",
    expectedCount: 3,
    maxMs: 3_000,
  },
];

await runtime.connect();
try {
  for (const probe of probes) {
    const started = performance.now();
    const result = await runtime.query(probe.sql, probe.values);
    const elapsedMs = Number((performance.now() - started).toFixed(1));
    const value = result.rows[0].value;
    const allowed = probe.allowedStatuses ?? [probe.expectedStatus];
    if (!allowed.includes(value.status)) {
      throw new Error(
        `${probe.name}: expected ${allowed.join("/")} but received ${value.status}`,
      );
    }
    if (probe.expectedUnit && value.candidates?.[0]?.unit !== probe.expectedUnit) {
      throw new Error(`${probe.name}: wrong unit candidate`);
    }
    const count = value.results?.length;
    if (probe.expectedCount !== undefined && count !== probe.expectedCount) {
      throw new Error(
        `${probe.name}: expected ${probe.expectedCount} results but received ${count}`,
      );
    }
    if (elapsedMs > probe.maxMs) {
      throw new Error(
        `${probe.name}: ${elapsedMs} ms exceeded ${probe.maxMs} ms gate`,
      );
    }
    console.log(JSON.stringify({
      probe: probe.name,
      status: value.status,
      result_count: count ?? value.candidates?.length ?? null,
      elapsed_ms: elapsedMs,
      max_ms: probe.maxMs,
    }));
  }
} finally {
  await runtime.end();
}
