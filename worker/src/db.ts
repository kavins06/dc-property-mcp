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
  "search_properties",
  "get_source_evidence",
  "describe_data",
]);
const MAX_SOURCE_REFS = 50;
const SOURCE_DETAIL_KEYS = ["covers", "covered_fields", "source_refs"] as const;

export type SafeDatabaseError = {
  status: "error";
  error: {
    code: "query_timeout" | "database_unavailable" | "invalid_request";
    hint: string;
    retryable: boolean;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectSourceRefs(value: unknown): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (ref: string) => {
    if (ref.trim() && !seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  };
  const collectStrings = (node: unknown): void => {
    if (typeof node === "string") {
      add(node);
    } else if (Array.isArray(node)) {
      for (const item of node) collectStrings(item);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "source_refs" && Array.isArray(child)) {
        collectStrings(child);
      }
      visit(child);
    }
  };
  visit(value);
  return refs;
}

export function chunkSourceRefs(
  refs: readonly string[],
  size = MAX_SOURCE_REFS,
): string[][] {
  if (size < 1) throw new RangeError("Chunk size must be positive.");
  const chunks: string[][] = [];
  for (let index = 0; index < refs.length; index += size) {
    chunks.push(refs.slice(index, index + size));
  }
  return chunks;
}

function stableJsonIdentity(value: unknown): string {
  return (
    JSON.stringify(value, (_key, current) => {
      if (!isRecord(current)) return current;
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .map((key) => [key, current[key]]),
      );
    }) ?? "undefined"
  );
}

function sourceRouteIdentity(source: unknown): string {
  if (!isRecord(source)) return stableJsonIdentity(source);
  return stableJsonIdentity(
    Object.fromEntries(
      Object.entries(source).filter(
        ([key]) => !SOURCE_DETAIL_KEYS.includes(key as (typeof SOURCE_DETAIL_KEYS)[number]),
      ),
    ),
  );
}

function mergeSourceDetails(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of SOURCE_DETAIL_KEYS) {
    const incoming = source[key];
    if (!Array.isArray(incoming)) continue;
    const values: unknown[] = Array.isArray(target[key]) ? [...target[key]] : [];
    const seen = new Set(values.map(stableJsonIdentity));
    for (const value of incoming) {
      const identity = stableJsonIdentity(value);
      if (!seen.has(identity)) {
        seen.add(identity);
        values.push(value);
      }
    }
    target[key] = values;
  }
}

function provenanceUnavailable(): Record<string, unknown> {
  return {
    status: "error",
    error: {
      code: "provenance_unavailable",
      hint: "Source verification is temporarily unavailable. Retry shortly.",
      retryable: true,
    },
  };
}

export function mergeSourceEvidence(responses: readonly unknown[]): {
  provenance: unknown[];
  sources: unknown[];
} {
  const provenance: unknown[] = [];
  const sources: unknown[] = [];
  const evidenceRefs = new Set<string>();
  const sourceIdentities = new Set<string>();
  const sourceByIdentity = new Map<string, unknown>();

  for (const response of responses) {
    if (!isRecord(response)) continue;
    if (Array.isArray(response.evidence)) {
      for (const item of response.evidence) {
        const sourceRef = isRecord(item) ? item.source_ref : undefined;
        if (
          typeof sourceRef === "string" &&
          sourceRef.trim() &&
          !evidenceRefs.has(sourceRef)
        ) {
          evidenceRefs.add(sourceRef);
          provenance.push(item);
        }
      }
    }
    if (Array.isArray(response.sources)) {
      for (const source of response.sources) {
        const identity = sourceRouteIdentity(source);
        if (!sourceIdentities.has(identity)) {
          sourceIdentities.add(identity);
          if (isRecord(source)) {
            const copy = { ...source };
            for (const key of SOURCE_DETAIL_KEYS) {
              if (Array.isArray(copy[key])) copy[key] = [...copy[key]];
            }
            sourceByIdentity.set(identity, copy);
            sources.push(copy);
          } else {
            sources.push(source);
          }
        } else if (isRecord(source)) {
          const existing = sourceByIdentity.get(identity);
          if (isRecord(existing)) mergeSourceDetails(existing, source);
        }
      }
    }
  }

  return { provenance, sources };
}

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
    const payload = result.rows[0]?.result ?? {
      status: "service_unavailable",
    };
    if (
      functionName === "get_source_evidence" ||
      !isRecord(payload) ||
      ["error", "service_unavailable", "invalid_input"].includes(
        String(payload.status ?? ""),
      )
    ) {
      return payload;
    }

    const sourceRefs = collectSourceRefs(payload);
    if (!sourceRefs.length) return payload;

    const evidenceResponses: unknown[] = [];
    try {
      for (const chunk of chunkSourceRefs(sourceRefs)) {
        const evidenceResult = await client.query<{
          result: Record<string, unknown>;
        }>("select api_v1.get_source_evidence($1::text[]) as result", [chunk]);
        const evidence = evidenceResult.rows[0]?.result;
        if (
          !isRecord(evidence) ||
          evidence.status !== "ok" ||
          !Array.isArray(evidence.evidence) ||
          !Array.isArray(evidence.sources) ||
          !evidence.evidence.length ||
          !evidence.sources.length
        ) {
          return provenanceUnavailable();
        }
        evidenceResponses.push(evidence);
      }
    } catch {
      return provenanceUnavailable();
    }

    const merged = mergeSourceEvidence(evidenceResponses);
    if (!merged.provenance.length || !merged.sources.length) {
      return provenanceUnavailable();
    }
    return { ...payload, ...merged };
  } catch (error) {
    return sanitizeDatabaseError(error);
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}
