import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import { verifyLive } from "./verify-live.mjs";

export const STABLE_VERSION = "bfb184ec-dc18-4b63-aab0-30c320b17cf7";
export const CANDIDATE_VERSION = "d188a0c0-6f95-4b29-8fe3-0d7b68e92a43";
export const HETZNER_HYPERDRIVE = "5fd47b059f824188998ad4ce9dc4503c";
export const NEON_HYPERDRIVE = "d4524b1f397a454da9f9b37105d8d399";
export const NEXT_PERCENTAGE = new Map([
  [0, 1],
  [1, 5],
  [5, 25],
  [25, 50],
  [50, 100],
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export function split(candidatePercentage) {
  return [
    { version_id: STABLE_VERSION, percentage: 100 - candidatePercentage },
    { version_id: CANDIDATE_VERSION, percentage: candidatePercentage },
  ];
}

export function assertDeployment(deployment, candidatePercentage, expectedId) {
  if (!deployment || deployment.id !== expectedId) {
    throw new Error("The active deployment ID changed.");
  }
  const actual = new Map(
    (deployment.versions ?? []).map(({ version_id, percentage }) => [
      version_id,
      percentage,
    ]),
  );
  const expected = new Map(
    split(candidatePercentage).map(({ version_id, percentage }) => [
      version_id,
      percentage,
    ]),
  );
  if (
    actual.size !== expected.size ||
    [...expected].some(([id, percentage]) => actual.get(id) !== percentage)
  ) {
    throw new Error("The active Worker split changed.");
  }
}

export function validateAuthenticatedReceipt(receipt, now = Date.now()) {
  const verifiedAt = Date.parse(receipt?.verified_at ?? "");
  const statuses = Object.values(receipt?.statuses ?? {});
  const hashes = Object.values(receipt?.response_sha256 ?? {});
  if (
    receipt?.passed !== true ||
    receipt?.endpoint !== "https://mcp.quoindata.com/mcp" ||
    receipt?.worker_version_override !== CANDIDATE_VERSION ||
    receipt?.tool_count !== 15 ||
    statuses.length !== 15 ||
    statuses.some((status) => !["ok", "resolved"].includes(status)) ||
    hashes.length !== 15 ||
    hashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash)) ||
    !Number.isFinite(verifiedAt) ||
    now - verifiedAt < 0 ||
    now - verifiedAt > 30 * 60 * 1000
  ) {
    throw new Error("A fresh, complete candidate authentication receipt is required.");
  }
}

export function assertVersionPair(stable, candidate) {
  const binding = (version, name) =>
    version?.resources?.bindings?.find((item) => item.name === name);
  if (
    stable?.id !== STABLE_VERSION ||
    candidate?.id !== CANDIDATE_VERSION ||
    stable.resources?.script?.etag !== candidate.resources?.script?.etag ||
    binding(stable, "HYPERDRIVE")?.id !== HETZNER_HYPERDRIVE ||
    binding(candidate, "HYPERDRIVE")?.id !== NEON_HYPERDRIVE
  ) {
    throw new Error("The reviewed Worker/Hyperdrive pair changed.");
  }
  const normalized = (version) =>
    Object.fromEntries(
      version.resources.bindings.map((item) => [
        item.name,
        item.name === "HYPERDRIVE" ? { ...item, id: "<expected-difference>" } : item,
      ]),
    );
  if (JSON.stringify(normalized(stable)) !== JSON.stringify(normalized(candidate))) {
    throw new Error("Worker bindings differ beyond Hyperdrive.");
  }
}

function argumentsFrom(values) {
  const options = Object.fromEntries(
    values.flatMap((value, index) =>
      value.startsWith("--") && values[index + 1] && !values[index + 1].startsWith("--")
        ? [[value, values[index + 1]]]
        : [],
    ),
  );
  const from = Number(options["--from"]);
  const to = Number(options["--to"]);
  const expectedDeployment = options["--expected-deployment"];
  const receipt = options["--authenticated-receipt"];
  if (
    NEXT_PERCENTAGE.get(from) !== to ||
    !UUID.test(expectedDeployment ?? "") ||
    !receipt ||
    !values.includes("--confirm")
  ) {
    throw new Error(
      "Usage: rollout-neon-gate5.mjs --from <0|1|5|25|50> --to <next> " +
        "--expected-deployment <uuid> --authenticated-receipt <path> --confirm",
    );
  }
  return { from, to, expectedDeployment, receipt };
}

async function main() {
  const project = resolve(import.meta.dirname, "..");
  const options = argumentsFrom(process.argv.slice(2));
  const receiptPath = resolve(project, options.receipt);
  const reportRoot = resolve(project, "db", "reports", "generated");
  const reportRelative = relative(reportRoot, receiptPath);
  if (!reportRelative || reportRelative.startsWith("..") || resolve(reportRoot, reportRelative) !== receiptPath) {
    throw new Error("The authentication receipt must be under db/reports/generated.");
  }
  validateAuthenticatedReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));

  const env = {
    ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
    ...process.env,
  };
  const config = JSON.parse(readFileSync(resolve(project, "worker", "wrangler.jsonc"), "utf8"));
  const client = createCloudflareClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    scriptName: config.name,
  });
  const current = await client.request("/deployments");
  const active = (current.deployments ?? current)[0];
  assertDeployment(active, options.from, options.expectedDeployment);
  const [stable, candidate] = await Promise.all([
    client.request(`/versions/${STABLE_VERSION}`),
    client.request(`/versions/${CANDIDATE_VERSION}`),
  ]);
  assertVersionPair(stable, candidate);

  let deployment;
  try {
    deployment = await client.createDeployment(
      split(options.to),
      `Gate 5 Neon rollout: ${options.from}% -> ${options.to}%`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
    const after = await client.request("/deployments");
    assertDeployment((after.deployments ?? after)[0], options.to, deployment.id);
    await Promise.all([
      verifyLive({ expectedVersion: "0.4.10", versionId: STABLE_VERSION }),
      verifyLive({ expectedVersion: "0.4.10", versionId: CANDIDATE_VERSION }),
    ]);
  } catch (error) {
    const rollback = await client.createDeployment(
      split(options.from),
      `Gate 5 automatic rollback: ${options.to}% -> ${options.from}%`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
    const restored = await client.request("/deployments");
    assertDeployment((restored.deployments ?? restored)[0], options.from, rollback.id);
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      from_percentage: options.from,
      to_percentage: options.to,
      source_deployment: options.expectedDeployment,
      deployment: deployment.id,
      stable_version: STABLE_VERSION,
      candidate_version: CANDIDATE_VERSION,
      stable_hyperdrive: HETZNER_HYPERDRIVE,
      candidate_hyperdrive: NEON_HYPERDRIVE,
      verified_at: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
