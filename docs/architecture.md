# Architecture

The authoritative serving entity is a D.C. property-tax account identified by
SSL. It is not assumed to be a one-to-one physical parcel: condominium units,
possessory-interest accounts, tax lots, and related accounts exist.

The Cloudflare Worker exposes nine bounded, read-only MCP tools and validates
WorkOS access tokens. Hyperdrive connects to the direct Supabase PostgreSQL
endpoint. The runtime role has no table access and may only execute hardened
`api_v1` functions.

Raw source files, manifests, reports, and logical backups belong in a private
R2 Standard bucket. PostgreSQL contains only compact serving data, semantic
metadata, and source locators.

pgvector is intentionally excluded from v1 because all current use cases are
structured identity, range, and history queries.

## Trust boundaries

- WorkOS is the authorization server. The Worker verifies signature, issuer,
  expiration, and the exact MCP resource audience on every request.
- Cloudflare terminates public TLS, enforces per-user rate limits, and connects
  to PostgreSQL only through Hyperdrive.
- `mcp_runtime` has no direct table privileges and may execute only the nine
  curated `api_v1` functions.
- Supabase `anon`, `authenticated`, and `PUBLIC` have no access to those
  functions. The Data API is not part of the serving path.
- Official portals are evidence destinations, not machine data dependencies;
  their current contents cannot override the frozen source extracts.

The MCP SDK's Node adapter is pinned through npm overrides to a patched
`@hono/node-server` release. Both production and development dependency trees
must report zero known vulnerabilities at release time.
