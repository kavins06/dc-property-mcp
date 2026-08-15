# D.C. Property Records MCP

Quoin Data's read-only, source-linked Washington, D.C. property-account data
service for MCP clients.

The project builds:

1. Compact PostgreSQL serving tables and a semantic catalog.
2. Deterministic ETL from the current canonical ITSPE file and the official D.C.
   Tax System Property Sales (CAMA) export, plus a release-pinned normalization
   pipeline for 38 official regulatory and building-data sources.
3. Fact-level provenance and human-facing portal verification routes with
   exact address, SSL, or instrument lookup instructions.
4. A curated Cloudflare-hosted MCP server protected by WorkOS AuthKit.

The canonical CSV files remain in the parent workspace and are never modified.
Generated load files belong in `data/generated/` or
`data/regulatory/generated/` or `data/parcel/generated/` and are excluded from
Git.

## Hosted service

The production MCP endpoint is:

```text
https://mcp.quoindata.com/mcp
```

The remote MCP is available now. Add that Streamable HTTP URL to a compatible
MCP client and complete the WorkOS OAuth sign-in flow; no API key is required
for MCP authorization. This endpoint is not a consumer-facing REST API.
Consumer-facing API access is by request.

It is deployed on Cloudflare Workers with a custom domain, Hyperdrive, two
rate-limit bindings, and WorkOS AuthKit OAuth. The WorkOS production
environment allows public email/password sign-up and supports both Client ID
Metadata Document and Dynamic Client Registration.

The isolated PostgreSQL 18 production cluster on the shared Hetzner VM
currently contains:

- 221,263 current D.C. property-tax accounts
- 2025 prior, 2026 current, and 2027 proposed assessment values on each
  current property-account record
- 221,263 compact, lossless tax series
- 215,408 accounts with official sale history
- 421,436 linked CAMA sale records; 9 source records are retained as unlinked
  diagnostics
- a 38-source official regulatory release with 3,623,995 source rows,
  2,600,666 served records, and 5,862,456 property-account links
- 142,700 searchable MAR addresses, 238,561 official address-to-parcel links,
  and 291,896 searchable residential units

The MCP exposes 15 read-only tools:

- identity and discovery: `resolve_property`, `resolve_properties_batch`, and
  `search_properties`
- exhaustive single-property retrieval: `get_complete_property_record`
- account facts: `get_property_snapshot`, `get_assessment_history`,
  `get_tax_and_balance_history`, `get_ownership_and_sale`, and
  `get_latest_sale_and_deed`
- regulatory facts: `get_permit_history`, `get_license_history`,
  `get_inspection_and_enforcement_history`, and
  `get_building_and_land_profile`
- evidence and semantic guidance: `get_source_evidence` and `describe_data`

### Tool input contract

All property detail tools accept an optional `ssl` (1–32 characters) or
`address` (2–160 characters). Resolve identity first when the intended account
is not already certain. The server advertises these exact bounded inputs:

| Tool | Additional input and limits |
| --- | --- |
| `resolve_property` | `include_deleted` defaults to `false`; `limit` 1–10 (default 10); `parcel_offset` 0 or greater (default 0); `parcel_limit` 1–100 (default 25) |
| `resolve_properties_batch` | 1–50 named `items`; each needs `client_id` (1–100 characters) and an `ssl` or `address` |
| `search_properties` | Allowlisted filters and sorts only; `cursor` at most 128 characters; `limit` 1–50 (default 20) |
| `get_complete_property_record` | Property input only; follow every returned continuation when `coverage.complete` is false |
| `get_property_snapshot` | Property input only |
| `get_assessment_history` | Property input only |
| `get_tax_and_balance_history` | Property input only |
| `get_ownership_and_sale` | Property input only |
| `get_latest_sale_and_deed` | Property input only |
| `get_permit_history` | Property input plus optional `cursor` up to 512 characters and `limit` 1–50 (default 20) |
| `get_license_history` | Property input plus optional `cursor` up to 512 characters and `limit` 1–50 (default 20) |
| `get_inspection_and_enforcement_history` | Property input plus optional `cursor` up to 512 characters and `limit` 1–50 (default 20) |
| `get_building_and_land_profile` | Property input plus optional `cursor` up to 512 characters and `limit` 1–50 (default 20) |
| `get_source_evidence` | 1–50 `source_refs`, each 1–192 characters |
| `describe_data` | Optional `question`, at most 500 characters |

The runtime schemas in [`worker/src/server.ts`](worker/src/server.ts) are
authoritative. All 15 tools carry read-only, non-destructive, idempotent
annotations. Responses are bounded to 768 KiB; page through returned cursors
instead of requesting an unbounded export.

`search_properties` accepts only `ward`, `property_type`, `use_code`,
`tax_class`, assessment bounds, balance filters, tax-sale status, sale-date
bounds, and the documented cursor and limit. Sorts are limited to assessment,
balance, sale date, address, or account ID in the directions encoded by the
runtime schema; account ID ascending is the default.

The four regulatory tools preserve the publishing agency, record type, and
property-link scope. Only SSL-derived links are exact property facts.
Shared-building, multi-parcel, and proximity matches are explicitly contextual
and are not silently promoted to parcel facts.

Exact address resolution also returns the official MAR parcel set. Multiple
official parcels remain explicitly ambiguous so the caller selects the intended
SSL; exact residential-unit matches narrow to an official condominium SSL when
DC publishes one.

The screening surface supports validated tax class, balance, tax-sale,
sale-date, valuation, use, type, and ward filters; deterministic sorts;
keyset cursors; total counts; and no owner-name search or mailing-address
output. Detail responses preserve source values while carrying quality flags
and explicit unsupported-inference boundaries.

## Rebuild and verification

The deterministic local build can run without hosted credentials:

```powershell
python .\etl\src\dc_property_etl\build.py
python -m unittest discover -s .\etl\tests -v
python .\scripts\validate_artifacts.py
```

Hosted credentials are stored only in the ignored `.env.hosted` file. To
re-apply a targeted migration or run the database release gates:

```powershell
node --env-file=.env.hosted scripts/validate-migrations.mjs db/migrations/0018_search_runtime_hardening.sql db/migrations/0019_screening_indexes.sql
node --env-file=.env.hosted scripts/validate-reviewer-remediation.mjs
node --env-file=.env.hosted scripts/apply-migration.mjs db/tests/postload_checks.sql
node --env-file=.env.hosted scripts/check-resolve-performance.mjs
node --env-file=.env.hosted scripts/verify-runtime.mjs
```

The regulatory loader requires one approved, normalized run directory under
`data/regulatory/generated/`, the exact manifest SHA-256, and a live database
whose core account mapping matches the manifest. Run its live-bound,
non-writing preflight before the load:

```powershell
$env:PYTHONPATH="etl\src"
python -m dc_property_etl.regulatory_verify data\regulatory\generated\<run>
cd loader
node load-regulatory.mjs ..\data\regulatory\generated\<run> --manifest-sha256 <sha256> --preflight-only
node load-regulatory.mjs ..\data\regulatory\generated\<run> --manifest-sha256 <sha256>
```

The capacity-bounded loader is for an empty blue-green target. It creates a
hidden batch, checkpoints resumable phases, runs publication gates, and changes
current-release pointers only after every gate passes. It refuses an in-place
double snapshot when current regulatory pointers already exist.

Worker validation and deployment:

```powershell
cd worker
npm run check
npm test
npm run bundle
npm audit --audit-level=moderate
node --env-file=..\.env.hosted ..\scripts\deploy-cloudflare.mjs --stage-only
$env:MCP_AUTH_SERVER_URL="https://mcp.quoindata.com/mcp"
node ..\scripts\verify-authenticated-mcp.mjs <candidate-preview-url>/mcp
Remove-Item Env:\MCP_AUTH_SERVER_URL
node --env-file=..\.env.hosted ..\scripts\promote-cloudflare.mjs
node ..\scripts\verify-live.mjs 0.4.7
node ..\scripts\verify-authenticated-mcp.mjs
```

The deployment helper uploads an immutable Worker version, attaches it at zero
traffic, and smoke-tests its exact version-specific preview URL. The attended
OAuth verifier authenticates against the production WorkOS resource and uses
that audience-bound token to call all 15 tools on the zero-traffic preview.
`promote-cloudflare.mjs` refuses stale candidate reports and automatically
restores the previous version if post-promotion checks fail.

`verify-authenticated-mcp.mjs` is an attended gate: it dynamically registers a
temporary OAuth client, prints the WorkOS authorization URL, receives the
localhost callback, discovers all 15 tools, and calls every tool without
persisting tokens. WorkOS may require a human-verification challenge.

PostgreSQL is not designed around a provider plan ceiling. On the shared
197 GB Hetzner Volume, loaders warn at 25 GB and block publication at 40 GB.
Raw acquisitions, manifests, normalized release artifacts, verification
reports, and application backups are retained in the private `quoindata`
Hetzner S3-compatible bucket; PostgreSQL is a serving database, not the sole
archive.

Application backups use format v3 and cover `meta`, `core`, `history`,
`semantic`, `regulatory`, and `property_context`. A verified backup is not a
restore proof: every material release must also restore into an isolated empty
PostgreSQL target and pass the database contracts and runtime probes.

Runtime traffic uses only the least-privileged `mcp_runtime` role through
Hyperdrive, a Workers VPC service, and an outbound Cloudflare Tunnel. The
database listens only on loopback and the runtime role cannot read serving
tables directly. Encrypted pgBackRest full/differential backups and WAL
archiving provide recurring physical/PITR coverage in Hetzner Object Storage.

Operational thresholds, incident steps, and rollback procedures are in
`docs/operations-runbook.md`.

## Registry metadata

[`server.json`](server.json) is a registry-ready description of the hosted
Streamable HTTP server. It follows the official MCP Registry schema and tracks
the Worker service version. Preparing this artifact does not publish the server
or change its OAuth requirements. See the official
[remote-server registry documentation](https://modelcontextprotocol.io/registry/remote-servers).
