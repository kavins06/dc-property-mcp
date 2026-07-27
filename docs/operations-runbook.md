# Operations runbook

## Service

- MCP: `https://dc-property-mcp.quoindata.com/mcp`
- Health: `https://dc-property-mcp.quoindata.com/healthz`
- Database: Supabase PostgreSQL through Cloudflare Hyperdrive
- Authentication: WorkOS AuthKit

The service is read-only. A healthy unauthenticated MCP request returns `401`
with a `WWW-Authenticate` link to protected-resource metadata.

## Release

Run from the project root:

```powershell
python -m unittest discover -s etl\tests -v
cd worker
npm run check
npm test
npm run bundle
npm audit --audit-level=moderate
cd ..
node --env-file=.env.hosted scripts\apply-migration.mjs db\tests\postload_checks.sql
node --env-file=.env.hosted scripts\validate-reviewer-remediation.mjs
node --env-file=.env.hosted scripts\verify-runtime.mjs
python scripts\check_evidence.py
node --env-file=.env.hosted scripts\deploy-cloudflare.mjs
node scripts\verify-live.mjs 0.3.0
node scripts\verify-authenticated-mcp.mjs
```

Run the database migration rehearsal, post-load assertions, and runtime timing
checks serially. They intentionally take DDL and read locks that can deadlock
or distort latency when run against the same small database in parallel.

The authenticated verifier starts a localhost callback and prints a short-lived
WorkOS authorization URL. Open it in a browser, complete sign-in and any
human-verification challenge, then let the script discover and call all ten
tools. It stores OAuth client data and tokens only in process memory.

The deployment helper keeps the active version at 100%, adds the candidate at
0%, targets the candidate with Cloudflare's version-override header, and only
then promotes it. Any failed candidate or post-promotion check restores the
previous version automatically. The release report in
`db/reports/generated/release-<version>.json` records both version IDs.

Database migrations are additive and backward-compatible. A Worker rollback
therefore does not require an immediate database rollback.

## Monitoring and thresholds

Cloudflare Workers Logs and traces sample 100% of this low-volume service.
Structured logs contain request ID, method, path, status, duration, and a safe
error class only; they must never contain tokens, request bodies, owner/mailing
payloads, source URLs, or database connection strings.

Investigate when any of these occurs:

- health check is not `200` for two consecutive minutes;
- 5xx rate exceeds 1% over 15 minutes or any sustained 1101 Worker exception;
- p95 MCP latency exceeds 3 seconds over 15 minutes;
- OAuth metadata or the unauthenticated challenge fails;
- database size reaches 470,000,000 bytes (headroom warning) or exceeds the
  480,000,000-byte release gate;
- any dependency audit reports a high or critical vulnerability;
- source evidence returns an ArcGIS REST, JSON, or session-bound MyTax URL.

## Incident response

1. Record UTC time, Cloudflare Ray/request ID, endpoint, and deployed version.
2. Check Worker logs without copying access tokens or request bodies.
3. Run `node scripts\verify-live.mjs <expected-version>`.
4. Run `node --env-file=.env.hosted scripts\verify-runtime.mjs` to separate the
   Worker/OAuth layer from PostgreSQL.
5. If the current Worker is faulty, use the previous version ID in the release
   report:

   ```powershell
   node --env-file=.env.hosted scripts\rollback-cloudflare.mjs <version-id> <service-version> --confirm
   ```

   The rollback command verifies the restored service and automatically returns
   to the starting version if that verification fails.
6. If database functions fail, leave the Worker authentication boundary up,
   stop releases, and investigate Supabase logs/advisors. Do not grant direct
   table access as a workaround.
7. After recovery, document cause, impact window, evidence, and prevention.

## Data and advisor checks

- Expected serving counts are 221,263 current accounts, 652,131 assessment
  records, 221,263 tax series, 215,408 sale-history accounts, and 421,436 linked
  CAMA records.
- Nine CAMA source records are intentionally retained as unlinked diagnostics.
- Supabase security advisor must be empty before release.
- The performance advisor may report unindexed foreign keys on static source
  metadata and a missing primary key on the immutable assessment history. This
  is an accepted free-tier storage waiver: runtime lookups use dedicated
  account indexes, diagnostic links use a partial unique index, and post-load
  assertions enforce integrity. Re-evaluate the waiver before enabling writes
  or moving to a storage tier where the approximately 14 MB full index is
  immaterial.
- Any new warning, any security advisory, or a changed query plan requires
  investigation; do not expand the waiver by analogy.

## Demo smoke sequence

Use the pre-verified 1801 K Street account (`0107--0075`) for the institutional
walkthrough:

1. Resolve the SSL and the address independently.
2. Fetch the snapshot, assessment history, tax/balance history, sale/deed
   history, and ownership.
3. Confirm the mailing-jurisdiction conflict is preserved and flagged.
4. Expand the 2015 sale and TY2022 penalty refs through source evidence.
5. Screen Ward 2, tax class 2, large offices by descending assessment and drill
   into one result.
6. Send one invalid ward, one inverted range, and one malformed evidence ref;
   each must return a structured safe response with no SQL or driver text.

Never improvise a title, lien, appraisal, DSCR, NOI, or zoning conclusion from
these records.

## Recovery objectives

- Worker code rollback target: under 10 minutes.
- Database: rebuildable from canonical source files and deterministic artifacts.
- Acceptable data loss: none for the frozen snapshot; the service has no user
  write path.
