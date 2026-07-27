import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  protectedResourceMetadata,
  unauthorized,
} from "../src/auth";
import type { Env } from "../src/types";

const env = {
  WORKOS_AUTHKIT_DOMAIN: "auth.example.com",
  WORKOS_RESOURCE_URI: "https://mcp.example.com/mcp",
  ALLOWED_ORIGINS: "",
} as Env;

let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  jwk = {
    ...await exportJWK(keys.publicKey),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(options?: {
  audience?: string;
  issuer?: string;
  subject?: string;
}) {
  let builder = new SignJWT({ scope: "openid profile" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options?.issuer ?? "https://auth.example.com")
    .setAudience(options?.audience ?? "https://mcp.example.com/mcp")
    .setIssuedAt()
    .setExpirationTime("5m");
  if (options?.subject !== "") {
    builder = builder.setSubject(options?.subject ?? "user_123");
  }
  return builder.sign(privateKey);
}

function mockJwks() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [jwk] })),
  );
}

describe("OAuth metadata", () => {
  it("advertises the exact MCP resource", () => {
    expect(protectedResourceMetadata(env)).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://auth.example.com"],
      bearer_methods_supported: ["header"],
    });
  });

  it("returns an MCP discovery challenge", () => {
    const response = unauthorized(new Request("https://mcp.example.com/mcp"), env);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });

  it("accepts only a correctly issued token for the exact MCP audience", async () => {
    mockJwks();
    const accessToken = await token();
    const subject = await authenticate(
      new Request("https://mcp.example.com/mcp", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      env,
    );
    expect(subject).toEqual({
      sub: "user_123",
      scope: ["openid", "profile"],
    });
  });

  it("rejects a token issued for a different audience", async () => {
    mockJwks();
    const accessToken = await token({ audience: "https://other.example.com" });
    await expect(
      authenticate(
        new Request("https://mcp.example.com/mcp", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        env,
      ),
    ).rejects.toThrow();
  });

  it("rejects an access token without a subject", async () => {
    mockJwks();
    const accessToken = await token({ subject: "" });
    await expect(
      authenticate(
        new Request("https://mcp.example.com/mcp", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        env,
      ),
    ).rejects.toThrow("Access token is missing sub");
  });
});
