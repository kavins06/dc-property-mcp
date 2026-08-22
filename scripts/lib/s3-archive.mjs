import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";

export const S3_ARCHIVE_RECEIPT_KIND = "dc-property-s3-archive";
export const S3_ARCHIVE_RECEIPT_VERSION = 2;
export const DEFAULT_S3_PART_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function containedPath(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function safeKeySegment(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error(`${label} is not a safe S3 key segment.`);
  }
  return value;
}

async function walkInput(projectRoot, input) {
  const requested = resolve(projectRoot, input);
  if (!containedPath(projectRoot, requested)) {
    throw new Error(`Archive input must be below the project root: ${input}`);
  }
  const requestedStat = await lstat(requested);
  if (requestedStat.isSymbolicLink()) {
    throw new Error(`Archive input cannot be a symbolic link: ${input}`);
  }
  const canonicalProject = await realpath(projectRoot);
  const canonicalRequested = await realpath(requested);
  if (!containedPath(canonicalProject, canonicalRequested)) {
    throw new Error(`Archive input resolves outside the project root: ${input}`);
  }
  if (requestedStat.isFile()) return [requested];
  if (!requestedStat.isDirectory()) {
    throw new Error(`Archive input is not a regular file or directory: ${input}`);
  }
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Archive tree contains a symbolic link: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Archive tree contains a non-regular file: ${path}`);
      }
    }
  }
  await visit(requested);
  return files;
}

export async function inventoryArchiveInputs(
  projectRoot,
  inputs,
  {
    bucket,
    prefix,
    provider = "s3_compatible",
    endpoint,
    region,
    encryption,
    fixture = false,
    partBytes = DEFAULT_S3_PART_BYTES,
  },
) {
  if (!Array.isArray(inputs) || inputs.length < 1) {
    throw new Error("At least one archive input is required.");
  }
  safeKeySegment(bucket, "S3 bucket");
  safeKeySegment(provider, "S3 provider");
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
    throw new Error("S3 endpoint must be an HTTPS URL.");
  }
  if (
    typeof region !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)
  ) {
    throw new Error("S3 region is invalid.");
  }
  const cleanPrefix = String(prefix ?? "")
    .split("/")
    .filter(Boolean)
    .map((segment) => safeKeySegment(segment, "S3 prefix"))
    .join("/");
  if (!cleanPrefix) throw new Error("A nonempty S3 prefix is required.");
  if (!Number.isSafeInteger(partBytes) || partBytes < 5 * 1024 * 1024) {
    throw new Error("S3 part size must be an integer of at least 5 MiB.");
  }
  if (
    encryption?.mode !== "SSE-C" ||
    encryption?.algorithm !== "AES256" ||
    !SHA256.test(encryption?.key_sha256 ?? "")
  ) {
    throw new Error("S3 archival requires AES256 SSE-C encryption metadata.");
  }

  const uniqueFiles = new Map();
  for (const input of inputs) {
    for (const path of await walkInput(projectRoot, input)) {
      uniqueFiles.set(await realpath(path), path);
    }
  }
  const files = [];
  for (const path of [...uniqueFiles.values()].sort((left, right) =>
    portableRelative(projectRoot, left).localeCompare(
      portableRelative(projectRoot, right),
    )
  )) {
    const fileStat = await stat(path);
    const fileSha256 = await sha256File(path);
    const partCount = Math.max(1, Math.ceil(fileStat.size / partBytes));
    const parts = [];
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      const start = partIndex * partBytes;
      const bytes = Math.min(partBytes, fileStat.size - start);
      const partSha256 =
        partCount === 1
          ? fileSha256
          : await sha256Range(path, start, bytes);
      const partLabel =
        partCount === 1
          ? basename(path)
          : `${basename(path)}.part-${String(partIndex + 1).padStart(4, "0")}` +
            `-of-${String(partCount).padStart(4, "0")}`;
      parts.push({
        part_number: partIndex + 1,
        byte_offset: start,
        bytes,
        sha256: partSha256,
        object_key: posix.join(
          cleanPrefix,
          "sha256",
          partSha256,
          partLabel,
        ),
      });
    }
    files.push({
      relative_path: portableRelative(projectRoot, path),
      bytes: fileStat.size,
      sha256: fileSha256,
      parts,
    });
  }
  const identity = {
    receipt_kind: S3_ARCHIVE_RECEIPT_KIND,
    receipt_version: S3_ARCHIVE_RECEIPT_VERSION,
    provider,
    endpoint,
    region,
    bucket,
    prefix: cleanPrefix,
    encryption,
    files,
    ...(fixture ? { fixture: true } : {}),
  };
  const archiveId = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return {
    ...identity,
    archive_id: archiveId,
    status: fixture ? "fixture_verified" : "verified",
    receipt_object_key: posix.join(
      cleanPrefix,
      "receipts",
      `${archiveId}.json`,
    ),
  };
}

async function sha256Range(path, start, bytes) {
  const digest = createHash("sha256");
  const end = start + bytes - 1;
  for await (const chunk of createReadStream(path, { start, end })) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function materializePart(sourcePath, part, directory) {
  const destination = resolve(
    directory,
    `${part.sha256}.part-${String(part.part_number).padStart(4, "0")}`,
  );
  await pipeline(
    createReadStream(sourcePath, {
      start: part.byte_offset,
      end: part.byte_offset + part.bytes - 1,
    }),
    createWriteStream(destination, {
      flags: "wx",
      mode: 0o600,
    }),
  );
  const observed = await sha256File(destination);
  if (observed !== part.sha256 || (await stat(destination)).size !== part.bytes) {
    await rm(destination, { force: true });
    throw new Error("Materialized S3 archive part failed its local hash gate.");
  }
  return destination;
}

export async function writeDeterministicReceipt(receipt, directory) {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${receipt.archive_id}.json`);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await writeFile(path, bytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== bytes) {
      throw new Error(`Existing archive receipt differs: ${path}`);
    }
  }
  return {
    path,
    sha256: await sha256File(path),
  };
}

export async function withArchiveTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "dc-property-s3-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

export function validateArchiveReceipt(
  receipt,
  { allowFixture = false, allowLegacyV1 = false } = {},
) {
  const fixture = receipt?.fixture === true;
  const legacyV1 = receipt?.receipt_version === 1;
  if (legacyV1 && !allowLegacyV1) {
    throw new Error("Legacy v1 archive receipts require explicit opt-in.");
  }
  if (fixture && !allowFixture) throw new Error("Fixture archive receipts require explicit disposable integration validation.");
  if (fixture && receipt.provider !== "rehearsal_fixture_no_upload") throw new Error("Fixture archive receipts must use the no-upload rehearsal provider.");
  const expectedStatus = fixture ? "fixture_verified" : "verified";
  const prefix = typeof receipt?.prefix === "string" ? receipt.prefix : "";
  const prefixSegments = prefix.split("/");
  if (
    !receipt ||
    receipt.receipt_kind !== S3_ARCHIVE_RECEIPT_KIND ||
    ![1, S3_ARCHIVE_RECEIPT_VERSION].includes(receipt.receipt_version) ||
    receipt.status !== expectedStatus ||
    !SHA256.test(receipt.archive_id) ||
    typeof receipt.provider !== "string" ||
    !receipt.provider ||
    typeof receipt.endpoint !== "string" ||
    !/^https:\/\//.test(receipt.endpoint) ||
    typeof receipt.region !== "string" ||
    !receipt.region ||
    typeof receipt.bucket !== "string" ||
    !receipt.bucket ||
    !prefix ||
    prefixSegments.some((segment) => {
      try {
        safeKeySegment(segment, "S3 prefix");
        return false;
      } catch {
        return true;
      }
    }) ||
    !Array.isArray(receipt.files) ||
    receipt.files.length < 1 ||
    (!legacyV1 && (
      receipt.encryption?.mode !== "SSE-C" ||
      receipt.encryption?.algorithm !== "AES256" ||
      !SHA256.test(receipt.encryption?.key_sha256 ?? "")
    ))
  ) {
    throw new Error("Invalid S3 archive receipt.");
  }
  try {
    safeKeySegment(receipt.bucket, "S3 bucket");
  } catch {
    throw new Error("Invalid S3 archive receipt.");
  }
  const relativePaths = new Set();
  for (const file of receipt.files) {
    const pathSegments = typeof file.relative_path === "string"
      ? file.relative_path.split("/")
      : [];
    if (
      typeof file.relative_path !== "string" ||
      !file.relative_path ||
      file.relative_path.includes("\\") ||
      pathSegments.some((segment) => !segment || segment === "." || segment === "..") ||
      posix.isAbsolute(file.relative_path) ||
      relativePaths.has(file.relative_path) ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !Array.isArray(file.parts) ||
      file.parts.length < 1
    ) {
      throw new Error("Invalid file entry in S3 archive receipt.");
    }
    relativePaths.add(file.relative_path);
    const ordered = [...file.parts].sort(
      (left, right) => left.part_number - right.part_number,
    );
    let offset = 0;
    for (const [index, part] of ordered.entries()) {
      if (
        part.part_number !== index + 1 ||
        !Number.isSafeInteger(part.byte_offset) ||
        part.byte_offset !== offset ||
        !Number.isSafeInteger(part.bytes) ||
        part.bytes < 0 ||
        !SHA256.test(part.sha256) ||
        typeof part.object_key !== "string" ||
        !part.object_key ||
        !part.object_key.startsWith(`${prefix}/`)
      ) {
        throw new Error("Invalid part entry in S3 archive receipt.");
      }
      offset += part.bytes;
      if (!Number.isSafeInteger(offset)) {
        throw new Error("Invalid part entry in S3 archive receipt.");
      }
    }
    if (offset !== file.bytes) {
      throw new Error("S3 archive parts do not reconstruct their source file.");
    }
  }
  const {
    archive_id: archiveId,
    status,
    receipt_object_key: receiptObjectKey,
    ...identity
  } = receipt;
  const expectedArchiveId = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (
    status !== expectedStatus ||
    archiveId !== expectedArchiveId ||
    receiptObjectKey !== posix.join(receipt.prefix, "receipts", `${archiveId}.json`)
  ) {
    throw new Error("S3 archive receipt identity is inconsistent.");
  }
  return receipt;
}

export const ACQUISITION_ARCHIVE_BINDING_KIND = "dc-property-acquisition-archive-binding";
export const ACQUISITION_ARCHIVE_BINDING_VERSION = 1;

function projectRelativePath(projectRoot, candidate, label) {
  const root = resolve(projectRoot);
  const path = resolve(candidate);
  if (!containedPath(root, path)) throw new Error(`${label} must be below the project root.`);
  return portableRelative(root, path);
}

function receiptFile(receipt, relativePath, bytes, sha256, label) {
  const matches = receipt.files.filter((entry) => entry.relative_path === relativePath);
  const file = matches[0];
  if (matches.length !== 1 || !file || file.bytes !== bytes || file.sha256 !== sha256) {
    throw new Error(`Encrypted archive receipt does not bind ${label}: ${relativePath}.`);
  }
  return file;
}

async function acquisitionArchiveInputs({ projectRoot, manifestPath, artifactPath, receiptPath, allowFixture = false }) {
  const manifestRelativePath = projectRelativePath(projectRoot, manifestPath, "Acquisition manifest");
  const artifactRelativePath = projectRelativePath(projectRoot, artifactPath, "Acquisition artifact");
  const receiptRelativePath = projectRelativePath(projectRoot, receiptPath, "Archive receipt");
  const [manifestBytes, artifactStat, receiptBytes] = await Promise.all([
    readFile(manifestPath),
    stat(artifactPath),
    readFile(receiptPath),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const receipt = validateArchiveReceipt(JSON.parse(receiptBytes), { allowFixture });
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const artifactSha256 = await sha256File(artifactPath);
  if (
    manifest.status !== "complete" ||
    manifest.artifact?.file !== basename(artifactPath) ||
    manifest.artifact?.bytes !== artifactStat.size ||
    manifest.artifact?.sha256 !== artifactSha256
  ) {
    throw new Error("Acquisition manifest does not close its artifact bytes and hash.");
  }
  const receiptManifest = receiptFile(receipt, manifestRelativePath, manifestBytes.length, manifestSha256, "acquisition manifest");
  const receiptArtifact = receiptFile(receipt, artifactRelativePath, artifactStat.size, artifactSha256, "acquisition artifact");
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  return {
    manifest,
    manifestRelativePath,
    manifestBytes: manifestBytes.length,
    manifestSha256,
    artifactRelativePath,
    artifactBytes: artifactStat.size,
    artifactSha256,
    receipt,
    receiptPath: receiptRelativePath,
    receiptSha256,
    receiptManifest,
    receiptArtifact,
  };
}

export async function finalizeAcquisitionArchiveBinding({
  projectRoot,
  manifestPath,
  artifactPath,
  receiptPath,
  allowFixture = false,
  bindingPath = `${manifestPath}.archive-binding.json`,
}) {
  const inputs = await acquisitionArchiveInputs({ projectRoot, manifestPath, artifactPath, receiptPath, allowFixture });
  projectRelativePath(projectRoot, bindingPath, "Acquisition archive binding");
  const binding = {
    binding_kind: ACQUISITION_ARCHIVE_BINDING_KIND,
    binding_version: ACQUISITION_ARCHIVE_BINDING_VERSION,
    status: "verified",
    acquisition_manifest: {
      relative_path: inputs.manifestRelativePath,
      bytes: inputs.manifestBytes,
      sha256: inputs.manifestSha256,
    },
    acquisition_artifact: {
      relative_path: inputs.artifactRelativePath,
      bytes: inputs.artifactBytes,
      sha256: inputs.artifactSha256,
    },
    archive: {
      archive_id: inputs.receipt.archive_id,
      receipt_sha256: inputs.receiptSha256,
      receipt_object_key: inputs.receipt.receipt_object_key,
      artifact_object_keys: inputs.receiptArtifact.parts.map((part) => part.object_key),
      manifest_object_keys: inputs.receiptManifest.parts.map((part) => part.object_key),
    },
  };
  const bytes = `${JSON.stringify(binding, null, 2)}\n`;
  try {
    await writeFile(bindingPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if ((await readFile(bindingPath, "utf8")) !== bytes) throw new Error(`Existing acquisition archive binding differs: ${bindingPath}`);
  }
  return { path: bindingPath, binding };
}

export async function validateAcquisitionArchiveBinding({
  projectRoot,
  manifestPath,
  artifactPath,
  receiptPath,
  allowFixture = false,
  bindingPath = null,
}) {
  const inputs = await acquisitionArchiveInputs({ projectRoot, manifestPath, artifactPath, receiptPath, allowFixture });
  if (!bindingPath) return inputs;
  projectRelativePath(projectRoot, bindingPath, "Acquisition archive binding");
  let binding;
  try {
    binding = JSON.parse(await readFile(bindingPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Required acquisition archive binding sidecar is missing: ${bindingPath}`);
    throw error;
  }
  if (
    binding.binding_kind !== ACQUISITION_ARCHIVE_BINDING_KIND ||
    binding.binding_version !== ACQUISITION_ARCHIVE_BINDING_VERSION ||
    binding.status !== "verified" ||
    JSON.stringify(binding.acquisition_manifest) !== JSON.stringify({ relative_path: inputs.manifestRelativePath, bytes: inputs.manifestBytes, sha256: inputs.manifestSha256 }) ||
    JSON.stringify(binding.acquisition_artifact) !== JSON.stringify({ relative_path: inputs.artifactRelativePath, bytes: inputs.artifactBytes, sha256: inputs.artifactSha256 }) ||
    binding.archive?.archive_id !== inputs.receipt.archive_id ||
    binding.archive?.receipt_sha256 !== inputs.receiptSha256 ||
    binding.archive?.receipt_object_key !== inputs.receipt.receipt_object_key ||
    JSON.stringify(binding.archive?.artifact_object_keys) !== JSON.stringify(inputs.receiptArtifact.parts.map((part) => part.object_key)) ||
    JSON.stringify(binding.archive?.manifest_object_keys) !== JSON.stringify(inputs.receiptManifest.parts.map((part) => part.object_key))
  ) {
    throw new Error("Acquisition archive binding does not close the manifest, artifact, and verified receipt.");
  }
  return { ...inputs, binding };
}
