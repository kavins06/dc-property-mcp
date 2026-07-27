# D.C. Property Records MCP

Read-only, lender-oriented Washington, D.C. property-account data service.

The project builds:

1. Compact PostgreSQL serving tables and a semantic catalog.
2. Deterministic ETL from the canonical ITSPE files and the official D.C.
   Tax System Property Sales (CAMA) export.
3. Fact-level provenance and human-facing portal verification routes with
   exact address, SSL, or instrument lookup instructions.
4. A curated Cloudflare-hosted MCP server protected by WorkOS AuthKit.

The canonical CSV files remain in the parent workspace and are never modified.
Generated load files belong in `data/generated/` and are excluded from Git.

## Hosted service

The production MCP endpoint is:

```text
https://dc-property-mcp.quoindata.com/mcp
```

It is deployed on Cloudflare Workers with a custom domain, Hyperdrive, two
rate-limit bindings, and WorkOS AuthKit OAuth. The WorkOS production
environment allows public email/password sign-up and supports both Client ID
Metadata Document and Dynamic Client Registration.

The Supabase database currently contains:

- 221,263 current D.C. property-tax accounts
- 652,131 assessment snapshot records
- 221,263 compact, lossless tax series
- 215,408 accounts with official sale history
- 421,436 linked CAMA sale records; 9 source records are retained as unlinked
  diagnostics
- approximately 467.7 million total PostgreSQL bytes after indexes

The MCP exposes ten read-only tools for exact-first single and batch identity
resolution, lender-oriented property snapshots, assessment history, compact
tax/balance history, ownership, full linked CAMA sale history with the latest
assessor deed, validated lender screening, official source evidence, and
question-routed semantic guidance.

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

Worker validation and deployment:

```powershell
cd worker
npm run check
npm test
npm run bundle
npm audit --audit-level=moderate
node --env-file=..\.env.hosted ..\scripts\deploy-cloudflare.mjs
node ..\scripts\verify-live.mjs 0.3.0
node ..\scripts\verify-authenticated-mcp.mjs
```

The deployment helper uploads an immutable Worker version, attaches it at zero
traffic, smoke-tests that exact version through Cloudflare's version-override
header, then promotes it to 100%. A failed smoke test automatically restores
the previous version.

`verify-authenticated-mcp.mjs` is an attended gate: it dynamically registers a
temporary OAuth client, prints the WorkOS authorization URL, receives the
localhost callback, discovers all ten tools, and calls every tool without
persisting tokens. WorkOS may require a human-verification challenge.

The loader streams gzip CSVs without expanding them on disk, builds the
historical-account link audit, validates exact row counts, and enforces the
480 MB database no-go gate. Runtime traffic uses only the least-privileged
`mcp_runtime` role through Hyperdrive; it cannot read serving tables directly.

Operational thresholds, incident steps, and rollback procedures are in
`docs/operations-runbook.md`.
