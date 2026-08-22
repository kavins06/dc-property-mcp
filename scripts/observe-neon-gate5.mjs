import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import {
  CANDIDATE_VERSION,
  EXPECTED_TOOLS,
  HETZNER_HYPERDRIVE,
  MINIMUM_STAGE_MINUTES,
  NEON_HYPERDRIVE,
  STABLE_VERSION,
  assertDeployment,
  assertVersionPair,
} from "./rollout-neon-gate5.mjs";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const GRAPHQL_QUERY = `query Gate5Hyperdrive(
  $accountTag: string!
  $configId: string!
  $start: Time!
  $end: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      hyperdriveQueriesAdaptiveGroups(
        limit: 10000
        filter: {
          configId: $configId
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        count
        avg { connectionLatency queryLatency }
        dimensions { cacheStatus eventStatus }
      }
      hyperdrivePoolSizesAdaptiveGroups(
        limit: 10000
        filter: {
          configId: $configId
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        avg { currentPoolSize availablePoolSlots waitingClients }
        max { maxPoolSize currentPoolSize waitingClients }
        dimensions { coloCode }
      }
    }
  }
}`;
const WORKER_DATASET = "cloudflare-workers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function exactKeys(record) {
  return Object.keys(record ?? {}).sort();
}

function assertReceipt(receipt, expectedOverride, now, maximumAgeMs) {
  const expected = EXPECTED_TOOLS.slice().sort();
  const verifiedAt = Date.parse(receipt?.verified_at ?? "");
  if (
    receipt?.passed !== true ||
    receipt?.service_version !== "0.4.10" ||
    receipt?.endpoint !== "https://mcp.quoindata.com/mcp" ||
    receipt?.worker_version_override !== expectedOverride ||
    receipt?.tool_count !== expected.length ||
    receipt?.warmup_completed !== true ||
    JSON.stringify([...(receipt?.tools ?? [])].sort()) !== JSON.stringify(expected) ||
    JSON.stringify(exactKeys(receipt?.statuses)) !== JSON.stringify(expected) ||
    JSON.stringify(exactKeys(receipt?.response_sha256)) !== JSON.stringify(expected) ||
    JSON.stringify(exactKeys(receipt?.timings_ms)) !== JSON.stringify(expected) ||
    Object.values(receipt.statuses).some((status) => !["ok", "resolved"].includes(status)) ||
    Object.values(receipt.response_sha256).some(
      (hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash),
    ) ||
    Object.values(receipt.timings_ms).some((timing) => !Number.isFinite(timing) || timing < 0) ||
    !Number.isFinite(verifiedAt) ||
    now - verifiedAt < 0 ||
    now - verifiedAt > maximumAgeMs
  ) {
    throw new Error("A fresh, complete authenticated receipt is required.");
  }
}

export function compareAuthenticatedReceipts(
  stable,
  candidate,
  now = Date.now(),
  maximumAgeMs = 24 * 60 * 60 * 1000,
) {
  assertReceipt(stable, null, now, maximumAgeMs);
  assertReceipt(candidate, CANDIDATE_VERSION, now, maximumAgeMs);
  const stableHashes = stable?.response_sha256 ?? {};
  const candidateHashes = candidate?.response_sha256 ?? {};
  const stableTimings = Object.values(stable?.timings_ms ?? {});
  const candidateTimings = Object.values(candidate?.timings_ms ?? {});
  const stableP95 = percentile(stableTimings, 0.95);
  const candidateP95 = percentile(candidateTimings, 0.95);
  if (
    JSON.stringify(stable?.tools) !== JSON.stringify(candidate?.tools) ||
    JSON.stringify(stable?.statuses) !== JSON.stringify(candidate?.statuses) ||
    JSON.stringify(stableHashes) !== JSON.stringify(candidateHashes) ||
    stableP95 === null ||
    candidateP95 === null ||
    candidateP95 > 3000 ||
    candidateP95 > stableP95 * 2
  ) {
    throw new Error("Authenticated Hetzner/Neon correctness or latency parity failed.");
  }
  return { hashes_match: true, stable_p95_ms: stableP95, candidate_p95_ms: candidateP95 };
}

export function summarizeHyperdrive(queryGroups = [], poolGroups = []) {
  const numeric = (value, field) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Cloudflare returned an invalid ${field}.`);
    }
    return value;
  };
  if (!Array.isArray(queryGroups) || !Array.isArray(poolGroups) || !poolGroups.length) {
    throw new Error("Cloudflare returned incomplete Hyperdrive telemetry.");
  }
  for (const group of queryGroups) {
    numeric(group.count, "query count");
    if (group.dimensions?.eventStatus === "complete") {
      numeric(group.avg?.queryLatency, "query latency");
      numeric(group.avg?.connectionLatency, "connection latency");
    }
  }
  for (const group of poolGroups) {
    for (const field of ["waitingClients", "currentPoolSize", "maxPoolSize"]) {
      numeric(group.max?.[field], `pool ${field}`);
    }
  }
  const queries = queryGroups.reduce((total, group) => total + Number(group.count ?? 0), 0);
  const errors = queryGroups.reduce(
    (total, group) =>
      total + (group.dimensions?.eventStatus === "complete" ? 0 : Number(group.count ?? 0)),
    0,
  );
  const completeGroups = queryGroups.filter(
    (group) => group.dimensions?.eventStatus === "complete",
  );
  const completeQueries = completeGroups.reduce((total, group) => total + group.count, 0);
  const weighted = (field) =>
    completeQueries === 0
      ? null
      : completeGroups.reduce(
          (total, group) => total + group.avg[field] * group.count,
          0,
        ) / completeQueries;
  return {
    queries,
    errors,
    error_rate: queries === 0 ? null : errors / queries,
    average_query_latency_ms: weighted("queryLatency"),
    average_connection_latency_ms: weighted("connectionLatency"),
    peak_waiting_clients: Math.max(0, ...poolGroups.map((group) => Number(group.max?.waitingClients ?? 0))),
    peak_open_connections: Math.max(0, ...poolGroups.map((group) => Number(group.max?.currentPoolSize ?? 0))),
    maximum_pool_size: Math.max(0, ...poolGroups.map((group) => Number(group.max?.maxPoolSize ?? 0))),
  };
}

export function assertHealthyObservation(metrics, minimumQueries = 1) {
  if (
    metrics.queries < minimumQueries ||
    metrics.error_rate === null ||
    metrics.error_rate > 0.01 ||
    metrics.average_query_latency_ms === null ||
    metrics.average_query_latency_ms > 3000 ||
    metrics.peak_waiting_clients > 0 ||
    metrics.maximum_pool_size <= 0 ||
    metrics.peak_open_connections / metrics.maximum_pool_size >= 0.9
  ) {
    throw new Error("Hyperdrive observation did not satisfy the Gate 5 thresholds.");
  }
}

function groupValue(aggregate, key) {
  return aggregate.groups?.find((group) => group.key === key)?.value;
}

export function summarizeWorker(calculations = [], versionId) {
  const byAlias = new Map(calculations.map((calculation) => [calculation.alias, calculation.aggregates]));
  const requestGroups = byAlias.get("requests");
  if (!Array.isArray(requestGroups) || !requestGroups.length) {
    throw new Error("Cloudflare returned incomplete version-aware Worker telemetry.");
  }
  const finite = (value, field) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Cloudflare returned an invalid Worker ${field}.`);
    }
    return value;
  };
  const selected = requestGroups.filter(
    (aggregate) => groupValue(aggregate, "$workers.scriptVersion.id") === versionId,
  );
  if (!selected.length) throw new Error(`Cloudflare returned no Worker telemetry for ${versionId}.`);

  let requests = 0;
  let successfulRequests = 0;
  let errors = 0;
  const statusCounts = {};
  const outcomeCounts = {};
  const statusOutcomeCounts = {};
  for (const aggregate of selected) {
    const count = finite(aggregate.value, "request count");
    const status = groupValue(aggregate, "$workers.event.response.status");
    const outcome = groupValue(aggregate, "$workers.outcome");
    if (!Number.isInteger(status) || status < 100 || status > 599 || typeof outcome !== "string") {
      throw new Error("Cloudflare returned malformed Worker status telemetry.");
    }
    requests += count;
    statusCounts[status] = (statusCounts[status] ?? 0) + count;
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + count;
    const crossTabKey = `${status}|${outcome}`;
    statusOutcomeCounts[crossTabKey] = (statusOutcomeCounts[crossTabKey] ?? 0) + count;
    if (status >= 200 && status < 400 && outcome === "ok") successfulRequests += count;
    if (status >= 500 || outcome !== "ok") errors += count;
  }

  const metric = (alias) => {
    const groups = byAlias.get(alias);
    if (!Array.isArray(groups)) throw new Error(`Cloudflare omitted Worker ${alias}.`);
    const values = groups
      .filter((aggregate) => groupValue(aggregate, "$workers.scriptVersion.id") === versionId)
      .map((aggregate) => finite(aggregate.value, alias));
    if (!values.length) throw new Error(`Cloudflare omitted Worker ${alias} for ${versionId}.`);
    return Math.max(...values);
  };
  return {
    version_id: versionId,
    requests,
    successful_requests: successfulRequests,
    errors,
    error_rate: requests === 0 ? null : errors / requests,
    status_counts: statusCounts,
    outcome_counts: outcomeCounts,
    status_outcome_counts: statusOutcomeCounts,
    cpu_time_p50_ms: metric("cpu_p50_ms"),
    cpu_time_p99_ms: metric("cpu_p99_ms"),
    wall_time_p95_ms: metric("wall_p95_ms"),
  };
}

export function assertHealthyWorker(metrics, minimumSuccessfulRequests = 15) {
  if (
    metrics.successful_requests < minimumSuccessfulRequests ||
    metrics.error_rate === null ||
    metrics.error_rate > 0.01 ||
    metrics.wall_time_p95_ms > 3000
  ) {
    throw new Error("Version-aware Worker observation did not satisfy the Gate 5 thresholds.");
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
  const candidatePercentage = Number(options["--candidate-percentage"]);
  const expectedDeployment = options["--expected-deployment"];
  const stableReceipt = options["--stable-receipt"];
  const candidateReceipt = options["--candidate-receipt"];
  const start = new Date(options["--start"] ?? "");
  const end = new Date(options["--end"] ?? new Date());
  const minimumMinutes = MINIMUM_STAGE_MINUTES.get(candidatePercentage);
  if (
    ![0, 1, 5, 25, 50, 100].includes(candidatePercentage) ||
    !UUID.test(expectedDeployment ?? "") ||
    !stableReceipt ||
    !candidateReceipt ||
    !Number.isFinite(start.valueOf()) ||
    !Number.isFinite(end.valueOf()) ||
    end <= start ||
    end - start < minimumMinutes * 60 * 1000 ||
    end - start > 24 * 60 * 60 * 1000
  ) {
    throw new Error(
      "Usage: observe-neon-gate5.mjs --candidate-percentage <0|1|5|25|50|100> " +
        "--expected-deployment <uuid> --stable-receipt <path> --candidate-receipt <path> " +
        "--start <ISO timestamp> [--end <ISO timestamp>]",
    );
  }
  return { candidatePercentage, expectedDeployment, stableReceipt, candidateReceipt, start, end, minimumMinutes };
}

async function analytics(accountId, token, configId, start, end) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        accountTag: accountId,
        configId,
        start: start.toISOString(),
        end: end.toISOString(),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(`Cloudflare analytics failed: ${JSON.stringify(payload.errors ?? [])}`);
  }
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("Cloudflare analytics returned no account.");
  return summarizeHyperdrive(
    account.hyperdriveQueriesAdaptiveGroups,
    account.hyperdrivePoolSizesAdaptiveGroups,
  );
}

async function workerAnalytics(accountId, token, start, end) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
    {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      queryId: "quoin-gate5-version-status",
      timeframe: { from: start.valueOf(), to: end.valueOf() },
      view: "calculations",
      chart: false,
      chartType: "aggregate",
      ignoreSeries: true,
      dry: true,
      parameters: {
        datasets: [WORKER_DATASET],
        filterCombination: "and",
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: "dc-property-mcp" },
          { key: "$workers.eventType", operation: "eq", type: "string", value: "fetch" },
          { key: "$workers.event.request.url", operation: "includes", type: "string", value: "/mcp" },
          { key: "$workers.event.response.status", operation: "exists", type: "number" },
          { key: "$workers.outcome", operation: "exists", type: "string" },
        ],
        calculations: [
          { operator: "count", alias: "requests" },
          { operator: "median", key: "$workers.cpuTimeMs", keyType: "number", alias: "cpu_p50_ms" },
          { operator: "p99", key: "$workers.cpuTimeMs", keyType: "number", alias: "cpu_p99_ms" },
          { operator: "p95", key: "$workers.wallTimeMs", keyType: "number", alias: "wall_p95_ms" },
        ],
        groupBys: [
          { type: "string", value: "$workers.scriptVersion.id" },
          { type: "number", value: "$workers.event.response.status" },
          { type: "string", value: "$workers.outcome" },
        ],
        limit: 2000,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(`Cloudflare Worker analytics failed: ${JSON.stringify(payload.errors ?? [])}`);
  }
  return {
    stable: summarizeWorker(payload.result?.calculations, STABLE_VERSION),
    candidate: summarizeWorker(payload.result?.calculations, CANDIDATE_VERSION),
  };
}

async function main() {
  const project = resolve(import.meta.dirname, "..");
  const options = argumentsFrom(process.argv.slice(2));
  const reportDirectory = realpathSync(resolve(project, "db", "reports", "generated"));
  const receiptPath = (requested) => {
    const candidate = realpathSync(resolve(project, requested));
    const child = relative(reportDirectory, candidate);
    if (!child || child.startsWith("..") || resolve(reportDirectory, child) !== candidate) {
      throw new Error("Authentication receipts must be under db/reports/generated.");
    }
    return candidate;
  };
  const stableReceiptBytes = readFileSync(receiptPath(options.stableReceipt));
  const candidateReceiptBytes = readFileSync(receiptPath(options.candidateReceipt));
  const stableReceipt = JSON.parse(stableReceiptBytes.toString("utf8"));
  const candidateReceipt = JSON.parse(candidateReceiptBytes.toString("utf8"));
  const receiptMaximumAgeMs = options.candidatePercentage === 0
    ? 30 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  const parity = compareAuthenticatedReceipts(
    stableReceipt,
    candidateReceipt,
    Date.now(),
    receiptMaximumAgeMs,
  );
  const env = {
    ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
    ...process.env,
  };
  const client = createCloudflareClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    scriptName: "dc-property-mcp",
  });
  const deployments = await client.request("/deployments");
  const activeDeployment = (deployments.deployments ?? deployments)[0];
  assertDeployment(
    activeDeployment,
    options.candidatePercentage,
    options.expectedDeployment,
  );
  const deploymentCreatedAt = new Date(activeDeployment.created_on);
  if (
    !Number.isFinite(deploymentCreatedAt.valueOf()) ||
    options.start < deploymentCreatedAt ||
    options.end > new Date(Date.now() + 60_000)
  ) {
    throw new Error("The observation window is not bound to the active deployment.");
  }
  const [stableVersion, candidateVersion, stableMetrics, candidateMetrics, workerMetrics] = await Promise.all([
    client.request(`/versions/${STABLE_VERSION}`),
    client.request(`/versions/${CANDIDATE_VERSION}`),
    analytics(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, HETZNER_HYPERDRIVE, options.start, options.end),
    analytics(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, NEON_HYPERDRIVE, options.start, options.end),
    workerAnalytics(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN, options.start, options.end),
  ]);
  assertVersionPair(stableVersion, candidateVersion);
  assertHealthyObservation(stableMetrics, 15);
  assertHealthyObservation(candidateMetrics, 15);
  assertHealthyWorker(workerMetrics.stable, 15);
  assertHealthyWorker(workerMetrics.candidate, 15);
  if (
    workerMetrics.candidate.cpu_time_p99_ms > Math.max(5, workerMetrics.stable.cpu_time_p99_ms * 2) ||
    workerMetrics.candidate.wall_time_p95_ms > Math.max(100, workerMetrics.stable.wall_time_p95_ms * 2)
  ) {
    throw new Error("Candidate Worker CPU or wall-time regression exceeded the Gate 5 baseline.");
  }

  const report = {
    passed: true,
    deployment: options.expectedDeployment,
    deployment_created_at: activeDeployment.created_on,
    candidate_percentage: options.candidatePercentage,
    window: { start: options.start.toISOString(), end: options.end.toISOString() },
    authenticated_parity: parity,
    authenticated_receipts: {
      stable: {
        sha256: createHash("sha256").update(stableReceiptBytes).digest("hex"),
        verified_at: stableReceipt.verified_at,
      },
      candidate: {
        sha256: createHash("sha256").update(candidateReceiptBytes).digest("hex"),
        verified_at: candidateReceipt.verified_at,
      },
    },
    hyperdrive: { hetzner: stableMetrics, neon: candidateMetrics },
    worker: workerMetrics,
    cost_signal: "request/query volume recorded; provider billing signals reviewed during supervised cutover",
    thresholds: {
      minimum_neon_queries: 15,
      maximum_error_rate: 0.01,
      maximum_average_query_latency_ms: 3000,
      maximum_waiting_clients: 0,
      maximum_pool_utilization_exclusive: 0.9,
      minimum_worker_requests: 15,
      maximum_worker_error_rate: 0.01,
      maximum_worker_wall_time_p95_ms: 3000,
      maximum_candidate_to_stable_worker_regression: 2,
      minimum_stage_minutes: options.minimumMinutes,
    },
    observed_at: new Date().toISOString(),
  };
  mkdirSync(reportDirectory, { recursive: true });
  const stamp = report.observed_at.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const reportPath = resolve(reportDirectory, `neon-gate5-${options.candidatePercentage}pct-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, report: reportPath }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
