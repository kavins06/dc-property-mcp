import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_VERSION,
  CANDIDATE_ACCESS_SHA256,
  HETZNER_HYPERDRIVE,
  NEON_HYPERDRIVE,
  STABLE_VERSION,
  assertDeployment,
  assertVersionPair,
  split,
  validateAuthenticatedReceipt,
  validateObservationReceipt,
} from "../rollout-neon-gate5.mjs";
import { argumentsFrom as rollbackArgumentsFrom } from "../rollback-neon-gate5.mjs";

const version = (id, hyperdrive) => ({
  id,
  resources: {
    script: { etag: "same-code" },
    bindings: [
      { name: "A", type: "plain_text", text: "same" },
      { name: "HYPERDRIVE", type: "hyperdrive", id: hyperdrive },
      ...(id === CANDIDATE_VERSION ? [{
        name: "CANDIDATE_ACCESS_SHA256",
        type: "plain_text",
        text: CANDIDATE_ACCESS_SHA256,
      }] : []),
    ],
  },
});

test("Gate 5 accepts only the next reviewed split and exact deployment", () => {
  assert.deepEqual(split(25), [
    { version_id: STABLE_VERSION, percentage: 75 },
    { version_id: CANDIDATE_VERSION, percentage: 25 },
  ]);
  assert.doesNotThrow(() =>
    assertDeployment({ id: "deployment", strategy: "percentage", versions: split(25) }, 25, "deployment"),
  );
  assert.throws(
    () => assertDeployment({ id: "other", strategy: "percentage", versions: split(25) }, 25, "deployment"),
    /ID changed/,
  );
  assert.throws(
    () => assertDeployment({ id: "deployment", strategy: "percentage", versions: split(50) }, 25, "deployment"),
    /split changed/,
  );
  assert.throws(
    () =>
      assertDeployment(
        {
          id: "deployment",
          strategy: "percentage",
          versions: [...split(25), split(25)[0]],
        },
        25,
        "deployment",
      ),
    /malformed/,
  );
});

test("Gate 5 rollback accepts adjacent reversal or emergency zero only", () => {
  const deployment = "7149f90d-39da-4045-b8a1-54b79e622e78";
  assert.deepEqual(
    rollbackArgumentsFrom(["--from", "100", "--to", "50", "--expected-deployment", deployment, "--confirm"]),
    { from: 100, to: 50, expectedDeployment: deployment },
  );
  assert.deepEqual(
    rollbackArgumentsFrom(["--from", "100", "--to", "0", "--expected-deployment", deployment, "--confirm"]),
    { from: 100, to: 0, expectedDeployment: deployment },
  );
  assert.throws(
    () => rollbackArgumentsFrom(["--from", "25", "--to", "5", "--expected-deployment", deployment]),
    /Usage/,
  );
  assert.throws(
    () => rollbackArgumentsFrom(["--from", "0", "--to", "0", "--expected-deployment", deployment, "--confirm"]),
    /Usage/,
  );
});

test("Gate 5 binds byte-identical Workers only to the reviewed databases", () => {
  assert.doesNotThrow(() =>
    assertVersionPair(
      version(STABLE_VERSION, HETZNER_HYPERDRIVE),
      version(CANDIDATE_VERSION, NEON_HYPERDRIVE),
    ),
  );
  assert.throws(
    () =>
      assertVersionPair(
        version(STABLE_VERSION, HETZNER_HYPERDRIVE),
        version(CANDIDATE_VERSION, "wrong"),
      ),
    /pair changed/,
  );
});

test("Gate 5 requires a fresh complete authenticated candidate receipt", () => {
  const now = Date.parse("2026-08-22T03:30:00Z");
  const receipt = {
    passed: true,
    endpoint: "https://mcp.quoindata.com/mcp",
    worker_version_override: CANDIDATE_VERSION,
    service_version: "0.4.10",
    tool_count: 15,
    warmup_completed: true,
    tools: [
      "describe_data", "get_assessment_history", "get_building_and_land_profile",
      "get_complete_property_record", "get_inspection_and_enforcement_history",
      "get_latest_sale_and_deed", "get_license_history", "get_ownership_and_sale",
      "get_permit_history", "get_property_snapshot", "get_source_evidence",
      "get_tax_and_balance_history", "resolve_properties_batch", "resolve_property",
      "search_properties",
    ],
    statuses: Object.fromEntries(
      [
        "describe_data", "get_assessment_history", "get_building_and_land_profile",
        "get_complete_property_record", "get_inspection_and_enforcement_history",
        "get_latest_sale_and_deed", "get_license_history", "get_ownership_and_sale",
        "get_permit_history", "get_property_snapshot", "get_source_evidence",
        "get_tax_and_balance_history", "resolve_properties_batch", "resolve_property",
        "search_properties",
      ].map((name) => [name, "ok"]),
    ),
    response_sha256: Object.fromEntries(
      [
        "describe_data", "get_assessment_history", "get_building_and_land_profile",
        "get_complete_property_record", "get_inspection_and_enforcement_history",
        "get_latest_sale_and_deed", "get_license_history", "get_ownership_and_sale",
        "get_permit_history", "get_property_snapshot", "get_source_evidence",
        "get_tax_and_balance_history", "resolve_properties_batch", "resolve_property",
        "search_properties",
      ].map((name) => [name, "a".repeat(64)]),
    ),
    timings_ms: Object.fromEntries(
      [
        "describe_data", "get_assessment_history", "get_building_and_land_profile",
        "get_complete_property_record", "get_inspection_and_enforcement_history",
        "get_latest_sale_and_deed", "get_license_history", "get_ownership_and_sale",
        "get_permit_history", "get_property_snapshot", "get_source_evidence",
        "get_tax_and_balance_history", "resolve_properties_batch", "resolve_property",
        "search_properties",
      ].map((name) => [name, 100]),
    ),
    verified_at: "2026-08-22T03:15:00Z",
  };
  assert.doesNotThrow(() => validateAuthenticatedReceipt(receipt, now));
  assert.throws(
    () => validateAuthenticatedReceipt(
      { ...receipt, verified_at: "2026-08-22T02:59:59Z" },
      now,
      30 * 60 * 1000,
    ),
    /fresh, complete/,
  );
  assert.throws(
    () => validateAuthenticatedReceipt({ ...receipt, verified_at: "2026-08-20T02:00:00Z" }, now),
    /fresh, complete/,
  );
});

test("Gate 5 observation receipts bind the exact deployment and split", () => {
  const now = Date.parse("2026-08-22T04:00:00Z");
  const workerMetrics = (versionId, p99 = 8, wall = 100) => ({
    version_id: versionId,
    requests: 20,
    successful_requests: 20,
    errors: 0,
    error_rate: 0,
    status_counts: { 200: 20 },
    outcome_counts: { ok: 20 },
    status_outcome_counts: { "200|ok": 20 },
    cpu_time_p50_ms: 2,
    cpu_time_p99_ms: p99,
    wall_time_p95_ms: wall,
  });
  const hyperdriveMetrics = {
    queries: 20, errors: 0, error_rate: 0,
    average_query_latency_ms: 100, peak_waiting_clients: 0,
    peak_open_connections: 2, maximum_pool_size: 10,
  };
  const receipt = {
    passed: true,
    deployment: "deployment",
    deployment_created_at: "2026-08-22T03:00:00Z",
    candidate_percentage: 5,
    authenticated_parity: { hashes_match: true, stable_p95_ms: 100, candidate_p95_ms: 150 },
    authenticated_receipts: {
      candidate: { sha256: "a".repeat(64), verified_at: "2026-08-22T03:45:00Z" },
    },
    hyperdrive: {
      hetzner: hyperdriveMetrics,
      neon: hyperdriveMetrics,
    },
    worker: {
      stable: workerMetrics(STABLE_VERSION),
      candidate: workerMetrics(CANDIDATE_VERSION),
    },
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
      minimum_stage_minutes: 2,
    },
    window: { start: "2026-08-22T03:10:00Z", end: "2026-08-22T03:50:00Z" },
    observed_at: "2026-08-22T03:55:00Z",
  };
  assert.doesNotThrow(() =>
    validateObservationReceipt(
      receipt, 5, "deployment", receipt.deployment_created_at,
      "a".repeat(64), "2026-08-22T03:45:00Z", now,
    ),
  );
  assert.throws(
    () =>
      validateObservationReceipt(
        { ...receipt, candidate_percentage: 1 },
        5,
        "deployment",
        receipt.deployment_created_at,
        "a".repeat(64),
        "2026-08-22T03:45:00Z",
        now,
      ),
    /exact active deployment/,
  );
  assert.throws(
    () =>
      validateObservationReceipt(
        { passed: true, deployment: "deployment", candidate_percentage: 5 },
        5,
        "deployment",
        receipt.deployment_created_at,
        "a".repeat(64),
        "2026-08-22T03:45:00Z",
        now,
      ),
    /exact active deployment/,
  );
  assert.throws(
    () => validateObservationReceipt(
      { ...receipt, worker: { ...receipt.worker, candidate: { ...receipt.worker.candidate, errors: 999999 } } },
      5, "deployment", receipt.deployment_created_at,
      "a".repeat(64), "2026-08-22T03:45:00Z", now,
    ),
    /exact active deployment/,
  );
  assert.throws(
    () => validateObservationReceipt(
      { ...receipt, hyperdrive: { ...receipt.hyperdrive, neon: { ...hyperdriveMetrics, errors: 20, error_rate: 1 } } },
      5, "deployment", receipt.deployment_created_at,
      "a".repeat(64), "2026-08-22T03:45:00Z", now,
    ),
    /exact active deployment/,
  );
  assert.throws(
    () => validateObservationReceipt(
      {
        ...receipt,
        worker: {
          ...receipt.worker,
          candidate: { ...receipt.worker.candidate, status_counts: { 500: 20 } },
        },
      },
      5, "deployment", receipt.deployment_created_at,
      "a".repeat(64), "2026-08-22T03:45:00Z", now,
    ),
    /exact active deployment/,
  );
});
