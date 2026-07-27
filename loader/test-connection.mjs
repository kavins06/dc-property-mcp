import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const project = resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  readFileSync(resolve(project, ".env.hosted"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const client = new pg.Client({
  host: `db.${env.SUPABASE_PROJECT_REF}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
});

try {
  await client.connect();
  const result = await client.query(
    "select current_database() database, current_user username, version() version",
  );
  console.log({
    database: result.rows[0].database,
    username: result.rows[0].username,
    version: result.rows[0].version.split(",")[0],
    tls: true,
  });
} finally {
  await client.end().catch(() => {});
}
