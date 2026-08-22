import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactTarget,
  compareInventories,
  listInventory,
  HETZNER_ARCHIVE_TARGET,
} from "../verify-hetzner-archive.mjs";

test("archive verifier accepts only the canonical private target", () => {
  assert.deepEqual(assertExactTarget({
    HETZNER_S3_BUCKET: HETZNER_ARCHIVE_TARGET.bucket,
    HETZNER_S3_ENDPOINT: HETZNER_ARCHIVE_TARGET.endpoint,
    HETZNER_S3_REGION: HETZNER_ARCHIVE_TARGET.region,
  }), HETZNER_ARCHIVE_TARGET);
  assert.throws(() => assertExactTarget({
    HETZNER_S3_BUCKET: "other",
    HETZNER_S3_ENDPOINT: HETZNER_ARCHIVE_TARGET.endpoint,
    HETZNER_S3_REGION: HETZNER_ARCHIVE_TARGET.region,
  }), /refuses non-canonical bucket/);
});

test("archive verifier inventory is sorted and content-addressed", async () => {
  const client = {
    send: async (command) => {
      assert.equal(command.input.Bucket, HETZNER_ARCHIVE_TARGET.bucket);
      return {
        Contents: [
          { Key: "z/file", Size: 3, ETag: '"z"', LastModified: new Date("2026-01-02T00:00:00Z") },
          { Key: "a/file", Size: 5, ETag: '"a"', LastModified: new Date("2026-01-01T00:00:00Z") },
        ],
        IsTruncated: false,
      };
    },
  };
  const inventory = await listInventory(client, HETZNER_ARCHIVE_TARGET.bucket);
  assert.deepEqual(inventory.objects.map((object) => object.key), ["a/file", "z/file"]);
  assert.equal(inventory.object_count, 2);
  assert.equal(inventory.total_bytes, 8);
  assert.match(inventory.inventory_sha256, /^[0-9a-f]{64}$/);
});

test("archive verifier allows additions but rejects deletions and mutations", () => {
  const original = {
    key: "raw/file",
    size: 3,
    etag: "etag-1",
    last_modified: "2026-01-01T00:00:00.000Z",
  };
  const added = {
    key: "raw/new-file",
    size: 4,
    etag: "etag-2",
    last_modified: "2026-01-02T00:00:00.000Z",
  };
  assert.deepEqual(
    compareInventories({ objects: [original] }, { objects: [original, added] }),
    { additions: ["raw/new-file"], deletions: [], mutations: [] },
  );
  assert.throws(
    () => compareInventories({ objects: [original, added] }, { objects: [original] }),
    /1 deletions, 0 mutations/,
  );
  assert.throws(
    () => compareInventories({ objects: [original] }, { objects: [{ ...original, size: 99 }] }),
    /0 deletions, 1 mutations/,
  );
});
