import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHealthyObservation,
  assertHealthyWorker,
  compareAuthenticatedReceipts,
  summarizeHyperdrive,
  summarizeWorker,
} from "../observe-neon-gate5.mjs";
import { CANDIDATE_VERSION, STABLE_VERSION } from "../rollout-neon-gate5.mjs";
import { EXPECTED_TOOLS } from "../rollout-neon-gate5.mjs";

const receipt = (override, timing = 100) => ({
  passed: true,
  endpoint: "https://mcp.quoindata.com/mcp",
  worker_version_override: override,
  service_version: "0.4.10",
  tool_count: 15,
  warmup_completed: true,
  tools: EXPECTED_TOOLS,
  statuses: Object.fromEntries(EXPECTED_TOOLS.map((name) => [name, "ok"])),
  response_sha256: Object.fromEntries(EXPECTED_TOOLS.map((name) => [name, "a".repeat(64)])),
  timings_ms: Object.fromEntries(EXPECTED_TOOLS.map((name) => [name, timing])),
  verified_at: "2026-08-22T03:15:00Z",
});

test("Worker telemetry requires finite volume and a bounded error rate", () => {
  const groups = (value, status = 200, outcome = "ok") => [{
    groups: [
      { key: "$workers.scriptVersion.id", value: CANDIDATE_VERSION },
      { key: "$workers.event.response.status", value: status },
      { key: "$workers.outcome", value: outcome },
    ],
    value,
  }];
  const calculations = [
    { alias: "requests", aggregates: groups(20) },
    { alias: "cpu_p50_ms", aggregates: groups(2) },
    { alias: "cpu_p99_ms", aggregates: groups(8) },
    { alias: "wall_p95_ms", aggregates: groups(100) },
  ];
  const metrics = summarizeWorker(calculations, CANDIDATE_VERSION);
  assert.deepEqual(metrics, {
    version_id: CANDIDATE_VERSION,
    requests: 20,
    successful_requests: 20,
    errors: 0,
    error_rate: 0,
    status_counts: { 200: 20 },
    outcome_counts: { ok: 20 },
    status_outcome_counts: { "200|ok": 20 },
    cpu_time_p50_ms: 2,
    cpu_time_p99_ms: 8,
    wall_time_p95_ms: 100,
  });
  assert.doesNotThrow(() => assertHealthyWorker(metrics));
  assert.throws(() => summarizeWorker(calculations, STABLE_VERSION), /no Worker telemetry/);
  assert.throws(() => assertHealthyWorker({ ...metrics, errors: 1, error_rate: 0.05 }), /thresholds/);
});

test("authenticated parity requires identical responses and bounded Neon p95", () => {
  const now = Date.parse("2026-08-22T03:30:00Z");
  assert.deepEqual(compareAuthenticatedReceipts(receipt(null), receipt(CANDIDATE_VERSION, 150), now), {
    hashes_match: true,
    stable_p95_ms: 100,
    candidate_p95_ms: 150,
  });
  assert.throws(
    () => compareAuthenticatedReceipts(receipt(null), receipt(CANDIDATE_VERSION, 250), now),
    /parity failed/,
  );
  assert.throws(
    () => compareAuthenticatedReceipts(
      { ...receipt(null), verified_at: "2026-08-22T02:59:59Z" },
      receipt(CANDIDATE_VERSION),
      now,
      30 * 60 * 1000,
    ),
    /fresh, complete/,
  );
});

test("Hyperdrive summaries are weighted and unhealthy observations fail closed", () => {
  const metrics = summarizeHyperdrive(
    [
      { count: 9, avg: { queryLatency: 100, connectionLatency: 20 }, dimensions: { eventStatus: "complete" } },
      { count: 1, avg: { queryLatency: 200, connectionLatency: 40 }, dimensions: { eventStatus: "error" } },
    ],
    [{ max: { waitingClients: 0, currentPoolSize: 4, maxPoolSize: 10 } }],
  );
  assert.equal(metrics.average_query_latency_ms, 100);
  assert.equal(metrics.error_rate, 0.1);
  assert.throws(() => assertHealthyObservation(metrics, 10), /thresholds/);
  assert.doesNotThrow(() =>
    assertHealthyObservation({ ...metrics, errors: 0, error_rate: 0, peak_open_connections: 3 }, 10),
  );
  assert.throws(
    () => summarizeHyperdrive([{ count: Number.NaN }], []),
    /incomplete|invalid/,
  );
});
