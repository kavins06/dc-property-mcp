import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { UnauthorizedError } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js";
import { InMemoryOAuthClientProvider } from "../worker/node_modules/@modelcontextprotocol/sdk/dist/esm/examples/client/simpleOAuthClientProvider.js";

const serverUrl = new URL(
  process.argv[2] ?? "https://dc-property-mcp.quoindata.com/mcp",
);
const authServerUrl = new URL(
  process.env.MCP_AUTH_SERVER_URL ?? serverUrl,
);
const isCandidate = authServerUrl.origin !== serverUrl.origin;
const project = resolve(import.meta.dirname, "..");
const callbackPort = Number(process.env.MCP_OAUTH_CALLBACK_PORT ?? 8765);
const callbackTimeoutSeconds = Number(
  process.env.MCP_OAUTH_CALLBACK_TIMEOUT_SECONDS ?? 600,
);
if (
  !Number.isSafeInteger(callbackTimeoutSeconds) ||
  callbackTimeoutSeconds < 60 ||
  callbackTimeoutSeconds > 1800
) {
  throw new Error(
    "MCP_OAUTH_CALLBACK_TIMEOUT_SECONDS must be an integer from 60 to 1800.",
  );
}
const callbackUrl = `http://localhost:${callbackPort}/callback`;
async function loggingFetch(input, init = {}) {
  const requestUrl = new URL(
    input instanceof Request ? input.url : input.toString(),
  );
  const response = await fetch(input, init);
  if (!response.ok) {
    const details = await response
      .clone()
      .json()
      .catch(() => ({}));
    process.stderr.write(
      `${JSON.stringify({
        event: "oauth_http_error",
        origin: requestUrl.origin,
        path: requestUrl.pathname,
        status: response.status,
        error:
          typeof details.error === "string" ? details.error : undefined,
        error_description:
          typeof details.error_description === "string"
            ? details.error_description
            : undefined,
      })}\n`,
    );
  }
  return response;
}

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
  callbackServer.listen(
    { port: callbackPort, host: "::", ipv6Only: false },
    resolve,
  );
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
  { name: "quoin-release-verifier", version: "0.4.1" },
  { capabilities: {} },
);

async function connect(targetUrl, targetClient, allowAuthorization) {
  const transport = new StreamableHTTPClientTransport(targetUrl, {
    authProvider: provider,
    fetch: loggingFetch,
  });
  try {
    await targetClient.connect(transport);
    return transport;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    if (!allowAuthorization) {
      throw new Error(
        `The audience-bound token was rejected by ${targetUrl.origin}.`,
        { cause: error },
      );
    }
    await authorizationUrlPromise;
    let callbackTimeout;
    const code = await Promise.race([
      callbackPromise,
      new Promise((_, reject) => {
        callbackTimeout = setTimeout(
          () =>
            reject(
              new Error(
                `OAuth callback timed out after ${callbackTimeoutSeconds} seconds.`,
              ),
            ),
          callbackTimeoutSeconds * 1000,
        );
      }),
    ]).finally(() => clearTimeout(callbackTimeout));
    await transport.finishAuth(code);
    return connect(targetUrl, targetClient, false);
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
  "search_properties",
  "get_source_evidence",
  "describe_data",
];
const regulatoryTools = new Set([
  "get_permit_history",
  "get_license_history",
  "get_inspection_and_enforcement_history",
  "get_building_and_land_profile",
]);
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
  [
    "get_complete_property_record",
    { address: "4800 E Capitol St NE in DC" },
  ],
  ["get_property_snapshot", { ssl: "01070075" }],
  ["get_assessment_history", { ssl: "01070075" }],
  ["get_tax_and_balance_history", { ssl: "01070075" }],
  ["get_ownership_and_sale", { ssl: "01070075" }],
  ["get_latest_sale_and_deed", { ssl: "01070075" }],
  ["get_permit_history", { ssl: "01070075", limit: 1 }],
  ["get_license_history", { ssl: "01070075", limit: 1 }],
  [
    "get_inspection_and_enforcement_history",
    { ssl: "01070075", limit: 1 },
  ],
  ["get_building_and_land_profile", { ssl: "01070075", limit: 1 }],
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
let authTransport;
let authClient;
try {
  if (authServerUrl.origin !== serverUrl.origin) {
    authClient = new Client(
      { name: "quoin-release-auth-bootstrap", version: "0.4.1" },
      { capabilities: {} },
    );
    authTransport = await connect(authServerUrl, authClient, true);
  }
  transport = await connect(
    serverUrl,
    client,
    authServerUrl.origin === serverUrl.origin,
  );
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
    if (
      regulatoryTools.has(name) &&
      (!Array.isArray(payload.records) || payload.property === undefined)
    ) {
      throw new Error(
        `${name} did not return the v0.4 regulatory response contract.`,
      );
    }
    if (
      name === "get_complete_property_record" &&
      (
        payload.coverage?.complete !== true ||
        payload.coverage?.included_sections?.length !== 9 ||
        payload.coverage?.record_counts?.permits !== 42 ||
        payload.coverage?.record_counts?.licenses !== 4 ||
        payload.coverage?.record_counts?.inspections_and_enforcement !== 1 ||
        payload.coverage?.record_counts?.building_and_land !== 15
      )
    ) {
      throw new Error(
        "Complete-record tool did not exhaust every data domain for the incident property.",
      );
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

  const verification = {
    passed: true,
    service_version: "0.4.1",
    endpoint: serverUrl.toString(),
    authorization_resource: authServerUrl.toString(),
    tool_count: toolNames.length,
    tools: toolNames,
    statuses,
    timings_ms: timings,
    sale_evidence_portal: portal,
    verified_at: new Date().toISOString(),
  };
  const reportDirectory = resolve(project, "db", "reports", "generated");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    resolve(
      reportDirectory,
      `authenticated-mcp-${isCandidate ? "candidate" : "production"}-0.4.1.json`,
    ),
    `${JSON.stringify(verification, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
} finally {
  callbackServer.close();
  if (transport) await transport.close().catch(() => undefined);
  if (authTransport) await authTransport.close().catch(() => undefined);
  await client.close().catch(() => undefined);
  if (authClient) await authClient.close().catch(() => undefined);
}
