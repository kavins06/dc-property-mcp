import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server";
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
        "get_latest_sale_and_deed",
        "get_ownership_and_sale",
        "get_property_snapshot",
        "get_source_evidence",
        "get_tax_and_balance_history",
        "resolve_properties_batch",
        "resolve_property",
        "search_properties",
      ]);
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
    } finally {
      await client.close();
      await server.close();
    }
  });
});
