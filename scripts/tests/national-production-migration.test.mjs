import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../db/production-migrations/0001_national_foundation.sql",
  ),
  "utf8",
);
const contract = readFileSync(
  resolve(
    import.meta.dirname,
    "../../db/production-tests/0001_national_foundation_contract.sql",
  ),
  "utf8",
);
const availabilityMigration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../db/production-migrations/0003_national_availability_reason.sql",
  ),
  "utf8",
);

const migrationSha256 = createHash("sha256").update(migration).digest("hex");

test("national production foundation is independently fail-closed", () => {
  assert.equal(
    migrationSha256,
    "b84cee659122185318d3abc11c2097a00949882586b45fefa140de0a702b2ffe",
  );
  assert.match(migration, /current_database\(\) <> 'dc_property'/);
  assert.match(migration, /quoin\.migration_sha256/);
  assert.match(migration, /quoin\.migration_target_class/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /national foundation is already present/);
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
  assert.doesNotMatch(migration, /dc_property_dmv_rehearsal_20260819/);
});

test("national availability correction is checksum-pinned and fail-closed", () => {
  assert.equal(
    createHash("sha256").update(availabilityMigration).digest("hex"),
    "b151a3bb896b5f4b21dc8efb55af54546dd37c6397c0c70573a81f24e72ccaab",
  );
  assert.match(availabilityMigration, /national-availability-reason-v1/);
  assert.match(availabilityMigration, /m\.availability_status = 'available'/);
});

test("national publication requires a transaction-local marker", () => {
  assert.match(migration, /is distinct from\s+'NATIONAL_PUBLICATION_APPROVED:'/);
  assert.match(migration, /txid_current\(\)::text/);
  for (const table of [
    "publication_set",
    "publication_set_member",
    "publication_set_pointer",
  ]) {
    assert.match(
      migration,
      new RegExp(`before insert or update or delete on meta\\.${table}`),
    );
  }
  assert.match(contract, /publication guard accepted an unapproved write/);
});

test("national runtime is function-only and initially D.C.-only", () => {
  assert.match(migration, /revoke all on %s from public, mcp_runtime/);
  assert.match(migration, /grant execute on function api_v1\.list_national_jurisdictions/);
  assert.match(migration, /'area_us_dc'.*'available'/s);
  assert.doesNotMatch(migration, /'area_us_md'.*'available'/s);
  assert.doesNotMatch(migration, /'area_us_va'.*'available'/s);
  assert.match(
    contract,
    /runtime publication contains a non-D\.C\. available member/,
  );
});

test("national production rollbacks bind to exact reviewed migrations", () => {
  for (const name of [
    "0003_national_availability_reason.sql",
    "0002_national_geography_2025.sql",
    "0001_national_foundation.sql",
  ]) {
    const sql = readFileSync(
      resolve(import.meta.dirname, "../../db/production-rollbacks", name),
      "utf8",
    );
    assert.match(sql, /quoin\.rollback_sha256/);
    assert.match(sql, /quoin\.rollback_target_class/);
    assert.match(sql, /migration_sha256 = '[0-9a-f]{64}'/);
    assert.match(sql, /pg_advisory_xact_lock/);
  }
});
