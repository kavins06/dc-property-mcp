import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  PRODUCTION_CONFIRMATION_TOKEN,
  PRODUCTION_TARGET,
  assertConnectionTarget,
  assertTargetDatabase,
  parseArgs,
  readVerifiedSql,
  resolveSqlArtifact,
  runProductionSql,
  setSessionMarkers,
  sha256Hex,
} from "../run-production-sql.mjs";

const project = resolve(import.meta.dirname, "../..");
const migrationPath = "db/production-migrations/0001_national_foundation.sql";

test("production SQL roots accept only numbered direct-child SQL artifacts", async () => {
  const valid = await resolveSqlArtifact("migration", migrationPath);
  assert.equal(valid.kind, "migration");
  await assert.rejects(resolveSqlArtifact("migration", "db/production-tests/0001_national_foundation_contract.sql"), /outside/);
  await assert.rejects(resolveSqlArtifact("test", "db/production-tests/fixtures/dc_property_minimal.sql"), /outside/);
  await assert.rejects(resolveSqlArtifact("migration", "db/production-migrations/../production-tests/0001_national_foundation_contract.sql"), /traversal/);
  await assert.rejects(resolveSqlArtifact("migration", "db/production-migrations/0001_national_foundation.sql.txt"), /outside/);
});

test("verified SQL requires the exact lowercase expected SHA-256", async () => {
  const bytes = readFileSync(resolve(project, migrationPath));
  const digest = sha256Hex(bytes);
  const artifact = await readVerifiedSql("migration", migrationPath, digest);
  assert.equal(artifact.expectedSha256, digest);
  assert.equal(artifact.sql, bytes.toString("utf8"));
  await assert.rejects(readVerifiedSql("migration", migrationPath, "0".repeat(64)), /reviewed digest/);
  await assert.rejects(readVerifiedSql("migration", migrationPath, digest.toUpperCase()), /lowercase/);
});

test("argument parsing requires production confirmation and rejects ambiguous options", () => {
  const digest = sha256Hex(readFileSync(resolve(project, migrationPath)));
  const base = ["--kind", "migration", "--path", migrationPath, "--expected-sha256", digest, "--target"];
  assert.deepEqual(parseArgs([...base, "rehearsal"]), {
    kind: "migration",
    requestedPath: migrationPath,
    expectedSha256: digest,
    target: "rehearsal",
    confirmation: undefined,
  });
  assert.throws(() => parseArgs([...base, "production"]), /confirmation/);
  assert.equal(
    parseArgs([...base, "production", "--confirm-production", PRODUCTION_CONFIRMATION_TOKEN]).confirmation,
    PRODUCTION_CONFIRMATION_TOKEN,
  );
  assert.throws(() => parseArgs([...base, "rehearsal", "--confirm-production", PRODUCTION_CONFIRMATION_TOKEN]), /only valid/);
  assert.throws(() => parseArgs([...base, "rehearsal", "--unknown", "x"]), /Unsupported/);
});

test("migration and rollback markers are session-level, parameterized, and never use a test marker", async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); } };
  assert.equal(await setSessionMarkers(client, "migration", "a".repeat(64), "rehearsal"), true);
  assert.match(calls[0].sql, /quoin\.migration_sha256/);
  assert.match(calls[0].sql, /quoin\.migration_target_class/);
  assert.deepEqual(calls[0].values, ["a".repeat(64), "rehearsal"]);
  assert.equal(await setSessionMarkers(client, "rollback", "b".repeat(64), "production"), true);
  assert.match(calls[1].sql, /quoin\.rollback_sha256/);
  assert.match(calls[1].sql, /quoin\.rollback_target_class/);
  assert.deepEqual(calls[1].values, ["b".repeat(64), "production"]);
  assert.equal(await setSessionMarkers(client, "test", "b".repeat(64), "rehearsal"), false);
});

test("runner fails closed unless PostgreSQL reports the exact dc_property database", async () => {
  await assert.doesNotReject(assertTargetDatabase({
    query: async () => ({ rows: [{ database_name: "dc_property", user_name: "dc_property_admin" }] }),
  }));
  await assert.rejects(assertTargetDatabase({
    query: async () => ({ rows: [{ database_name: "postgres", user_name: "dc_property_admin" }] }),
  }), /identity/);
  await assert.rejects(assertTargetDatabase({
    query: async () => ({ rows: [{ database_name: "dc_property", user_name: "neondb_owner" }] }),
  }), /identity/);
  await assert.rejects(assertTargetDatabase({
    query: async () => ({ rows: [] }),
  }), /identity/);
});

test("production execution is bound to the reviewed Neon project branch endpoint", () => {
  const environment = {
    DATABASE_HOST: PRODUCTION_TARGET.host,
    DATABASE_PORT: PRODUCTION_TARGET.port,
    DATABASE_NAME: PRODUCTION_TARGET.database,
    DATABASE_ADMIN_USER: PRODUCTION_TARGET.user,
    DATABASE_SSL_MODE: PRODUCTION_TARGET.sslMode,
  };
  assert.doesNotThrow(() => assertConnectionTarget(environment, "production"));
  assert.doesNotThrow(() => assertConnectionTarget({
    ...environment,
    DATABASE_ADMIN_LOGIN_USER: "neondb_owner",
  }, "production"));
  assert.throws(() => assertConnectionTarget({
    ...environment,
    DATABASE_ADMIN_LOGIN_USER: "unexpected_owner",
  }, "production"), /reviewed Neon owner/);
  for (const [name, value] of [
    ["DATABASE_HOST", "ep-wrong.example.neon.tech"],
    ["DATABASE_PORT", "6432"],
    ["DATABASE_NAME", "postgres"],
    ["DATABASE_ADMIN_USER", "neondb_owner"],
    ["DATABASE_SSL_MODE", "require"],
  ]) {
    assert.throws(
      () => assertConnectionTarget({ ...environment, [name]: value }, "production"),
      /reviewed Neon target/,
    );
  }
  assert.doesNotThrow(() => assertConnectionTarget({}, "rehearsal"));
});

test("runner validates before connecting and uses adminDatabaseConfig without exposing credentials", async () => {
  let connected = false;
  class UnexpectedClient {
    constructor() { connected = true; }
  }
  const digest = sha256Hex(readFileSync(resolve(project, migrationPath)));
  await assert.rejects(
    runProductionSql({
      kind: "migration",
      requestedPath: migrationPath,
      expectedSha256: "0".repeat(64),
      target: "rehearsal",
    }, { DATABASE_ADMIN_PASSWORD: "do-not-log" }, UnexpectedClient),
    /reviewed digest/,
  );
  assert.equal(connected, false);
  const source = readFileSync(resolve(import.meta.dirname, "../run-production-sql.mjs"), "utf8");
  assert.match(source, /adminDatabaseConfig\(environment\)/);
  assert.match(source, /set_config\('\$\{marker\.hash\}'/);
  assert.doesNotMatch(source, /console\.(log|error)\([^\n]*(PASSWORD|SECRET|TOKEN)/i);
  assert.equal(typeof digest, "string");
});
