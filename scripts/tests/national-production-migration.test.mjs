import assert from "node:assert/strict";
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

test("national production foundation is independently fail-closed", () => {
  assert.match(migration, /current_database\(\) <> 'dc_property'/);
  assert.match(migration, /quoin\.migration_sha256/);
  assert.match(migration, /quoin\.migration_target_class/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /national foundation is already present/);
  assert.match(migration, /begin;/i);
  assert.match(migration, /commit;/i);
  assert.doesNotMatch(migration, /dc_property_dmv_rehearsal_20260819/);
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
  assert.match(contract, /runtime publication contains a non-D\.C\. member/);
});
