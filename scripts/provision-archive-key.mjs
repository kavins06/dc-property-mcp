import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const environmentPath = resolve(project, ".env.hosted");
const variable = "ARCHIVE_SSE_C_KEY_BASE64";
const current = await readFile(environmentPath, "utf8");
const match = current.match(new RegExp(`^${variable}=(.*)$`, "m"));
let encoded = match?.[1]?.trim();

if (encoded) {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error(`${variable} exists but is not a canonical 32-byte key.`);
  }
} else {
  encoded = randomBytes(32).toString("base64");
  const next = match
    ? current.replace(new RegExp(`^${variable}=.*$`, "m"), `${variable}=${encoded}`)
    : `${current.replace(/\s*$/, "\n")}${variable}=${encoded}\n`;
  const temporary = `${environmentPath}.archive-key-${process.pid}.partial`;
  await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, environmentPath);
}

const fingerprint = createHash("sha256")
  .update(Buffer.from(encoded, "base64"))
  .digest("hex");
process.stdout.write(
  `${variable} ready; key fingerprint ${fingerprint}. Key value not printed.\n`,
);
