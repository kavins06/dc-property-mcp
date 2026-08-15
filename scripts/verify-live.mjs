import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(project, "worker", "package.json"), "utf8"),
);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function verifyLive({
  baseUrl = "https://mcp.quoindata.com",
  expectedVersion = packageJson.version,
  expectedResourceUrl = `${baseUrl}/mcp`,
  versionId,
  scriptName = "dc-property-mcp",
  attempts = 15,
} = {}) {
  const headers = { "Cache-Control": "no-cache" };
  if (versionId) {
    headers["Cloudflare-Workers-Version-Overrides"] =
      `${scriptName}="${versionId}"`;
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const healthResponse = await fetch(
        `${baseUrl}/healthz?verification=${crypto.randomUUID()}`,
        { headers },
      );
      const health = await healthResponse.json();
      if (
        healthResponse.status !== 200 ||
        health.service !== "dc-property-mcp" ||
        health.version !== expectedVersion
      ) {
        throw new Error(
          `healthz returned ${healthResponse.status} / ${JSON.stringify(health)}`,
        );
      }
      for (const requiredHeader of [
        "content-security-policy",
        "strict-transport-security",
        "x-content-type-options",
        "x-request-id",
      ]) {
        if (!healthResponse.headers.get(requiredHeader)) {
          throw new Error(`healthz is missing ${requiredHeader}`);
        }
      }

      const metadataResponse = await fetch(
        `${baseUrl}/.well-known/oauth-protected-resource`,
        { headers },
      );
      const metadata = await metadataResponse.json();
      if (
        metadataResponse.status !== 200 ||
        metadata.resource !== expectedResourceUrl ||
        !Array.isArray(metadata.authorization_servers) ||
        metadata.authorization_servers.length !== 1
      ) {
        throw new Error("protected-resource metadata is invalid");
      }

      const authorizationResponse = await fetch(
        `${baseUrl}/.well-known/oauth-authorization-server`,
        { headers },
      );
      const authorization = await authorizationResponse.json();
      if (
        authorizationResponse.status !== 200 ||
        authorization.issuer !== metadata.authorization_servers[0] ||
        typeof authorization.authorization_endpoint !== "string" ||
        typeof authorization.token_endpoint !== "string"
      ) {
        throw new Error("authorization-server metadata proxy is invalid");
      }

      const mcpResponse = await fetch(`${baseUrl}/mcp`, { headers });
      const challenge = mcpResponse.headers.get("www-authenticate") ?? "";
      if (
        mcpResponse.status !== 401 ||
        !challenge.includes("/.well-known/oauth-protected-resource")
      ) {
        throw new Error("unauthenticated MCP boundary did not return its OAuth challenge");
      }

      const blockedOriginResponse = await fetch(`${baseUrl}/mcp`, {
        headers: { ...headers, Origin: "https://untrusted.example.com" },
      });
      if (blockedOriginResponse.status !== 403) {
        throw new Error("untrusted browser origin was not rejected");
      }

      return {
        passed: true,
        version: health.version,
        version_override: versionId ?? null,
        checks: {
          health: true,
          security_headers: true,
          oauth_metadata: true,
          authorization_server_metadata: true,
          oauth_challenge: true,
          origin_allowlist: true,
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(1000);
    }
  }
  throw lastError;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await verifyLive({ expectedVersion: process.argv[2] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
