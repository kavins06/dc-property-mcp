import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { once } from "node:events";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { archiveEncryption, s3ClientConfig } from "./archive-to-s3.mjs";
import { validateArchiveReceipt } from "./lib/s3-archive.mjs";

function below(root, requested, label) {
  const path = resolve(root, ...requested.split("/"));
  const fromRoot = relative(resolve(root), path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must be below its configured root.`);
  }
  return path;
}

async function assertMissing(path) {
  try {
    await lstat(path);
    throw new Error(`Refusing to overwrite restored artifact: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function safeOutputTarget(outputRoot, relativePath) {
  await mkdir(outputRoot, { recursive: true });
  const root = await realpath(outputRoot);
  const target = below(root, relativePath, "Archive output");
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const fromRoot = relative(root, parent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Archive output parent resolves outside its configured root.");
  }
  return target;
}

export async function restoreArchive({ receiptPath, receipt: suppliedReceipt, objectRoot, objectReader, outputRoot, only, allowLegacyV1 = false }) {
  const receipt = validateArchiveReceipt(
    suppliedReceipt ?? JSON.parse(await readFile(receiptPath, "utf8")),
    { allowLegacyV1 },
  );
  const hasOnly = only !== null && only !== undefined;
  if (hasOnly && (typeof only !== "string" || !only)) {
    throw new Error("Archive restore filter must be a nonempty string.");
  }
  const files = hasOnly ? receipt.files.filter((file) => file.relative_path === only) : receipt.files;
  if (hasOnly && files.length !== 1) throw new Error(`Archive receipt does not contain requested file: ${only}`);
  if (!objectReader && !objectRoot) throw new Error("Archive restore requires an object root or object reader.");
  const results = [];
  for (const file of files) {
    const target = await safeOutputTarget(outputRoot, file.relative_path);
    const partial = `${target}.partial`;
    await assertMissing(target);
    await assertMissing(partial);
    const output = createWriteStream(partial, { flags: "wx", mode: 0o600 });
    const fileHash = createHash("sha256");
    let fileBytes = 0;
    try {
      for (const part of [...file.parts].sort((a, b) => a.part_number - b.part_number)) {
        if (part.byte_offset !== fileBytes) throw new Error(`Non-contiguous archive part for ${file.relative_path}.`);
        const prefix = `${receipt.prefix}/`;
        if (!part.object_key.startsWith(prefix)) throw new Error("Archive object key is outside the receipt prefix.");
        const objectPath = objectReader ? null : below(objectRoot, part.object_key.slice(prefix.length), "Archive object");
        const partHash = createHash("sha256");
        let partBytes = 0;
        const input = objectReader ? await objectReader(part.object_key) : createReadStream(objectPath);
        for await (const chunk of input) {
          partBytes += chunk.length;
          fileBytes += chunk.length;
          partHash.update(chunk);
          fileHash.update(chunk);
          if (!output.write(chunk)) await once(output, "drain");
        }
        if (partBytes !== part.bytes || partHash.digest("hex") !== part.sha256) {
          throw new Error(`Archive part verification failed for ${part.object_key}.`);
        }
      }
      output.end();
      await finished(output);
      const sha256 = fileHash.digest("hex");
      if (fileBytes !== file.bytes || sha256 !== file.sha256) {
        throw new Error(`Restored file verification failed for ${file.relative_path}.`);
      }
      await link(partial, target);
      await rm(partial);
      results.push({ relative_path: file.relative_path, bytes: fileBytes, sha256 });
    } catch (error) {
      output.destroy();
      try { await finished(output); } catch {}
      await rm(partial, { force: true });
      throw error;
    }
  }
  return { archive_id: receipt.archive_id, files: results };
}

export function s3ArchiveReader(
  receipt,
  environment = process.env,
  { timeoutMs = 30 * 60 * 1000, allowLegacyV1 = false } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("S3 restore timeout must be a positive integer.");
  const legacyV1 = receipt?.receipt_version === 1;
  if (legacyV1 && !allowLegacyV1) throw new Error("Legacy v1 archive receipts require explicit opt-in.");
  const encryption = legacyV1 ? null : archiveEncryption(environment);
  if (
    receipt.provider !== "hetzner_object_storage"
    || receipt.endpoint !== environment.HETZNER_S3_ENDPOINT
    || receipt.region !== environment.HETZNER_S3_REGION
    || receipt.bucket !== environment.HETZNER_S3_BUCKET
    || (!legacyV1 && receipt.encryption.key_sha256 !== encryption.receipt.key_sha256)
  ) {
    throw new Error("Archive receipt does not match the configured encrypted object store.");
  }
  const client = new S3Client(s3ClientConfig(environment));
  return {
    read: async (objectKey) => {
      const response = await client.send(new GetObjectCommand({
        Bucket: receipt.bucket,
        Key: objectKey,
        ...(encryption?.request ?? {}),
      }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      if (!response.Body) throw new Error(`S3 object has no response body: ${objectKey}`);
      return response.Body;
    },
    close: () => client.destroy(),
  };
}

export function parseRestoreArguments(args) {
  const result = { fromS3: false };
  const keys = new Set();
  const valueFlags = new Map([
    ["--receipt", "receipt"],
    ["--objects", "objects"],
    ["--output", "output"],
    ["--only", "only"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (keys.has(argument)) throw new Error(`Duplicate restore argument: ${argument}`);
    keys.add(argument);
    if (argument === "--from-s3") {
      result.fromS3 = true;
      continue;
    }
    if (argument === "--allow-legacy-v1") {
      result.allowLegacyV1 = true;
      continue;
    }
    const key = valueFlags.get(argument);
    if (!key) throw new Error(`Unknown restore argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value.`);
    result[key] = value;
    index += 1;
  }
  if (!result.receipt || !result.output) throw new Error("--receipt and --output are required.");
  if (result.fromS3 === Boolean(result.objects)) {
    throw new Error("Choose exactly one archive source: --from-s3 or --objects <directory>.");
  }
  return result;
}

async function main(args) {
  const options = parseRestoreArguments(args);
  const receiptPath = resolve(options.receipt);
  const receipt = validateArchiveReceipt(
    JSON.parse(await readFile(receiptPath, "utf8")),
    { allowLegacyV1: options.allowLegacyV1 === true },
  );
  const remote = options.fromS3
    ? s3ArchiveReader(receipt, process.env, { allowLegacyV1: options.allowLegacyV1 === true })
    : null;
  try {
    return await restoreArchive({
      receipt,
      objectRoot: options.objects ? resolve(options.objects) : null,
      objectReader: remote?.read,
      outputRoot: resolve(options.output),
      only: options.only ?? null,
      allowLegacyV1: options.allowLegacyV1 === true,
    });
  } finally {
    remote?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ success: false, error: error.message })}\n`);
      process.exitCode = 1;
    });
}
