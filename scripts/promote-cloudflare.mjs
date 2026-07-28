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
const candidatePath = resolve(
  project,
  "db",
  "reports",
  "generated",
  `release-candidate-${packageJson.version}.json`,
);
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const token = env.CLOUDFLARE_API_TOKEN;
const scriptName = config.name;
const baseUrl = new URL(config.vars.WORKOS_RESOURCE_URI).origin;
const releaseMessage = `Release v${packageJson.version}: production hardening`;
const apiBase =
  `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
  `/workers/scripts/${scriptName}`;

if (!accountId || !token) {
  throw new Error("Cloudflare deployment credentials are not configured.");
}
if (
  candidate.status !== "staged" ||
  candidate.release !== packageJson.version ||
  !candidate.version ||
  !candidate.previous_version
) {
  throw new Error("The staged Worker candidate report is invalid.");
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
const activeVersionIds = new Set(
  (activeDeployment?.versions ?? []).map((entry) => entry.version_id),
);
if (
  !activeVersionIds.has(candidate.version) ||
  !activeVersionIds.has(candidate.previous_version)
) {
  throw new Error(
    "The active deployment no longer matches the staged candidate and rollback pair.",
  );
}

let promotedDeployment;
try {
  promotedDeployment = await createDeployment(
    [{ version_id: candidate.version, percentage: 100 }],
    releaseMessage,
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
  await verifyLive({
    baseUrl,
    expectedVersion: packageJson.version,
    scriptName,
    attempts: 50,
  });
} catch (error) {
  try {
    await createDeployment(
      [{ version_id: candidate.previous_version, percentage: 100 }],
      `Automatic rollback after failed ${releaseMessage}`,
    );
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "Promotion and automatic rollback both failed.",
    );
  }
  throw error;
}

const result = {
  success: true,
  status: "promoted",
  release: packageJson.version,
  previous_version: candidate.previous_version,
  version: candidate.version,
  staged_deployment: candidate.staged_deployment,
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
