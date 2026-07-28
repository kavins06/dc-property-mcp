import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import { verifyLive } from "./verify-live.mjs";

const project = resolve(import.meta.dirname, "..");

const env = parseEnv(
  readFileSync(resolve(project, ".env.hosted"), "utf8"),
);
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
if (!accountId || !token) {
  throw new Error("Cloudflare deployment credentials are not configured.");
}
const {
  request: cloudflare,
  createDeployment,
} = createCloudflareClient({ accountId, token, scriptName });
if (
  candidate.status !== "staged" ||
  candidate.release !== packageJson.version ||
  !candidate.version ||
  !candidate.previous_version ||
  !candidate.preview_url ||
  candidate.verification_method !== "exact-version-preview"
) {
  throw new Error("The staged Worker candidate report is invalid.");
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
