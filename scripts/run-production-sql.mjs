import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import pg from "../loader/node_modules/pg/lib/index.js";

import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const project = resolve(import.meta.dirname, "..");
const roots = Object.freeze({
  migration: resolve(project, "db", "production-migrations"),
  test: resolve(project, "db", "production-tests"),
  rollback: resolve(project, "db", "production-rollbacks"),
});

export const REVIEWED_SQL_SHA256 = Object.freeze({
  "db/production-migrations/0001_national_foundation.sql": "b84cee659122185318d3abc11c2097a00949882586b45fefa140de0a702b2ffe",
  "db/production-migrations/0002_national_geography_2025.sql": "04c01e855b78a43e78ef6c43b48f9d52937bd188451f0178c4063d9942a3e87d",
  "db/production-migrations/0003_national_availability_reason.sql": "b151a3bb896b5f4b21dc8efb55af54546dd37c6397c0c70573a81f24e72ccaab",
  "db/production-migrations/0004_national_contract_facade.sql": "e5f7f15ac71b0051220b50387c532886d8a81a8f0beeee1365dc5d3009998318",
  "db/production-rollbacks/0001_national_foundation.sql": "0958832ccba1ad6b44b63302de2cfdda106f5e35b708a2f6a05333584326da07",
  "db/production-rollbacks/0002_national_geography_2025.sql": "9babed9bde591b9708c29d30aff56f3ef2ba8d34c211c333d27df69605040f81",
  "db/production-rollbacks/0003_national_availability_reason.sql": "e6457b464ef5f40163ac78059febc3e060d938f323118678d668a373dc65206c",
  "db/production-rollbacks/0004_national_contract_facade.sql": "5b55075ef1d6e707c61d5cfede37b194f756de0463c3e43d4d3d2eb63212f0c9",
  "db/production-tests/0001_national_foundation_contract.sql": "0859552c840e33f8ceae7d77d1eec4a2e7b98f42586f33dafb7de71159ae316b",
  "db/production-tests/0002_national_geography_contract.sql": "c0b15651033c08f04c7fb0c1776aa3979c98ef68bb4e72e921bea40d3689685b",
  "db/production-tests/0003_national_availability_reason_contract.sql": "c8eb056e51b5dee59229cd8dc3e46d8f8d85bcf71925599555c8dab23c5ef83d",
  "db/production-tests/0004_national_contract_facade_contract.sql": "3eaec6b9be4627c18e939bd6ca788abce9c7b03c4ee7fb49db24d19dfd8ff619",
});

export const PRODUCTION_CONFIRMATION_TOKEN = "PRODUCTION_SQL_APPLY_CONFIRMED";
export const PRODUCTION_TARGET = Object.freeze({
  projectId: "orange-feather-99332051",
  branchId: "br-soft-feather-ayz26yo9",
  endpointId: "ep-crimson-truth-ay2a66lm",
  host: "ep-crimson-truth-ay2a66lm.c-5.us-east-2.aws.neon.tech",
  port: "5432",
  database: "dc_property",
  user: "dc_property_admin",
  sslMode: "verify-full",
});

const sessionMarkers = Object.freeze({
  migration: Object.freeze({
    hash: "quoin.migration_sha256",
    target: "quoin.migration_target_class",
  }),
  rollback: Object.freeze({
    hash: "quoin.rollback_sha256",
    target: "quoin.rollback_target_class",
  }),
});

const optionNames = new Set([
  "--kind",
  "--path",
  "--expected-sha256",
  "--target",
  "--confirm-production",
]);

function assertKind(kind) {
  if (!(kind in roots)) throw new Error("SQL kind must be migration, test, or rollback.");
}

function assertTarget(target) {
  if (target !== "rehearsal" && target !== "production") {
    throw new Error("SQL target must be rehearsal or production.");
  }
}

function assertExpectedSha256(expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("An exact lowercase 64-character expected SHA-256 is required.");
  }
}

function assertProductionConfirmation(target, confirmation) {
  if (target === "production" && confirmation !== PRODUCTION_CONFIRMATION_TOKEN) {
    throw new Error("Production target requires the exact explicit confirmation token.");
  }
  if (target !== "production" && confirmation !== undefined) {
    throw new Error("Production confirmation is only valid with the production target.");
  }
}

function isWithinRoot(root, candidate) {
  const child = relative(root, candidate);
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
}

function isNumberedDirectSqlFile(root, candidate) {
  const child = relative(root, candidate);
  return !child.includes("\\") && !child.includes("/") && /^\d{4}_[A-Za-z0-9._-]+\.sql$/i.test(basename(candidate));
}

/**
 * Resolve only numbered, direct-child SQL artifacts under the selected
 * production root. realpath() makes symlink escapes fail closed as well.
 */
export async function resolveSqlArtifact(kind, requestedPath) {
  assertKind(kind);
  if (typeof requestedPath !== "string" || !requestedPath || isAbsolute(requestedPath)) {
    throw new Error("SQL path must be a non-empty project-relative path.");
  }
  if (requestedPath.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("SQL path traversal is not permitted.");
  }
  if (
    extname(requestedPath).toLowerCase() !== ".sql"
    || !/^\d{4}_[A-Za-z0-9._-]+\.sql$/i.test(basename(requestedPath))
  ) {
    throw new Error("SQL path is outside the selected production SQL root.");
  }

  const root = await realpath(roots[kind]);
  const candidate = await realpath(resolve(project, requestedPath));
  if (
    !isWithinRoot(root, candidate)
    || extname(candidate).toLowerCase() !== ".sql"
    || !isNumberedDirectSqlFile(root, candidate)
  ) {
    throw new Error("SQL path is outside the selected production SQL root.");
  }
  return { kind, requestedPath, path: candidate };
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readVerifiedSql(kind, requestedPath, expectedSha256) {
  assertExpectedSha256(expectedSha256);
  const reviewedSha256 = REVIEWED_SQL_SHA256[requestedPath.replaceAll("\\", "/")];
  if (reviewedSha256 !== expectedSha256) {
    throw new Error("SQL SHA-256 is not the reviewed digest for this production artifact.");
  }
  const artifact = await resolveSqlArtifact(kind, requestedPath);
  const bytes = await readFile(artifact.path);
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error("SQL SHA-256 does not match the exact expected value.");
  }
  return {
    ...artifact,
    expectedSha256,
    sql: bytes.toString("utf8"),
  };
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    if (!optionNames.has(name)) throw new Error("Unsupported runner option.");
    if (Object.hasOwn(values, name)) throw new Error("Runner options may not be repeated.");
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith("--")) throw new Error("Every runner option requires a value.");
    values[name] = value;
  }

  const options = {
    kind: values["--kind"],
    requestedPath: values["--path"],
    expectedSha256: values["--expected-sha256"],
    target: values["--target"],
    confirmation: values["--confirm-production"],
  };
  assertKind(options.kind);
  assertTarget(options.target);
  assertExpectedSha256(options.expectedSha256);
  if (!options.requestedPath) throw new Error("A project-relative SQL path is required.");
  assertProductionConfirmation(options.target, options.confirmation);
  return options;
}

export async function setSessionMarkers(client, kind, expectedSha256, target) {
  const marker = sessionMarkers[kind];
  if (!marker) return false;
  await client.query(
    `select pg_catalog.set_config('${marker.hash}', $1, false),
            pg_catalog.set_config('${marker.target}', $2, false)`,
    [expectedSha256, target],
  );
  return true;
}

export async function resetSessionMarkers(client, kind) {
  const marker = sessionMarkers[kind];
  if (!marker) return;
  await client.query(`reset ${marker.hash}; reset ${marker.target}`);
}

export async function assertTargetDatabase(client) {
  const result = await client.query(
    "select pg_catalog.current_database() as database_name, current_user as user_name",
  );
  if (
    result.rows?.[0]?.database_name !== "dc_property"
    || result.rows?.[0]?.user_name !== "dc_property_admin"
  ) {
    throw new Error("Production SQL runner connected with the wrong database identity.");
  }
}

function assertOptions(options) {
  if (!options || typeof options !== "object") throw new Error("Runner options are required.");
  assertKind(options.kind);
  assertTarget(options.target);
  assertExpectedSha256(options.expectedSha256);
  if (!options.requestedPath) throw new Error("A project-relative SQL path is required.");
  assertProductionConfirmation(options.target, options.confirmation);
}

export function assertConnectionTarget(environment, target) {
  if (target !== "production") return;
  const actual = {
    host: environment.DATABASE_HOST?.trim(),
    port: environment.DATABASE_PORT?.trim() || "5432",
    database: environment.DATABASE_NAME?.trim() || "dc_property",
    user: environment.DATABASE_ADMIN_USER?.trim() || "dc_property_admin",
    sslMode: environment.DATABASE_SSL_MODE?.trim().toLowerCase() || "verify-full",
  };
  for (const key of ["host", "port", "database", "user", "sslMode"]) {
    if (actual[key] !== PRODUCTION_TARGET[key]) {
      throw new Error(`Production SQL ${key} does not match the reviewed Neon target.`);
    }
  }
  const loginUser = environment.DATABASE_ADMIN_LOGIN_USER?.trim();
  if (loginUser && loginUser !== "neondb_owner") {
    throw new Error("Production SQL login user does not match the reviewed Neon owner.");
  }
}

async function assumeAdminRole(client, environment) {
  const role = environment.DATABASE_ADMIN_USER?.trim() || "dc_property_admin";
  const loginUser = environment.DATABASE_ADMIN_LOGIN_USER?.trim() || role;
  if (loginUser !== role) await client.query('set role "dc_property_admin"');
}

export async function runProductionSql(options, environment = process.env, Client = pg.Client) {
  assertOptions(options);
  assertConnectionTarget(environment, options.target);
  const artifact = await readVerifiedSql(
    options.kind,
    options.requestedPath,
    options.expectedSha256,
  );
  const client = new Client({
    ...adminDatabaseConfig(environment),
    statement_timeout: 0,
    application_name: "dc-property-production-sql-runner",
  });
  let connected = false;
  let markersSet = false;
  try {
    await client.connect();
    connected = true;
    await assumeAdminRole(client, environment);
    await assertTargetDatabase(client);
    markersSet = await setSessionMarkers(
      client,
      options.kind,
      artifact.expectedSha256,
      options.target,
    );
    await client.query(artifact.sql);
    return {
      kind: artifact.kind,
      requestedPath: artifact.requestedPath,
      target: options.target,
      expectedSha256: artifact.expectedSha256,
      targetIdentity: options.target === "production" ? PRODUCTION_TARGET : undefined,
    };
  } finally {
    if (connected && markersSet) await resetSessionMarkers(client, options.kind).catch(() => undefined);
    if (connected) await client.end();
  }
}

function redactSecrets(message, environment) {
  let redacted = message;
  for (const [name, value] of Object.entries(environment)) {
    if (value && /PASSWORD|SECRET|TOKEN|KEY/i.test(name)) redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runProductionSql(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Executed ${result.kind} ${result.requestedPath} for ${result.target}.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runner failure.";
    process.exitCode = 1;
    process.stderr.write(`Production SQL runner failed: ${redactSecrets(message, process.env)}\n`);
  }
}
