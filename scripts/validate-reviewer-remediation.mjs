import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "../loader/node_modules/pg/lib/index.js";

const project = resolve(import.meta.dirname, "..");
const migrationPaths = [
  "db/migrations/0013_sale_history_and_semantics.sql",
  "db/migrations/0014_resolution_and_quality.sql",
  "db/migrations/0015_lender_api.sql",
  "db/migrations/0016_evidence_and_dictionary.sql",
  "db/migrations/0017_free_tier_headroom.sql",
  "db/migrations/0018_search_runtime_hardening.sql",
  "db/migrations/0019_screening_indexes.sql",
];

function readEnv(path) {
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function transactionBody(relativePath) {
  return readFileSync(resolve(project, relativePath), "utf8")
    .replace(/^\s*begin;\s*/i, "")
    .replace(/\s*(commit|rollback);\s*$/i, "");
}

const env = readEnv(resolve(project, ".env.hosted"));
const password =
  process.env.SUPABASE_DB_PASSWORD ?? env.SUPABASE_DB_PASSWORD;
const projectRef =
  process.env.SUPABASE_PROJECT_REF ?? env.SUPABASE_PROJECT_REF;
if (!password || !projectRef) {
  throw new Error("Supabase remediation-validation credentials are unavailable.");
}

const client = new pg.Client({
  connectionString:
    `postgresql://postgres:${encodeURIComponent(password)}` +
    `@db.${projectRef}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 0,
  application_name: "dc-property-reviewer-remediation-validator",
});

await client.connect();
try {
  await client.query("begin");
  for (const migrationPath of migrationPaths) {
    await client.query(transactionBody(migrationPath));
    await client.query("reset role");
    process.stdout.write(`Applied in rollback-only test: ${migrationPath}\n`);
  }

  await client.query(`
    insert into history.sale_series (
      account_id,
      source_objectids,
      sale_dates,
      sale_prices,
      qualified_codes,
      sale_codes,
      current_owner_flags
    )
    select
      account_id,
      array[1]::integer[],
      array[date '2015-01-14'],
      array[445000000]::bigint[],
      array['Q'],
      array['01'],
      array[1]::smallint[]
    from core.property_account_current
    where ssl_normalized = '01070075'
    on conflict (account_id) do nothing
  `);
  process.stdout.write(
    "Ensured a sale-history fixture exists in rollback-only test.\n",
  );

  await client.query(transactionBody("db/tests/reviewer_regressions.sql"));
  process.stdout.write("Reviewer regression SQL passed.\n");

  await client.query("set local role mcp_runtime");
  const probes = [
    {
      name: "exact_address",
      sql: "select api_v1.resolve_property(null, $1, false, 10) result",
      values: ["1100 15th St NW"],
    },
    {
      name: "unit_address",
      sql: "select api_v1.resolve_property(null, $1, false, 10) result",
      values: ["1010 Massachusetts Ave NW Unit 402"],
    },
    {
      name: "fuzzy_disclosure",
      sql: "select api_v1.resolve_property(null, $1, false, 10) result",
      values: ["1425 15th St NW"],
    },
    {
      name: "tax_compaction",
      sql: "select api_v1.get_tax_and_balance_history($1, null) result",
      values: ["01070075"],
    },
    {
      name: "lender_search",
      sql: "select api_v1.search_properties($1::jsonb) result",
      values: [JSON.stringify({
        property_type: "commercial-office (large)",
        tax_class: "2",
        sort_by: "assessment_desc",
        limit: 3,
      })],
    },
    {
      name: "routed_dictionary",
      sql: "select api_v1.describe_data($1) result",
      values: ["What property_type values can I use in search_properties?"],
    },
  ];
  const metrics = {};
  for (const probe of probes) {
    const started = performance.now();
    const response = await client.query(probe.sql, probe.values);
    const duration = Math.round((performance.now() - started) * 10) / 10;
    const result = response.rows[0].result;
    metrics[probe.name] = {
      duration_ms: duration,
      status: result.status,
      payload_bytes: Buffer.byteLength(JSON.stringify(result)),
    };
    if (duration > 3000) {
      throw new Error(`${probe.name} exceeded the 3-second validation ceiling.`);
    }
  }
  await client.query("reset role");
  process.stdout.write(`${JSON.stringify({ probes: metrics })}\n`);

  await client.query("rollback");
  process.stdout.write("Validation transaction rolled back.\n");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
