import { readFileSync, writeFileSync } from "node:fs";

const secretsPath = new URL("../.env.hosted", import.meta.url);

export function getDeploymentSecret(name) {
  const lines = readFileSync(secretsPath, "utf8").split(/\r?\n/);
  const prefix = `${name}=`;
  const line = lines.find((value) => value.startsWith(prefix));
  if (!line) throw new Error(`Deployment secret is not configured: ${name}`);
  return line.slice(prefix.length);
}

export function setDeploymentSecret(name, value) {
  const lines = readFileSync(secretsPath, "utf8").split(/\r?\n/);
  const prefix = `${name}=`;
  const nextLine = `${prefix}${value}`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    lines.push(nextLine);
  }
  writeFileSync(secretsPath, `${lines.filter(Boolean).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
