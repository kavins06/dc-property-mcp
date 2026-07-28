function requireValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for database access.`);
  }
  return value;
}

function databasePort(environment) {
  const portText = environment.DATABASE_PORT?.trim() || "5432";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DATABASE_PORT must be a valid TCP port.");
  }
  return port;
}

function databaseSsl(environment) {
  const mode = environment.DATABASE_SSL_MODE?.trim().toLowerCase() ||
    "verify-full";
  if (mode === "disable") return false;
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "verify-full") return { rejectUnauthorized: true };
  throw new Error(
    "DATABASE_SSL_MODE must be disable, require, or verify-full.",
  );
}

function commonDatabaseConfig(environment) {
  return {
    host: requireValue(environment, "DATABASE_HOST"),
    port: databasePort(environment),
    database: environment.DATABASE_NAME?.trim() || "dc_property",
    ssl: databaseSsl(environment),
  };
}

export function adminDatabaseConfig(environment = process.env) {
  return {
    ...commonDatabaseConfig(environment),
    user: environment.DATABASE_ADMIN_USER?.trim() || "dc_property_admin",
    password: requireValue(environment, "DATABASE_ADMIN_PASSWORD"),
  };
}

export function runtimeDatabaseConfig(environment = process.env) {
  return {
    ...commonDatabaseConfig(environment),
    user: environment.DATABASE_RUNTIME_USER?.trim() || "mcp_runtime",
    password: requireValue(environment, "DC_PROPERTY_RUNTIME_PASSWORD"),
  };
}
