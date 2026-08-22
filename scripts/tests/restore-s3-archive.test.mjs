import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { inventoryArchiveInputs, validateArchiveReceipt } from "../lib/s3-archive.mjs";
import { parseRestoreArguments, restoreArchive, s3ArchiveReader } from "../restore-s3-archive.mjs";

const KEY = Buffer.alloc(32, 7);

function s3Environment(receipt) {
  return {
    ARCHIVE_SSE_C_KEY_BASE64: KEY.toString("base64"),
    HETZNER_S3_ENDPOINT: receipt.endpoint,
    HETZNER_S3_REGION: receipt.region,
    HETZNER_S3_BUCKET: receipt.bucket,
    HETZNER_S3_ACCESS_KEY_ID: "test-access",
    HETZNER_S3_SECRET_ACCESS_KEY: "test-secret",
  };
}

test("remote archive restore streams and verifies only the requested file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quoin-restore-"));
  const bytes = Buffer.from("verified remote archive\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const inputRoot = join(directory, "input");
  const outputRoot = join(directory, "output");
  const source = join(inputRoot, "data/generated/md/example.txt");
  await mkdir(join(inputRoot, "data/generated/md"), { recursive: true });
  await writeFile(source, bytes);
  const receipt = await inventoryArchiveInputs(inputRoot, [source], {
    bucket: "test-bucket",
    prefix: "releases/test",
    provider: "hetzner_object_storage",
    endpoint: "https://objects.example.test",
    region: "test-1",
    encryption: { mode: "SSE-C", algorithm: "AES256", key_sha256: "a".repeat(64) },
  });
  try {
    const result = await restoreArchive({
      receipt,
      objectReader: async () => Readable.from([bytes]),
      outputRoot,
      only: "data/generated/md/example.txt",
    });
    assert.equal(result.files[0].sha256, sha256);
    assert.deepEqual(await readFile(join(outputRoot, "data/generated/md/example.txt")), bytes);
    await assert.rejects(
      restoreArchive({ receipt, objectReader: async () => Readable.from([bytes]), outputRoot, only: "missing" }),
      /does not contain requested file/,
    );
    await assert.rejects(
      restoreArchive({ receipt, objectReader: async () => Readable.from([bytes]), outputRoot, only: "" }),
      /filter must be a nonempty string/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore CLI rejects ambiguous or incomplete arguments", () => {
  assert.deepEqual(
    parseRestoreArguments(["--receipt", "receipt.json", "--objects", "objects", "--output", "out", "--only", "file"]),
    { fromS3: false, receipt: "receipt.json", objects: "objects", output: "out", only: "file" },
  );
  assert.throws(() => parseRestoreArguments(["--receipt", "r", "--objects", "o", "--output", "x", "--only"]), /requires a nonempty value/);
  assert.throws(() => parseRestoreArguments(["--receipt", "r", "--objects", "o", "--output", "x", "--only", ""]), /requires a nonempty value/);
  assert.throws(() => parseRestoreArguments(["--receipt", "r", "--objects", "o", "--output", "x", "--unknown"]), /Unknown restore argument/);
  assert.throws(() => parseRestoreArguments(["--receipt", "r", "--receipt", "r", "--objects", "o", "--output", "x"]), /Duplicate restore argument/);
  assert.throws(() => parseRestoreArguments(["--receipt", "r", "--objects", "o", "--from-s3", "--output", "x"]), /exactly one archive source/);
  assert.deepEqual(
    parseRestoreArguments(["--receipt", "r", "--objects", "o", "--output", "x", "--allow-legacy-v1"]),
    { fromS3: false, receipt: "r", objects: "o", output: "x", allowLegacyV1: true },
  );
});

test("legacy v1 receipts require explicit opt-in and remote reader omits SSE-C", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quoin-legacy-v1-"));
  const inputRoot = join(directory, "input");
  await mkdir(inputRoot);
  await writeFile(join(inputRoot, "example.txt"), "legacy\n");
  const v2 = await inventoryArchiveInputs(inputRoot, ["example.txt"], {
    bucket: "test-bucket",
    prefix: "releases/test",
    provider: "hetzner_object_storage",
    endpoint: "https://objects.example.test",
    region: "test-1",
    encryption: { mode: "SSE-C", algorithm: "AES256", key_sha256: createHash("sha256").update(KEY).digest("hex") },
  });
  const { archive_id: ignoredArchiveId, status: ignoredStatus, receipt_object_key: ignoredReceiptKey, encryption, ...legacyIdentity } = v2;
  const v1Identity = { ...legacyIdentity, receipt_version: 1 };
  const archiveId = createHash("sha256").update(JSON.stringify(v1Identity)).digest("hex");
  const v1 = { ...v1Identity, archive_id: archiveId, status: "verified", receipt_object_key: `${v2.prefix}/receipts/${archiveId}.json` };
  try {
    assert.throws(() => validateArchiveReceipt(v1), /explicit opt-in/);
    assert.equal(validateArchiveReceipt(v1, { allowLegacyV1: true }).receipt_version, 1);
    assert.throws(() => s3ArchiveReader(v1, {
      HETZNER_S3_ENDPOINT: v1.endpoint,
      HETZNER_S3_REGION: v1.region,
      HETZNER_S3_BUCKET: v1.bucket,
      HETZNER_S3_ACCESS_KEY_ID: "test-access",
      HETZNER_S3_SECRET_ACCESS_KEY: "test-secret",
    }), /explicit opt-in/);
    const remote = s3ArchiveReader(v1, {
      HETZNER_S3_ENDPOINT: v1.endpoint,
      HETZNER_S3_REGION: v1.region,
      HETZNER_S3_BUCKET: v1.bucket,
      HETZNER_S3_ACCESS_KEY_ID: "test-access",
      HETZNER_S3_SECRET_ACCESS_KEY: "test-secret",
    }, { allowLegacyV1: true });
    remote.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore refuses existing targets, cleans failed partials, and rejects escaped parents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quoin-restore-safety-"));
  const inputRoot = join(directory, "input");
  const outputRoot = join(directory, "output");
  const source = join(inputRoot, "nested/example.txt");
  const expected = Buffer.from("expected\n");
  await mkdir(join(inputRoot, "nested"), { recursive: true });
  await writeFile(source, expected);
  const receipt = await inventoryArchiveInputs(inputRoot, [source], {
    bucket: "test-bucket",
    prefix: "releases/test",
    provider: "hetzner_object_storage",
    endpoint: "https://objects.example.test",
    region: "test-1",
    encryption: { mode: "SSE-C", algorithm: "AES256", key_sha256: createHash("sha256").update(KEY).digest("hex") },
  });
  const target = join(outputRoot, "nested/example.txt");
  try {
    await mkdir(join(outputRoot, "nested"), { recursive: true });
    await writeFile(target, "keep\n");
    await assert.rejects(
      restoreArchive({ receipt, objectReader: async () => Readable.from([expected]), outputRoot }),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(target, "utf8"), "keep\n");
    await rm(target);

    await assert.rejects(
      restoreArchive({ receipt, objectReader: async () => Readable.from([Buffer.from("wrong\n")]), outputRoot }),
      /verification failed/,
    );
    await assert.rejects(readFile(`${target}.partial`), { code: "ENOENT" });

    await rm(join(outputRoot, "nested"), { recursive: true });
    const outside = join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(outputRoot, "nested"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      restoreArchive({ receipt, objectReader: async () => Readable.from([expected]), outputRoot }),
      /outside its configured root/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S3 restore reader rejects storage mismatches and invalid timeouts before I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quoin-restore-env-"));
  const inputRoot = join(directory, "input");
  const source = join(inputRoot, "example.txt");
  await mkdir(inputRoot);
  await writeFile(source, "example\n");
  const receipt = await inventoryArchiveInputs(inputRoot, [source], {
    bucket: "test-bucket",
    prefix: "releases/test",
    provider: "hetzner_object_storage",
    endpoint: "https://objects.example.test",
    region: "test-1",
    encryption: { mode: "SSE-C", algorithm: "AES256", key_sha256: createHash("sha256").update(KEY).digest("hex") },
  });
  try {
    assert.throws(() => s3ArchiveReader(receipt, { ...s3Environment(receipt), HETZNER_S3_BUCKET: "wrong" }), /does not match/);
    assert.throws(() => s3ArchiveReader(receipt, s3Environment(receipt), { timeoutMs: 0 }), /positive integer/);
    s3ArchiveReader(receipt, s3Environment(receipt)).close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
