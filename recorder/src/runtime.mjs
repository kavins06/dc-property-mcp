import { resolve } from "node:path";

export function profileDirectory() {
  if (process.env.DC_RECORDER_PROFILE_DIR) {
    return resolve(process.env.DC_RECORDER_PROFILE_DIR);
  }
  const localRoot =
    process.env.LOCALAPPDATA ??
    process.env.XDG_STATE_HOME ??
    resolve(import.meta.dirname, "..", "..", ".local");
  return resolve(localRoot, "dc-property-mcp", "recorder-profile");
}

export function authorizationReference() {
  const value = process.env.DC_RECORDER_AUTHORIZATION_REF?.trim();
  if (!value || value.length > 200) {
    throw new Error(
      "Set DC_RECORDER_AUTHORIZATION_REF to a short reference for the written authorization.",
    );
  }
  if (/(password|secret|bearer|cookie|token)\s*[:=]/i.test(value)) {
    throw new Error(
      "DC_RECORDER_AUTHORIZATION_REF must be a reference, never a credential or session value.",
    );
  }
  return value;
}

export function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (!value.startsWith("--") || !value.includes("=")) {
      throw new Error(`Unsupported argument: ${value}`);
    }
    const [key, ...parts] = value.slice(2).split("=");
    options[key] = parts.join("=");
  }
  return options;
}

export function isoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a calendar date.`);
  }
  return value;
}

export function dateRange(from, to, maximumDays) {
  const values = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    values.push(cursor.toISOString().slice(0, 10));
    if (values.length > maximumDays) {
      throw new Error(
        `Date range exceeds the ${maximumDays}-day safety limit for one run.`,
      );
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return values;
}

export function compactDate(value) {
  return value.replaceAll("-", "");
}

export function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
