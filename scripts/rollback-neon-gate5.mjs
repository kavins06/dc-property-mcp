import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createCloudflareClient } from "./lib/cloudflare.mjs";
import {
  CANDIDATE_VERSION,
  STABLE_VERSION,
  assertDeployment,
  assertVersionPair,
  split,
  waitForDeployment,
} from "./rollout-neon-gate5.mjs";
import { verifyLive } from "./verify-live.mjs";

const PREVIOUS_PERCENTAGE = new Map([[1, 0], [5, 1], [25, 5], [50, 25], [100, 50]]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function argumentsFrom(values) {
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
  if (
    !PREVIOUS_PERCENTAGE.has(from) ||
    (to !== 0 && PREVIOUS_PERCENTAGE.get(from) !== to) ||
    !UUID.test(expectedDeployment ?? "") ||
    !values.includes("--confirm")
  ) {
    throw new Error(
      "Usage: rollback-neon-gate5.mjs --from <1|5|25|50|100> --to <previous|0> " +
        "--expected-deployment <uuid> --confirm",
    );
  }
  return { from, to, expectedDeployment };
}

async function main() {
  const project = resolve(import.meta.dirname, "..");
  const options = argumentsFrom(process.argv.slice(2));
  const env = {
    ...parseEnv(readFileSync(resolve(project, ".env.hosted"), "utf8")),
    ...process.env,
  };
  const client = createCloudflareClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    scriptName: "dc-property-mcp",
  });
  const current = await client.request("/deployments");
  assertDeployment((current.deployments ?? current)[0], options.from, options.expectedDeployment);
  const [stable, candidate] = await Promise.all([
    client.request(`/versions/${STABLE_VERSION}`),
    client.request(`/versions/${CANDIDATE_VERSION}`),
  ]);
  assertVersionPair(stable, candidate);
  let deployment;
  try {
    deployment = await client.createDeployment(
      split(options.to),
      `Gate 5 guarded rollback: ${options.from}% -> ${options.to}%`,
    );
    await waitForDeployment(client, options.to, deployment.id);
  } catch (error) {
    try {
      if (!deployment?.id) throw new Error("Cloudflare did not return a rollback deployment ID.");
      const reconciled = await client.request("/deployments");
      const active = (reconciled.deployments ?? reconciled)[0];
      assertDeployment(active, options.to, deployment.id);
      deployment = active;
    } catch (reconciliationError) {
      throw new AggregateError(
        [error, reconciliationError],
        "Rollback failed and the requested active deployment could not be proven.",
      );
    }
  }
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
  const report = {
    passed: true,
    from_percentage: options.from,
    to_percentage: options.to,
    source_deployment: options.expectedDeployment,
    deployment: deployment.id,
    verified_at: new Date().toISOString(),
  };
  const reportRoot = resolve(project, "db", "reports", "generated");
  mkdirSync(reportRoot, { recursive: true });
  const stamp = report.verified_at.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const reportPath = resolve(reportRoot, `neon-gate5-rollback-${options.to}pct-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, report: reportPath }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
