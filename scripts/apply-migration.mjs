import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "../loader/node_modules/pg/lib/index.js";
import { requireDmvRehearsalTarget } from "../loader/dmv-rehearsal-target.mjs";
import { adminDatabaseConfig } from "./lib/hosted-db.mjs";

const project = resolve(import.meta.dirname, "..");
const allowedRoots = [
  resolve(project, "db", "migrations"),
  resolve(project, "db", "tests"),
];

export function requiresDmvRehearsalTarget(sqlPath) {
  const match = basename(sqlPath).match(/^(\d{4})_/);
  return match ? Number(match[1]) >= 35 : false;
}

export async function applyMigration(migration, environment = process.env) {
  const sqlPath = migration ? resolve(project, migration) : "";
  const isAllowed = allowedRoots.some((root) => {
    const candidate = relative(root, sqlPath);
    return candidate && !candidate.startsWith("..") && !isAbsolute(candidate);
  });
  if (!migration || extname(sqlPath).toLowerCase() !== ".sql" || !isAllowed) {
    throw new Error("Pass a SQL path under db/migrations/ or db/tests/.");
  }
  const client = new pg.Client({
    ...adminDatabaseConfig(environment),
    statement_timeout: 0,
    application_name: "dc-property-migration",
  });
  await client.connect();
  try {
    if (requiresDmvRehearsalTarget(sqlPath)) {
      await requireDmvRehearsalTarget(
        client,
        environment.DMV_REHEARSAL_DATABASE_NAME,
        environment,
      );
    }
    await client.query(await readFile(sqlPath, "utf8"));
    console.log(`Applied ${migration}`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await applyMigration(process.argv[2]);
}
