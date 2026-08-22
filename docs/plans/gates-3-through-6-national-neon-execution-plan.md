# Gates 3–6: national-ready Neon and controlled production cutover

## Status

Approved by the owner on 2026-08-21. Hetzner cancellation automation and a
cancellation handoff are out of scope. This document does not authorize deleting
Hetzner compute or Object Storage.

Gate 3 completed on 2026-08-22 at zero public traffic. On 2026-08-22 the owner
explicitly waived the proposed 30-day soak and durable listener. Gates 4–6 use
the accelerated, evidence-based cutover gates below; this is a risk-acceptance
decision, not a relaxation of correctness, security, restore, or rollback checks.

Gates 5 and 6 completed on 2026-08-22. The owner additionally waived the fresh
manual WorkOS test, percentage rollout/observation batches, and reverse-routing
drill and authorized direct promotion. Automated SQL contracts, immutable
candidate isolation, exact binding checks, public health/OAuth-boundary checks,
automatic rollback, and retention of both Hetzner rollback versions remained in
force. Production now serves Worker `0.4.11` through Neon Hyperdrive; the
national façade exposes D.C. compatibility and reports all Maryland and Virginia
jurisdictions unavailable. No Maryland or Virginia property data was published.

## Outcome

Complete the property product's infrastructure migration without coupling it
to unfinished Maryland or Virginia acquisition work:

1. make the Neon database nationally extensible while preserving the exact
   D.C. contract;
2. create a separate Neon Hyperdrive and a zero-traffic Worker candidate;
3. move D.C. production traffic gradually from Hetzner PostgreSQL to Neon;
4. expose a national jurisdiction/availability contract that marks D.C. as
   available through the byte-compatible legacy D.C. tools and reports
   unverified jurisdictions explicitly unavailable; and
5. prove Hetzner compute is no longer required after accelerated cutover validation, while
   retaining Hetzner Object Storage and leaving all cancellation/deletion to a
   separate future owner decision.

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
| Hetzner compute cancellation credential | Not required | No token is requested and no cancellation capability or handoff is built. Gate 6 only proves that production no longer depends on Hetzner compute |
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
   Production SQL must run only through the checksum-pinned runner, which is
   hard-bound to project `orange-feather-99332051`, branch
   `br-soft-feather-ayz26yo9`, and endpoint `ep-crimson-truth-ay2a66lm` with
   `verify-full` TLS; direct `psql` application is not an approved path.
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
   staging. Create a
   deployment containing that exact ID at 100% and the Neon candidate at 0%.
   Do not build from the dirty local DMV Worker tree.
5. Use Cloudflare's version-override header to invoke the zero-percent
   candidate only with the operator-held `Quoin-Candidate-Access` token. Keep
   production preview URLs disabled; a missing or invalid token must return
   404 before any route or authentication metadata is served. Naturally
   sampled rollout requests carry no override and remain unaffected. Perform the
   complete anonymous, authenticated, entitlement,
   error-shape, pagination, rate-limit, timeout, and D.C. tool-catalog suite.
6. Compare candidate results against live Hetzner and direct Neon SQL. Verify
   Worker version metadata, Neon sessions, query plans, origin connections,
   logs, errors, and latency. Run an adversarial configuration/secret review.

### Acceptance

- Public traffic remains 100% on the Hetzner version.
- Candidate module hashes match live; the reviewed binding differences are
  the Hyperdrive target and candidate-access hash only.
- The candidate additionally carries the reviewed access-token hash binding;
  the stable version does not. The raw token remains local and secret-free
  receipts record only the hash.
- All D.C. responses are correct, security controls remain enforced, no query
  exceeds the runtime timeout, and warm p95 is no worse than 2× live.
- `NATIONAL_SURFACE_ENABLED=false` on both Gate 5 versions, so no
  Maryland/Virginia/national tools are exposed before Gate 6.
- A secret-free Gate 4 receipt contains Worker/deployment/version/Hyperdrive
  identifiers and the complete diff.

### Rollback

Delete or abandon only the zero-percent candidate and Neon Hyperdrive. The live
deployment and existing Hetzner Hyperdrive are unchanged.

## Gate 5 — Progressive D.C. traffic cutover and accelerated validation

### Purpose

Make Neon authoritative for serving while retaining immediate Hetzner rollback.

### Promotion schedule

1. Re-run Gate 4 immediately before promotion.
2. Shift Neon traffic through `1% → 5% → 25% → 50% → 100%`.
3. Run one supervised cutover session with no background listener. At 1%, 5%,
   25%, and 50%, require two consecutive clean observation batches after
   propagation; at 100%, require four consecutive clean batches. Every batch
   exercises all 15 existing D.C. tools with bounded read-only synthetic probes
   and samples current Worker/Hyperdrive/Neon telemetry. A batch is evidence
   based rather than calendar based and cannot be skipped for low natural traffic.
4. Compare error rate, correctness hashes, status distribution, p50/p95/p99,
   timeouts, Worker CPU, Hyperdrive connection errors, Neon connections/CPU,
   slow queries, and cost signals against the Gate 4 baseline.
5. Automatically revert to the last known-good percentage on any correctness
   drift, authorization bypass, elevated 5xx/timeout rate, invalid cursor/order,
   connection exhaustion, or sustained p95 breach.
6. At 100%, run the restore and reverse-routing drills immediately, then perform
   the four clean full-traffic batches. Keep the old Worker version, Hetzner
   Hyperdrive, PostgreSQL, pgBackRest, tunnel, and database dump intact as the
   rollback set; this plan does not authorize their deletion.
7. Write one secret-free receipt for every stage and one consolidated cutover
   receipt. Do not create a durable monitor or long-running listener.

### Acceptance

- Neon serves 100% of D.C. production traffic through four consecutive clean
  full-traffic observation batches with no correctness/security regression and
  performance within the approved bounds.
- Restore and reverse-routing drills pass in the supervised cutover session.
- No application, cron, backup, tunnel, monitoring, or human workflow still
  depends on Hetzner PostgreSQL.

### Rollback

Restore the immutable pre-candidate Worker version ID recorded at staging to
100% immediately. Because the service is read-only, there is no
application-data reconciliation step. Keep Neon for diagnosis and do not
modify the Hetzner source.

## Gate 6 — National MCP contract and Hetzner compute dependency removal

### Purpose

Finish the technical infrastructure transition, make national expansion a
normal data release rather than another platform rewrite, and prove that the
serving path no longer depends on Hetzner compute.

### Implementation

1. Apply checksum-pinned migration `0004_national_contract_facade.sql` to the
   reviewed Neon production branch, run its SQL contract as `mcp_runtime`, and
   prove D.C. available while Maryland/Virginia return explicit unavailable
   responses. Do not enable the Worker surface before this passes.
2. Add the minimal national Worker surface:
   - jurisdiction discovery and availability;
   - state/jurisdiction-qualified property resolution/search; and
   - backward-compatible aliases for all existing D.C. tools.
   Keep that code behind the fail-closed `NATIONAL_SURFACE_ENABLED` binding;
   enable it only on the Gate 6 candidate after migration `0004` and its SQL
   contract pass on Neon.
3. Return a stable `unavailable`/`coming_soon` response for unpublished areas.
   Never expose rehearsal tables or partial source records.
4. Deploy the national Worker surface first as a 0% version, validate by
   override, then use the same gradual schedule. Database publication pointer
   and Worker contract hash must agree before a jurisdiction can serve.
5. Keep the public hostname and existing D.C. response contracts. Do not
   rename the repository, domain, database, or Vercel projects in this gate.
6. After Gate 5's accelerated full-traffic validation and final restore/rollback
   drill, take a final encrypted pgBackRest backup and retain the Gate 2 custom
   dump on the Hetzner volume until a separately approved deletion decision.
7. Prove PostgreSQL/tunnel services are absent from the production serving path
   without stopping or disabling them. Record the dependency removal and leave
   the complete Hetzner rollback set intact. Do not build cancellation
   automation, produce a cancellation workflow, stop/delete any Hetzner
   resource, or remove its credentials. Retain the Hetzner account, private
   Object Storage bucket, Object Storage credentials, inventory, and restore
   tooling.
8. Rotate/revoke obsolete Hetzner database/tunnel credentials, remove unused
   Cloudflare secrets, and preserve the old Worker/Hyperdrive identifiers in
   the final receipt until the rollback retention period expires.
9. Update the accepted architecture ADR, operating runbook, data-coverage
   documentation, and GitHub release only after reality matches the records.

### Acceptance

- Existing D.C. clients remain byte-compatible where promised.
- The national discovery contract marks D.C. available and explicitly routes
  D.C. property calls to the byte-compatible legacy tools. Every other
  unpublished jurisdiction is reported honestly; no partial Maryland or
  Virginia data is exposed.
- GitHub CI/protection, Neon protection, Cloudflare rollout/rollback, credential
  inventory, monitoring, and restore evidence all pass.
- Production has no remaining dependency on Hetzner compute, and Hetzner Object
  Storage remains intact.
- Gate 6 technical completion makes no claim about Hetzner compute billing or
  cancellation; both are outside this plan.
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
5. **Validation duration:** the owner waived the 30-day soak and durable daily
   monitor on 2026-08-22. Use the supervised evidence-based batches and immediate
   restore/reverse-routing drills defined in Gate 5.
6. **WorkOS:** complete one attended authentication bootstrap immediately
   before autonomous execution, or provide an approved non-human production
   test identity. No password or token should be pasted into chat.
7. **Credential handling:** authorize generation/rotation of the Neon runtime
   secret and restricted local temporary storage, then confirm the owner will
   escrow it in their password manager before local removal.
8. **Hetzner cancellation:** no cancellation credential, automation, or handoff
   is required, and no Hetzner resource deletion is authorized. Object Storage
   remains active.
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
> reports all other jurisdictions unavailable; accelerated supervised validation;
> no paid or bypassed
> sources; all listed Neon, Cloudflare, GitHub, traffic, rollback, credential,
> and Hetzner-compute actions are authorized; Hetzner Object Storage must be
> retained. Hetzner cancellation/deletion is not part of this plan. I will
> complete the one WorkOS authentication bootstrap before autonomous execution.

Any exception should name the item number and replacement decision.
