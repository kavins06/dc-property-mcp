import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, SERVICE_VERSION } from "../src/server";
import type { Env } from "../src/types";

describe("MCP tool catalog", () => {
  it("publishes the complete curated read-only tool contract", async () => {
    const server = createServer({ NATIONAL_SURFACE_ENABLED: "true" } as Env);
    const client = new Client({ name: "catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: "dc-property-records",
        title: "Quoin Data — D.C. Property Records & National Availability",
        version: "0.4.11",
        icons: [
          {
            src: "https://quoindata.com/assets/mcp-logo.png",
            mimeType: "image/png",
            sizes: ["1179x1179"],
          },
        ],
      });
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name).sort()).toEqual([
        "describe_data",
        "get_assessment_history",
        "get_building_and_land_profile",
        "get_complete_property_record",
        "get_inspection_and_enforcement_history",
        "get_latest_sale_and_deed",
        "get_license_history",
        "get_national_building",
        "get_national_jurisdiction_availability",
        "get_national_property",
        "get_ownership_and_sale",
        "get_permit_history",
        "get_property_snapshot",
        "get_source_evidence",
        "get_tax_and_balance_history",
        "list_national_jurisdictions",
        "list_national_subjurisdictions",
        "resolve_national_property",
        "resolve_properties_batch",
        "resolve_property",
        "search_national_properties",
        "search_properties",
      ]);
      expect(
        response.tools.every(
          (tool) => Boolean(tool.title?.trim()) && Boolean(tool.description?.trim()),
        ),
      ).toBe(true);
      expect(
        response.tools.find(
          (tool) => tool.name === "get_complete_property_record",
        )?.description,
      ).toMatch(/all|complete|everything/i);
      expect(
        response.tools.find((tool) => tool.name === "get_latest_sale_and_deed")
          ?.description,
      ).toContain("history");
      expect(
        response.tools.find((tool) => tool.name === "resolve_properties_batch")
          ?.description,
      ).toContain("named");
      expect(
        response.tools.find((tool) => tool.name === "search_properties")
          ?.description,
      ).toContain("delinquency");
      expect(response.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
        true,
      );
      expect(
        response.tools.every(
          (tool) => tool.annotations?.destructiveHint === false,
        ),
      ).toBe(true);
      expect(
        response.tools.every(
          (tool) =>
            tool.annotations?.idempotentHint === true &&
            tool.annotations?.openWorldHint === false,
        ),
      ).toBe(true);
      expect(SERVICE_VERSION).toBe("0.4.11");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises jurisdiction-aware national tools with strict identity inputs", async () => {
    const server = createServer({ NATIONAL_SURFACE_ENABLED: "true" } as Env);
    const client = new Client({ name: "national-catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      for (const name of [
        "resolve_national_property",
        "get_national_property",
        "get_national_building",
        "search_national_properties",
      ]) {
        expect(tools.get(name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(tools.get(name)?.description).toMatch(/D\.C\.|unpublished|published/);
      }
      const schema = tools.get("get_national_property")?.inputSchema as {
        properties?: Record<string, { enum?: string[]; pattern?: string }>;
      };
      expect(schema.properties?.state_code?.enum).toEqual(["DC", "MD", "VA"]);
      expect(schema.properties?.fips_code?.pattern).toBe("^\\d{5}$");
      expect(tools.get("list_national_jurisdictions")?.description).toMatch(/availability/i);
      expect(tools.get("list_national_subjurisdictions")?.description).toMatch(/FIPS/i);
      expect(tools.get("get_national_jurisdiction_availability")?.description).toMatch(/unpublished/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises the intentionally narrow three-stage assessment contract", async () => {
    const server = createServer({} as Env);
    const client = new Client({
      name: "assessment-catalog-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const response = await client.listTools();
      const description =
        response.tools.find((tool) => tool.name === "get_assessment_history")
          ?.description ?? "";

      expect(description).toMatch(/2025.+prior/i);
      expect(description).toMatch(/2026.+current/i);
      expect(description).toMatch(/2027.+proposed/i);
      expect(description).not.toMatch(
        /archive|gap|missing|2016|2017|2018|2020|2021|2022/i,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps national tools out of the catalog until Gate 6 enables them", async () => {
    const server = createServer({ NATIONAL_CONTRACT_VERSION: "national-v1" } as Env);
    const client = new Client({ name: "dc-only-catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        "list_national_jurisdictions",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
