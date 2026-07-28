import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";
import {
  ACCOUNT_MAPPING_COLUMNS,
  databaseAccountMappingFingerprint,
  localAccountMappingFingerprint,
} from "./core-artifact-fingerprint.mjs";

const project = resolve(import.meta.dirname, "..");
const artifactPath = resolve(
  project,
  "data",
  "generated",
  "property_account_current.csv.gz",
);
const buildManifestPath = resolve(
  project,
  "data",
  "manifests",
  "build_manifest.json",
);

function readEnv(path) {
  const result = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const buildManifestBytes = readFileSync(buildManifestPath);
const buildManifest = JSON.parse(buildManifestBytes.toString("utf8"));
const expected =
  buildManifest.generated_artifacts?.property_account_current;
if (!expected) {
  throw new Error(
    "Build manifest is missing property_account_current provenance.",
  );
}
const artifactSha256 = await fileSha256(artifactPath);
if (artifactSha256 !== expected.sha256) {
  throw new Error(
    "property_account_current.csv.gz does not match build_manifest.json.",
  );
}

const local = await localAccountMappingFingerprint(artifactPath);
if (local.rows !== expected.rows) {
  throw new Error(
    `Local mapping has ${local.rows} rows; expected ${expected.rows}.`,
  );
}
if (await fileSha256(artifactPath) !== artifactSha256) {
  throw new Error(
    "property_account_current.csv.gz changed while its mapping was " +
      "fingerprinted; retry with a stable artifact.",
  );
}

const env = {
  ...readEnv(resolve(project, ".env.hosted")),
  ...process.env,
};
const client = new pg.Client({
  ...adminDatabaseConfig(env),
  statement_timeout: 0,
  connectionTimeoutMillis: 30_000,
  application_name: "dc-property-core-artifact-binder",
});

await client.connect();
let inTransaction = false;
try {
  await client.query("begin isolation level repeatable read");
  inTransaction = true;
  await client.query(
    "lock table core.property_account_current in share mode",
  );
  const bindingReady = await client.query(`
    select to_regclass('meta.loaded_artifact_binding') is not null ready
  `);
  if (!bindingReady.rows[0].ready) {
    throw new Error(
      "Apply 0024_regulatory_release_lifecycle.sql before binding.",
    );
  }
  const database = await databaseAccountMappingFingerprint(client);
  if (
    database.rows !== local.rows ||
    database.sha256 !== local.sha256
  ) {
    throw new Error(
      "Core database identity mapping does not match the canonical " +
        `property-account artifact: ${JSON.stringify({
          local,
          database,
        })}`,
    );
  }
  const buildManifestSha256 = createHash("sha256")
    .update(buildManifestBytes)
    .digest("hex");
  await client.query(
    `
      insert into meta.loaded_artifact_binding (
        artifact_key,
        file_name,
        relation_name,
        artifact_sha256,
        artifact_row_count,
        mapping_sha256,
        build_manifest_sha256,
        verification_method,
        detail
      ) values (
        'property_account_current',
        'property_account_current.csv.gz',
        'core.property_account_current',
        $1,
        $2,
        $3,
        $4,
        'full_ordered_identity_mapping_sha256_v1',
        $5::jsonb
      )
      on conflict (artifact_key) do update
      set
        file_name = excluded.file_name,
        relation_name = excluded.relation_name,
        artifact_sha256 = excluded.artifact_sha256,
        artifact_row_count = excluded.artifact_row_count,
        mapping_sha256 = excluded.mapping_sha256,
        build_manifest_sha256 = excluded.build_manifest_sha256,
        verification_method = excluded.verification_method,
        verified_at = now(),
        detail = excluded.detail
    `,
    [
      artifactSha256,
      local.rows,
      local.sha256,
      buildManifestSha256,
      JSON.stringify({
        mapping_columns: ACCOUNT_MAPPING_COLUMNS,
        local_mapping_sha256: local.sha256,
        database_mapping_sha256: database.sha256,
      }),
    ],
  );
  await client.query("commit");
  inTransaction = false;
  process.stdout.write(
    `Bound core.property_account_current to ${artifactSha256}: ` +
      `${local.rows} rows, mapping ${local.sha256}.\n`,
  );
} catch (error) {
  if (inTransaction) {
    await client.query("rollback").catch(() => undefined);
  }
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
