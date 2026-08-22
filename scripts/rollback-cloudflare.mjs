import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  assertExactDeployment,
  assertVersionBindings,
  createCloudflareClient,
} from "./lib/cloudflare.mjs";
import { assertDmvPublicationApproval } from "./lib/dmv-publication-approval.mjs";
import { verifyLive } from "./verify-live.mjs";

const project = resolve(import.meta.dirname, "..");
const targetVersion = process.argv[2];
const expectedServiceVersion = process.argv[3];
const expectedHyperdrive = process.argv[4];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    targetVersion ?? "",
  ) ||
  !/^\d+\.\d+\.\d+$/.test(expectedServiceVersion ?? "") ||
  !/^[0-9a-f]{32}$/i.test(expectedHyperdrive ?? "") ||
  !process.argv.includes("--confirm")
) {
  throw new Error(
    "Usage: rollback-cloudflare.mjs <version-id> <service-version> <hyperdrive-id> --confirm",
  );
}

const env = {
  ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
  ...process.env,
};
assertDmvPublicationApproval(env);
const config = JSON.parse(
  readFileSync(resolve(project, "worker", "wrangler.jsonc"), "utf8"),
);
const {
  request: cloudflare,
  createDeployment,
} = createCloudflareClient({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  token: env.CLOUDFLARE_API_TOKEN,
  scriptName: config.name,
});

const deployments = await cloudflare("/deployments");
const target = await cloudflare(`/versions/${targetVersion}`);
assertVersionBindings(target, [
  { type: "hyperdrive", name: "HYPERDRIVE", id: expectedHyperdrive },
  ...(config.d1_databases ?? []).map((binding) => ({
    type: "d1",
    name: binding.binding,
    id: binding.database_id,
  })),
]);
const previousVersion =
  deployments.deployments?.[0]?.versions
    ?.slice()
    .sort((left, right) => right.percentage - left.percentage)[0]?.version_id;
if (!previousVersion) throw new Error("Could not resolve the current Worker version.");

try {
  const deployment = await createDeployment(
    [{ version_id: targetVersion, percentage: 100 }],
    `Manual rollback to ${expectedServiceVersion}`,
  );
  await verifyLive({
    expectedVersion: expectedServiceVersion,
    scriptName: config.name,
    versionId: targetVersion,
  });
  const finalDeployments = await cloudflare("/deployments");
  assertExactDeployment(
    finalDeployments.deployments?.[0] ?? finalDeployments[0],
    deployment.id,
    [{ version_id: targetVersion, percentage: 100 }],
  );
  process.stdout.write(
    `${JSON.stringify({
      success: true,
      deployment: deployment.id,
      previous_version: previousVersion,
      active_version: targetVersion,
    })}\n`,
  );
} catch (error) {
  await createDeployment(
    [{ version_id: previousVersion, percentage: 100 }],
    "Automatic recovery after failed manual rollback",
  );
  throw error;
}
