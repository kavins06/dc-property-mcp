# Architecture

The authoritative serving entity is a D.C. property-tax account identified by
SSL. It is not assumed to be a one-to-one physical parcel: condominium units,
possessory-interest accounts, tax lots, and related accounts exist.

The Cloudflare Worker exposes ten bounded, read-only MCP tools and validates
WorkOS access tokens. Hyperdrive connects to the direct Supabase PostgreSQL
endpoint. The runtime role has no table access and may only execute hardened
`api_v1` functions.

Raw source files, manifests, reports, and logical backups belong in a private
R2 Standard bucket. PostgreSQL contains only compact serving data, semantic
metadata, compact linked CAMA sale vectors, and source locators.

pgvector is intentionally excluded from v1 because all current use cases are
structured identity, range, and history queries.

## Trust boundaries

- WorkOS is the authorization server. The Worker verifies signature, issuer,
  expiration, and the exact MCP resource audience on every request.
- Cloudflare terminates public TLS, enforces per-user rate limits, and connects
  to PostgreSQL only through Hyperdrive.
- `mcp_runtime` has no direct table privileges and may execute only the ten
  curated `api_v1` functions.
- Supabase `anon`, `authenticated`, and `PUBLIC` have no access to those
  functions. The Data API is not part of the serving path.
- Official portals are evidence destinations, not machine data dependencies;
  their current contents cannot override the frozen source extracts.

The MCP SDK's Node adapter is pinned through npm overrides to a patched
`@hono/node-server` release. Both production and development dependency trees
must report zero known vulnerabilities at release time.

## Query and semantic boundaries

- Resolution is exact-first against precomputed normalized SSL and address
  fields. Fuzzy lookup runs only after exact lookup fails, uses a bounded
  candidate set, labels suggestions, and never returns collateral facts.
- A bounded batch resolver accepts only 1–50 caller-named assets. It is not a
  universe export.
- Screening accepts an allowlist of typed filters and sort orders. It validates
  filter vocabulary and ranges before querying and excludes owner/mailing data.
- A frozen semantic property-type vocabulary validates source and canonical
  labels without per-row canonicalization. Two compact partial indexes serve
  type/tax-class and ward/tax-class screening.
- Shared semantic metadata lives in `semantic` tables and is exposed through
  topic-routed `describe_data` responses, field definitions, code decodes,
  coverage declarations, quality flags, and unsupported-inference lists.
- `get_source_evidence` validates every four-part source reference before any
  cast and returns durable human portal routes rather than machine endpoints.

The large immutable assessment history intentionally has no full-table primary
key index. Runtime reads use `assessment_account_idx`; the 16,717 unlinked or
ambiguous diagnostics use a small partial unique index. ETL and post-load
assertions enforce full-record uniqueness and link integrity. Supabase may
therefore report an informational no-primary-key advisory; adding a roughly
14 MB unused index would breach the free-tier operating margin without
improving a runtime path.
