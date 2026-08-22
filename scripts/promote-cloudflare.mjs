import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  assertExactDeployment,
  createCloudflareClient,
} from "./lib/cloudflare.mjs";
import { assertDmvPublicationApproval } from "./lib/dmv-publication-approval.mjs";
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
const candidatePath = resolve(
  project,
  "db",
  "reports",
  "generated",
  `release-candidate-${packageJson.version}.json`,
);
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const workerBytes = readFileSync(resolve(project, "worker", "dist", "worker.js"));
const bundleSha256 = createHash("sha256").update(workerBytes).digest("hex");
assertDmvPublicationApproval(env, { bundleSha256 });
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
  candidate.bundle_sha256 !== bundleSha256 ||
  candidate.verification_method !== "exact-version-override" ||
  !["stable_replacement", "candidate"].includes(candidate.release_role) ||
  (candidate.release_role === "candidate" && candidate.candidate_access_protected !== true)
) {
  throw new Error("The staged Worker candidate report is invalid.");
}

const deploymentList = await cloudflare("/deployments");
const activeDeployment =
  deploymentList.deployments?.[0] ?? deploymentList[0];
const stagedSplit = [
  { version_id: candidate.previous_version, percentage: 100 },
  { version_id: candidate.version, percentage: 0 },
];
assertExactDeployment(
  activeDeployment,
  candidate.staged_deployment,
  stagedSplit,
);

let promotedDeployment;
try {
  const promotionCheck = await cloudflare("/deployments");
  assertExactDeployment(
    promotionCheck.deployments?.[0] ?? promotionCheck[0],
    candidate.staged_deployment,
    stagedSplit,
  );
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
  const finalDeployment = await cloudflare("/deployments");
  assertExactDeployment(
    finalDeployment.deployments?.[0] ?? finalDeployment[0],
    promotedDeployment.id,
    [{ version_id: candidate.version, percentage: 100 }],
  );
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
  bundle_sha256: bundleSha256,
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
