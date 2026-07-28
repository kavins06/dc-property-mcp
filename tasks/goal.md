# Production Goal: D.C. Property Records MCP v0.4.0

## Status

Complete.

## Objective

Finish and release the D.C. Property Records MCP v0.4.0 in production by:

- replacing the Supabase PostgreSQL origin with an isolated PostgreSQL 18
  cluster on the existing Hetzner VM;
- replacing R2-specific archival with verified, provider-neutral,
  S3-compatible archival in Hetzner Object Storage;
- loading and validating the complete core and 38-source regulatory release;
- proving backup integrity and restoration on an isolated target;
- cutting Cloudflare Hyperdrive over without weakening WorkOS, MCP, or
  least-privilege boundaries;
- completing unauthenticated and attended authenticated production
  verification; and
- committing, tagging, and pushing the verified v0.4.0 release.

## Production Baseline

- Public MCP endpoint: `https://dc-property-mcp.quoindata.com/mcp`
- Authentication: WorkOS AuthKit
- Edge runtime: Cloudflare Worker
- Database transport: Cloudflare Hyperdrive through Workers VPC and a protected
  outbound Cloudflare Tunnel
- Database host: `ubuntu-4gb-ash-1`
- Database engine: PostgreSQL 18
- Archive provider: Hetzner S3-compatible Object Storage
- Archive bucket: private `quoindata` bucket in `fsn1`
- Alert destination: `kavins@quoindata.com`
- Git target: `https://github.com/kavins06/dc-property-mcp.git`

## Scope

### Repository

- Make database configuration provider-neutral.
- Add plain-PostgreSQL bootstrap and role handling.
- Remove active Supabase endpoint and pooler assumptions.
- Make the archive implementation provider-neutral and S3-compatible.
- Regenerate and verify canonical manifests.
- Reconcile backup/restore code and documentation.
- Extend tests for the Hetzner database, S3 archive, and restore paths.
- Preserve all unrelated working-tree changes.

### Hetzner VM

- Preserve the existing `quoin_cmbs` and `quoin_property_national`
  applications, services, and PostgreSQL clusters.
- Create a third isolated PostgreSQL 18 cluster for this project.
- Use the attached Hetzner Volume for database storage.
- Keep PostgreSQL off the public network.
- Configure conservative resource limits, TLS, SCRAM, role isolation,
  logging, monitoring, and backup jobs.
- Add firewall protection without interrupting ports 22, 80, or 443.
- Measure load behavior before paying for a RAM upgrade.

### Data and Recovery

- Rebuild the active three-artifact core release.
- Remove obsolete assessment-history artifacts from the active contract.
- Archive raw and normalized release material in Hetzner Object Storage.
- Generate a provider-neutral content-addressed archive receipt.
- Regenerate the approved regulatory manifest against that receipt.
- Load all serving data and verify exact/contextual linkage contracts.
- Create application backup format v3.
- Configure database-aware physical/PITR backup coverage.
- Restore into an isolated empty target and record proof.

### Cloudflare and WorkOS

- Create a protected database tunnel and Workers VPC service.
- Create a new Hyperdrive configuration for the Hetzner database.
- Keep the Supabase-backed Hyperdrive configuration available for rollback.
- Deploy the Worker as an immutable candidate before promotion.
- Preserve the public MCP URL and WorkOS audience.
- Complete all 14-tool OAuth verification.

### Release

- Run all local, database, runtime, archive, backup, security, and live gates.
- Record the previous Worker version and previous Hyperdrive target.
- Cut traffic over only after the candidate passes.
- Commit the completed repository state.
- Tag `v0.4.0`.
- Push to `kavins06/dc-property-mcp`.

## Non-Goals

- Do not alter or delete either existing Quoin application or database.
- Do not expose PostgreSQL directly to the public internet.
- Do not delete the Supabase database during this project.
- Do not add unsupported title, lien, appraisal, zoning, NOI, DSCR, or credit
  conclusions.
- Do not broaden the MCP beyond its read-only, bounded, lender-oriented
  contract.
- Do not commit credentials, private keys, database dumps, generated source
  data, backups, or archive secrets.

## Invariants

- `mcp_runtime` has no direct table privileges.
- Only the 14 allowlisted `api_v1` functions are callable by the runtime.
- Exact regulatory facts remain SSL-derived at confidence `1.0000`.
- Address, shared-building, multi-parcel, and proximity links remain
  explicitly contextual.
- Every served fact retains release-pinned provenance.
- Current release pointers change only after all publication gates pass.
- Existing VM applications remain available throughout the migration.
- Supabase remains a rollback target until the Hetzner release has baked.

## Definition of Done

The goal is complete only when all of the following are true:

- [x] Every local test, type check, artifact validator, and dependency audit
      passes.
- [x] The Hetzner PostgreSQL cluster is isolated, secured, monitored, and
      resource-bounded.
- [x] Core row counts and hashes match the approved active artifacts.
- [x] The 38-source regulatory release passes independent verification and
      live-bound preflight.
- [x] All regulatory records, context records, and property links load and
      publish with approved counts.
- [x] Every database schema, API, privilege, evidence, lifecycle, and
      performance contract passes.
- [x] A verified application backup v3 exists in Hetzner Object Storage.
- [x] An isolated restore succeeds and passes database and runtime probes.
- [x] The exact Worker candidate passes health, security, OAuth, MCP catalog,
      and all 14 authenticated tool calls.
- [x] Hyperdrive is cut over to Hetzner and the public MCP endpoint remains
      healthy.
- [x] Rollback identifiers and procedures are recorded and tested.
- [x] Documentation accurately describes the production architecture.
- [x] No secrets or private generated artifacts are tracked by Git.
- [x] The release is committed, tagged `v0.4.0`, and pushed to the configured
      GitHub repository.

## Human Gate

The only planned attended step is the final WorkOS browser authorization,
email/CAPTCHA challenge if presented, and OAuth consent used by the
authenticated 14-tool verifier.
