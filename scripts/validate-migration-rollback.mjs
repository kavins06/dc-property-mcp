import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import pg from "../loader/node_modules/pg/lib/index.js";
import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const project = resolve(import.meta.dirname, "..");
const migrationRoot = resolve(project, "db", "migrations");
const rollbackRoot = resolve(project, "db", "rollbacks");
const [requestedMigration, requestedRollback] = process.argv.slice(2);

function sqlFile(root, requestedPath, label) {
  const path = resolve(project, requestedPath || "");
  const candidate = relative(root, path);
  if (
    !requestedPath ||
    !candidate ||
    candidate.startsWith("..") ||
    isAbsolute(candidate) ||
    !candidate.toLowerCase().endsWith(".sql")
  ) {
    throw new Error(
      `Pass a SQL ${label} under ${relative(project, root)}/.`,
    );
  }
  return readFileSync(path, "utf8")
    .replace(/^\s*begin;\s*/i, "")
    .replace(/\s*commit;\s*$/i, "");
}

const migration = sqlFile(
  migrationRoot,
  requestedMigration,
  "migration",
);
const rollback = sqlFile(
  rollbackRoot,
  requestedRollback,
  "rollback",
);

const client = new pg.Client({
  ...adminDatabaseConfig(process.env),
  statement_timeout: 0,
  application_name: "dc-property-rollback-validator",
});

await client.connect();
try {
  await client.query("begin");
  await client.query(migration);
  await client.query("reset role");
  await client.query(rollback);
  await client.query("reset role");
  await client.query("rollback");
  process.stdout.write(
    `Validated ${requestedMigration} -> ${requestedRollback}; ` +
      "transaction rolled back.\n",
  );
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
