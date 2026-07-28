import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callApi } from "./db";
import type { Env } from "./types";

export const SERVICE_VERSION = "0.4.1";
export const MAX_TOOL_RESPONSE_BYTES = 768 * 1024;

// McpServer output validation requires an object schema. A Zod record is not
// normalized as an object by the SDK and fails successful tool calls.
const resultSchema = z.object({}).loose();
const propertyInput = {
  ssl: z.string().trim().min(1).max(32).optional(),
  address: z.string().trim().min(2).max(160).optional(),
};
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function toolResult(result: Record<string, unknown>) {
  const text = JSON.stringify(result);
  if (new TextEncoder().encode(text).byteLength > MAX_TOOL_RESPONSE_BYTES) {
    const compactError = {
      status: "error",
      error: {
        code: "response_too_large",
        hint:
          "Request a smaller page with limit, then continue with the returned cursor.",
        retryable: false,
      },
      limits: {
        max_response_bytes: MAX_TOOL_RESPONSE_BYTES,
      },
    };
    const compactText = JSON.stringify(compactError);
    return {
      content: [{ type: "text" as const, text: compactText }],
      structuredContent: compactError,
    };
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: result,
  };
}

export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "dc-property-records", version: SERVICE_VERSION },
    {
      instructions:
        "Read-only public D.C. property-account facts for commercial-real-estate lending. " +
        "Resolve identity before using facts; preserve fact-level dates, source references, " +
        "null meanings, proposed/current distinctions, and limitations. Never infer title, " +
        "lien priority, building metrics, NOI, occupancy, zoning compliance, or a lending decision. " +
        "Use resolve_properties_batch only for a caller-supplied list of named assets. " +
        "When a user asks for all, everything, complete, full, or the entire available record " +
        "for one property, call get_complete_property_record instead of stopping after one " +
        "domain tool. If its coverage.complete value is false, follow every returned continuation " +
        "until each section reports has_more false.",
    },
  );

  server.registerTool(
    "resolve_property",
    {
      description:
        "Use first for one SSL or address. Exact matches win; otherwise returns explicitly labeled, scored fuzzy suggestions. Never returns collateral facts for an unresolved identity.",
      inputSchema: {
        ...propertyInput,
        include_deleted: z.boolean().default(false),
        limit: z.number().int().min(1).max(10).default(10),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ ssl, address, include_deleted, limit }) =>
      toolResult(
        await callApi(env, "resolve_property", [
          ssl ?? null,
          address ?? null,
          include_deleted,
          limit,
        ]),
      ),
  );

  server.registerTool(
    "get_complete_property_record",
    {
      description:
        "Use whenever the user asks for all data, everything available, a complete record, a full property report, or the entire record for one property. Resolves identity and returns all nine property-data sections: snapshot, assessments, tax/balance history, ownership, sales/deed history, permits, licenses, inspections/enforcement, and building/land context. Check coverage.complete; follow every named continuation when false. Do not substitute a single domain tool for a complete-record request.",
      inputSchema: propertyInput,
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ ssl, address }) =>
      toolResult(
        await callApi(env, "get_complete_property_record", [
          ssl ?? null,
          address ?? null,
        ]),
      ),
  );

  server.registerTool(
    "resolve_properties_batch",
    {
      description:
        "Resolve 1–50 caller-supplied named assets for a portfolio tape. Returns one result per client_id in input order; this is bounded lookup, not bulk export.",
      inputSchema: {
        items: z.array(
          z.object({
            client_id: z.string().trim().min(1).max(100),
            ssl: z.string().trim().min(1).max(32).optional(),
            address: z.string().trim().min(2).max(160).optional(),
          }).refine((item) => Boolean(item.ssl || item.address), {
            message: "Each named asset requires an SSL or address.",
          }),
        ).min(1).max(50),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ items }) =>
      toolResult(
        await callApi(env, "resolve_properties_batch", [
          JSON.stringify(items),
        ]),
      ),
  );

  const propertyTools = [
    {
      name: "get_property_snapshot",
      description:
        "Use for a lender-oriented collateral quick look: identity, decoded classification, owner of record, assessments, taxes/balances, special assessments, quality flags, and a slim latest-transfer summary.",
      db: "get_property_snapshot",
    },
    {
      name: "get_assessment_history",
      description:
        "Use for the current official assessment sequence: tax year 2025 prior, tax year 2026 current, and tax year 2027 proposed. These stages are distinct, and assessed value is not an appraisal or lending value.",
      db: "get_assessment_history",
    },
    {
      name: "get_tax_and_balance_history",
      description:
        "Use for annual tax, raw tax-account slots, amounts due/collected, balances, penalties, interest, fees, credits, and tax-sale flags. Does not infer unsupported annual aggregation.",
      db: "get_tax_and_balance_history",
    },
    {
      name: "get_ownership_and_sale",
      description:
        "Use for current owner and mailing data with source-preserving quality flags. Sale history is intentionally returned by get_latest_sale_and_deed to avoid duplicate payloads.",
      db: "get_ownership_and_sale",
    },
    {
      name: "get_latest_sale_and_deed",
      description:
        "Use for official CAMA sale history plus the latest assessor-reported deed fields. It is not a Recorder chain of title, lien search, or title report.",
      db: "get_latest_sale_and_deed",
    },
  ] as const;

  for (const tool of propertyTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: propertyInput,
        outputSchema: resultSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ ssl, address }) =>
        toolResult(await callApi(env, tool.db, [ssl ?? null, address ?? null])),
    );
  }

  const regulatoryInput = {
    ...propertyInput,
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  };
  const regulatoryTools = [
    {
      name: "get_permit_history",
      description:
        "Use for official building permit history, certificate of occupancy records, and DDOT public-space permit records associated with a resolved property. Record types and property-link scope stay explicit.",
      db: "get_permit_history",
    },
    {
      name: "get_license_history",
      description:
        "Use for official business and occupational licenses associated with the reported premise. A premise match is context only; it is not proof of ownership or title.",
      db: "get_license_history",
    },
    {
      name: "get_inspection_and_enforcement_history",
      description:
        "Use for official inspection history and enforcement or violation context associated with a resolved property. Agency, record type, and property-link scope stay explicit.",
      db: "get_inspection_and_enforcement_history",
    },
    {
      name: "get_building_and_land_profile",
      description:
        "Use for official CAMA building characteristics, energy benchmarking, BEPS status, and vacant or blighted property context. Shared-building and proximity records are not exact parcel facts.",
      db: "get_building_and_land_profile",
    },
  ] as const;

  for (const tool of regulatoryTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: regulatoryInput,
        outputSchema: resultSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ ssl, address, cursor, limit }) =>
        toolResult(
          await callApi(env, tool.db, [
            ssl ?? null,
            address ?? null,
            JSON.stringify({
              limit,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          ]),
        ),
    );
  }

  server.registerTool(
    "search_properties",
    {
      description:
        "Use for bounded lender screening with allowlisted valuation, classification, sale-date, delinquency, balance, and tax-sale filters plus deterministic sorting. No arbitrary SQL, owner-name search, mailing-address output, or bulk export.",
      inputSchema: {
        ward: z.string().max(8).optional(),
        property_type: z.string().max(80).optional(),
        use_code: z.string().max(16).optional(),
        tax_class: z.string().max(8).optional(),
        min_assessment: z.number().int().nonnegative().optional(),
        max_assessment: z.number().int().nonnegative().optional(),
        has_balance: z.boolean().optional(),
        min_balance_cents: z.number().int().nonnegative().optional(),
        has_tax_sale_flag: z.boolean().optional(),
        sale_date_from: z.iso.date().optional(),
        sale_date_to: z.iso.date().optional(),
        sort_by: z.enum([
          "assessment_desc",
          "balance_desc",
          "sale_date_desc",
          "address_asc",
          "account_id_asc",
        ]).default("account_id_asc"),
        cursor: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      toolResult(
        await callApi(env, "search_properties", [JSON.stringify(input)]),
      ),
  );

  server.registerTool(
    "get_source_evidence",
    {
      description:
        "Validate fact source references, then return human-facing D.C. portal links, exact address/SSL/safe instrument lookup inputs, and short verification steps in caller order. Does not return ArcGIS REST, JSON, or session-bound URLs.",
      inputSchema: {
        source_refs: z.array(z.string().min(1).max(192)).min(1).max(50),
      },
      outputSchema: resultSchema,
      annotations: {
        ...READ_ONLY_ANNOTATIONS,
        openWorldHint: true,
      },
    },
    async ({ source_refs }) =>
      toolResult(await callApi(env, "get_source_evidence", [source_refs])),
  );

  server.registerTool(
    "describe_data",
    {
      description:
        "Ask a data, coverage, code, or filter question. Returns a compact keyword-routed answer, discoverable filter vocabulary, limitations, and the best next tool; it does not invoke an LLM.",
      inputSchema: { question: z.string().max(500).optional() },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ question }) =>
      toolResult(await callApi(env, "describe_data", [question ?? null])),
  );

  return server;
}
