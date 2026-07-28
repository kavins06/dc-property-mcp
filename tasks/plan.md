# Implementation Plan: Hetzner Production Release

## Overview

Migrate the production PostgreSQL origin from Supabase to a third isolated
PostgreSQL 18 cluster on the shared Hetzner VM, move immutable archive and
backup storage to Hetzner Object Storage, verify recovery, cut Cloudflare
Hyperdrive over through a protected private-database path, and release v0.4.0.

## Architecture Decisions

- Rebuild an empty target from deterministic artifacts instead of copying the
  active Supabase database.
- Preserve the existing schema and `api_v1` contract.
- Create a third PostgreSQL cluster; do not reuse ports 5432 or 5433.
- Keep PostgreSQL socket/private-only and route Hyperdrive through Workers VPC
  and Cloudflare Tunnel.
- Make archive receipts provider-neutral while preserving content addressing,
  chunking, byte verification, and canonical-row verification.
- Keep Supabase and the current Worker version as rollback targets.
- Do not resize the VM until controlled load measurements show sustained
  memory pressure or unsafe swap/OOM behavior.

## Dependency Order

Provider-neutral code and artifact contracts
→ isolated PostgreSQL cluster
→ verified object archive
→ core load and binding
→ regulatory preflight/load/publication
→ backup and restore proof
→ Hyperdrive candidate
→ authenticated verification
→ cutover
→ release commit/tag/push.

## Phase 1: Repository Foundation

### Task 1: Protect and baseline the working tree

**Acceptance criteria:**

- Existing modified and untracked work is inventoried and preserved.
- No secret-bearing or generated private artifact is eligible for commit.
- The GitHub remote is configured without overwriting repository state.

**Verification:** `git status`, ignore-boundary audit, and remote read check.

### Task 2: Make hosted database configuration provider-neutral

**Acceptance criteria:**

- Administrative and runtime connections accept generic PostgreSQL settings.
- Supabase project/pooler derivation is no longer required.
- Connection configuration tests cover local socket, SSH-forwarded, and
  TLS-hosted paths without exposing credentials.

**Verification:** focused Node tests and complete loader/script tests.

### Task 3: Add plain-PostgreSQL bootstrap compatibility

**Acceptance criteria:**

- Required roles, extensions, ownership, and default privileges exist on an
  empty PostgreSQL 18 target.
- Migrations do not depend on provider-created Supabase roles.
- Runtime permissions remain function-only.

**Verification:** disposable PostgreSQL migration and privilege contract.

### Checkpoint: Foundation

- [ ] All existing local suites remain green.
- [ ] An empty plain PostgreSQL target accepts the full migration chain.

## Phase 2: Object Storage and Artifact Contracts

### Task 4: Replace R2-specific archival with S3-compatible archival

**Acceptance criteria:**

- Archive code uses the Hetzner S3 endpoint and private bucket.
- Upload, chunk reconstruction, download verification, and receipt validation
  remain deterministic.
- Provider-specific secrets never enter receipts or logs.

**Verification:** unit tests plus a uniquely scoped write/read/delete probe.

### Task 5: Make release manifests provider-neutral

**Acceptance criteria:**

- Regulatory verification accepts only a verified provider-neutral archive
  receipt.
- Loader contracts reject missing, stale, or mismatched object-storage proof.
- R2-specific wording and manifest fields are removed or migrated.

**Verification:** Python and Node manifest contract tests.

### Task 6: Rebuild and approve canonical artifacts

**Acceptance criteria:**

- The active core release contains only current accounts, tax series, and sale
  series.
- Raw acquisitions and normalized regulatory artifacts are archived and
  independently verified.
- A new approved regulatory manifest digest is recorded consistently.

**Verification:** artifact validators, canonical-row hashes, and source-count
reconciliation.

### Checkpoint: Artifact Readiness

- [ ] Core and regulatory releases are reproducible and independently
      verifiable.
- [ ] Hetzner Object Storage contains the exact approved archive.

## Phase 3: Hetzner PostgreSQL

### Task 7: Create the isolated production cluster

**Acceptance criteria:**

- A PostgreSQL 18 cluster exists on a new port/socket and dedicated Volume
  directory.
- Existing ports 5432/5433 and Quoin services are unaffected.
- PostgreSQL is not publicly reachable.

**Verification:** service, socket, port, ownership, and isolation checks.

### Task 8: Harden and monitor the cluster

**Acceptance criteria:**

- SCRAM, TLS/private transport, least privilege, safe logging, and host
  firewall controls are active.
- Memory, connection, WAL, disk, lock, and health monitoring are configured.
- Existing Caddy, SSH, and Quoin services remain healthy.

**Verification:** permission probes, network scan, monitoring probes, and
existing-service smoke tests.

### Task 9: Apply migrations and load the core release

**Acceptance criteria:**

- Migrations through 0024 apply to the empty target.
- Core counts and hashes match the approved artifacts.
- The loaded account mapping is cryptographically bound to the core artifact.

**Verification:** post-load, reviewer, v0.4, privilege, and performance gates.

### Task 10: Load and publish the regulatory release

**Acceptance criteria:**

- Live-bound preflight passes without writes.
- Hidden phases load with exact checkpoints.
- All publication gates pass before current pointers are set.

**Verification:** regulatory schema, API, typed projection, lifecycle,
evidence, linkage, row-count, and storage gates.

### Checkpoint: Database Ready

- [ ] All 14 `api_v1` functions pass directly on Hetzner.
- [ ] Existing VM applications remain healthy.
- [ ] Measured memory and swap behavior justify staying at 4 GB or trigger a
      reviewed resize.

## Phase 4: Backup and Recovery

### Task 11: Configure physical and application backups

**Acceptance criteria:**

- Database-aware physical/PITR coverage is configured.
- Application backup format v3 is created and verified.
- Backups and reports are stored privately in Hetzner Object Storage.

**Verification:** backup job execution, object verification, and alert test.

### Task 12: Prove restoration

**Acceptance criteria:**

- The approved backup restores into an isolated empty PostgreSQL target.
- Every table/sequence reconciles with the manifest.
- Database contracts and runtime API probes pass after restore.

**Verification:** signed restore report archived with release evidence.

### Checkpoint: Recovery Ready

- [ ] Backup integrity and actual recoverability are both proven.
- [ ] Measured restore time satisfies the production recovery target.

## Phase 5: Cloudflare Cutover

### Task 13: Create the protected database path

**Acceptance criteria:**

- Cloudflare Tunnel reaches only the new PostgreSQL cluster.
- A Workers VPC service restricts the private TCP path to the selected tunnel.
- No public PostgreSQL port is opened.

**Verification:** unauthorized network access fails; authorized Hyperdrive
connection succeeds as `mcp_runtime`.

### Task 14: Create and verify the Hetzner Hyperdrive configuration

**Acceptance criteria:**

- A new Hyperdrive configuration targets Hetzner.
- Origin connection limits and caching behavior are explicitly configured.
- The Supabase configuration remains available for rollback.

**Verification:** exact-version runtime probes and `pg_stat_activity`.

### Task 15: Deploy and promote the Worker candidate

**Acceptance criteria:**

- The immutable candidate starts at zero traffic.
- Health, headers, OAuth metadata, CORS, size/rate limits, and catalog checks
  pass against the exact candidate.
- Failed promotion automatically restores the prior Worker/Hyperdrive target.

**Verification:** deployment report and live unauthenticated smoke suite.

### Task 16: Complete authenticated production verification

**Acceptance criteria:**

- WorkOS OAuth completes through the attended browser flow.
- All 14 tools are discovered and called successfully.
- Institutional evidence, error, and exact/contextual linkage probes pass.

**Verification:** authenticated verifier and institutional smoke sequence.

### Checkpoint: Production

- [ ] Public traffic uses the Hetzner database.
- [ ] Supabase and the prior Worker version remain valid rollback targets.
- [ ] Monitoring and alerts show healthy production behavior.

## Phase 6: Release

### Task 17: Reconcile documentation and evidence

**Acceptance criteria:**

- README, architecture, operations, deployment, provenance, coverage, and
  source inventory match production.
- Release evidence contains artifact hashes, archive receipt, restore proof,
  database gates, Worker version IDs, Hyperdrive IDs, and smoke results.

**Verification:** documentation search finds no active Supabase/R2 operational
claims except rollback/history.

### Task 18: Commit, tag, and push v0.4.0

**Acceptance criteria:**

- Only reviewed source, tests, documentation, and safe metadata are committed.
- The release commit is tagged `v0.4.0`.
- The branch and tag are pushed to `kavins06/dc-property-mcp`.

**Verification:** clean status, remote commit/tag confirmation, and final live
health check.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Shared 4 GB VM memory pressure | High | Isolated cluster, conservative tuning, serialized load, live measurement, resize only when proven necessary |
| Existing applications disrupted | High | New port/socket/data directory; pre/post-change service smoke checks |
| Archive contract drift | High | Provider-neutral receipt tests and complete manifest regeneration |
| Incomplete backup confidence | High | Physical backup plus application v2 plus isolated restore proof |
| Hyperdrive cutover failure | High | Zero-traffic candidate, exact-version probes, retained Supabase rollback |
| Credential exposure | High | Ignored env files, provider secret stores, redacted logs, rotation after release |
| Government source ambiguity | High | Preserve exact/contextual policy and fact-level release provenance |

## Open Questions

No blocking architecture questions remain. The final WorkOS OAuth challenge is
an attended human gate.
