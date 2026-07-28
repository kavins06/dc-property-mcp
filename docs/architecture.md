# Architecture

The authoritative serving entity is a D.C. property-tax account identified by
SSL. It is not assumed to be a one-to-one physical parcel: condominium units,
possessory-interest accounts, tax lots, and related accounts exist.

## Production path

```text
MCP client
  -> Cloudflare custom domain / Worker
  -> WorkOS AuthKit token verification
  -> Cloudflare Hyperdrive
  -> Workers VPC service
  -> outbound Cloudflare Tunnel
  -> PostgreSQL 18 on 127.0.0.1:5434
```

PostgreSQL runs as the isolated Debian cluster `18/dcproperty` on the shared
Hetzner VM. Its data directory is
`/mnt/HC_Volume_106250480/dc-property/pgdata`, its socket is
`/run/postgresql-dc-property`, and it does not listen on a public interface.
The tunnel validates the dedicated `db-origin.quoindata.com` PostgreSQL
certificate with `verify_full`.

The Worker exposes 14 bounded, read-only MCP tools. WorkOS tokens are checked
for signature, issuer, expiration, and the exact
`https://dc-property-mcp.quoindata.com/mcp` audience. Hyperdrive connects as
`mcp_runtime`, which has no direct table privileges and may execute only the
14 allowlisted `api_v1` functions.

The former Supabase database and its Hyperdrive configuration are retained only
as a rollback target during the v0.4.0 bake period. They are not the active
architecture after cutover.

## Storage and recovery

The private `quoindata` bucket in Hetzner Object Storage (`fsn1`) is the durable
archive for raw source snapshots, manifests, normalized artifacts, release
reports, verified application backups, and restore evidence. Objects are
content-addressed, large files are split into deterministic parts, and every
upload is downloaded and checked for byte length and SHA-256 before its receipt
is accepted.

PostgreSQL is the serving database, not the only copy of a release. Encrypted
pgBackRest full and differential backups plus continuous WAL archiving provide
physical/PITR coverage in the same private object-storage account under an
independent encrypted repository. Application backup format v3 covers `meta`,
`core`, `history`, `semantic`, `regulatory`, and `property_context`; an isolated
restore reconciles every table and sequence before runtime probes are accepted.

## Trust boundaries

- Cloudflare terminates public TLS, enforces rate limits, and reaches the
  database only through Hyperdrive, Workers VPC, and the outbound tunnel.
- PostgreSQL is loopback-only, uses SCRAM and TLS, and has a 30-connection
  ceiling with conservative memory settings for the shared 4 GB VM.
- `mcp_runtime` cannot select from serving tables or mutate application data.
- Official portals are evidence destinations, not live machine dependencies;
  their current content cannot override frozen source extracts.
- Secrets remain in ignored environment files, root-only VM configuration, and
  provider secret stores. They do not belong in Git, receipts, logs, or reports.

## Query and semantic boundaries

- Resolution is exact-first against normalized SSL and address fields. Fuzzy
  lookup runs only after exact lookup fails and never returns collateral facts.
- Batch resolution is bounded to 1-50 caller-named assets.
- Screening accepts an allowlist of typed filters and sort orders and excludes
  owner-name search and mailing-address output.
- `get_source_evidence` returns release-pinned human portal routes, never raw
  service endpoints or session-bound URLs.
- Regulatory APIs read only releases selected by
  `meta.source_release_pointer`.
- `exact_property` is reserved for SSL-derived confidence `1.0000`.
  `shared_building`, `multi_parcel`, and `proximity_context` remain contextual.
- TY2025 prior, TY2026 current, and TY2027 proposed assessment fields are
  carried on `core.property_account_current`; no assessment-history artifact is
  part of the active v0.4 pipeline.

## Regulatory lifecycle and capacity

The normalized manifest binds the exact core account input, all 38 official
sources, and every normalized artifact by byte length, row count, file hash,
and canonical-row hash. The loader verifies the live core binding, loads a
hidden checkpointed batch, and changes current pointers only after every
source, linkage, quality, storage, and API gate passes.

Capacity gates are based on the shared 197 GB Hetzner Volume: 25 GB triggers a
review warning and 40 GB is a hard publication stop. The verified v0.4.0
database is approximately 7.89 GB, with more than 100 GB of volume headroom.
