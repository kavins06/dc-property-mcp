# Changelog

## 0.4.0 — 2026-07-28

- Added four bounded regulatory tools for permits, licenses,
  inspections/enforcement, and building/land profiles, bringing the public
  read-only MCP catalog to 14 tools.
- Normalized and release-pinned 38 official D.C. sources: 3,623,995 source
  rows, 2,600,666 served records, and 5,862,456 property-account links.
- Added exact-versus-contextual property-link semantics. Only SSL-derived
  `exact_property` links are exact facts; shared-building, multi-parcel, and
  proximity records remain labeled context.
- Added tamper-evident six-part regulatory source references and official
  human-portal evidence routes with release metadata and exact lookup inputs.
- Added approved-manifest and core-artifact binding, an empty-target
  blue-green loader, hidden checkpointed phases, safe identical-manifest
  resume, guarded unpublished-batch purge, and publication pointers.
- Defined the active assessment scope as TY2025 prior, TY2026 current, and
  TY2027 proposed.
- Added provider-neutral, content-addressed S3 archival tooling and
  application backup format v3 for
  `meta`, `core`, `history`, `semantic`, `regulatory`, and
  `property_context`, with isolated restore proof required for release.
- Migrated the production origin from Supabase to an isolated PostgreSQL 18
  cluster on Hetzner through Hyperdrive, Workers VPC, and Cloudflare Tunnel.
- Added encrypted pgBackRest physical backups, continuous WAL/PITR coverage,
  and monthly verified application backups in Hetzner Object Storage.
- Replaced provider-plan limits with a 25 GB shared-volume review threshold
  and a 40 GB hard publication gate.

## 0.3.0 — 2026-07-27

- Rebuilt address resolution around normalized exact matches, safe bounded
  fuzzy suggestions, explicit statuses, similarity scores, full display
  addresses, conflicting-input detection, and a 50-asset batch resolver.
- Added structured database-error sanitization so SQL, driver, connection, and
  credential details cannot cross the MCP boundary.
- Made screening case-insensitive and validated; added tax class, balance,
  tax-sale, sale-date, sorting, total-count, and `has_more` support.
- Added compact partial type/tax-class and ward/tax-class indexes so exact
  screening counts remain fast on the free database tier.
- Converted `describe_data` into a compact question-routed semantic guide with
  filter vocabulary, code decodes, coverage, tool selection, and limitations.
- Added official D.C. CAMA sale history: 421,436 linked records for 215,408
  current accounts, with 9 unlinked records retained as diagnostics.
- Compacted tax and assessment history payloads, qualified tax-slot source
  references, and corrected `TOTDUEAMT` to
  `total_liabilities_reported_cents`.
- Added source-preserving quality flags for mailing-jurisdiction conflicts,
  sale/assessment outliers, vacant/improvement conflicts, and source field
  length limits.
- Removed duplicate transfer payloads, slimmed the snapshot transfer summary,
  added safe bare-instrument handling, and preserved zero-price caveats.
- Hardened evidence parsing and ordering while returning only durable,
  human-facing official portals with exact lookup instructions.
- Added reviewer regression gates, rollback-only migration rehearsals,
  production runtime probes, and a free-tier storage-headroom migration.

## 0.2.0 — 2026-07-27

- Added a dedicated, tested latest sale/deed MCP tool.
- Replaced machine-readable evidence destinations with human D.C. portals,
  exact lookup inputs, and verification steps.
- Added bounded MCP request bodies, explicit CORS allowlisting, defensive HTTP
  headers, request IDs, generic failure responses, and structured non-PII logs.
- Expanded OAuth verification, HTTP-boundary, and nine-tool catalog tests.
- Consolidated database runtime checks into one complete smoke suite.
- Patched the transitive Hono Node adapter advisory without downgrading the MCP
  SDK.
- Added immutable Worker version upload, zero-traffic smoke testing, promotion,
  and automatic rollback.
- Removed the obsolete Python database loader; the streaming Node loader now
  applies every migration through `0012`.

## 0.1.2 — 2026-07-27

- Exposed the dedicated latest sale/deed function through the live MCP server.

## 0.1.1 — 2026-07-27

- Added human-facing official evidence portals and exact verification inputs.

## 0.1.0 — 2026-07-27

- Initial read-only D.C. property database and WorkOS-protected Cloudflare MCP.
