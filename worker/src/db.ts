import Client from "pg/lib/client.js";
import type { Env } from "./types";

const ALLOWED_FUNCTIONS = new Set([
  "resolve_property",
  "get_property_snapshot",
  "get_assessment_history",
  "get_tax_and_balance_history",
  "get_ownership_and_sale",
  "get_latest_sale_and_deed",
  "search_properties",
  "get_source_evidence",
  "describe_data",
]);

export async function callApi(
  env: Env,
  functionName: string,
  args: unknown[],
): Promise<Record<string, unknown>> {
  if (!ALLOWED_FUNCTIONS.has(functionName)) {
    throw new Error("Unapproved database function");
  }
  const placeholders = args.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `select api_v1.${functionName}(${placeholders}) as result`;
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    // Supabase Free/nano can have occasional cold-start latency even when the
    // indexed query itself is fast. Keep a firm ceiling without rejecting a
    // valid first request during connection warm-up.
    statement_timeout: 8000,
    query_timeout: 9500,
  });
  await client.connect();
  try {
    // Hyperdrive can reuse an existing PostgreSQL session whose role default
    // predates a timeout change, so set the ceiling explicitly per checkout.
    await client.query("set statement_timeout = '8s'");
    const result = await client.query<{ result: Record<string, unknown> }>(sql, args);
    return result.rows[0]?.result ?? { status: "service_unavailable" };
  } finally {
    await client.end();
  }
}
