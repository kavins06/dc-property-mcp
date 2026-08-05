import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import { verifyLive } from "./verify-live.mjs";

const project = resolve(import.meta.dirname, "..");

const env = {
  ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
  ...process.env,
};
const config = JSON.parse(
  readFileSync(resolve(project, "worker", "wrangler.jsonc"), "utf8"),
);
const packageJson = JSON.parse(
  readFileSync(resolve(project, "worker", "package.json"), "utf8"),
);
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const token = env.CLOUDFLARE_API_TOKEN;
const scriptName = config.name;
const workerPath = resolve(project, "worker", "dist", "worker.js");
const baseUrl = new URL(config.vars.WORKOS_RESOURCE_URI).origin;
const releaseMessage = `Release v${packageJson.version}: production hardening`;
const argumentsList = process.argv.slice(2);
if (
  argumentsList.length !== 1 ||
  argumentsList[0] !== "--stage-only"
) {
  throw new Error(
    "Candidate deployment is stage-only. Pass --stage-only, complete " +
      "authenticated candidate verification, then run promote-cloudflare.mjs.",
  );
}
if (!accountId || !token) {
  throw new Error("Cloudflare deployment credentials are not configured.");
}
if (!scriptName || !config.main || !config.compatibility_date) {
  throw new Error("Wrangler configuration is incomplete.");
}
const {
  request: cloudflare,
  accountRequest: accountCloudflare,
  createDeployment,
} = createCloudflareClient({ accountId, token, scriptName });

function deploymentBindings() {
  return [
    ...(config.hyperdrive ?? []).map((binding) => ({
      type: "hyperdrive",
      name: binding.binding,
      id: binding.id,
    })),
    ...Object.entries(config.vars ?? {}).map(([name, text]) => ({
      type: "plain_text",
      name,
      text,
    })),
    ...(config.ratelimits ?? []).map((binding) => ({
      type: "ratelimit",
      name: binding.name,
      namespace_id: binding.namespace_id,
      simple: binding.simple,
    })),
  ];
}

async function enableExactVersionPreviews() {
  const current = await cloudflare("/subdomain");
  if (current.previews_enabled) return;
  await cloudflare("/subdomain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: Boolean(current.enabled),
      previews_enabled: true,
    }),
  });
}

async function getExactVersionPreviewUrl(versionId) {
  const versions = await accountCloudflare(
    `/workers/workers/${scriptName}/versions`,
  );
  const version = versions.find((entry) => entry.id === versionId);
  const previewUrl = version?.urls?.find((url) =>
    url.startsWith("https://"),
  );
  if (!previewUrl) {
    throw new Error(
      `Cloudflare did not expose an exact preview URL for version ${versionId}.`,
    );
  }
  return new URL(previewUrl).origin;
}

const deploymentList = await cloudflare("/deployments");
const activeDeployment =
  deploymentList.deployments?.[0] ?? deploymentList[0];
const stableVersion = activeDeployment?.versions
  ?.slice()
  .sort((left, right) => right.percentage - left.percentage)[0]?.version_id;
if (!stableVersion) {
  throw new Error("No active Worker version is available for rollback.");
}

await enableExactVersionPreviews();

const metadata = {
  main_module: "worker.js",
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  bindings: deploymentBindings(),
  observability: config.observability,
  annotations: {
    "workers/message": releaseMessage,
    "workers/tag": `v${packageJson.version}`,
  },
};
const form = new FormData();
form.append(
  "metadata",
  new Blob([JSON.stringify(metadata)], { type: "application/json" }),
);
form.append(
  "worker.js",
  new Blob([readFileSync(workerPath)], {
    type: "application/javascript+module",
  }),
  "worker.js",
);

const uploaded = await cloudflare("/versions?bindings_inherit=strict", {
  method: "POST",
  body: form,
});
const newVersion = uploaded.id;
if (!newVersion) throw new Error("Cloudflare did not return a Worker version ID.");
const previewUrl = await getExactVersionPreviewUrl(newVersion);

let staged = false;
let stagedDeployment;
try {
  stagedDeployment = await createDeployment(
    [
      { version_id: stableVersion, percentage: 100 },
      { version_id: newVersion, percentage: 0 },
    ],
    `${releaseMessage} (smoke test)`,
  );
  staged = true;

  // A newly created split deployment can take several seconds to propagate
  // globally before the version-override header is honored.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  await verifyLive({
    baseUrl: previewUrl,
    expectedVersion: packageJson.version,
    expectedResourceUrl: config.vars.WORKOS_RESOURCE_URI,
    scriptName,
    attempts: 20,
  });
} catch (error) {
  if (staged) {
    try {
      await createDeployment(
        [{ version_id: stableVersion, percentage: 100 }],
        `Automatic rollback after failed ${releaseMessage}`,
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Deployment and automatic rollback both failed.",
      );
    }
  }
  throw error;
}

const result = {
  success: true,
  status: "staged",
  release: packageJson.version,
  previous_version: stableVersion,
  version: newVersion,
  preview_url: previewUrl,
  verification_method: "exact-version-preview",
  staged_deployment: stagedDeployment?.id ?? null,
  production_deployment: null,
  verified_at: new Date().toISOString(),
};
const reportDirectory = resolve(project, "db", "reports", "generated");
mkdirSync(reportDirectory, { recursive: true });
writeFileSync(
  resolve(
    reportDirectory,
    `release-candidate-${packageJson.version}.json`,
  ),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
