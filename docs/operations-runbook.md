# Operations runbook

## Service

- MCP: `https://mcp.quoindata.com/mcp`
- Health: `https://mcp.quoindata.com/healthz`
- Authentication: WorkOS AuthKit
- Database: PostgreSQL 18 on Neon through Cloudflare Hyperdrive
- Contract: v0.4.11, 22 read-only MCP tools (15 D.C. tools plus 7 national routing/availability tools)

A healthy unauthenticated MCP request returns `401` with a
`WWW-Authenticate` link to protected-resource metadata.

## Production identifiers

- Neon production project/branch: `orange-feather-99332051` / `br-soft-feather-ayz26yo9`
- Neon production Hyperdrive: `d4524b1f397a454da9f9b37105d8d399`
- Production Worker version: `15cc38a9-4b00-454c-b072-529ab84624f0` (`0.4.11`)
- Retired Hetzner cluster: `18/dcproperty` (removed 2026-08-22)
- Retired Hetzner Hyperdrive: `5fd47b059f824188998ad4ce9dc4503c`
- Final encrypted Hetzner Object Storage backup: `20260822-083140F`, LSN `B/9A000190`
- Supabase legacy Hyperdrive (not a Gate 5 rollback target):
  `a9ec4dc6114e4057a11bea66b8fe50b3`
- Workers VPC service: `019faa01-7a77-7ac3-83c4-40c9439e5499`
- Cloudflare Tunnel: `279f1681-2ce0-43f8-8c4c-d85ec4bc0a22`
- WorkOS resource: `https://mcp.quoindata.com/mcp`
- Alert destination: `kavins@quoindata.com`

Worker version and deployment IDs are recorded in the gate receipt. The live
Hetzner PostgreSQL rollback was retired with owner approval after a final full
encrypted backup. Hetzner Object Storage remains the recovery repository; the
Supabase and Hetzner Hyperdrives are legacy inventory only.

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

Gate 1 read-only baseline (2026-08-21T19:36:15.736Z): endpoint
`https://fsn1.your-objectstorage.com`, 9,651 objects, 142,610,527,372 bytes,
and canonical inventory SHA-256
`868c40c81375889fcdf55342840915b4a6833548dbc892e123f755fb66acdb70` on both
inventory passes. There were no additions, deletions, or mutations between
passes. The complete local report is
`db/reports/generated/hetzner-archive-gate1-20260821T193615Z.json` with
SHA-256
`be57dfd746bb9e13e9cec0938a2b7956a7210c4dc326300861b1c335b84fc035`.
The report covered 48 local receipts (5 legacy v1 and 43 encrypted v2) and
2,525 remote objects; all 48 receipt objects matched their local bytes and
stored SHA metadata. The bucket remained private, versioning disabled, Object
Lock absent, with lifecycle `raw-batches-90d` expiring `raw-batches/` after 90
days. This verifier is strictly read-only; no existing Hetzner object was
deleted, overwritten, or otherwise mutated.

The archive SSE-C fingerprint recorded by the verifier is
`ac98a65226deb6d486d9b54627da1229b6f425da9bbfab5377541a64dab820c2`.
Restore evidence is recorded at
`db/reports/generated/hetzner-gate1-restore-evidence-20260821T194203Z.json`
with SHA-256
`cbd2d6b79658083790366b63db36940f37d252947cb135409f7afec2e0895304`.
The complete v1 receipt and restored archive each contain 67 files, 68 parts,
and 651,908,507 bytes. Their canonical receipt-file metadata SHA-256 is
`15d7b6fafc06f9e882e55e5ee7b5ae5ce0cea5bb9fe65c06b3405bcc0832b00a`; this
hash covers sorted `{path,bytes,sha256}` receipt records, not concatenated
file bytes. The application-backup subset contains 37 files, 38 parts, and
651,415,561 bytes, with restored-file metadata SHA-256
`df6ea6e68e4f4653dca80367c00e57b1c330f8eafc3e7badccdfb931341bfbcb`.
The read-only pgBackRest evidence is at
`db/reports/generated/hetzner-gate1-pgbackrest-20260821T193630Z.json` with
SHA-256
`4f5acf83d039669f6a12602a4de147004deb0eca9469286d64a43ddeba47045f`.

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
  --input <project-relative-path> `
  [--acquisition-manifest <manifest> --acquisition-artifact <artifact>]
```

For an acquisition handoff, provide both explicit manifest and artifact paths.
The verified archive command then creates the immutable archive-binding sidecar
required by downstream loaders; unrelated archives receive no binding.

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

### Gate 1 archive recovery commands

Use explicit temporary directories outside the repository. Before any
recursive cleanup, resolve and inspect the target path; remove it only after
the restore and verification succeed.

```powershell
$legacyTemp = Join-Path $env:TEMP 'quoin-gate1-legacy-v1-20260821T193615Z'
$legacyTemp = [IO.Path]::GetFullPath($legacyTemp)
if ($legacyTemp -notlike "$env:TEMP*") { throw 'Unexpected legacy temp path' }
New-Item -ItemType Directory -Force $legacyTemp | Out-Null
node --env-file=.env.hosted scripts\restore-s3-archive.mjs `
  --from-s3 --allow-legacy-v1 `
  --receipt archive-receipts\239af8ba54aa196442c765ea3d4d8356dab9b34e4b868a74dfb29c041fe6a420.json `
  --output $legacyTemp
node scripts\verify-application-backup.mjs `
  "$legacyTemp\application-backups\application-v0.4.0-20260728"
Get-ChildItem $legacyTemp -Recurse -File | Get-FileHash -Algorithm SHA256

$v2Temp = Join-Path $env:TEMP 'quoin-gate1-v2-20260821T193615Z'
$v2Temp = [IO.Path]::GetFullPath($v2Temp)
if ($v2Temp -notlike "$env:TEMP*") { throw 'Unexpected v2 temp path' }
New-Item -ItemType Directory -Force $v2Temp | Out-Null
node --env-file=.env.hosted scripts\restore-s3-archive.mjs `
  --from-s3 `
  --receipt archive-receipts\7af869679b6b346cf634e1c5763647e9aa95d09ea5fc2b54fd9c376aef65b5a6.json `
  --output $v2Temp
Get-ChildItem $v2Temp -Recurse -File | Get-FileHash -Algorithm SHA256
```

After successful evidence capture, verify both resolved paths again before
`Remove-Item -LiteralPath $legacyTemp,$v2Temp -Recurse -Force`.

### Key escrow checkpoint

The archive SSE-C and pgBackRest cipher secrets are present and their recorded
fingerprints are, respectively,
`ac98a65226deb6d486d9b54627da1229b6f425da9bbfab5377541a64dab820c2` and
`6cf0294a4945eb7051f2cf097c1da175e274cf8c0e25da624673926752805c51`. External
password-manager escrow is not complete because no password-manager connector
or removable drive is available. This is the sole manual Gate 1 checkpoint.
In a trusted local terminal, copy the archive SSE-C secret from the protected
`.env.hosted` file and the pgBackRest cipher secret from the server's protected
`/etc/dc-property-mcp/pgbackrest.conf` directly into the password manager
without printing either value. Use the password manager's secure
clipboard/import flow or another non-echoing secure channel. Never paste either
secret into chat, shell history, a report, or a normal clipboard, and clear any
secure clipboard after storage. Gate 1 remains pending until the owner confirms
password-manager storage.

## Staged deployment and authenticated verification

Do not execute this section for the DMV expansion until the owner explicitly
approves publication. The deployment helpers require the post-approval marker
and otherwise fail before any Cloudflare mutation.

```powershell
node scripts\deploy-cloudflare.mjs --stage-only
$env:MCP_AUTH_SERVER_URL="https://mcp.quoindata.com/mcp"
node scripts\verify-authenticated-mcp.mjs <candidate-preview-url>/mcp
Remove-Item Env:\MCP_AUTH_SERVER_URL
node scripts\promote-cloudflare.mjs
node scripts\verify-live.mjs 0.4.11
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
4. For a Neon database-path regression, deploy immutable Worker version
   `bfb184ec-dc18-4b63-aab0-30c320b17cf7` at 100%. It is already bound to
   Hetzner Hyperdrive `5fd47b059f824188998ad4ce9dc4503c`; verify the binding
   and exact deployment state after rollback.
5. Do not expose PostgreSQL or grant direct table privileges as a workaround.
6. For data recovery, restore the pgBackRest repository to the selected
   timestamp or rebuild from the verified application backup and canonical
   release archive.
7. Document cause, impact window, recovery evidence, and prevention.

### DMV schema rollback

Use the prior Worker/database pair for an ordinary release regression. Remove
the DMV schema only when abandoning an unpublished DMV release or after a
verified restore has been selected. Before running any down migration:

1. stop DMV writers and roll the Worker back;
2. record and clear `current`, `candidate`, and `previous` rows from
   `meta.publication_set_pointer` in a controlled transaction;
3. verify the latest encrypted backup and its isolated restore evidence;
4. run rollbacks in exact reverse migration order: `0040`, `0039`, `0038`,
   `0037`, `0036`, then `0035`; and
5. compare the resulting schema dump with the captured pre-migration dump.

The destructive acknowledgements are session-local safeguards. Set them only
in the operator session that immediately runs the reviewed rollback files:

```sql
set quoin.confirm_dmv_api_rollback = 'DROP_PUBLISHED_DMV_API';
set quoin.confirm_dmv_data_rollback = 'DROP_STAGED_DMV_DATA';
\i db/rollbacks/0040_md_cama_buildings.sql
set quoin.confirm_dmv_api_rollback = 'DROP_PUBLISHED_AND_STAGED_DMV_API';
\i db/rollbacks/0039_md_coverage_and_parcel_api.sql
set quoin.confirm_dmv_api_rollback = 'DROP_PUBLISHED_DMV_API';
\i db/rollbacks/0038_md_parcel_identity.sql
\i db/rollbacks/0037_national_api.sql
\i db/rollbacks/0036_national_property_record.sql
\i db/rollbacks/0035_national_identity_and_release.sql
```

The 0039 rollback requires the combined acknowledgement when either a
publication pointer or staged/validated Maryland generation data exists. Do not clear
that acknowledgement by placing it in a role, database, pool, or Worker
configuration; set it only in the operator session that immediately runs the
reviewed rollback chain.

Rehearse the exact chain with `scripts/validate-migration-rollback.mjs` on a
schema clone whose name starts with `dc_property_dmv_rollback_` before a
production migration.

Migration `0042_md_local_context_checkpoint_namespace.sql` is an exception to
the ordinary rollback rule. Its rollback never deletes checkpoint rows. If
`md_local_context:%` rows exist, it intentionally retains the expanded phase
constraint (and therefore cannot claim byte-for-byte schema equality). Run an
uncommitted `0042` check against the fixed isolated DMV rehearsal database,
or run `scripts/validate-migration-rollback.mjs --committed-disposable` on a
disposable database named `dc_property_dmv_rollback_<suffix>`; the latter sets
the transaction-local marker accepted by both 0042 guards. With zero namespaced rows, exact schema equality is required. After a local load, treat
the constraint-only rollback as the documented, non-equality-preserving
policy.

Recovery objectives:

- Worker rollback: under 10 minutes
- frozen source release data loss: none
- database recovery: encrypted physical/PITR repository plus independently
  verified application backup and canonical S3 archive
