import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  rm,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  inventoryArchiveInputs,
  materializePart,
  sha256File,
  validateArchiveReceipt,
  withArchiveTemporaryDirectory,
  writeDeterministicReceipt,
} from "./lib/s3-archive.mjs";

const project = resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage:",
    "  node --env-file=.env.hosted scripts/archive-to-s3.mjs \\",
    "    --prefix <prefix> \\",
    "    --input <project-relative-file-or-directory> [--input ...]",
    "",
    "The bucket defaults to HETZNER_S3_BUCKET. Every object is content-",
    "addressed, downloaded after upload, and checked against its local SHA-256.",
    "Files over 250 MiB are split into ordered parts.",
  ].join("\n");
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for S3 archival.`);
  return value;
}

export function s3ClientConfig(environment = process.env) {
  return {
    region: requiredEnvironment(environment, "HETZNER_S3_REGION"),
    endpoint: requiredEnvironment(environment, "HETZNER_S3_ENDPOINT"),
    forcePathStyle: true,
    maxAttempts: 3,
    credentials: {
      accessKeyId: requiredEnvironment(
        environment,
        "HETZNER_S3_ACCESS_KEY_ID",
      ),
      secretAccessKey: requiredEnvironment(
        environment,
        "HETZNER_S3_SECRET_ACCESS_KEY",
      ),
    },
  };
}

export function parseArchiveArguments(argumentsList, environment = process.env) {
  const options = {
    bucket: environment.HETZNER_S3_BUCKET?.trim() || null,
    prefix: null,
    inputs: [],
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (["--bucket", "--prefix", "--input"].includes(argument)) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--input") {
        options.inputs.push(value);
      } else {
        const key = argument.slice(2);
        if (options[key]) throw new Error(`${argument} may be supplied only once.`);
        options[key] = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    !options.help &&
    (!options.bucket || !options.prefix || options.inputs.length < 1)
  ) {
    throw new Error(
      "A bucket, --prefix, and at least one --input are required.",
    );
  }
  return options;
}

async function uploadAndVerify(
  client,
  bucket,
  objectKey,
  localPath,
  temporaryDirectory,
) {
  const localStat = await stat(localPath);
  const localHash = await sha256File(localPath);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: createReadStream(localPath),
    ContentLength: localStat.size,
    ContentType: "application/octet-stream",
    Metadata: {
      "dc-property-sha256": localHash,
    },
  }));

  const downloaded = resolve(
    temporaryDirectory,
    `verify-${randomUUID()}`,
  );
  try {
    const response = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }));
    if (!response.Body) {
      throw new Error(`S3 returned no body for ${objectKey}.`);
    }
    await pipeline(response.Body, createWriteStream(downloaded, {
      flags: "wx",
      mode: 0o600,
    }));
    const [remoteHash, remoteStat] = await Promise.all([
      sha256File(downloaded),
      stat(downloaded),
    ]);
    if (
      localHash !== remoteHash ||
      localStat.size !== remoteStat.size
    ) {
      throw new Error(
        `Remote S3 verification failed for ${objectKey}: ` +
          "bytes or SHA-256 differ.",
      );
    }
    return {
      bytes: remoteStat.size,
      sha256: remoteHash,
    };
  } finally {
    await rm(downloaded, { force: true });
  }
}

export async function archiveToS3(options, environment = process.env) {
  const client = new S3Client(s3ClientConfig(environment));
  const receipt = validateArchiveReceipt(
    await inventoryArchiveInputs(project, options.inputs, {
      bucket: options.bucket,
      prefix: options.prefix,
      provider: "hetzner_object_storage",
      endpoint: requiredEnvironment(environment, "HETZNER_S3_ENDPOINT"),
      region: requiredEnvironment(environment, "HETZNER_S3_REGION"),
    }),
  );
  try {
    return await withArchiveTemporaryDirectory(async (temporaryDirectory) => {
      let completedParts = 0;
      const totalParts = receipt.files.reduce(
        (total, file) => total + file.parts.length,
        0,
      );
      for (const file of receipt.files) {
        const sourcePath = resolve(project, ...file.relative_path.split("/"));
        for (const part of file.parts) {
          const localPath =
            file.parts.length === 1
              ? sourcePath
              : await materializePart(sourcePath, part, temporaryDirectory);
          const verified = await uploadAndVerify(
            client,
            options.bucket,
            part.object_key,
            localPath,
            temporaryDirectory,
          );
          if (
            verified.sha256 !== part.sha256 ||
            verified.bytes !== part.bytes
          ) {
            throw new Error(
              `Receipt mismatch after S3 verification for ${part.object_key}.`,
            );
          }
          if (file.parts.length > 1) {
            await rm(localPath, { force: true });
          }
          completedParts += 1;
          process.stdout.write(
            `S3 verified ${completedParts}/${totalParts}: ` +
              `${file.relative_path} part ${part.part_number}/` +
              `${file.parts.length}\n`,
          );
        }
      }

      const localReceipt = await writeDeterministicReceipt(
        receipt,
        resolve(project, "archive-receipts"),
      );
      const verifiedReceipt = await uploadAndVerify(
        client,
        options.bucket,
        receipt.receipt_object_key,
        localReceipt.path,
        temporaryDirectory,
      );
      if (verifiedReceipt.sha256 !== localReceipt.sha256) {
        throw new Error("Remote S3 archive receipt SHA-256 differs from local.");
      }
      return {
        success: true,
        provider: "hetzner_object_storage",
        endpoint: environment.HETZNER_S3_ENDPOINT,
        region: environment.HETZNER_S3_REGION,
        bucket: options.bucket,
        archive_id: receipt.archive_id,
        receipt_path: localReceipt.path,
        receipt_sha256: localReceipt.sha256,
        receipt_object_key: receipt.receipt_object_key,
        file_count: receipt.files.length,
        part_count: totalParts,
        total_bytes: receipt.files.reduce(
          (total, file) => total + file.bytes,
          0,
        ),
      };
    });
  } finally {
    client.destroy();
  }
}

async function main() {
  const options = parseArchiveArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await archiveToS3(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "S3 archive failed.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
