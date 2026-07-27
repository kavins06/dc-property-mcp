# Changelog

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
