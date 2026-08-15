# Operations runbook

## Service

- MCP: `https://mcp.quoindata.com/mcp`
- Health: `https://mcp.quoindata.com/healthz`
- Authentication: WorkOS AuthKit
- Database: PostgreSQL 18 on Hetzner through Hyperdrive and Workers VPC
- Contract: v0.4.9, 15 read-only MCP tools

A healthy unauthenticated MCP request returns `401` with a
`WWW-Authenticate` link to protected-resource metadata.

## Production identifiers

- PostgreSQL cluster: `18/dcproperty`, loopback port 5434
- Hetzner Hyperdrive: `5fd47b059f824188998ad4ce9dc4503c`
- Supabase rollback Hyperdrive: `a9ec4dc6114e4057a11bea66b8fe50b3`
- Workers VPC service: `019faa01-7a77-7ac3-83c4-40c9439e5499`
- Cloudflare Tunnel: `279f1681-2ce0-43f8-8c4c-d85ec4bc0a22`
- WorkOS resource: `https://mcp.quoindata.com/mcp`
- Alert destination: `kavins@quoindata.com`

Worker version and deployment IDs are recorded in
`db/reports/generated/release-0.4.0.json` after promotion. The previous Worker
and Supabase Hyperdrive remain rollback targets during the bake period.

## Release gates

Run from the project root:

```powershell
python -m unittest discover -s etl\tests -p "test_*.py"
python scripts\validate_artifacts.py
npm test --prefix loader
npm audit --prefix loader --omit=dev
npm test --prefix scripts
npm audit --prefix scripts --omit=dev
npm run check --prefix worker
npm test --prefix worker
npm run bundle --prefix worker
npm audit --prefix worker --omit=dev

node --env-file=.env.hosted scripts\validate-reviewer-remediation.mjs
node --env-file=.env.hosted scripts\verify-runtime.mjs
node --env-file=.env.hosted scripts\check-resolve-performance.mjs
node --env-file=.env.hosted scripts\verify-regulatory-typed-projections.mjs
```

Run database migration rehearsal and timing checks serially because they take
locks or intentionally exercise the same small connection pool.

## Regulatory release

Canonical run:

```text
data/regulatory/generated/dc_official_regulatory_20260728_s3
```

Approved manifest SHA-256:

```text
60496f01cbd5dcd15eb8c5755ef603711ff929e6638fcc0b2095d620ba514666
```

Expected totals:

- 38 sources
- 3,623,995 input rows
- 2,600,666 served rows
- 5,862,456 property links
- 945,074 exact links
- 4,917,382 contextual links
- 27,145 capped ambiguous rows
- 996,184 unlinked rows

The loaded serving database contains 2,378,628 regulatory records:
1,660,221 permits, 193,127 licenses, 76,737 occupancy records, 448,543
inspections, and no enforcement rows, plus the approved building/land context
tables.

Before a future refresh, independently verify the artifacts, bind the exact
core mapping, run `load-regulatory.mjs --preflight-only`, and load an empty
blue-green target. The loader will not replace current pointers in place.

## Object-storage evidence

Provider: private Hetzner S3-compatible Object Storage, bucket `quoindata`,
region `fsn1`.

- Raw regulatory archive ID:
  `201fff966baff319ae051291e6d43428cdcf6b4eb809ab3d3f2b550183e6319f`
- Application backup/restore archive ID:
  `239af8ba54aa196442c765ea3d4d8356dab9b34e4b868a74dfb29c041fe6a420`
- Application backup manifest SHA-256:
  `930d915c44d67353e4407579406ccfeb0bba8b81917c99b4495c05e70309d5a4`
- Automated backup proof archive ID:
  `074584fd090ce6c321945f4c7622e38802925e434aa6ad2df81c15ebf1946673`
- Production deployment/authentication evidence archive ID:
  `6e1ae1b100c480783c97a56f331efb33e44a6996854f2cdd4de1c2020f277827`

Archive new reviewed inputs with:

```powershell
node --env-file=.env.hosted scripts\archive-to-s3.mjs `
  --prefix <reviewed-prefix> `
  --input <project-relative-path>
```

The command succeeds only after downloading and hashing every uploaded part.

## Backup and recovery

Physical/PITR configuration:

- encrypted pgBackRest repository:
  `/backups/dc-property/pgbackrest`
- Monday full backup:
  `dc-property-pgbackrest-full.timer`
- Tuesday-Sunday differential backup:
  `dc-property-pgbackrest-diff.timer`
- continuous WAL archive command with five-minute archive timeout
- monthly verified logical/application backup:
  `dc-property-application-backup.timer`

Useful checks:

```bash
sudo -u postgres pgbackrest \
  --config=/etc/dc-property-mcp/pgbackrest.conf \
  --stanza=dc-property info

sudo -u postgres pgbackrest \
  --config=/etc/dc-property-mcp/pgbackrest.conf \
  --stanza=dc-property check

systemctl list-timers 'dc-property-*'
systemctl status dc-property-pgbackrest-full.service
systemctl status dc-property-application-backup.service
```

The v0.4.0 application backup contains 35 tables, 11,776,717 rows, and 14
sequences. It was restored into the isolated `dc_property_restore_proof`
database; all table/sequence reconciliation and runtime probes passed. The
temporary proof database was dropped only after its report and archive were
verified.

Backup integrity is not a substitute for restore testing. Repeat the isolated
restore after every material schema or backup-format change.

## Staged deployment and authenticated verification

```powershell
node scripts\deploy-cloudflare.mjs --stage-only
$env:MCP_AUTH_SERVER_URL="https://mcp.quoindata.com/mcp"
node scripts\verify-authenticated-mcp.mjs <candidate-preview-url>/mcp
Remove-Item Env:\MCP_AUTH_SERVER_URL
node scripts\promote-cloudflare.mjs
node scripts\verify-live.mjs 0.4.9
node scripts\verify-authenticated-mcp.mjs
```

The authenticated verifier prints a short-lived WorkOS URL and listens on
localhost port 8765 for both IPv4 and IPv6 loopback. Open the URL in an
external browser on the same computer. Tokens and temporary client data remain
in process memory.

The first verifier call authenticates against the production WorkOS resource,
then targets the exact zero-traffic Worker preview URL with the same
audience-bound token. Promotion refuses a stale candidate/rollback pair. If
public verification fails, the promotion helper restores the previous Worker
version automatically.

## Monitoring and thresholds

Investigate:

- health not `200` for two consecutive minutes;
- 5xx rate above 1% for 15 minutes;
- p95 MCP latency above three seconds for 15 minutes;
- failed OAuth metadata or unauthenticated challenge;
- PostgreSQL above the 25 GB review threshold or approaching the 40 GB stop;
- pgBackRest repository/WAL check failure or a missed backup timer;
- dependency audit vulnerability;
- raw/REST/session-bound source-evidence URLs;
- exact regulatory data that is not SSL-derived at confidence `1.0000`; or
- source pointers or archive receipts that do not match the approved release.

The shared VM remains appropriately sized while available memory stays healthy,
swap-in/swap-out is inactive, the attached Volume retains ample headroom, and
no OOM events occur. Resize only on measured sustained pressure.

## Incident response and rollback

1. Record UTC time, Cloudflare Ray/request ID, deployed Worker version, and
   Hyperdrive ID.
2. Run `verify-live.mjs` and the direct `verify-runtime.mjs` probe to isolate
   edge/OAuth failures from PostgreSQL failures.
3. For a Worker regression, restore the previous Worker version recorded in
   the release report.
4. For a Hetzner database-path regression, bind a rollback Worker version to
   Supabase Hyperdrive `a9ec4dc6114e4057a11bea66b8fe50b3` and verify it before
   promotion.
5. Do not expose PostgreSQL or grant direct table privileges as a workaround.
6. For data recovery, restore the pgBackRest repository to the selected
   timestamp or rebuild from the verified application backup and canonical
   release archive.
7. Document cause, impact window, recovery evidence, and prevention.

Recovery objectives:

- Worker rollback: under 10 minutes
- frozen source release data loss: none
- database recovery: encrypted physical/PITR repository plus independently
  verified application backup and canonical S3 archive
