import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inventoryArchiveInputs,
  materializePart,
  finalizeAcquisitionArchiveBinding,
  validateArchiveReceipt,
  validateAcquisitionArchiveBinding,
  writeDeterministicReceipt,
} from "../lib/s3-archive.mjs";
import {
  archiveEncryption,
  finalizeVerifiedAcquisitionArchive,
  parseArchiveArguments,
} from "../archive-to-s3.mjs";
import { restoreArchive } from "../restore-s3-archive.mjs";

const ENCRYPTION = {
  mode: "SSE-C",
  algorithm: "AES256",
  key_sha256: "1".repeat(64),
};

test("S3 archive inventory is content addressed, chunked, and reconstructable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dc-s3-test-"));
  try {
    await mkdir(join(root, "input"));
    const bytes = Buffer.from("abcdefghijklmno", "utf8");
    await writeFile(join(root, "input", "sample.bin"), bytes);
    const receipt = await inventoryArchiveInputs(root, ["input"], {
      bucket: "dc-property-private",
      prefix: "releases/test",
      provider: "hetzner_object_storage",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      encryption: ENCRYPTION,
      partBytes: 5 * 1024 * 1024,
    });
    validateArchiveReceipt(receipt);
    assert.throws(
      () => validateArchiveReceipt({ ...receipt, prefix: "../unsafe" }),
      /Invalid S3 archive receipt/,
    );
    assert.throws(
      () => validateArchiveReceipt({ ...receipt, files: [...receipt.files, receipt.files[0]] }),
      /Invalid file entry/,
    );
    assert.throws(
      () => validateArchiveReceipt({ ...receipt, files: [{ ...receipt.files[0], relative_path: "../sample.bin" }] }),
      /Invalid file entry/,
    );
    assert.throws(
      () => validateArchiveReceipt({ ...receipt, files: [{ ...receipt.files[0], parts: [{ ...receipt.files[0].parts[0], byte_offset: Number.MAX_SAFE_INTEGER + 1 }] }] }),
      /Invalid part entry/,
    );
    assert.throws(
      () => validateArchiveReceipt({ ...receipt, archive_id: "0".repeat(64) }),
      /identity is inconsistent/,
    );
    assert.equal(receipt.files.length, 1);
    assert.equal(receipt.files[0].parts.length, 1);
    assert.equal(
      receipt.files[0].sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.match(
      receipt.files[0].parts[0].object_key,
      /releases\/test\/sha256\//,
    );
    const materialized = await materializePart(
      join(root, "input", "sample.bin"),
      receipt.files[0].parts[0],
      root,
    );
    assert.deepEqual(await readFile(materialized), bytes);
    const first = await writeDeterministicReceipt(receipt, join(root, "receipts"));
    const second = await writeDeterministicReceipt(receipt, join(root, "receipts"));
    assert.equal(first.sha256, second.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture archive receipts are rejected by normal paths and require the disposable integration gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "dc-s3-fixture-test-"));
  try {
    const artifact = join(root, "fixture.ndjson");
    await writeFile(artifact, '{"fixture":true}\n');
    const receipt = await inventoryArchiveInputs(root, ["fixture.ndjson"], {
      bucket: "quoin-local-fixture",
      prefix: "rehearsal/fixture",
      provider: "rehearsal_fixture_no_upload",
      endpoint: "https://fixture.invalid",
      region: "local",
      encryption: ENCRYPTION,
      fixture: true,
    });
    assert.equal(receipt.status, "fixture_verified");
    assert.throws(() => validateArchiveReceipt(receipt), /explicit disposable integration validation/i);
    assert.equal(validateArchiveReceipt(receipt, { allowFixture: true }).fixture, true);
    assert.throws(
      () => validateArchiveReceipt({ ...receipt, provider: "hetzner_object_storage" }, { allowFixture: true }),
      /no-upload rehearsal provider/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 archive restore verifies parts and the reconstructed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "dc-s3-restore-test-"));
  try {
    const bytes = Buffer.from("restored archive", "utf8");
    await mkdir(join(root, "input"));
    await writeFile(join(root, "input", "sample.bin"), bytes);
    const receipt = await inventoryArchiveInputs(root, ["input/sample.bin"], {
      bucket: "dc-property-private",
      prefix: "releases/test",
      provider: "hetzner_object_storage",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      encryption: ENCRYPTION,
    });
    const receiptPath = join(root, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt));
    const part = receipt.files[0].parts[0];
    const objectPath = join(root, "objects", ...part.object_key.slice("releases/test/".length).split("/"));
    await mkdir(join(objectPath, ".."), { recursive: true });
    await writeFile(objectPath, bytes);
    const result = await restoreArchive({
      receiptPath,
      objectRoot: join(root, "objects"),
      outputRoot: join(root, "restore"),
    });
    assert.equal(result.archive_id, receipt.archive_id);
    assert.deepEqual(await readFile(join(root, "restore", "input", "sample.bin")), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S3 archive rejects project-root and traversal inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dc-s3-test-"));
  try {
    await assert.rejects(
      inventoryArchiveInputs(root, ["."], {
        bucket: "dc-property-private",
        prefix: "releases/test",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
        encryption: ENCRYPTION,
      }),
      /below the project root/,
    );
    await assert.rejects(
      inventoryArchiveInputs(root, [".."], {
        bucket: "dc-property-private",
        prefix: "releases/test",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
        encryption: ENCRYPTION,
      }),
      /below the project root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquisition archive binding closes exact manifest/artifact hashes and rejects unarchived or mismatched inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dc-s3-binding-test-"));
  try {
    await mkdir(join(root, "data"));
    const artifactPath = join(root, "data", "source.ndjson");
    const manifestPath = join(root, "data", "source.manifest.json");
    const artifactBytes = Buffer.from('{"id":"a"}\n');
    await writeFile(artifactPath, artifactBytes);
    const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
    const manifest = { status: "complete", artifact: { file: "source.ndjson", bytes: artifactBytes.length, sha256: artifactSha256 } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const receipt = await inventoryArchiveInputs(root, ["data"], {
      bucket: "dc-property-private",
      prefix: "releases/binding",
      provider: "hetzner_object_storage",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      encryption: ENCRYPTION,
    });
    const receiptPath = join(root, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt));
    const binding = await finalizeAcquisitionArchiveBinding({ projectRoot: root, manifestPath, artifactPath, receiptPath });
    assert.equal(binding.binding.status, "verified");
    await validateAcquisitionArchiveBinding({ projectRoot: root, manifestPath, artifactPath, receiptPath, bindingPath: binding.path });
    const cliBinding = await finalizeVerifiedAcquisitionArchive({
      projectRoot: root,
      options: {
        acquisitionManifest: "data/source.manifest.json",
        acquisitionArtifact: "data/source.ndjson",
      },
      receiptPath,
    });
    assert.equal(cliBinding.path, binding.path);
    assert.equal(
      await finalizeVerifiedAcquisitionArchive({ options: {}, receiptPath, projectRoot: root }),
      null,
    );
    await assert.rejects(
      validateAcquisitionArchiveBinding({ projectRoot: root, manifestPath, artifactPath, receiptPath, bindingPath: join(root, "missing.archive-binding.json") }),
      /required acquisition archive binding sidecar is missing/i,
    );

    await writeFile(binding.path, JSON.stringify({ ...binding.binding, archive: { ...binding.binding.archive, archive_id: "0".repeat(64) } }));
    await assert.rejects(
      validateAcquisitionArchiveBinding({ projectRoot: root, manifestPath, artifactPath, receiptPath, bindingPath: binding.path }),
      /does not close/i,
    );

    const unarchivedReceipt = await inventoryArchiveInputs(root, ["data/source.ndjson"], {
      bucket: "dc-property-private",
      prefix: "releases/unarchived",
      provider: "hetzner_object_storage",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      encryption: ENCRYPTION,
    });
    const unarchivedPath = join(root, "unarchived-receipt.json");
    await writeFile(unarchivedPath, JSON.stringify(unarchivedReceipt));
    await assert.rejects(
      finalizeAcquisitionArchiveBinding({ projectRoot: root, manifestPath, artifactPath, receiptPath: unarchivedPath }),
      /does not bind acquisition manifest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive CLI requires an explicit manifest/artifact pair for acquisition bindings", () => {
  const base = ["--bucket", "bucket", "--prefix", "release", "--input", "data"];
  assert.deepEqual(
    parseArchiveArguments([...base, "--acquisition-manifest", "data/a.manifest.json", "--acquisition-artifact", "data/a.ndjson"], {}).acquisitionManifest,
    "data/a.manifest.json",
  );
  assert.throws(
    () => parseArchiveArguments([...base, "--acquisition-manifest", "data/a.manifest.json"], {}),
    /must be supplied together/,
  );
});

test("S3 archive encryption validates a separate 256-bit key", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encryption = archiveEncryption({
    ARCHIVE_SSE_C_KEY_BASE64: key,
  });
  assert.deepEqual(encryption.receipt, {
    mode: "SSE-C",
    algorithm: "AES256",
    key_sha256: createHash("sha256")
      .update(Buffer.alloc(32, 7))
      .digest("hex"),
  });
  assert.equal(encryption.request.SSECustomerAlgorithm, "AES256");
  assert.equal(encryption.request.SSECustomerKey, key);
  assert.equal(
    encryption.request.SSECustomerKeyMD5,
    createHash("md5").update(Buffer.alloc(32, 7)).digest("base64"),
  );
  assert.throws(
    () => archiveEncryption({ ARCHIVE_SSE_C_KEY_BASE64: "short" }),
    /exactly 32 bytes/,
  );
});
