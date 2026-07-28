# Hosted deployment checklist

No provider secret belongs in Git, chat, logs, manifests, object names, backup
artifacts, or generated evidence. Use ignored environment files and provider
secret stores, and rotate any credential that is exposed.

## PostgreSQL target

- PostgreSQL 18 cluster: `18/dcproperty`
- Host: shared Hetzner VM `ubuntu-4gb-ash-1`
- Port: `5434`, loopback only
- Data directory: `/mnt/HC_Volume_106250480/dc-property/pgdata`
- Database: `dc_property`
- Runtime role: `mcp_runtime`
- TLS name: `db-origin.quoindata.com`, certificate verification `verify_full`

Verify that existing ports 5432 and 5433 and the existing Quoin applications
remain unchanged. Confirm `mcp_runtime` cannot select from `meta`, `core`,
`history`, `semantic`, `regulatory`, or `property_context`, and can execute
only the 14 public `api_v1` functions.

The database is not constrained by a provider plan ceiling. The 197 GB shared
Volume has a 25 GB review warning and a 40 GB hard publication gate.

## Regulatory release

The approved v0.4.0 release contains 38 official sources, 3,623,995 input rows,
2,600,666 served records, and 5,862,456 property-account links.

Before loading:

1. Independently verify all compressed artifacts and canonical-row hashes.
2. Record and require the exact `manifest.json` SHA-256.
3. Run `load-regulatory.mjs --preflight-only` against the live core binding.
4. Confirm the target has no current regulatory pointers.
5. Verify the raw-source archive receipt in Hetzner Object Storage.

The loader uses a hidden, checkpointed batch and changes current pointers only
after every publication gate passes. A failed unpublished batch may be purged
only after resolving and reviewing its exact batch ID:

```powershell
cd loader
node purge-regulatory-batch.mjs <batch_id> --confirm
```

## Hetzner Object Storage

Use the private `quoindata` bucket at
`https://fsn1.your-objectstorage.com`. Archive only reviewed,
project-relative inputs:

```powershell
node --env-file=.env.hosted scripts\archive-to-s3.mjs `
  --prefix releases/v0.4.0/<archive-name> `
  --input <project-relative-file-or-directory>
```

The helper content-addresses files, splits files over 250 MiB, downloads every
uploaded part, and compares bytes and SHA-256 before writing a deterministic
receipt. Preserve the receipt as release evidence.

## Backup and recovery

Create and verify application backup format v3:

```powershell
node --env-file=.env.hosted scripts\backup-application.mjs --output-dir <directory>
node scripts\verify-application-backup.mjs <backup-directory>
```

Restore the verified backup into an isolated empty database with
`restore-application.mjs`, reconcile every table and sequence, and run database
and runtime probes. Verification alone is not restore proof.

Production also requires:

- encrypted pgBackRest full backup every Monday;
- differential backups Tuesday through Sunday;
- continuous WAL archiving with a five-minute archive timeout;
- monthly verified application backup and S3 round-trip check; and
- enabled systemd failure recording for all backup units.

## Cloudflare private database path

The required path is:

```text
Hyperdrive -> Workers VPC service -> Cloudflare Tunnel -> 127.0.0.1:5434
```

Do not create a public PostgreSQL listener or public DNS origin. The tunnel is
outbound, the VPC service uses TCP/PostgreSQL with `verify_full`, and
Hyperdrive connects as `mcp_runtime` with a bounded origin-connection limit.
Retain the previous Supabase Hyperdrive ID as the rollback target.

## WorkOS

- AuthKit domain: `ripe-theater-06.authkit.app`
- Resource indicator: `https://dc-property-mcp.quoindata.com/mcp`
- CIMD enabled; DCR retained for compatible clients

The Worker validates issuer, JWKS signature, expiration, and exact audience.
The attended verifier stores OAuth state and tokens only in memory.

## Staged release

```powershell
cd worker
npm run check
npm test
npm run bundle
npm audit --audit-level=moderate
cd ..

node scripts\deploy-cloudflare.mjs --stage-only
$env:CLOUDFLARE_WORKER_VERSION_ID="<candidate-version-id>"
node scripts\verify-authenticated-mcp.mjs
node scripts\promote-cloudflare.mjs
node scripts\verify-live.mjs 0.4.0
node scripts\verify-authenticated-mcp.mjs
```

The candidate remains at 0% traffic until it passes health, headers, OAuth
metadata, origin boundary, catalog, and all 14 authenticated tool calls. The
promotion helper refuses a stale candidate pair and automatically restores the
previous Worker version if post-promotion verification fails.

## Release gates

- All local tests, type checks, artifact validators, and dependency audits pass.
- Core, regulatory, context, and link counts match the approved manifests.
- Direct runtime, privilege, typed-projection, lifecycle, reviewer, and latency
  gates pass on Hetzner.
- Exact regulatory facts are SSL-derived at confidence `1.0000`; all other
  link scopes remain explicitly contextual.
- Raw and normalized archives, application backup, pgBackRest repository, and
  isolated restore proof are independently verified.
- Existing VM applications remain healthy and memory/disk measurements do not
  justify a RAM upgrade.
- The exact zero-traffic Worker candidate passes attended OAuth and all 14 MCP
  tools before promotion.
- Previous Worker and Supabase Hyperdrive identifiers are recorded.
- Git contains no credentials, private keys, dumps, generated source data, or
  secret-bearing reports.
- The reviewed commit and `v0.4.0` tag are pushed and final production health
  is rechecked.

## Official references

- Cloudflare private database/VPC:
  https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/
- Cloudflare Tunnel private database:
  https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/
- WorkOS AuthKit MCP:
  https://workos.com/docs/authkit/mcp
