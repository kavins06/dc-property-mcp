import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callApi } from "./db";
import type { Env } from "./types";

export const SERVICE_VERSION = "0.4.11";
export const MAX_TOOL_RESPONSE_BYTES = 768 * 1024;

// McpServer output validation requires an object schema. A Zod record is not
// normalized as an object by the SDK and fails successful tool calls.
const resultSchema = z.object({}).loose();
const propertyInput = {
  ssl: z.string().trim().min(1).max(32).optional(),
  address: z.string().trim().min(2).max(160).optional(),
};
const nationalPropertyKinds = [
  "tax_account",
  "parcel",
  "building",
  "unit",
  "land_interest",
  "address",
] as const;
const nationalIdentityInput = {
  state_code: z.enum(["DC", "MD", "VA"]),
  fips_code: z.string().regex(/^\d{5}$/, "FIPS must be exactly five digits."),
  property_kind: z.enum(nationalPropertyKinds),
  // Trim transport whitespace, then preserve the identifier value exactly.
  native_id: z.string().trim().min(1).max(256).optional(),
  address: z.string().trim().min(2).max(160).optional(),
};
const nationalBuildingInput = {
  state_code: z.enum(["DC", "MD", "VA"]),
  fips_code: z.string().regex(/^\d{5}$/, "FIPS must be exactly five digits."),
  source_record_key: z.string().trim().min(1).max(512).optional(),
  native_account_id: z.string().trim().min(1).max(256).optional(),
  camalink: z.string().trim().min(1).max(256).optional(),
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

function nationalConfigurationError(): Record<string, unknown> {
  return {
    status: "error",
    error: {
      code: "national_contract_not_configured",
      hint: "The national publication contract is not configured. Retry shortly.",
      retryable: true,
    },
  };
}

function nationalIdentityError(): Record<string, unknown> {
  return {
    status: "invalid_request",
    error_code: "native_id_or_address_required",
    hint: "Provide a native_id or address after selecting the jurisdiction and property kind.",
  };
}

async function callNationalApi(
  env: Env,
  functionName:
    | "resolve_national_property"
    | "get_national_property"
    | "get_national_building"
    | "search_national_properties",
  args: unknown[],
): Promise<Record<string, unknown>> {
  const contractVersion = env.NATIONAL_CONTRACT_VERSION?.trim();
  if (!contractVersion) return nationalConfigurationError();
  return callApi(env, functionName, [contractVersion, ...args]);
}

export function createServer(env: Env): McpServer {
  const nationalSurfaceEnabled = env.NATIONAL_SURFACE_ENABLED === "true";
  const server = new McpServer(
    {
      name: "dc-property-records",
      title: nationalSurfaceEnabled
        ? "Quoin Data — D.C. Property Records & National Availability"
        : "Quoin Data — D.C. Property Records",
      version: SERVICE_VERSION,
      description: nationalSurfaceEnabled
        ? "Source-linked D.C. property-account records plus explicit national jurisdiction availability. Unpublished jurisdictions never fall back to partial data."
        : "Source-linked Washington, D.C. property-account records.",
      websiteUrl: "https://quoindata.com/mcp",
      icons: [
        {
          src: "https://quoindata.com/assets/mcp-logo.png",
          mimeType: "image/png",
          sizes: ["1179x1179"],
        },
      ],
    },
    {
      instructions:
        (nationalSurfaceEnabled
          ? "Read-only public property-account routing and facts for commercial-real-estate lending. Use the legacy D.C. tools for published D.C. records. National tools return explicit unavailable results until a state generation is published. "
          : "Read-only public D.C. property-account facts for commercial-real-estate lending. ") +
        "Resolve identity before using facts; preserve fact-level dates, source references, " +
        "null meanings, proposed/current distinctions, and limitations. Never infer title, " +
        "lien priority, building metrics, NOI, occupancy, zoning compliance, or a lending decision. " +
        "When displaying sourced facts, show a visible Source or Verify action using sources; " +
        "show sources, not machine-facing provenance, to end users. " +
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
      title: "Resolve Property",
      description:
        "Use first for one SSL or address. Exact address matches include all official MAR parcel accounts, paginated with parcel_offset and parcel_limit. Exact matches win; otherwise returns explicitly labeled, scored fuzzy suggestions. Never returns collateral facts for an unresolved identity.",
      inputSchema: {
        ...propertyInput,
        include_deleted: z.boolean().default(false),
        limit: z.number().int().min(1).max(10).default(10),
        parcel_offset: z.number().int().min(0).default(0),
        parcel_limit: z.number().int().min(1).max(100).default(25),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ ssl, address, include_deleted, limit, parcel_offset, parcel_limit }) =>
      toolResult(
        await callApi(env, "resolve_property", [
          ssl ?? null,
          address ?? null,
          include_deleted,
          limit,
          parcel_offset,
          parcel_limit,
        ]),
      ),
  );

  server.registerTool(
    "get_complete_property_record",
    {
      title: "Get Complete Property Record",
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
      title: "Resolve Properties Batch",
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
      title: "Get Property Snapshot",
      description:
        "Use for a lender-oriented collateral quick look: identity, decoded classification, owner of record, assessments, taxes/balances, special assessments, quality flags, and a slim latest-transfer summary.",
      db: "get_property_snapshot",
    },
    {
      name: "get_assessment_history",
      title: "Get Assessment History",
      description:
        "Use for the current official assessment sequence: tax year 2025 prior, tax year 2026 current, and tax year 2027 proposed. These stages are distinct, and assessed value is not an appraisal or lending value.",
      db: "get_assessment_history",
    },
    {
      name: "get_tax_and_balance_history",
      title: "Get Tax and Balance History",
      description:
        "Use for annual tax, raw tax-account slots, amounts due/collected, balances, penalties, interest, fees, credits, and tax-sale flags. Does not infer unsupported annual aggregation.",
      db: "get_tax_and_balance_history",
    },
    {
      name: "get_ownership_and_sale",
      title: "Get Ownership and Sale",
      description:
        "Use for current owner and mailing data with source-preserving quality flags. Sale history is intentionally returned by get_latest_sale_and_deed to avoid duplicate payloads.",
      db: "get_ownership_and_sale",
    },
    {
      name: "get_latest_sale_and_deed",
      title: "Get Latest Sale and Deed",
      description:
        "Use for official CAMA sale history plus the latest assessor-reported deed fields. It is not a Recorder chain of title, lien search, or title report.",
      db: "get_latest_sale_and_deed",
    },
  ] as const;

  for (const tool of propertyTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
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
      title: "Get Permit History",
      description:
        "Use for official building permit history, certificate of occupancy records, and DDOT public-space permit records associated with a resolved property. Record types and property-link scope stay explicit.",
      db: "get_permit_history",
    },
    {
      name: "get_license_history",
      title: "Get License History",
      description:
        "Use for official business and occupational licenses associated with the reported premise. A premise match is context only; it is not proof of ownership or title.",
      db: "get_license_history",
    },
    {
      name: "get_inspection_and_enforcement_history",
      title: "Get Inspection and Enforcement History",
      description:
        "Use for official inspection history and enforcement or violation context associated with a resolved property. Agency, record type, and property-link scope stay explicit.",
      db: "get_inspection_and_enforcement_history",
    },
    {
      name: "get_building_and_land_profile",
      title: "Get Building and Land Profile",
      description:
        "Use for official CAMA building characteristics, energy benchmarking, BEPS status, and vacant or blighted property context. Shared-building and proximity records are not exact parcel facts.",
      db: "get_building_and_land_profile",
    },
  ] as const;

  for (const tool of regulatoryTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
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
      title: "Search Properties",
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

  if (nationalSurfaceEnabled) {
  server.registerTool(
    "list_national_jurisdictions",
    {
      title: "List National Jurisdictions",
      description:
        "List U.S. state, district, and territory routing areas with explicit publication availability. Omit state_code for the national list; this never implies that unpublished property records are available.",
      inputSchema: {
        state_code: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ state_code }) =>
      toolResult(
        await callApi(env, "list_national_jurisdictions", [
          state_code?.toUpperCase() ?? null,
        ]),
      ),
  );

  server.registerTool(
    "list_national_subjurisdictions",
    {
      title: "List D.C., Maryland, or Virginia Jurisdictions",
      description:
        "List the official Census county or county-equivalent jurisdictions for D.C., Maryland, or Virginia, including stable area IDs, five-digit FIPS codes, and honest publication availability.",
      inputSchema: { state_code: z.enum(["DC", "MD", "VA"]) },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ state_code }) =>
      toolResult(await callApi(env, "list_national_subjurisdictions", [state_code])),
  );

  server.registerTool(
    "get_national_jurisdiction_availability",
    {
      title: "Get National Jurisdiction Availability",
      description:
        "Check whether one state or stable area ID has a published property generation. Unpublished jurisdictions return unavailable with a reason and never fall back to partial data.",
      inputSchema: {
        state_code: z.string().trim().regex(/^[A-Za-z]{2}$/),
        area_uid: z.string().trim().regex(/^area_[a-z0-9_]+$/).optional(),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ state_code, area_uid }) =>
      toolResult(
        await callApi(env, "get_national_jurisdiction_availability", [
          state_code.toUpperCase(),
          area_uid ?? null,
        ]),
      ),
  );

  server.registerTool(
    "resolve_national_property",
    {
      title: "Resolve National Property",
      description:
        "Resolve one property identity within a state and five-digit Census jurisdiction when that jurisdiction has a published generation. D.C. compatibility remains on resolve_property; unpublished jurisdictions return unavailable. Native identifiers are matched verbatim.",
      inputSchema: nationalIdentityInput,
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ state_code, fips_code, property_kind, native_id, address }) => {
      if (!native_id && !address) return toolResult(nationalIdentityError());
      return toolResult(
        await callNationalApi(env, "resolve_national_property", [
          state_code,
          fips_code,
          property_kind,
          native_id ?? null,
          address ?? null,
        ]),
      );
    },
  );

  server.registerTool(
    "get_national_property",
    {
      title: "Get National Property",
      description:
        "Return the generation-pinned record for one resolved national property when its jurisdiction is published. D.C. compatibility remains on get_complete_property_record and its domain tools; unpublished jurisdictions return unavailable and never substitute another property kind.",
      inputSchema: nationalIdentityInput,
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ state_code, fips_code, property_kind, native_id, address }) => {
      if (!native_id && !address) return toolResult(nationalIdentityError());
      return toolResult(
        await callNationalApi(env, "get_national_property", [
          state_code,
          fips_code,
          property_kind,
          native_id ?? null,
          address ?? null,
        ]),
      );
    },
  );

  server.registerTool(
    "get_national_building",
    {
      title: "Get National Building",
      description:
        "Return one generation-pinned CAMA building observation when its jurisdiction is published, using a bounded source record key, exact native account ID, or exact CAMALINK. Unpublished jurisdictions return unavailable.",
      inputSchema: nationalBuildingInput,
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ state_code, fips_code, source_record_key, native_account_id, camalink }) => {
      if (!source_record_key && !native_account_id && !camalink) return toolResult({ status: "invalid_request", error_code: "building_lookup_key_required", property_kind: "building" });
      return toolResult(
        await callNationalApi(env, "get_national_building", [
          state_code,
          fips_code,
          source_record_key ?? null,
          native_account_id ?? null,
          camalink ?? null,
        ]),
      );
    },
  );

  server.registerTool(
    "search_national_properties",
    {
      title: "Search National Properties",
      description:
        "Run a bounded exact search within one published Census jurisdiction and property kind. D.C. compatibility remains on search_properties; unpublished jurisdictions return unavailable. Results are generation-pinned and paginate only with an integrity-bound cursor.",
      inputSchema: {
        ...nationalIdentityInput,
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().trim().min(1).max(2048).optional(),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      state_code,
      fips_code,
      property_kind,
      native_id,
      address,
      limit,
      cursor,
    }) =>
      toolResult(
        await callNationalApi(env, "search_national_properties", [
          state_code,
          fips_code,
          property_kind,
          native_id ?? null,
          address ?? null,
          limit,
          cursor ?? null,
        ]),
      ),
  );
  }

  server.registerTool(
    "get_source_evidence",
    {
      title: "Get Source Evidence",
      description:
        "Validate fact source references, then return machine-readable provenance and official human-facing D.C. sources with exact lookup inputs and a safe fallback. Present `sources` to users. Does not return ArcGIS REST, JSON, or session-bound URLs.",
      inputSchema: {
        source_refs: z.array(z.string().min(1).max(192)).min(1).max(50),
      },
      outputSchema: resultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ source_refs }) =>
      toolResult(await callApi(env, "get_source_evidence", [source_refs])),
  );

  server.registerTool(
    "describe_data",
    {
      title: "Describe Data",
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
