import Client from "pg/lib/client.js";
import type { Env } from "./types";

const ALLOWED_FUNCTIONS = new Set([
  "resolve_property",
  "resolve_properties_batch",
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
  "get_recorder_instrument_history",
  "search_properties",
  "get_source_evidence",
  "describe_data",
]);

export type SafeDatabaseError = {
  status: "error";
  error: {
    code: "query_timeout" | "database_unavailable" | "invalid_request";
    hint: string;
    retryable: boolean;
  };
};

export function sanitizeDatabaseError(error: unknown): SafeDatabaseError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "57014") {
    return {
      status: "error",
      error: {
        code: "query_timeout",
        hint: "Try the SSL, or shorten the address to street number, street name, and quadrant.",
        retryable: true,
      },
    };
  }
  if (code.startsWith("22")) {
    return {
      status: "error",
      error: {
        code: "invalid_request",
        hint: "Check the supplied values against describe_data, then retry.",
        retryable: false,
      },
    };
  }
  return {
    status: "error",
    error: {
      code: "database_unavailable",
      hint: "The property service is temporarily unavailable. Retry shortly.",
      retryable: true,
    },
  };
}

export async function callApi(
  env: Env,
  functionName: string,
  args: unknown[],
): Promise<Record<string, unknown>> {
  if (!ALLOWED_FUNCTIONS.has(functionName)) {
    return {
      status: "error",
      error: {
        code: "invalid_request",
        hint: "The requested operation is not available.",
        retryable: false,
      },
    };
  }
  const placeholders = args.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `select api_v1.${functionName}(${placeholders}) as result`;
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    // The database tunnel and Hyperdrive can have occasional cold-start
    // latency even when the indexed query itself is fast. Keep a firm ceiling
    // without rejecting a valid first request during connection warm-up.
    statement_timeout: 8000,
    query_timeout: 9500,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    // Hyperdrive can reuse an existing PostgreSQL session whose role default
    // predates a timeout change, so set the ceiling explicitly per checkout.
    await client.query("set statement_timeout = '8s'");
    const result = await client.query<{ result: Record<string, unknown> }>(
      sql,
      args,
    );
    return result.rows[0]?.result ?? { status: "service_unavailable" };
  } catch (error) {
    return sanitizeDatabaseError(error);
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}
