import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");

function readEnv(path) {
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

const env = readEnv(resolve(project, ".env.hosted"));
const config = JSON.parse(
  readFileSync(resolve(project, "worker", "wrangler.jsonc"), "utf8"),
);
const accountApi =
  `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const api = `${accountApi}/workers/scripts/${config.name}`;

async function request(path) {
  const response = await fetch(`${api}${path}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Cloudflare inspection failed (${response.status} ${path}): ` +
        JSON.stringify(payload.errors ?? []),
    );
  }
  return payload.result;
}

async function accountRequest(path) {
  const response = await fetch(`${accountApi}${path}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Cloudflare account inspection failed (${response.status} ${path}): ` +
        JSON.stringify(payload.errors ?? []),
    );
  }
  return payload.result;
}

const [deploymentResult, versionResult, subdomainResult] = await Promise.all([
  request("/deployments"),
  request("/versions?per_page=10"),
  accountRequest("/workers/subdomain"),
]);
const deployments =
  deploymentResult.deployments ?? deploymentResult;
const versions =
  versionResult.items ?? versionResult.versions ?? versionResult;

process.stdout.write(`${JSON.stringify({
  script: config.name,
  workers_subdomain: subdomainResult.subdomain,
  deployments: deployments.slice(0, 5).map((deployment) => ({
    id: deployment.id,
    created_on: deployment.created_on,
    source: deployment.source,
    strategy: deployment.strategy,
    annotations: deployment.annotations,
    versions: deployment.versions,
  })),
  versions: versions.slice(0, 10).map((version) => ({
    id: version.id,
    number: version.number,
    created_on: version.metadata?.created_on ?? version.created_on,
    tag: version.annotations?.["workers/tag"],
    message: version.annotations?.["workers/message"],
    preview_url: version.preview_url ?? null,
    fields: Object.keys(version).sort(),
  })),
}, null, 2)}\n`);
