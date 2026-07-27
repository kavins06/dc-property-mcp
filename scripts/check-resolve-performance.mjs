import pg from "../loader/node_modules/pg/lib/index.js";

const client = new pg.Client({
  connectionString:
    `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}` +
    `@db.${process.env.SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const size = await client.query(
    "select pg_database_size(current_database())::bigint as bytes",
  );
  console.log("database-size", size.rows[0].bytes);
  for (const query of [
    {
      name: "exact",
      text: `
        select count(*)
        from core.property_account_current
        where not is_deleted and address_normalized = $1
      `,
    },
    {
      name: "trigram",
      text: `
        select count(*)
        from core.property_account_current
        where not is_deleted
          and address_normalized operator(extensions.%) $1
      `,
    },
    {
      name: "trigram-and-number",
      text: `
        select count(*)
        from core.property_account_current
        where not is_deleted
          and address_normalized operator(extensions.%) $1
          and split_part(address_normalized, ' ', 1) = split_part($1, ' ', 1)
      `,
    },
  ]) {
    const started = Date.now();
    const result = await client.query(query.text, [
      "1600 PENNSYLVANIA AVENUE NW",
    ]);
    console.log(query.name, result.rows[0].count, `${Date.now() - started}ms`);
  }
} finally {
  await client.end();
}

const runtimeClient = new pg.Client({
  connectionString:
    `postgresql://mcp_runtime:${encodeURIComponent(process.env.DC_PROPERTY_RUNTIME_PASSWORD)}` +
    `@db.${process.env.SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
});

await runtimeClient.connect();
try {
  const started = Date.now();
  const result = await runtimeClient.query(
    "select api_v1.resolve_property(null, $1, false, 5) as value",
    ["1600 Pennsylvania Avenue NW"],
  );
  console.log(
    "runtime-function",
    result.rows[0].value.status,
    `${Date.now() - started}ms`,
  );
  const searchStarted = Date.now();
  const searchResult = await runtimeClient.query(
    "select api_v1.search_properties($1::jsonb) as value",
    [JSON.stringify({ ward: "8", limit: 3 })],
  );
  console.log(
    "runtime-search",
    searchResult.rows[0].value.results.length,
    `${Date.now() - searchStarted}ms`,
  );
} finally {
  await runtimeClient.end();
}
