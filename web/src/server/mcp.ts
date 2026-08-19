import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import { getServerEnv } from "./env";

export const PROPERTY_TOOL_NAMES = [
  "resolve_property",
  "resolve_properties_batch",
  "search_properties",
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
  "get_source_evidence",
  "describe_data",
] as const;

const ALLOWED_TOOLS = new Set<string>(PROPERTY_TOOL_NAMES);

export function allowPropertyTools(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => ALLOWED_TOOLS.has(name)),
  );
}

export async function createPropertyMcpClient(
  accessToken: string,
): Promise<{ client: MCPClient; tools: ToolSet }> {
  const env = getServerEnv();
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: env.MCP_SERVER_URL,
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
    },
    maxRetries: 1,
  });

  const tools = allowPropertyTools(await client.tools());
  if (!tools.resolve_property || !tools.get_complete_property_record) {
    await client.close();
    throw new Error("The Quoin property tool catalog is incomplete.");
  }
  return { client, tools };
}
