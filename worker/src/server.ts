import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callApi } from "./db";
import type { Env } from "./types";

export const SERVICE_VERSION = "0.2.0";

// McpServer output validation requires an object schema. A Zod record is not
// normalized as an object by the SDK and fails successful tool calls.
const resultSchema = z.object({}).loose();
const propertyInput = {
  ssl: z.string().min(1).max(32).optional(),
  address: z.string().min(2).max(160).optional(),
};

function toolResult(result: Record<string, unknown>) {
  const text = JSON.stringify(result);
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
        "lien priority, building metrics, NOI, occupancy, zoning compliance, or a lending decision.",
    },
  );

  server.registerTool(
    "resolve_property",
    {
      description:
        "Use first for an SSL or address. Returns one resolved D.C. property-tax account or ranked ambiguity candidates; never returns collateral facts for an ambiguous match.",
      inputSchema: {
        ...propertyInput,
        include_deleted: z.boolean().default(false),
        limit: z.number().int().min(1).max(10).default(10),
      },
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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

  const propertyTools = [
    {
      name: "get_property_snapshot",
      description:
        "Use for a lender-oriented collateral quick look: identity, classification, owner of record, assessments, taxes/balances, special assessments, and latest reported transfer.",
      db: "get_property_snapshot",
    },
    {
      name: "get_assessment_history",
      description:
        "Use for available prior/current/proposed assessment periods. Reports coverage gaps and historical identity conflicts explicitly.",
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
        "Use for current owner/mailing data and the latest sale/deed carried by ITSPE. This is not a title report, lien search, or complete transfer history.",
      db: "get_ownership_and_sale",
    },
    {
      name: "get_latest_sale_and_deed",
      description:
        "Use whenever the user asks about a property's sale, purchase price, transfer, deed, sale type, sale acceptance classification, deed date, or instrument number. Returns the latest assessor-reported sale/deed record; it is not a complete sales history or title report.",
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
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ ssl, address }) =>
        toolResult(await callApi(env, tool.db, [ssl ?? null, address ?? null])),
    );
  }

  server.registerTool(
    "search_properties",
    {
      description:
        "Use for bounded property-account screening with allowlisted filters. No arbitrary SQL, owner-name search, mailing-address output, or bulk export.",
      inputSchema: {
        ward: z.string().max(8).optional(),
        property_type: z.string().max(80).optional(),
        use_code: z.string().max(16).optional(),
        min_assessment: z.number().nonnegative().optional(),
        max_assessment: z.number().nonnegative().optional(),
        cursor: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => toolResult(await callApi(env, "search_properties", [input])),
  );

  server.registerTool(
    "get_source_evidence",
    {
      description:
        "Turn fact source references into human-facing D.C. portal links, exact address/SSL/instrument lookup inputs, and short verification steps. Does not return ArcGIS REST, JSON, or session-bound URLs.",
      inputSchema: {
        source_refs: z.array(z.string().min(1).max(128)).min(1).max(50),
      },
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        "Use when a request is vague or may be unsupported. Deterministically explains terms, coverage, limitations, and the best tool to call; it does not invoke an LLM.",
      inputSchema: { question: z.string().max(500).optional() },
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ question }) =>
      toolResult(await callApi(env, "describe_data", [question ?? null])),
  );

  return server;
}
