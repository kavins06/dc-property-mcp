import assert from "node:assert/strict";
import test from "node:test";

import {
  adminDatabaseConfig,
  databaseSslMode,
  runtimeDatabaseConfig,
} from "../lib/hosted-db.mjs";

const environment = {
  DATABASE_HOST: "db.internal.example",
  DATABASE_ADMIN_PASSWORD: "admin-secret",
  DC_PROPERTY_RUNTIME_PASSWORD: "runtime-secret",
};

test("admin connections use explicit provider-neutral PostgreSQL metadata", () => {
  const config = adminDatabaseConfig(environment);

  assert.equal(config.host, "db.internal.example");
  assert.equal(config.port, 5432);
  assert.equal(config.database, "dc_property");
  assert.equal(config.user, "dc_property_admin");
  assert.equal(config.password, "admin-secret");
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test("runtime connections use the least-privileged runtime role", () => {
  const config = runtimeDatabaseConfig(environment);

  assert.equal(config.host, "db.internal.example");
  assert.equal(config.user, "mcp_runtime");
  assert.equal(config.password, "runtime-secret");
});

test("Neon admin connections can assume the non-login ownership role", () => {
  const config = adminDatabaseConfig({
    ...environment,
    DATABASE_ADMIN_LOGIN_USER: "neondb_owner",
    DATABASE_ADMIN_LOGIN_PASSWORD: "neon-secret",
  });

  assert.equal(config.user, "neondb_owner");
  assert.equal(config.password, "neon-secret");
});

test("explicit connection metadata and local no-TLS mode are supported", () => {
  const config = adminDatabaseConfig({
    ...environment,
    DATABASE_HOST: "/run/postgresql-dc-property",
    DATABASE_PORT: "5434",
    DATABASE_NAME: "property",
    DATABASE_ADMIN_USER: "migration-user",
    DATABASE_SSL_MODE: "disable",
  });

  assert.equal(config.host, "/run/postgresql-dc-property");
  assert.equal(config.port, 5434);
  assert.equal(config.database, "property");
  assert.equal(config.user, "migration-user");
  assert.equal(config.ssl, false);
});

test("required metadata and unsafe SSL modes fail closed", () => {
  assert.throws(
    () => adminDatabaseConfig({ DATABASE_ADMIN_PASSWORD: "secret" }),
    /DATABASE_HOST/,
  );
  assert.throws(
    () =>
      runtimeDatabaseConfig({
        DATABASE_HOST: "db.internal.example",
      }),
    /DC_PROPERTY_RUNTIME_PASSWORD/,
  );
  assert.throws(
    () => adminDatabaseConfig({
      ...environment,
      DATABASE_SSL_MODE: "prefer",
    }),
    /DATABASE_SSL_MODE/,
  );
});

test("libpq child processes reuse the validated SSL mode", () => {
  assert.equal(databaseSslMode({}), "verify-full");
  assert.equal(databaseSslMode({ DATABASE_SSL_MODE: " REQUIRE " }), "require");
  assert.equal(databaseSslMode({ DATABASE_SSL_MODE: "disable" }), "disable");
});
