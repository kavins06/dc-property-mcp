# Changelog

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
