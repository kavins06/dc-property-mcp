# Gates 3–6: national-ready Neon and controlled production cutover

## Status

Approved by the owner on 2026-08-21, with Hetzner compute cancellation retained
as a manual owner action. This document does not authorize deleting Hetzner
compute or Object Storage.

Gate 3 completed on 2026-08-22 at zero public traffic. Gate 4 is next; Gates 5
and 6 remain pending their staged rollout and 30-day soak requirements.

## Outcome

Complete the property product's infrastructure migration without coupling it
to unfinished Maryland or Virginia acquisition work:

1. make the Neon database nationally extensible while preserving the exact
   D.C. contract;
2. create a separate Neon Hyperdrive and a zero-traffic Worker candidate;
3. move D.C. production traffic gradually from Hetzner PostgreSQL to Neon;
4. expose a national jurisdiction/availability contract with D.C. available
   and unverified jurisdictions explicitly unavailable; and
5. prove Hetzner compute is no longer required after a successful soak and
   provide the owner an exact manual-cancellation handoff, while retaining
   Hetzner Object Storage.

The marketing site, customer-platform application, Vercel projects, DNS,
billing, and CMBS remain out of scope unless the owner changes the scope in the
approval response.

## Verified starting state

- Gate 1 Object Storage evidence is complete. The private Hetzner bucket stays
  authoritative; an encrypted D-drive mirror is optional and non-blocking.
- Gate 2 is complete. D.C. has exact schema, row, sequence, API, security, and
  performance parity on Neon at zero traffic.
- Neon project `orange-feather-99332051`, protected branch
  `br-soft-feather-ayz26yo9` (`production`), database `dc_property`, and direct
  endpoint `ep-crimson-truth-ay2a66lm.c-5.us-east-2.aws.neon.tech` are ready.
- The protected production branch is 7.98 GB and has one always-on 0.25–8 CU
  read/write compute. `vercel-dev` is a separate child and will not be changed.
- The live Cloudflare Worker `dc-property-mcp` is version
  `bfb184ec-dc18-4b63-aab0-30c320b17cf7` at 100% traffic through the existing
  Hetzner Hyperdrive. No Neon Hyperdrive exists.
- Loader tests pass 121/121, production-script tests pass 38/38, Worker tests
  pass 62/62, and the Worker TypeScript check passes.
- Maryland acquisition and loader code exists, but the formerly referenced
  exact rehearsal database and generation 29 are absent from both inspected
  database hosts. No completed generation 29 may be inferred from test logs.
- Virginia has research/contracts but no production acquisition and loading
  pipeline. Full Virginia publication is therefore not a Gate 3–6 dependency.
- The repository is public, `main` is unprotected, CI is absent, and the
  working tree contains substantial uncommitted DMV work. Those changes must
  be preserved and reviewed, never overwritten or accidentally published.

## Non-negotiable boundaries

- Do not apply rehearsal-only migrations `0035–0043` unchanged to Neon.
- Do not copy raw dumps or property data into GitHub, Vercel, Cloudflare D1, or
  the unencrypted D drive.
- Do not move or delete Hetzner Object Storage.
- Do not alter the existing Hetzner Hyperdrive; it is the instant rollback
  path.
- Do not publish Maryland or Virginia data unless the state-specific release
  passes every acquisition, provenance, completeness, identity, security, and
  quality gate and the one-time approval explicitly authorizes that state.
- A missing jurisdiction returns a stable `unavailable` result; it never falls
  back to guessed, partial, research, or unrelated nationwide parcel data.
- Database migration, data publication, Worker deployment, and ordinary web
  deployment remain separate release authorities.
- Any correctness, security, credential, provenance, or rollback failure stops
  promotion and returns traffic to the last known-good version. The executor
  may repair and retry only when the repair is reversible and within this
  approved scope.

## Dependency disposition

| Dependency | State before approval | Treatment |
|---|---|---|
| Gate 1 restore/inventory evidence | Ready | Re-verify receipt hashes; no object mutation |
| Gate 2 Neon D.C. candidate | Ready | Re-run drift checks before Gate 3 |
| Neon protected production branch | Ready | Keep protected; build/rehearse on a temporary child |
| PostgreSQL 18 client tools | Ready | Reuse native `psql`, `pg_dump`, and `pg_restore` |
| Cloudflare Worker and Hyperdrive access | Read access verified | Prove required write scopes before mutation |
| GitHub authentication | Ready | Add CI and protect `main` before production merge |
| Vercel | Authenticated but out of scope | No changes |
| WorkOS authenticated smoke test | Human login currently required | Complete one attended token bootstrap before autonomous execution, or supply an approved non-human test identity |
| Neon `mcp_runtime` credential | Not created | Generate a new random credential, use only in Neon/Cloudflare, and store it with restricted local ACL until owner escrow |
| Local `.env.hosted` ACL | Too broad | Remove inherited broad-user access before storing any new credential |
| Hetzner compute cancellation credential | Not required | No token is requested. Gate 6 proves decommission readiness and produces an exact manual-cancellation handoff; billing continues until the owner cancels it |
| Maryland production release | Not ready | Keep local/unpublished; may continue as a separate later data gate |
| Virginia production release | Not ready | Keep unavailable; separate acquisition program |

## Gate 3 — National database foundation on Neon

### Purpose

Install a provider-neutral national control plane without changing the existing
D.C. API or copying the 8 GB D.C. dataset into a second generic representation.

### Implementation

1. Record fresh Git, Neon, Hetzner, Cloudflare, backup, object-inventory, and
   database fingerprints. Harden `.env.hosted` ACLs and run a secret scan.
2. Preserve the current dirty working tree on a dedicated `codex/` branch.
   Separate pre-existing DMV work from new production changes in reviewable
   commits; never rewrite or discard user work.
3. Add the smallest CI workflow that runs the four already-proven suites and a
   secret scan. Protect `main` against deletion/force-push and require the CI
   check before merge.
4. Create one temporary Neon child branch from protected `production`. Neon
   assigns new passwords to roles copied from a protected parent; use only the
   child connection details for rehearsal.
5. Build a clean production national migration bundle rather than weakening or
   reusing rehearsal guards in `0035–0043`. Retain those files as rehearsal
   evidence. Use a transaction, checksum ledger, exact target identity, and
   fail-closed pre/postconditions.
6. Model national scope with:
   - stable internal `area_uid` values and a typed geographic hierarchy;
   - effective-dated external identifiers such as FIPS, GNIS, and issuer-local
     codes, none used as the internal primary key;
   - issuing authorities separate from geographic areas, with explicit scope;
   - source, release, acquisition, artifact, generation, provenance, coverage,
     and publication records that are not hard-coded to three states;
   - property identities keyed by authority, native namespace, and native ID;
   - arbitrary publication membership and atomic active pointers; and
   - explicit availability reason/status for every exposed jurisdiction.
7. Seed only small, authoritative national reference data needed for routing:
   U.S. states/territories and county-equivalents from official federal
   identifiers. Do not ingest nationwide property records.
8. Attach existing D.C. property accounts to the national identity and
   publication layer by adapter tables/views. Keep existing D.C. base tables,
   functions, role restrictions, and JSON contracts unchanged.
9. Add national API functions behind database grants but do not expose them
   through the live Worker. The initial active publication contains D.C. only;
   Maryland, Virginia, and all other jurisdictions are explicit `unavailable`.
10. Rehearse install, rollback, reinstall, checksum rejection, partial-failure
    rollback, least privilege, concurrency, cursor ordering, and publication
    atomicity on the child branch. Run an adversarial schema/security review.
11. Apply the exact reviewed bundle to protected Neon `production` in one
    transaction, then repeat every Gate 2 parity test for legacy D.C.

### Acceptance

- Exact D.C. row counts, sequences, normalized legacy schema, API bytes,
  ordering, role restrictions, and performance remain within Gate 2 limits.
- National objects contain no Maryland/Virginia property rows and have exactly
  one active D.C. publication member.
- Reapplying the bundle is rejected or is a verified no-op according to its
  checksum ledger; altered checksums fail closed.
- Direct base-table access and all writes fail as `mcp_runtime`; only approved
  API functions execute.
- A secret-free Gate 3 receipt records all checks and hashes.

### Rollback

Before Worker cutover, discard the temporary child. If production installation
fails, the single transaction rolls back. If a post-commit validation fails,
the additive national objects remain unreachable while D.C. continues through
Hetzner; apply only the reviewed down bundle or corrective migration.

## Gate 4 — Neon Hyperdrive and zero-traffic Worker candidate

### Purpose

Prove the Neon runtime path without changing public traffic or mixing it with
the new national API surface.

### Implementation

1. Generate a distinct high-entropy password for Neon `mcp_runtime`, apply its
   three-second timeout/read-only settings, and validate privileges directly.
2. Create a new cache-disabled Hyperdrive against the direct Neon endpoint.
   Keep the origin connection limit conservative and below Neon capacity.
   Caching stays disabled through correctness validation.
3. Retrieve the currently deployed Worker version and bindings from
   Cloudflare. Upload a candidate with byte-identical modules and inherited
   bindings; the only semantic change is the `HYPERDRIVE` binding ID.
4. Re-read and persist the immutable live Worker version ID immediately before
   staging (currently `bfb184ec-dc18-4b63-aab0-30c320b17cf7`). Create a
   deployment containing that exact ID at 100% and the Neon candidate at 0%.
   Do not build from the dirty local DMV Worker tree.
5. Use Cloudflare's version-override header to invoke the zero-percent
   candidate. Perform the complete anonymous, authenticated, entitlement,
   error-shape, pagination, rate-limit, timeout, and D.C. tool-catalog suite.
6. Compare candidate results against live Hetzner and direct Neon SQL. Verify
   Worker version metadata, Neon sessions, query plans, origin connections,
   logs, errors, and latency. Run an adversarial configuration/secret review.

### Acceptance

- Public traffic remains 100% on the Hetzner version.
- Candidate module hashes match live; only the Hyperdrive binding differs.
- All D.C. responses are correct, security controls remain enforced, no query
  exceeds the runtime timeout, and warm p95 is no worse than 2× live.
- No Maryland/Virginia/national tools are exposed yet.
- A secret-free Gate 4 receipt contains Worker/deployment/version/Hyperdrive
  identifiers and the complete diff.

### Rollback

Delete or abandon only the zero-percent candidate and Neon Hyperdrive. The live
deployment and existing Hetzner Hyperdrive are unchanged.

## Gate 5 — Progressive D.C. traffic cutover and soak

### Purpose

Make Neon authoritative for serving while retaining immediate Hetzner rollback.

### Promotion schedule

1. Re-run Gate 4 immediately before promotion.
2. Shift Neon traffic through `1% → 5% → 25% → 50% → 100%`.
3. At each step require a minimum observation window of 15, 30, 60, 120, and
   240 minutes respectively, plus enough authenticated probes to exercise all
   15 existing D.C. tools. Low natural traffic is supplemented by bounded
   synthetic probes, never writes.
4. Compare error rate, correctness hashes, status distribution, p50/p95/p99,
   timeouts, Worker CPU, Hyperdrive connection errors, Neon connections/CPU,
   slow queries, and cost signals against the Gate 4 baseline.
5. Automatically revert to the last known-good percentage on any correctness
   drift, authorization bypass, elevated 5xx/timeout rate, invalid cursor/order,
   connection exhaustion, or sustained p95 breach.
6. At 100%, keep the old Worker version, Hetzner Hyperdrive, PostgreSQL,
   pgBackRest, tunnel, and database dump intact for a 30-day soak. Freeze
   unscheduled D.C. data writes during the soak; any necessary source refresh
   becomes a separately validated dual-provider migration event.
7. Record a daily bounded health receipt. A scheduled monitor may alert or roll
   traffic back, but it may not deploy new code, publish data, or delete
   infrastructure.

### Acceptance

- Neon serves 100% of D.C. production traffic for 30 consecutive days with no
  correctness/security regression and performance within the approved bounds.
- Restore and reverse-routing drills pass during the soak.
- No application, cron, backup, tunnel, monitoring, or human workflow still
  depends on Hetzner PostgreSQL.

### Rollback

Restore the immutable pre-candidate Worker version ID recorded at staging to
100% immediately. Because the service is read-only, there is no
application-data reconciliation step. Keep Neon for diagnosis and do not
modify the Hetzner source.

## Gate 6 — National MCP contract and Hetzner compute retirement handoff

### Purpose

Finish the technical infrastructure transition, make national expansion a
normal data release rather than another platform rewrite, and leave Hetzner
compute ready for the owner's manual cancellation.

### Implementation

1. Add the minimal national Worker surface:
   - jurisdiction discovery and availability;
   - state/jurisdiction-qualified property resolution/search; and
   - backward-compatible aliases for all existing D.C. tools.
2. Return a stable `unavailable`/`coming_soon` response for unpublished areas.
   Never expose rehearsal tables or partial source records.
3. Deploy the national Worker surface first as a 0% version, validate by
   override, then use the same gradual schedule. Database publication pointer
   and Worker contract hash must agree before a jurisdiction can serve.
4. Keep the public hostname and existing D.C. response contracts. Do not
   rename the repository, domain, database, or Vercel projects in this gate.
5. After the 30-day Gate 5 soak and one final restore/rollback drill, take a
   final encrypted pgBackRest backup and retain the Gate 2 custom dump on the
   Hetzner volume until compute deletion is imminent.
6. Stop and disable PostgreSQL/tunnel services, verify production remains
   healthy, and produce the exact Hetzner VM/compute resource inventory and
   manual cancellation checklist. Do not delete any Hetzner resource. Retain
   the Hetzner account, private Object Storage bucket, Object Storage
   credentials, inventory, and restore tooling.
7. Rotate/revoke obsolete Hetzner database/tunnel credentials, remove unused
   Cloudflare secrets, and preserve the old Worker/Hyperdrive identifiers in
   the final receipt until the rollback retention period expires.
8. Update the accepted architecture ADR, operating runbook, data-coverage
   documentation, and GitHub release only after reality matches the records.

### Acceptance

- Existing D.C. clients remain byte-compatible where promised.
- The national contract serves D.C. and reports every other unpublished
  jurisdiction honestly; it contains no partial Maryland or Virginia data.
- GitHub CI/protection, Neon protection, Cloudflare rollout/rollback, credential
  inventory, monitoring, and restore evidence all pass.
- Production has no remaining dependency on Hetzner compute, the exact manual
  cancellation list is verified, and Hetzner Object Storage remains intact.
- Gate 6 technical completion does not assert that Hetzner compute billing has
  stopped; billing ends only when the owner performs the manual cancellation.
- A signed-off, secret-free Gate 6 report links every receipt and records the
  final production identifiers.

## Deliberately deferred work

- Completing and publishing Maryland's property generation.
- Building Virginia's 133-jurisdiction acquisition/load program.
- Nationwide property-data acquisition.
- Cloudflare R2 migration or deletion of Hetzner Object Storage.
- Vercel marketing/platform changes, repository consolidation, repo rename, or
  domain rename.
- Automated data refresh scheduling.
- Hyperdrive query caching; consider it only after measured production demand
  shows a benefit and freshness semantics are documented.

These are separate gates because none is required to move the verified D.C.
service safely to Neon or to make its database and MCP contract nationally
extensible.

## One-time owner inputs and authority

Execution starts only after the owner answers all items in one response:

1. **Gate 6 data scope:** approve the recommended national contract with D.C.
   available and all unverified jurisdictions unavailable, or explicitly make
   completed Maryland/Virginia publication part of Gate 6 and accept that the
   present dependencies cannot guarantee autonomous completion.
2. **Product scope:** approve the recommended property database/MCP-only scope,
   with no Vercel marketing/platform changes.
3. **Mutation authority:** authorize Neon schema/role/password changes, a new
   Hyperdrive, Worker version/deployment changes, gradual traffic promotion,
   automatic rollback, Git branch/commit/push/PR/merge, CI, and `main`
   protection.
4. **Publication authority:** state whether this approval permits only the D.C.
   national publication member (recommended), or also permits Maryland if a
   new state release independently reaches every gate. Virginia should remain
   unapproved because no executable pipeline exists.
5. **Soak:** approve the recommended 30 consecutive days and the durable daily
   monitor. Execution cannot truthfully finish Gate 6 before the soak elapses.
6. **WorkOS:** complete one attended authentication bootstrap immediately
   before autonomous execution, or provide an approved non-human production
   test identity. No password or token should be pasted into chat.
7. **Credential handling:** authorize generation/rotation of the Neon runtime
   secret and restricted local temporary storage, then confirm the owner will
   escrow it in their password manager before local removal.
8. **Hetzner cancellation:** no cancellation credential is required and no
   Hetzner resource deletion is authorized. The owner will manually cancel the
   exact compute resources from the Gate 6 handoff. Object Storage remains
   active.
9. **Source policy:** confirm no paid purchases, CAPTCHA bypass, terms-of-use
   circumvention, or submitted public-record requests; unavailable data stays
   unavailable (recommended).
10. **Failure policy:** authorize safe repair/retry and automatic rollback, but
    require a stop—with no production deletion—if credentials are missing,
    scope cannot be proven, or correctness/security acceptance fails.

## Approval form

The shortest recommended approval response is:

> I approve Gates 3–6 using the recommended defaults in the plan: property
> database/MCP only; D.C. is the only published data member; national routing
> reports all other jurisdictions unavailable; 30-day soak; no paid or bypassed
> sources; all listed Neon, Cloudflare, GitHub, traffic, rollback, credential,
> and Hetzner-compute actions are authorized; Hetzner Object Storage must be
> retained. Hetzner deletion is not authorized; I will manually cancel the exact
> compute resources from the final Gate 6 handoff. I will complete the one WorkOS
> authentication bootstrap before autonomous execution.

Any exception should name the item number and replacement decision.
