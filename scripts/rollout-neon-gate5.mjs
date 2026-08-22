import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import { verifyLive } from "./verify-live.mjs";

export const STABLE_VERSION = "9881eb98-3fa1-4037-979d-4b9502f90b44";
export const CANDIDATE_VERSION = "b7e1a564-e4a1-4efc-a9dc-16e5faeec173";
export const CANDIDATE_ACCESS_SHA256 = "e831deebfa13c0308fb26c6a9628bdf86555588d2ebc8872f2efb8eff84cb553";
export const HETZNER_HYPERDRIVE = "5fd47b059f824188998ad4ce9dc4503c";
export const NEON_HYPERDRIVE = "d4524b1f397a454da9f9b37105d8d399";
export const NEXT_PERCENTAGE = new Map([
  [0, 1],
  [1, 5],
  [5, 25],
  [25, 50],
  [50, 100],
]);
export const MINIMUM_STAGE_MINUTES = new Map([
  [0, 2],
  [1, 2],
  [5, 2],
  [25, 2],
  [50, 2],
  [100, 5],
]);
export const EXPECTED_TOOLS = [
  "describe_data",
  "get_assessment_history",
  "get_building_and_land_profile",
  "get_complete_property_record",
  "get_inspection_and_enforcement_history",
  "get_latest_sale_and_deed",
  "get_license_history",
  "get_ownership_and_sale",
  "get_permit_history",
  "get_property_snapshot",
  "get_source_evidence",
  "get_tax_and_balance_history",
  "resolve_properties_batch",
  "resolve_property",
  "search_properties",
];

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
  const versions = deployment.versions ?? [];
  if (
    deployment.strategy !== "percentage" ||
    versions.length !== 2 ||
    new Set(versions.map(({ version_id }) => version_id)).size !== 2 ||
    versions.some(
      ({ percentage }) =>
        !Number.isInteger(percentage) || percentage < 0 || percentage > 100,
    ) ||
    versions.reduce((total, { percentage }) => total + percentage, 0) !== 100
  ) {
    throw new Error("The active Worker deployment is malformed.");
  }
  const actual = new Map(
    versions.map(({ version_id, percentage }) => [
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

export function validateAuthenticatedReceipt(
  receipt,
  now = Date.now(),
  maximumAgeMs = 24 * 60 * 60 * 1000,
) {
  const verifiedAt = Date.parse(receipt?.verified_at ?? "");
  const statusEntries = Object.entries(receipt?.statuses ?? {}).sort();
  const hashEntries = Object.entries(receipt?.response_sha256 ?? {}).sort();
  const timingEntries = Object.entries(receipt?.timings_ms ?? {}).sort();
  const toolNames = [...(receipt?.tools ?? [])].sort();
  const expected = EXPECTED_TOOLS.slice().sort();
  if (
    receipt?.passed !== true ||
    receipt?.service_version !== "0.4.10" ||
    receipt?.endpoint !== "https://mcp.quoindata.com/mcp" ||
    receipt?.worker_version_override !== CANDIDATE_VERSION ||
    receipt?.tool_count !== 15 ||
    receipt?.warmup_completed !== true ||
    JSON.stringify(toolNames) !== JSON.stringify(expected) ||
    JSON.stringify(statusEntries.map(([name]) => name)) !== JSON.stringify(expected) ||
    JSON.stringify(hashEntries.map(([name]) => name)) !== JSON.stringify(expected) ||
    JSON.stringify(timingEntries.map(([name]) => name)) !== JSON.stringify(expected) ||
    statusEntries.some(([, status]) => !["ok", "resolved"].includes(status)) ||
    hashEntries.some(([, hash]) => typeof hash !== "string" || !SHA256.test(hash)) ||
    timingEntries.some(([, timing]) => !Number.isFinite(timing) || timing < 0) ||
    !Number.isFinite(verifiedAt) ||
    now - verifiedAt < 0 ||
    now - verifiedAt > maximumAgeMs
  ) {
    throw new Error("A fresh, complete candidate authentication receipt is required.");
  }
}

export function validateObservationReceipt(
  receipt,
  percentage,
  deploymentId,
  deploymentCreatedAt,
  authenticatedReceiptSha256,
  authenticatedReceiptVerifiedAt,
  now = Date.now(),
) {
  const observedAt = Date.parse(receipt?.observed_at ?? "");
  const windowStart = Date.parse(receipt?.window?.start ?? "");
  const windowEnd = Date.parse(receipt?.window?.end ?? "");
  const createdAt = Date.parse(deploymentCreatedAt ?? "");
  const parity = receipt?.authenticated_parity ?? {};
  const neon = receipt?.hyperdrive?.neon ?? {};
  const worker = receipt?.worker ?? {};
  const authenticatedCandidate = receipt?.authenticated_receipts?.candidate ?? {};
  const thresholds = receipt?.thresholds ?? {};
  const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const validHyperdrive = (metrics) =>
    finite(metrics?.queries) && metrics.queries >= 15 &&
    finite(metrics?.errors) && metrics.errors <= metrics.queries &&
    finite(metrics?.error_rate) &&
    Math.abs(metrics.error_rate - metrics.errors / metrics.queries) < 1e-12 &&
    metrics.error_rate <= 0.01 &&
    finite(metrics?.average_query_latency_ms) && metrics.average_query_latency_ms <= 3000 &&
    finite(metrics?.peak_waiting_clients) && metrics.peak_waiting_clients === 0 &&
    finite(metrics?.peak_open_connections) &&
    finite(metrics?.maximum_pool_size) && metrics.maximum_pool_size > 0 &&
    metrics.peak_open_connections / metrics.maximum_pool_size < 0.9;
  const validWorker = (metrics, versionId) => {
    const statusCounts = Object.entries(metrics?.status_counts ?? {});
    const outcomeCounts = Object.entries(metrics?.outcome_counts ?? {});
    const statusTotal = statusCounts.reduce((total, [, count]) => total + (finite(count) ? count : NaN), 0);
    const outcomeTotal = outcomeCounts.reduce((total, [, count]) => total + (finite(count) ? count : NaN), 0);
    const crossTab = Object.entries(metrics?.status_outcome_counts ?? {});
    const crossTabTotal = crossTab.reduce((total, [, count]) => total + (finite(count) ? count : NaN), 0);
    const crossStatusCounts = {};
    const crossOutcomeCounts = {};
    const exactErrors = crossTab.reduce((total, [key, count]) => {
      const [status, outcome] = key.split("|");
      crossStatusCounts[status] = (crossStatusCounts[status] ?? 0) + count;
      crossOutcomeCounts[outcome] = (crossOutcomeCounts[outcome] ?? 0) + count;
      return total + (Number(status) >= 500 || outcome !== "ok" ? count : 0);
    }, 0);
    const sortedEntries = (record) => JSON.stringify(Object.entries(record).sort());
    return metrics?.version_id === versionId &&
      finite(metrics.requests) && metrics.requests >= 15 &&
      finite(metrics.successful_requests) && metrics.successful_requests >= 15 &&
      metrics.successful_requests <= metrics.requests &&
      finite(metrics.errors) && metrics.errors <= metrics.requests &&
      finite(metrics.error_rate) &&
      Math.abs(metrics.error_rate - metrics.errors / metrics.requests) < 1e-12 &&
      metrics.error_rate <= 0.01 &&
      statusTotal === metrics.requests && outcomeTotal === metrics.requests &&
      crossTabTotal === metrics.requests && metrics.errors === exactErrors &&
      sortedEntries(crossStatusCounts) === sortedEntries(metrics.status_counts) &&
      sortedEntries(crossOutcomeCounts) === sortedEntries(metrics.outcome_counts) &&
      finite(metrics.cpu_time_p50_ms) && finite(metrics.cpu_time_p99_ms) &&
      finite(metrics.wall_time_p95_ms) && metrics.wall_time_p95_ms <= 3000;
  };
  if (
    receipt?.passed !== true ||
    receipt?.deployment !== deploymentId ||
    receipt?.candidate_percentage !== percentage ||
    receipt?.deployment_created_at !== deploymentCreatedAt ||
    parity.hashes_match !== true ||
    !finite(parity.stable_p95_ms) ||
    !finite(parity.candidate_p95_ms) ||
    parity.candidate_p95_ms > 3000 ||
    parity.candidate_p95_ms > parity.stable_p95_ms * 2 ||
    authenticatedCandidate.sha256 !== authenticatedReceiptSha256 ||
    authenticatedCandidate.verified_at !== authenticatedReceiptVerifiedAt ||
    !validHyperdrive(receipt?.hyperdrive?.hetzner) ||
    !validHyperdrive(neon) ||
    !validWorker(worker.stable, STABLE_VERSION) ||
    !validWorker(worker.candidate, CANDIDATE_VERSION) ||
    worker.candidate.cpu_time_p99_ms > Math.max(5, worker.stable.cpu_time_p99_ms * 2) ||
    worker.candidate.wall_time_p95_ms > Math.max(100, worker.stable.wall_time_p95_ms * 2) ||
    receipt?.cost_signal !== "request/query volume recorded; provider billing signals reviewed during supervised cutover" ||
    thresholds.minimum_neon_queries !== 15 ||
    thresholds.maximum_error_rate !== 0.01 ||
    thresholds.maximum_average_query_latency_ms !== 3000 ||
    thresholds.maximum_waiting_clients !== 0 ||
    thresholds.maximum_pool_utilization_exclusive !== 0.9 ||
    thresholds.minimum_worker_requests !== 15 ||
    thresholds.maximum_worker_error_rate !== 0.01 ||
    thresholds.maximum_worker_wall_time_p95_ms !== 3000 ||
    thresholds.maximum_candidate_to_stable_worker_regression !== 2 ||
    thresholds.minimum_stage_minutes !== MINIMUM_STAGE_MINUTES.get(percentage) ||
    !Number.isFinite(windowStart) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(windowEnd) ||
    !Number.isFinite(createdAt) ||
    windowStart < createdAt ||
    windowEnd - windowStart < MINIMUM_STAGE_MINUTES.get(percentage) * 60 * 1000 ||
    observedAt < windowEnd ||
    now - observedAt < 0 ||
    now - observedAt > 30 * 60 * 1000 ||
    now - windowEnd < 0 ||
    now - windowEnd > 30 * 60 * 1000
  ) {
    throw new Error("A fresh observation of the exact active deployment is required.");
  }
}

export async function waitForDeployment(client, candidatePercentage, expectedId) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const current = await client.request("/deployments");
      const active = (current.deployments ?? current)[0];
      assertDeployment(active, candidatePercentage, expectedId);
      return active;
    } catch (error) {
      lastError = error;
      if (attempt < 11) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
    }
  }
  throw lastError;
}

export function assertVersionPair(stable, candidate) {
  const binding = (version, name) =>
    version?.resources?.bindings?.find((item) => item.name === name);
  if (
    stable?.id !== STABLE_VERSION ||
    candidate?.id !== CANDIDATE_VERSION ||
    stable.resources?.script?.etag !== candidate.resources?.script?.etag ||
    binding(stable, "HYPERDRIVE")?.id !== HETZNER_HYPERDRIVE ||
    binding(candidate, "HYPERDRIVE")?.id !== NEON_HYPERDRIVE ||
    binding(stable, "CANDIDATE_ACCESS_SHA256") !== undefined ||
    binding(candidate, "CANDIDATE_ACCESS_SHA256")?.text !== CANDIDATE_ACCESS_SHA256
  ) {
    throw new Error("The reviewed Worker/Hyperdrive pair changed.");
  }
  const normalized = (version) =>
    Object.fromEntries(
      version.resources.bindings
        .filter((item) => item.name !== "CANDIDATE_ACCESS_SHA256")
        .map((item) => [
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
  const observation = options["--observation-receipt"];
  if (
    NEXT_PERCENTAGE.get(from) !== to ||
    !UUID.test(expectedDeployment ?? "") ||
    !receipt ||
    !observation ||
    !values.includes("--confirm")
  ) {
    throw new Error(
      "Usage: rollout-neon-gate5.mjs --from <0|1|5|25|50> --to <next> " +
        "--expected-deployment <uuid> --authenticated-receipt <path> " +
        "--observation-receipt <path> --confirm",
    );
  }
  return { from, to, expectedDeployment, receipt, observation };
}

async function main() {
  const project = resolve(import.meta.dirname, "..");
  const options = argumentsFrom(process.argv.slice(2));
  const receiptPath = realpathSync(resolve(project, options.receipt));
  const reportRoot = realpathSync(resolve(project, "db", "reports", "generated"));
  const reportRelative = relative(reportRoot, receiptPath);
  if (!reportRelative || reportRelative.startsWith("..") || resolve(reportRoot, reportRelative) !== receiptPath) {
    throw new Error("The authentication receipt must be under db/reports/generated.");
  }
  const authenticatedReceiptBytes = readFileSync(receiptPath);
  const authenticatedReceipt = JSON.parse(authenticatedReceiptBytes.toString("utf8"));
  const authenticatedReceiptSha256 = createHash("sha256")
    .update(authenticatedReceiptBytes)
    .digest("hex");
  validateAuthenticatedReceipt(
    authenticatedReceipt,
    Date.now(),
    options.from === 0 ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000,
  );
  const observationPath = realpathSync(resolve(project, options.observation));
  const observationRelative = relative(reportRoot, observationPath);
  if (
    !observationRelative ||
    observationRelative.startsWith("..") ||
    resolve(reportRoot, observationRelative) !== observationPath
  ) {
    throw new Error("The observation receipt must be under db/reports/generated.");
  }
  const observationReceipt = JSON.parse(readFileSync(observationPath, "utf8"));

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
  validateObservationReceipt(
    observationReceipt,
    options.from,
    options.expectedDeployment,
    active.created_on,
    authenticatedReceiptSha256,
    authenticatedReceipt.verified_at,
  );
  const [stable, candidate] = await Promise.all([
    client.request(`/versions/${STABLE_VERSION}`),
    client.request(`/versions/${CANDIDATE_VERSION}`),
  ]);
  assertVersionPair(stable, candidate);
  const promotionCheck = await client.request("/deployments");
  assertDeployment(
    (promotionCheck.deployments ?? promotionCheck)[0],
    options.from,
    options.expectedDeployment,
  );

  let deployment;
  try {
    deployment = await client.createDeployment(
      split(options.to),
      `Gate 5 Neon rollout: ${options.from}% -> ${options.to}%`,
    );
    await waitForDeployment(client, options.to, deployment.id);
    await Promise.all([
      verifyLive({ expectedVersion: "0.4.10", versionId: STABLE_VERSION }),
      verifyLive({ expectedVersion: "0.4.10", versionId: CANDIDATE_VERSION }),
    ]);
    await verifyLive({ expectedVersion: "0.4.10" });
    const finalDeployment = await client.request("/deployments");
    assertDeployment(
      (finalDeployment.deployments ?? finalDeployment)[0],
      options.to,
      deployment.id,
    );
  } catch (error) {
    try {
      const rollback = await client.createDeployment(
        split(options.from),
        `Gate 5 automatic rollback: ${options.to}% -> ${options.from}%`,
      );
      await waitForDeployment(client, options.from, rollback.id);
      await verifyLive({ expectedVersion: "0.4.10" });
    } catch (rollbackError) {
      let observed = "unavailable";
      try {
        const current = await client.request("/deployments");
        observed = JSON.stringify((current.deployments ?? current)[0]);
      } catch {}
      throw new AggregateError(
        [error, rollbackError],
        `Promotion failed and rollback could not be proven; active deployment: ${observed}`,
      );
    }
    throw error;
  }

  const report = {
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
    };
  mkdirSync(reportRoot, { recursive: true });
  const stamp = report.verified_at.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const reportPath = resolve(reportRoot, `neon-gate5-rollout-${options.to}pct-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, report: reportPath }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
