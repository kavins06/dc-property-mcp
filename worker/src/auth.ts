import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthSubject, Env } from "./types";

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function issuerFor(domain: string): string {
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

function jwksFor(domain: string) {
  const issuer = issuerFor(domain);
  let jwks = jwksByDomain.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`));
    jwksByDomain.set(issuer, jwks);
  }
  return jwks;
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthSubject | null> {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer (.+)$/i);
  if (!match?.[1]) return null;

  const issuer = issuerFor(env.WORKOS_AUTHKIT_DOMAIN);
  const { payload } = await jwtVerify(match[1], jwksFor(env.WORKOS_AUTHKIT_DOMAIN), {
    algorithms: ["RS256"],
    issuer,
    audience: env.WORKOS_RESOURCE_URI,
  });
  if (!payload.sub) throw new Error("Access token is missing sub");

  const scopeValue = typeof payload.scope === "string" ? payload.scope : "";
  return { sub: payload.sub, scope: scopeValue.split(/\s+/).filter(Boolean) };
}

export function protectedResourceMetadata(env: Env) {
  return {
    resource: env.WORKOS_RESOURCE_URI,
    authorization_servers: [issuerFor(env.WORKOS_AUTHKIT_DOMAIN)],
    bearer_methods_supported: ["header"],
  };
}

export function unauthorized(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  return Response.json(
    { error: "unauthorized", error_description: "A valid WorkOS access token is required." },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      },
    },
  );
}
