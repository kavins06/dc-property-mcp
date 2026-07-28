import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import pg from "../loader/node_modules/pg/lib/index.js";
import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const migration = process.argv[2];
const project = resolve(import.meta.dirname, "..");
const sqlPath = migration ? resolve(project, migration) : "";
const allowedRoots = [
  resolve(project, "db", "migrations"),
  resolve(project, "db", "tests"),
];
const isAllowed = allowedRoots.some((root) => {
  const candidate = relative(root, sqlPath);
  return candidate && !candidate.startsWith("..") && !isAbsolute(candidate);
});
if (!migration || extname(sqlPath).toLowerCase() !== ".sql" || !isAllowed) {
  throw new Error("Pass a SQL path under db/migrations/ or db/tests/.");
}

const client = new pg.Client({
  ...adminDatabaseConfig(process.env),
  statement_timeout: 0,
  application_name: "dc-property-migration",
});

await client.connect();
try {
  await client.query(await readFile(sqlPath, "utf8"));
  console.log(`Applied ${migration}`);
} finally {
  await client.end();
}
