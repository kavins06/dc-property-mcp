import { mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { archiveToS3 } from "./archive-to-s3.mjs";
import { createBackup } from "./backup-application.mjs";

const project = resolve(import.meta.dirname, "..");

function timestampSlug(date = new Date()) {
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
}

function projectRelative(path) {
  const value = relative(project, path);
  if (!value || value.startsWith("..") || resolve(project, value) !== path) {
    throw new Error("Production backup output must remain inside the project.");
  }
  return value.split(sep).join("/");
}

const keepLocal = process.argv.includes("--keep-local");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--keep-local");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments[0]}`);
}

const startedAt = new Date();
const backupDirectory = resolve(
  project,
  "application-backups",
  `dc-property-${timestampSlug(startedAt)}`,
);
const prefix =
  `backups/dc-property/application/` +
  `${startedAt.getUTCFullYear()}-${String(startedAt.getUTCMonth() + 1).padStart(2, "0")}`;

let backup;
let archive;
try {
  backup = await createBackup(backupDirectory);
  archive = await archiveToS3(
    {
      bucket: process.env.HETZNER_S3_BUCKET,
      prefix,
      inputs: [projectRelative(backupDirectory)],
    },
    process.env,
  );

  const report = {
    success: true,
    backup,
    archive,
    local_backup_retained: keepLocal,
    completed_at: new Date().toISOString(),
  };
  const reportDirectory = resolve(project, "db", "reports", "generated");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "application-backup-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (archive?.success && !keepLocal) {
    await rm(backupDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
