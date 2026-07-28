import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";

const project = resolve(import.meta.dirname, "..");

const env = parseEnv(
  readFileSync(resolve(project, ".env.hosted"), "utf8"),
);
const config = JSON.parse(
  readFileSync(resolve(project, "worker", "wrangler.jsonc"), "utf8"),
);
const { request, accountRequest } = createCloudflareClient({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  token: env.CLOUDFLARE_API_TOKEN,
  scriptName: config.name,
});

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
