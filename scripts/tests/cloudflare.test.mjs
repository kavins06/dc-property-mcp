import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareClient } from "../lib/cloudflare.mjs";

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
