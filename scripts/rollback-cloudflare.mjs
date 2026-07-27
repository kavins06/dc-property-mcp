import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const env = Object.fromEntries(
  readFileSync(resolve(project, ".env.hosted"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const config = JSON.parse(
  readFileSync(resolve(project, "worker", "wrangler.jsonc"), "utf8"),
);
const api =
  `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}` +
  `/workers/scripts/${config.name}`;
const headers = {
  Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
  "Content-Type": "application/json",
};

async function cloudflare(path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Cloudflare rollback request failed (${response.status}): ` +
        `${JSON.stringify(payload.errors ?? [])}`,
    );
  }
  return payload.result;
}

async function deploy(versionId, message) {
  return cloudflare("/deployments", {
    method: "POST",
    body: JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { "workers/message": message },
    }),
  });
}

const deployments = await cloudflare("/deployments");
const previousVersion =
  deployments.deployments?.[0]?.versions
    ?.slice()
    .sort((left, right) => right.percentage - left.percentage)[0]?.version_id;
if (!previousVersion) throw new Error("Could not resolve the current Worker version.");

try {
  const deployment = await deploy(
    targetVersion,
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
  await deploy(previousVersion, "Automatic recovery after failed manual rollback");
  throw error;
}
