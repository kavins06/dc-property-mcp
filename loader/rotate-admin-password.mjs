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
const oldPassword = process.env.SUPABASE_OLD_DB_PASSWORD;
if (!oldPassword) throw new Error("SUPABASE_OLD_DB_PASSWORD is required for one-time rotation.");

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const client = new pg.Client({
  host: `db.${env.SUPABASE_PROJECT_REF}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: oldPassword,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
});

try {
  await client.connect();
  await client.query(
    `alter role postgres password ${sqlLiteral(env.SUPABASE_DB_PASSWORD)}`,
  );
  console.log("Supabase administrative password rotated successfully.");
} finally {
  await client.end().catch(() => {});
}
