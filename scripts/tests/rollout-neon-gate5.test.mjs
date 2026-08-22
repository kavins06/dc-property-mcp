import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_VERSION,
  HETZNER_HYPERDRIVE,
  NEON_HYPERDRIVE,
  STABLE_VERSION,
  assertDeployment,
  assertVersionPair,
  split,
  validateAuthenticatedReceipt,
} from "../rollout-neon-gate5.mjs";

const version = (id, hyperdrive) => ({
  id,
  resources: {
    script: { etag: "same-code" },
    bindings: [
      { name: "A", type: "plain_text", text: "same" },
      { name: "HYPERDRIVE", type: "hyperdrive", id: hyperdrive },
    ],
  },
});

test("Gate 5 accepts only the next reviewed split and exact deployment", () => {
  assert.deepEqual(split(25), [
    { version_id: STABLE_VERSION, percentage: 75 },
    { version_id: CANDIDATE_VERSION, percentage: 25 },
  ]);
  assert.doesNotThrow(() =>
    assertDeployment({ id: "deployment", versions: split(25) }, 25, "deployment"),
  );
  assert.throws(
    () => assertDeployment({ id: "other", versions: split(25) }, 25, "deployment"),
    /ID changed/,
  );
  assert.throws(
    () => assertDeployment({ id: "deployment", versions: split(50) }, 25, "deployment"),
    /split changed/,
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
    tool_count: 15,
    statuses: Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`tool_${index}`, "ok"]),
    ),
    response_sha256: Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`tool_${index}`, "a".repeat(64)]),
    ),
    verified_at: "2026-08-22T03:15:00Z",
  };
  assert.doesNotThrow(() => validateAuthenticatedReceipt(receipt, now));
  assert.throws(
    () => validateAuthenticatedReceipt({ ...receipt, verified_at: "2026-08-22T02:00:00Z" }, now),
    /fresh, complete/,
  );
});
