import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyLive } from "./verify-live.mjs";

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
const packageJson = JSON.parse(
  readFileSync(resolve(project, "worker", "package.json"), "utf8"),
);
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const token = env.CLOUDFLARE_API_TOKEN;
const scriptName = config.name;
const workerPath = resolve(project, "worker", "dist", "worker.js");
const baseUrl = new URL(config.vars.WORKOS_RESOURCE_URI).origin;
const releaseMessage = `Release v${packageJson.version}: production hardening`;
const apiBase =
  `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
  `/workers/scripts/${scriptName}`;

if (!accountId || !token) {
  throw new Error("Cloudflare deployment credentials are not configured.");
}
if (!scriptName || !config.main || !config.compatibility_date) {
  throw new Error("Wrangler configuration is incomplete.");
}

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

async function cloudflare(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Cloudflare API request failed (${response.status} ${path}): ` +
        `${JSON.stringify(payload.errors ?? [])}`,
    );
  }
  return payload.result;
}

async function createDeployment(versions, message) {
  return cloudflare("/deployments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "percentage",
      versions,
      annotations: { "workers/message": message },
    }),
  });
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

let staged = false;
let stagedDeployment;
let promotedDeployment;
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
    baseUrl,
    expectedVersion: packageJson.version,
    versionId: newVersion,
    scriptName,
    attempts: 20,
  });

  promotedDeployment = await createDeployment(
    [{ version_id: newVersion, percentage: 100 }],
    releaseMessage,
  );
  // The active deployment pointer can take materially longer than an override
  // to converge across custom-domain edges.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
  await verifyLive({
    baseUrl,
    expectedVersion: packageJson.version,
    scriptName,
    attempts: 50,
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
  release: packageJson.version,
  previous_version: stableVersion,
  version: newVersion,
  staged_deployment: stagedDeployment?.id ?? null,
  production_deployment: promotedDeployment?.id ?? null,
  verified_at: new Date().toISOString(),
};
const reportDirectory = resolve(project, "db", "reports", "generated");
mkdirSync(reportDirectory, { recursive: true });
writeFileSync(
  resolve(reportDirectory, `release-${packageJson.version}.json`),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
