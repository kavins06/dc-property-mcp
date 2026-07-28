import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const candidate = process.argv[2];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    candidate ?? "",
  )
) {
  throw new Error("Usage: probe-cloudflare-version.mjs <candidate-version-id>");
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
const accountApi =
  `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const api = `${accountApi}/workers/scripts/${config.name}`;

async function cloudflare(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Cloudflare request failed (${response.status}): ` +
        JSON.stringify(payload.errors ?? []),
    );
  }
  return payload.result;
}

async function deploy(versions, message) {
  return cloudflare(`${api}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "percentage",
      versions,
      annotations: { "workers/message": message },
    }),
  });
}

const deploymentResult = await cloudflare(`${api}/deployments`);
const active = deploymentResult.deployments?.[0] ?? deploymentResult[0];
const stable = active.versions
  .slice()
  .sort((left, right) => right.percentage - left.percentage)[0].version_id;
const targets = [
  new URL(config.vars.WORKOS_RESOURCE_URI).origin,
];

try {
  await deploy(
    [
      { version_id: stable, percentage: 100 },
      { version_id: candidate, percentage: 0 },
    ],
    `Probe candidate ${candidate}`,
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  const stagedDeployments = await cloudflare(`${api}/deployments`);
  const stagedActive =
    stagedDeployments.deployments?.[0] ?? stagedDeployments[0];

  const results = [];
  for (const target of targets) {
    for (const headerValue of [`${config.name}="${candidate}"`]) {
      const response = await fetch(
        `${target}/healthz?candidate=${candidate}&nonce=${crypto.randomUUID()}`,
        {
          headers: {
            "Cache-Control": "no-cache, no-store",
            "Cloudflare-Workers-Version-Overrides": headerValue,
          },
        },
      );
      results.push({
        target,
        header_value: headerValue,
        status: response.status,
        body: (await response.text()).slice(0, 500),
        cf_ray: response.headers.get("cf-ray"),
      });
    }
  }
  process.stdout.write(`${JSON.stringify({
    stable_version: stable,
    candidate_version: candidate,
    active_versions: stagedActive?.versions ?? [],
    results,
  }, null, 2)}\n`);
} finally {
  await deploy(
    [{ version_id: stable, percentage: 100 }],
    `Restore stable version after candidate probe ${candidate}`,
  );
}
