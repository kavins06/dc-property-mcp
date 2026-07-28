import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, SERVICE_VERSION } from "../src/server";
import type { Env } from "../src/types";

describe("MCP tool catalog", () => {
  it("publishes the complete curated read-only tool contract", async () => {
    const server = createServer({} as Env);
    const client = new Client({ name: "catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name).sort()).toEqual([
        "describe_data",
        "get_assessment_history",
        "get_building_and_land_profile",
        "get_complete_property_record",
        "get_inspection_and_enforcement_history",
        "get_latest_sale_and_deed",
        "get_license_history",
        "get_ownership_and_sale",
        "get_permit_history",
        "get_property_snapshot",
        "get_source_evidence",
        "get_tax_and_balance_history",
        "resolve_properties_batch",
        "resolve_property",
        "search_properties",
      ]);
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
      expect(SERVICE_VERSION).toBe("0.4.1");
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
});
