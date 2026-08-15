import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  allowedOrigin,
  boundedMcpRequest,
  highCostRequestCount,
  isHighCostRequest,
  PayloadTooLargeError,
} from "../src/index";
import type { Env } from "../src/types";

const env = {
  WORKOS_AUTHKIT_DOMAIN: "auth.example.com",
  WORKOS_RESOURCE_URI: "https://mcp.example.com/mcp",
  ALLOWED_ORIGINS: "https://app.example.com",
} as Env;
const ctx = {} as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HTTP boundary", () => {
  it("adds defensive headers without exposing a request ID", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://mcp.example.com/healthz"),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "dc-property-mcp",
      version: "0.4.10",
    });
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });

  it("serves the exact OpenAI domain challenge token only when configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const challengeEnv = {
      ...env,
      OPENAI_APPS_CHALLENGE_TOKEN: "openai-domain-token",
    } as Env;
    const response = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/openai-apps-challenge"),
      challengeEnv,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("openai-domain-token");

    const head = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/openai-apps-challenge", {
        method: "HEAD",
      }),
      challengeEnv,
      ctx,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("does not expose an OpenAI challenge route before a token is configured", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/openai-apps-challenge"),
      env,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("permanently redirects the legacy production hostname", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://dc-property-mcp.quoindata.com/mcp?client=test"),
      env,
      ctx,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://mcp.example.com/mcp?client=test",
    );
  });

  it("returns a browser preflight only for explicitly allowed origins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("blocks an origin that is absent from the allowlist", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = new Request("https://mcp.example.com/mcp", {
      headers: { Origin: "https://untrusted.example.com" },
    });
    expect(allowedOrigin(request, env)).toBe(false);

    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns the OAuth challenge without exposing implementation details", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp"),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a streamed MCP body above 128 KiB", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(128 * 1024 + 1),
    });

    await expect(boundedMcpRequest(request)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it("classifies every bounded regulatory history call as high cost", async () => {
    for (const name of [
      "get_permit_history",
      "get_license_history",
      "get_inspection_and_enforcement_history",
      "get_building_and_land_profile",
    ]) {
      const request = new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name, arguments: { ssl: "5576    0001" } },
          id: 1,
        }),
      });

      await expect(isHighCostRequest(request)).resolves.toBe(true);
    }
  });

  it("counts every high-cost call in a JSON-RPC batch regardless of media-type casing", async () => {
    const request = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "Application/JSON; Charset=UTF-8" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "get_permit_history", arguments: {} },
          id: 1,
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "describe_data", arguments: {} },
          id: 2,
        },
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search_properties", arguments: {} },
          id: 3,
        },
      ]),
    });

    await expect(highCostRequestCount(request)).resolves.toBe(2);
  });

  it("converts unexpected upstream failures to a generic response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("sensitive upstream detail");
      }),
    );
    const response = await worker.fetch(
      new Request(
        "https://mcp.example.com/.well-known/oauth-authorization-server",
      ),
      env,
      ctx,
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("sensitive upstream detail");
    expect(body).not.toContain("request_id");
    expect(response.headers.get("retry-after")).toBe("5");
  });
});
