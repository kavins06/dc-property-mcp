import { resolve } from "node:path";

import { verifyBackupDirectory } from "./lib/application-backup.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/verify-application-backup.mjs <backup-directory>",
  ].join("\n");
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (
    argumentsList.length === 1 &&
    ["--help", "-h"].includes(argumentsList[0])
  ) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (argumentsList.length !== 1 || argumentsList[0].startsWith("--")) {
    throw new Error(usage());
  }
  const result = await verifyBackupDirectory(resolve(argumentsList[0]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      passed: false,
      error: error instanceof Error ? error.message : "Verification failed.",
    })}\n`,
  );
  process.exitCode = 1;
});
