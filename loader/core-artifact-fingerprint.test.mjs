import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { localAccountMappingFingerprint } from "./core-artifact-fingerprint.mjs";

const header =
  "account_id,source_id,source_row_number,ssl_normalized," +
  "address_normalized,unit_number,is_deleted\n";

test("account binding rejects a same-count reordered identity map", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dc-account-binding-"));
  const orderedPath = join(directory, "ordered.csv.gz");
  const reorderedPath = join(directory, "reordered.csv.gz");
  try {
    await writeFile(
      orderedPath,
      gzipSync(
        header +
          "1,itspe_current,1,00010001,1 A ST NW,,false\n" +
          "2,itspe_current,2,00010002,2 A ST NW,,false\n",
      ),
    );
    await writeFile(
      reorderedPath,
      gzipSync(
        header +
          "2,itspe_current,2,00010002,2 A ST NW,,false\n" +
          "1,itspe_current,1,00010001,1 A ST NW,,false\n",
      ),
    );

    const ordered = await localAccountMappingFingerprint(orderedPath);
    assert.equal(ordered.rows, 2);
    assert.match(ordered.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(
      localAccountMappingFingerprint(reorderedPath),
      /strictly increasing account_id/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
