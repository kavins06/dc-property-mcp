import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertExactDeployment,
  assertVersionBindings,
  createCloudflareClient,
} from "../lib/cloudflare.mjs";

test("Cloudflare deployment evidence is bound to the exact ID and split", () => {
  const versions = [
    { version_id: "stable", percentage: 100 },
    { version_id: "candidate", percentage: 0 },
  ];
  assert.doesNotThrow(() =>
    assertExactDeployment(
      { id: "deployment", strategy: "percentage", versions },
      "deployment",
      versions,
    ),
  );
  assert.throws(
    () =>
      assertExactDeployment(
        { id: "stale", strategy: "percentage", versions },
        "deployment",
        versions,
      ),
    /exact reviewed deployment/,
  );
  assert.throws(
    () =>
      assertExactDeployment(
        {
          id: "deployment",
          strategy: "percentage",
          versions: [
            { version_id: "stable", percentage: 50 },
            { version_id: "candidate", percentage: 50 },
          ],
        },
        "deployment",
        versions,
      ),
    /exact reviewed deployment/,
  );
});

test("Cloudflare rollback targets require the reviewed database bindings", () => {
  const version = {
    resources: {
      bindings: [
        { type: "hyperdrive", name: "HYPERDRIVE", id: "expected-hyperdrive" },
        { type: "d1", name: "BILLING_DB", id: "expected-d1" },
      ],
    },
  };
  assert.doesNotThrow(() => assertVersionBindings(version, version.resources.bindings));
  assert.throws(
    () => assertVersionBindings(version, [
      { type: "hyperdrive", name: "HYPERDRIVE", id: "wrong" },
    ]),
    /reviewed binding set/,
  );
});

test("Cloudflare candidates cannot be staged without isolation", () => {
  const deploy = readFileSync(new URL("../deploy-cloudflare.mjs", import.meta.url), "utf8");
  const promote = readFileSync(new URL("../promote-cloudflare.mjs", import.meta.url), "utf8");
  const config = JSON.parse(readFileSync(new URL("../../worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.match(deploy, /config\.hyperdrive\?\.\[0\]\?\.id !== stableHyperdriveId/);
  assert.match(deploy, /Candidate releases require MCP_CANDIDATE_ACCESS_TOKEN/);
  assert.match(promote, /candidate_access_protected !== true/);
  assert.equal(config.preview_urls, false);
  assert.equal(config.env.staging.preview_urls, false);
});

test("Cloudflare client shares authentication and deployment formatting", async (context) => {
  const requests = [];
  context.mock.method(globalThis, "fetch", async (url, options = {}) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { id: "ok" } }),
    };
  });

  const client = createCloudflareClient({
    accountId: "account",
    token: "token",
    scriptName: "worker",
  });
  await client.request("/deployments");
  await client.accountRequest("/workers/subdomain");
  await client.createDeployment(
    [{ version_id: "version", percentage: 100 }],
    "Release",
  );

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/worker/deployments",
      "https://api.cloudflare.com/client/v4/accounts/account/workers/subdomain",
      "https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/worker/deployments",
    ],
  );
  assert.equal(
    requests[0].options.headers.get("Authorization"),
    "Bearer token",
  );
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    strategy: "percentage",
    versions: [{ version_id: "version", percentage: 100 }],
    annotations: { "workers/message": "Release" },
  });
});
