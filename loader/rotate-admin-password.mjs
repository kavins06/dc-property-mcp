import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { adminDatabaseConfig } from "../scripts/lib/hosted-db.mjs";

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
const oldPassword = process.env.DATABASE_OLD_ADMIN_PASSWORD;
if (!oldPassword) {
  throw new Error(
    "DATABASE_OLD_ADMIN_PASSWORD is required for one-time rotation.",
  );
}
const newPassword = env.DATABASE_ADMIN_PASSWORD;
if (!newPassword) {
  throw new Error("DATABASE_ADMIN_PASSWORD is missing from .env.hosted.");
}
const adminUser = env.DATABASE_ADMIN_USER ?? "dc_property_admin";
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(adminUser)) {
  throw new Error("DATABASE_ADMIN_USER is not a safe PostgreSQL role name.");
}

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const client = new pg.Client({
  ...adminDatabaseConfig({
    ...env,
    ...process.env,
    DATABASE_ADMIN_PASSWORD: oldPassword,
  }),
  connectionTimeoutMillis: 30_000,
});

try {
  await client.connect();
  await client.query(
    `alter role "${adminUser}" ` +
      `password ${sqlLiteral(newPassword)}`,
  );
  console.log("PostgreSQL administrative password rotated successfully.");
} finally {
  await client.end().catch(() => {});
}
