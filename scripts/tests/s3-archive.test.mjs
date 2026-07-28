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
  validateArchiveReceipt,
  writeDeterministicReceipt,
} from "../lib/s3-archive.mjs";

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
      partBytes: 5 * 1024 * 1024,
    });
    validateArchiveReceipt(receipt);
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

test("S3 archive rejects project-root and traversal inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dc-s3-test-"));
  try {
    await assert.rejects(
      inventoryArchiveInputs(root, ["."], {
        bucket: "dc-property-private",
        prefix: "releases/test",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
      }),
      /below the project root/,
    );
    await assert.rejects(
      inventoryArchiveInputs(root, [".."], {
        bucket: "dc-property-private",
        prefix: "releases/test",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
      }),
      /below the project root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
