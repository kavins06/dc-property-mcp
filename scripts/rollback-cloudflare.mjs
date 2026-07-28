import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import { verifyLive } from "./verify-live.mjs";

const project = resolve(import.meta.dirname, "..");
const targetVersion = process.argv[2];
const expectedServiceVersion = process.argv[3];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    targetVersion ?? "",
  ) ||
  !/^\d+\.\d+\.\d+$/.test(expectedServiceVersion ?? "") ||
  !process.argv.includes("--confirm")
) {
  throw new Error(
    "Usage: rollback-cloudflare.mjs <version-id> <service-version> --confirm",
  );
}

const env = parseEnv(
  readFileSync(resolve(project, ".env.hosted"), "utf8"),
);
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
  });
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
