# Production Release Checklist

## Foundation

- [x] Baseline and protect the existing working tree.
- [x] Configure the GitHub remote safely.
- [x] Replace Supabase-specific connection configuration.
- [x] Add plain-PostgreSQL role/bootstrap compatibility.
- [x] Pass all local foundation tests.

## Object Storage and Artifacts

- [x] Implement provider-neutral S3-compatible archival.
- [x] Update archive receipt and regulatory manifest contracts.
- [x] Rebuild the active core artifact set.
- [x] Archive and independently verify raw and normalized releases.
- [x] Approve and record the new regulatory manifest digest.

## Hetzner Database

- [x] Create the third isolated PostgreSQL 18 cluster.
- [x] Configure security, resource limits, monitoring, and firewall.
- [x] Confirm existing Quoin services remain healthy.
- [x] Apply migrations through 0024.
- [x] Load and cryptographically bind core artifacts.
- [x] Run regulatory live-bound preflight.
- [x] Load and publish the regulatory release.
- [x] Pass every database and performance contract.
- [x] Decide from measurements whether RAM must be increased.

## Backup and Recovery

- [x] Configure physical/PITR backup coverage.
- [x] Create and verify application backup v3.
- [x] Archive backups and verification reports.
- [x] Restore into an isolated empty target.
- [x] Pass restored database and runtime probes.
- [x] Archive the restore proof.

## Cloudflare and Production

- [x] Create the protected Cloudflare database tunnel.
- [x] Create the Workers VPC service.
- [x] Create the Hetzner Hyperdrive configuration.
- [x] Verify `mcp_runtime` function-only access.
- [x] Deploy a zero-traffic Worker candidate.
- [x] Pass exact-candidate unauthenticated checks.
- [x] Promote the candidate with rollback armed.
- [x] Complete attended WorkOS authorization.
- [x] Pass all 14 authenticated tool calls.
- [x] Pass the institutional smoke sequence.

## Release

- [x] Reconcile all documentation with production.
- [x] Assemble release, archive, backup, restore, and rollback evidence.
- [x] Audit Git for secrets and generated private artifacts.
- [x] Commit the reviewed v0.4.0 implementation.
- [x] Tag `v0.4.0`.
- [x] Push branch and tag to GitHub.
- [x] Confirm final live health and monitoring.
