import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import pg from "../loader/node_modules/pg/lib/index.js";

const project = resolve(import.meta.dirname, "..");
const migrationRoot = resolve(project, "db", "migrations");
const requested = process.argv.slice(2);

if (requested.length === 0) {
  throw new Error("Pass one or more migration paths under db/migrations/.");
}

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

const env = readEnv(resolve(project, ".env.hosted"));
const password =
  process.env.SUPABASE_DB_PASSWORD ?? env.SUPABASE_DB_PASSWORD;
const projectRef =
  process.env.SUPABASE_PROJECT_REF ?? env.SUPABASE_PROJECT_REF;
if (!password || !projectRef) {
  throw new Error("Supabase migration-validation credentials are unavailable.");
}

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

const client = new pg.Client({
  connectionString:
    `postgresql://postgres:${encodeURIComponent(password)}` +
    `@db.${projectRef}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
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
  await client.query("rollback");
  process.stdout.write("Validation transaction rolled back.\n");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
