import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { callApi } from "../src/db";
import { createServer } from "../src/server";
import type { Env } from "../src/types";

vi.mock("../src/db", () => ({
  callApi: vi.fn(async () => ({ status: "ok" })),
}));

const mockedCallApi = vi.mocked(callApi);

async function connectedClient() {
  const env = {} as Env;
  const server = createServer(env);
  const client = new Client({
    name: "json-argument-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, env, server };
}

afterEach(() => {
  mockedCallApi.mockClear();
});

describe("JSONB tool arguments", () => {
  it("passes parcel pagination to property resolution", async () => {
    const { client, env, server } = await connectedClient();
    try {
      await client.callTool({
        name: "resolve_property",
        arguments: {
          address: "555 12th St NW",
          parcel_offset: 25,
          parcel_limit: 50,
        },
      });
      expect(mockedCallApi).toHaveBeenCalledWith(
        env,
        "resolve_property",
        [null, "555 12th St NW", false, 10, 25, 50],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes complete-record requests through the exhaustive query", async () => {
    const { client, env, server } = await connectedClient();
    try {
      await client.callTool({
        name: "get_complete_property_record",
        arguments: { address: "4800 E Capitol St NE in DC" },
      });
      expect(mockedCallApi).toHaveBeenCalledWith(
        env,
        "get_complete_property_record",
        [null, "4800 E Capitol St NE in DC"],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serializes batch, regulatory options, and search input as JSON", async () => {
    const { client, env, server } = await connectedClient();
    try {
      const items = [
        { client_id: "asset-1", ssl: "01070075" },
        { client_id: "asset-2", address: "555 12th St NW" },
      ];
      await client.callTool({
        name: "resolve_properties_batch",
        arguments: { items },
      });
      expect(mockedCallApi).toHaveBeenLastCalledWith(
        env,
        "resolve_properties_batch",
        [JSON.stringify(items)],
      );

      await client.callTool({
        name: "get_permit_history",
        arguments: { ssl: "01070075", cursor: "next", limit: 2 },
      });
      expect(mockedCallApi).toHaveBeenLastCalledWith(
        env,
        "get_permit_history",
        [
          "01070075",
          null,
          JSON.stringify({ limit: 2, cursor: "next" }),
        ],
      );

      const search = {
        ward: "2",
        tax_class: "2",
        sort_by: "assessment_desc",
        limit: 3,
      };
      await client.callTool({
        name: "search_properties",
        arguments: search,
      });
      expect(mockedCallApi).toHaveBeenLastCalledWith(
        env,
        "search_properties",
        [JSON.stringify(search)],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps PostgreSQL text-array arguments as arrays", async () => {
    const { client, env, server } = await connectedClient();
    try {
      const sourceRefs = ["source|record|field|01070075"];
      await client.callTool({
        name: "get_source_evidence",
        arguments: { source_refs: sourceRefs },
      });
      expect(mockedCallApi).toHaveBeenLastCalledWith(
        env,
        "get_source_evidence",
        [sourceRefs],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
