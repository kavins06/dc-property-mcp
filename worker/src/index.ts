import { authenticate, protectedResourceMetadata, unauthorized } from "./auth";
import { createServer, SERVICE_VERSION } from "./server";
import { checkEntitlement } from "./entitlement";
import type { Env } from "./types";

const MAX_MCP_REQUEST_BYTES = 128 * 1024;
const LEGACY_PRODUCTION_HOST = "dc-property-mcp.quoindata.com";
const MCP_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
].join(", ");
const MCP_EXPOSED_HEADERS = [
  "www-authenticate",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-request-id",
].join(", ");

export class PayloadTooLargeError extends Error {
  constructor() {
    super("MCP request payload exceeds the configured limit");
    this.name = "PayloadTooLargeError";
  }
}

function configuredOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function allowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  return !origin || configuredOrigins(env).includes(origin);
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  const values = current?.split(",").map((item) => item.trim().toLowerCase()) ?? [];
  if (!values.includes(value.toLowerCase())) {
    headers.set("Vary", current ? `${current}, ${value}` : value);
  }
}

export function applyResponsePolicy(
  response: Response,
  request: Request,
  env: Env,
  requestId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Request-ID", requestId);

  const origin = request.headers.get("origin");
  if (origin && allowedOrigin(request, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", MCP_EXPOSED_HEADERS);
    appendVary(headers, "Origin");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function boundedMcpRequest(
  request: Request,
  maxBytes = MAX_MCP_REQUEST_BYTES,
): Promise<Request> {
  if (request.method !== "POST" || !request.body) return request;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new PayloadTooLargeError();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

const HIGH_COST_TOOLS = new Set([
  "search_properties",
  "resolve_properties_batch",
  "get_permit_history",
  "get_license_history",
  "get_inspection_and_enforcement_history",
  "get_building_and_land_profile",
  "get_complete_property_record",
]);

export async function highCostRequestCount(
  request: Request,
): Promise<number> {
  if (request.method !== "POST") return 0;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return 0;
  try {
    const body = await request.clone().json<
      | {
          method?: string;
          params?: { name?: string };
        }
      | Array<{
          method?: string;
          params?: { name?: string };
        }>
    >();
    const calls = Array.isArray(body) ? body : [body];
    return calls.filter(
      (call) =>
        call &&
        typeof call === "object" &&
        call.method === "tools/call" &&
        HIGH_COST_TOOLS.has(call.params?.name ?? ""),
    ).length;
  } catch {
    return 0;
  }
}

export async function isHighCostRequest(
  request: Request,
): Promise<boolean> {
  return (await highCostRequestCount(request)) > 0;
}

async function authorizationMetadata(env: Env): Promise<Response> {
  const domain = env.WORKOS_AUTHKIT_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const upstream = await fetch(`https://${domain}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}

function preflightResponse(request: Request): Response {
  const requestedMethod = request.headers.get("access-control-request-method");
  if (requestedMethod && !["GET", "POST", "DELETE"].includes(requestedMethod.toUpperCase())) {
    return jsonError("method_not_allowed", 405, { Allow: "GET, POST, DELETE, OPTIONS" });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": MCP_ALLOWED_HEADERS,
      "Access-Control-Max-Age": "600",
    },
  });
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === LEGACY_PRODUCTION_HOST) {
    const destination = new URL(request.url);
    destination.hostname = new URL(env.WORKOS_RESOURCE_URI).hostname;
    return Response.redirect(destination, 308);
  }

  if (url.pathname === "/healthz") {
    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonError("method_not_allowed", 405, { Allow: "GET, HEAD" });
    }
    return Response.json(
      { service: "dc-property-mcp", version: SERVICE_VERSION },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonError("method_not_allowed", 405, { Allow: "GET, HEAD" });
    }
    return Response.json(protectedResourceMetadata(env), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonError("method_not_allowed", 405, { Allow: "GET, HEAD" });
    }
    return authorizationMetadata(env);
  }
  if (url.pathname !== "/mcp") return jsonError("not_found", 404);
  if (!allowedOrigin(request, env)) return jsonError("forbidden_origin", 403);
  if (request.method === "OPTIONS") return preflightResponse(request);

  let subject;
  try {
    subject = await authenticate(request, env);
  } catch {
    return unauthorized(request, env);
  }
  if (!subject) return unauthorized(request, env);

  const entitlement = await checkEntitlement(subject.sub, env);
  if (!entitlement.allowed) {
    if (entitlement.unavailable) {
      return Response.json(
        { error: "service_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }
    return Response.json(
      {
        error: "subscription_required",
        action_url: env.BILLING_ACCOUNT_URL ?? "https://quoindata.com/pricing",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rateKey = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject.sub),
  );
  const key = Array.from(new Uint8Array(rateKey), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (env.GENERAL_RATE_LIMITER) {
    const { success } = await env.GENERAL_RATE_LIMITER.limit({ key });
    if (!success) {
      return jsonError("rate_limit_exceeded", 429, { "Retry-After": "60" });
    }
  }

  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonError("unsupported_media_type", 415);
    }
  }

  let boundedRequest: Request;
  try {
    boundedRequest = await boundedMcpRequest(request);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonError("payload_too_large", 413);
    }
    throw error;
  }

  if (env.SEARCH_RATE_LIMITER) {
    const highCostCalls = await highCostRequestCount(boundedRequest);
    for (let index = 0; index < highCostCalls; index += 1) {
      const { success } = await env.SEARCH_RATE_LIMITER.limit({ key });
      if (!success) {
        return jsonError("search_rate_limit_exceeded", 429, {
          "Retry-After": "60",
        });
      }
    }
  }

  const server = createServer(env);
  const { createMcpHandler } = await import("agents/mcp");
  const response = await createMcpHandler(server, {
    route: "/mcp",
    enableJsonResponse: true,
  })(boundedRequest, env, ctx);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = performance.now();
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    let response: Response;
    let errorName: string | undefined;

    try {
      response = await handleRequest(request, env, ctx);
    } catch (error) {
      errorName = error instanceof Error ? error.name : "UnknownError";
      response = Response.json(
        { error: "service_unavailable", request_id: requestId },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }

    const finalResponse = applyResponsePolicy(response, request, env, requestId);
    const log = {
      event: "mcp_request",
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      status: finalResponse.status,
      duration_ms: Math.round((performance.now() - started) * 10) / 10,
      ...(errorName ? { error_name: errorName } : {}),
    };
    if (finalResponse.status >= 500) {
      console.error(log);
    } else {
      console.log(log);
    }
    return finalResponse;
  },
} satisfies ExportedHandler<Env>;
