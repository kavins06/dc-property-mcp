import { createServer } from "node:http";
import { Client } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { UnauthorizedError } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js";
import { InMemoryOAuthClientProvider } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/examples/client/simpleOAuthClientProvider.js";

const serverUrl = new URL(
  process.argv[2] ?? "https://dc-property-mcp.quoindata.com/mcp",
);
const callbackPort = Number(process.env.MCP_OAUTH_CALLBACK_PORT ?? 8765);
const callbackUrl = `http://localhost:${callbackPort}/callback`;

let settleCallback;
const callbackPromise = new Promise((resolve, reject) => {
  settleCallback = { resolve, reject };
});

const callbackServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", callbackUrl);
  if (url.pathname === "/favicon.ico") {
    response.writeHead(404);
    response.end();
    return;
  }
  if (url.pathname !== "/callback") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (code) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      "<!doctype html><title>Quoin MCP verified</title>" +
        "<h1>Authorization received</h1>" +
        "<p>The automated MCP verification is continuing. This tab can close.</p>",
    );
    settleCallback.resolve(code);
    return;
  }
  response.writeHead(400, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end("Authorization failed.");
  settleCallback.reject(
    new Error(`OAuth callback failed: ${error ?? "missing_code"}`),
  );
});

await new Promise((resolve, reject) => {
  callbackServer.once("error", reject);
  callbackServer.listen(callbackPort, "127.0.0.1", resolve);
});

let authorizationUrl;
const authorizationUrlPromise = new Promise((resolve) => {
  authorizationUrl = resolve;
});
const provider = new InMemoryOAuthClientProvider(
  callbackUrl,
  {
    client_name: "Quoin D.C. Property Release Verification",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  (url) => {
    process.stdout.write(`AUTHORIZATION_REQUIRED ${url.toString()}\n`);
    authorizationUrl(url);
  },
);
const client = new Client(
  { name: "quoin-release-verifier", version: "0.3.0" },
  { capabilities: {} },
);

async function connect() {
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: provider,
  });
  try {
    await client.connect(transport);
    return transport;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    await authorizationUrlPromise;
    const code = await Promise.race([
      callbackPromise,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("OAuth callback timed out after 180 seconds.")),
          180_000,
        );
      }),
    ]);
    await transport.finishAuth(code);
    return connect();
  }
}

function structured(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

const expectedTools = [
  "resolve_property",
  "resolve_properties_batch",
  "get_property_snapshot",
  "get_assessment_history",
  "get_tax_and_balance_history",
  "get_ownership_and_sale",
  "get_latest_sale_and_deed",
  "search_properties",
  "get_source_evidence",
  "describe_data",
];
const probes = [
  ["resolve_property", { ssl: "01070075" }],
  [
    "resolve_properties_batch",
    {
      items: [
        { client_id: "asset-1", ssl: "01070075" },
        { client_id: "asset-2", address: "555 12th St NW" },
      ],
    },
  ],
  ["get_property_snapshot", { ssl: "01070075" }],
  ["get_assessment_history", { ssl: "01070075" }],
  ["get_tax_and_balance_history", { ssl: "01070075" }],
  ["get_ownership_and_sale", { ssl: "01070075" }],
  ["get_latest_sale_and_deed", { ssl: "01070075" }],
  [
    "search_properties",
    {
      property_type: "commercial-office (large)",
      tax_class: "2",
      sort_by: "assessment_desc",
      limit: 1,
    },
  ],
  [
    "describe_data",
    { question: "What property_type values can search_properties use?" },
  ],
];

let transport;
try {
  transport = await connect();
  const catalog = await client.listTools();
  const toolNames = catalog.tools.map((tool) => tool.name).sort();
  const expectedNames = expectedTools.slice().sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Live tool catalog mismatch: ${toolNames.join(", ")}`,
    );
  }

  const timings = {};
  const statuses = {};
  let saleSourceRef;
  for (const [name, args] of probes) {
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    timings[name] = Number((performance.now() - started).toFixed(1));
    const payload = structured(result);
    statuses[name] = payload.status;
    if (!["resolved", "ok"].includes(payload.status)) {
      throw new Error(`${name} returned unexpected status ${payload.status}`);
    }
    if (name === "get_latest_sale_and_deed") {
      saleSourceRef =
        payload.sale_history?.[0]?.sale_price_dollars?.source_refs?.[0];
      if (!saleSourceRef) {
        throw new Error("Live sale history did not return a source reference.");
      }
    }
  }

  const evidenceStarted = performance.now();
  const evidenceResult = await client.callTool({
    name: "get_source_evidence",
    arguments: { source_refs: [saleSourceRef] },
  });
  timings.get_source_evidence = Number(
    (performance.now() - evidenceStarted).toFixed(1),
  );
  const evidence = structured(evidenceResult);
  statuses.get_source_evidence = evidence.status;
  const portal =
    evidence.evidence?.[0]?.human_verification?.portal_url ?? "";
  if (
    evidence.status !== "ok" ||
    !portal.startsWith("https://opendata.dc.gov/datasets/") ||
    JSON.stringify(evidence).includes("FeatureServer")
  ) {
    throw new Error("Live sale evidence is not a human D.C. portal route.");
  }

  process.stdout.write(`${JSON.stringify({
    passed: true,
    endpoint: serverUrl.toString(),
    tool_count: toolNames.length,
    tools: toolNames,
    statuses,
    timings_ms: timings,
    sale_evidence_portal: portal,
  }, null, 2)}\n`);
} finally {
  callbackServer.close();
  if (transport) await transport.close().catch(() => undefined);
  await client.close().catch(() => undefined);
}
