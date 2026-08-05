# Parcel-resolution implementation plan

Status: approved for implementation on 2026-08-05.

- [x] Register the three MAR sources and normalize deterministic address,
  address-to-SSL, and residential-unit artifacts.
  - Acceptance: malformed identifiers and conflicting duplicates fail closed.
  - Verify: `python -m unittest discover -s .\etl\tests -p "test_*.py" -v`
- [ ] Load current MAR snapshots and publish release metadata transactionally.
  - Acceptance: a failed load preserves the prior current snapshot.
  - Verify: `Set-Location .\loader; npm test`
- [x] Add migration 0031 and the additive parcel-resolution contract.
  - Acceptance: SSL, single-lot, multi-lot, condo-unit, missing-account,
    retired, conflict, fuzzy, and pagination cases pass.
  - Verify: `node --env-file=.env.hosted scripts\validate-migrations.mjs db\migrations\0031_mar_parcel_resolution.sql --test db\tests\0031_mar_parcel_resolution_contract.sql`
- [x] Expose parcel pagination through the existing MCP resolver.
  - Acceptance: existing inputs remain valid and new bounds fail safely.
  - Verify: `Set-Location .\worker; npm run check; npm test; npm run bundle`
- [ ] Acquire, archive, normalize, load, migrate, deploy, and smoke-test.
  - Acceptance: representative production calls return source-linked official
    parcels without regressing existing tools.
  - Verify: authenticated MCP, runtime, security, and performance checks.
