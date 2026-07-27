import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  allowedOrigin,
  boundedMcpRequest,
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
  it("adds a request ID and defensive headers to health responses", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://mcp.example.com/healthz"),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "dc-property-mcp",
      version: "0.2.0",
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
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
    expect(await response.text()).not.toContain("sensitive upstream detail");
    expect(response.headers.get("retry-after")).toBe("5");
  });
});
