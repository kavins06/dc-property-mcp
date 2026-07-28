import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import pg from "../loader/node_modules/pg/lib/index.js";
import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const project = resolve(import.meta.dirname, "..");
const migrationRoot = resolve(project, "db", "migrations");
const testRoot = resolve(project, "db", "tests");
const argumentsList = process.argv.slice(2);
const testFlagIndex = argumentsList.indexOf("--test");
const requested =
  testFlagIndex < 0
    ? argumentsList
    : argumentsList.slice(0, testFlagIndex);
const requestedTest =
  testFlagIndex < 0 ? null : argumentsList[testFlagIndex + 1];

if (requested.length === 0) {
  throw new Error("Pass one or more migration paths under db/migrations/.");
}
if (
  testFlagIndex >= 0 &&
  (!requestedTest || testFlagIndex + 2 !== argumentsList.length)
) {
  throw new Error(
    "Pass exactly one SQL contract after --test.",
  );
}

const env = parseEnv(
  readFileSync(resolve(project, ".env.hosted"), "utf8"),
);
const databaseEnvironment = { ...env, ...process.env };

const migrations = requested.map((requestedPath) => {
  const path = resolve(project, requestedPath);
  const candidate = relative(migrationRoot, path);
  if (
    !candidate ||
    candidate.startsWith("..") ||
    isAbsolute(candidate) ||
    !candidate.toLowerCase().endsWith(".sql")
  ) {
    throw new Error(`Migration path is outside db/migrations/: ${requestedPath}`);
  }
  const sql = readFileSync(path, "utf8")
    .replace(/^\s*begin;\s*/i, "")
    .replace(/\s*commit;\s*$/i, "");
  return { requestedPath, sql };
});

let contract = null;
if (requestedTest) {
  const path = resolve(project, requestedTest);
  const candidate = relative(testRoot, path);
  if (
    !candidate ||
    candidate.startsWith("..") ||
    isAbsolute(candidate) ||
    !candidate.toLowerCase().endsWith(".sql")
  ) {
    throw new Error(
      `Contract path is outside db/tests/: ${requestedTest}`,
    );
  }
  contract = {
    requestedPath: requestedTest,
    sql: readFileSync(path, "utf8")
      .replace(/^\s*begin;\s*/i, "")
      .replace(/\s*rollback;\s*$/i, ""),
  };
}

const client = new pg.Client({
  ...adminDatabaseConfig(databaseEnvironment),
  statement_timeout: 0,
  application_name: "dc-property-migration-validator",
});

await client.connect();
try {
  await client.query("begin");
  for (const migration of migrations) {
    await client.query(migration.sql);
    await client.query("reset role");
    process.stdout.write(`Validated ${migration.requestedPath}\n`);
  }
  if (contract) {
    await client.query(contract.sql);
    await client.query("reset role");
    process.stdout.write(`Passed ${contract.requestedPath}\n`);
  }
  await client.query("rollback");
  process.stdout.write("Validation transaction rolled back.\n");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
