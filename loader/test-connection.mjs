import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";

const project = resolve(import.meta.dirname, "..");
const env = parseEnv(
  readFileSync(resolve(project, ".env.hosted"), "utf8"),
);

const client = new pg.Client({
  ...adminDatabaseConfig({ ...env, ...process.env }),
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
