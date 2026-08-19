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
  clientId?: string;
  issuer?: string;
  session?: boolean;
  subject?: string;
}) {
  let builder = new SignJWT({
    scope: "openid profile",
    ...(options?.clientId && { client_id: options.clientId }),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options?.issuer ?? "https://auth.example.com")
    .setIssuedAt()
    .setExpirationTime("5m");
  if (!options?.session) {
    builder = builder.setAudience(options?.audience ?? "https://mcp.example.com/mcp");
  }
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

  it("accepts a session from the configured first-party application", async () => {
    mockJwks();
    const accessToken = await token({ clientId: "client_quoin_chat", session: true });
    const subject = await authenticate(
      new Request("https://mcp.example.com/mcp", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      { ...env, WORKOS_CHAT_CLIENT_ID: "client_quoin_chat" },
    );
    expect(subject?.sub).toBe("user_123");
  });

  it("rejects an application session when it is not configured", async () => {
    mockJwks();
    const accessToken = await token({ clientId: "client_quoin_chat", session: true });
    await expect(
      authenticate(
        new Request("https://mcp.example.com/mcp", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        env,
      ),
    ).rejects.toThrow();
  });

  it("rejects a session from a different first-party application", async () => {
    mockJwks();
    const accessToken = await token({ clientId: "client_other", session: true });
    await expect(
      authenticate(
        new Request("https://mcp.example.com/mcp", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        { ...env, WORKOS_CHAT_CLIENT_ID: "client_quoin_chat" },
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
