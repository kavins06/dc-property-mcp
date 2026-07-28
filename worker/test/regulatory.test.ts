import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const { callApiMock } = vi.hoisted(() => ({
  callApiMock: vi.fn(),
}));

vi.mock("../src/db", () => ({
  callApi: callApiMock,
}));

import { createServer } from "../src/server";
import type { Env } from "../src/types";

const regulatoryTools = [
  "get_permit_history",
  "get_license_history",
  "get_inspection_and_enforcement_history",
  "get_building_and_land_profile",
] as const;

async function connectedClient() {
  const server = createServer({} as Env);
  const client = new Client({
    name: "regulatory-contract-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

afterEach(() => {
  callApiMock.mockReset();
});

describe("v0.4 regulatory MCP contract", () => {
  it("publishes four bounded read-only regulatory tools with lender-safe descriptions", async () => {
    const { client, server } = await connectedClient();
    try {
      const response = await client.listTools();
      const tools = new Map(response.tools.map((tool) => [tool.name, tool]));

      for (const name of regulatoryTools) {
        const tool = tools.get(name);
        expect(tool, `${name} is missing`).toBeDefined();
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        });

        const properties = (
          tool?.inputSchema as {
            properties?: Record<string, Record<string, unknown>>;
          }
        ).properties;
        expect(properties?.limit).toMatchObject({
          type: "integer",
          minimum: 1,
          maximum: 50,
        });
        expect(properties?.cursor).toMatchObject({
          type: "string",
        });
      }

      expect(tools.get("get_permit_history")?.description).toMatch(
        /building permit.+certificate of occupancy.+DDOT/i,
      );
      expect(tools.get("get_license_history")?.description).toMatch(
        /business.+premise|premise.+business/i,
      );
      expect(tools.get("get_license_history")?.description).toMatch(
        /not.+(?:ownership|title)/i,
      );
      expect(
        tools.get("get_inspection_and_enforcement_history")?.description,
      ).toMatch(/inspection.+(?:enforcement|violation)/i);
      expect(tools.get("get_building_and_land_profile")?.description).toMatch(
        /CAMA.+energy.+BEPS.+vacant.+blighted/i,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a high-cost page size above 50 before calling PostgreSQL", async () => {
    const { client, server } = await connectedClient();
    try {
      for (const name of regulatoryTools) {
        callApiMock.mockClear();
        const result = await client.callTool({
          name,
          arguments: {
            ssl: "5576    0001",
            limit: 51,
          },
        });

        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({
            type: "text",
            text: expect.stringMatching(
              /input validation|less than or equal to 50/i,
            ),
          }),
        ]);
        expect(callApiMock).not.toHaveBeenCalled();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("omits the cursor key on every first-page database call", async () => {
    callApiMock.mockResolvedValue({
      status: "resolved",
      records: [],
      page: { limit: 20, next_cursor: null },
    });
    const { client, server } = await connectedClient();
    try {
      for (const name of regulatoryTools) {
        callApiMock.mockClear();
        await client.callTool({
          name,
          arguments: {
            ssl: "5576    0001",
          },
        });
        expect(callApiMock).toHaveBeenCalledTimes(1);
        expect(callApiMock).toHaveBeenCalledWith(
          {},
          name,
          ["5576    0001", null, JSON.stringify({ limit: 20 })],
        );
        const filters = JSON.parse(
          String(callApiMock.mock.calls[0]?.[2]?.[2]),
        );
        expect(filters).not.toHaveProperty("cursor");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes an explicit cursor only on continuation-page calls", async () => {
    callApiMock.mockResolvedValue({
      status: "resolved",
      records: [],
      page: { limit: 7, next_cursor: null },
    });
    const { client, server } = await connectedClient();
    try {
      await client.callTool({
        name: "get_permit_history",
        arguments: {
          address: "1100 15th St NW",
          cursor: "opaque-next-page",
          limit: 7,
        },
      });
      expect(callApiMock).toHaveBeenCalledWith(
        {},
        "get_permit_history",
        [
          null,
          "1100 15th St NW",
          JSON.stringify({
            limit: 7,
            cursor: "opaque-next-page",
          }),
        ],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed with a compact response when a database result exceeds 768 KiB", async () => {
    callApiMock.mockResolvedValue({
      status: "resolved",
      records: [
        {
          record_type: "building_permit",
          description: "x".repeat(800 * 1024),
        },
      ],
    });
    const { client, server } = await connectedClient();

    try {
      const result = await client.callTool({
        name: "get_permit_history",
        arguments: {
          ssl: "5576    0001",
          limit: 50,
        },
      });

      expect(result.structuredContent).toMatchObject({
        status: "error",
        error: {
          code: "response_too_large",
          retryable: false,
        },
      });
      expect(
        Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8"),
      ).toBeLessThanOrEqual(768 * 1024);
      expect(JSON.stringify(result)).not.toContain("x".repeat(1024));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
