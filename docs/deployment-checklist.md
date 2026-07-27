# Hosted deployment checklist

No provider secret belongs in Git, chat, logs, manifests, or generated evidence.
Use provider secret stores and rotate any credential that is accidentally
exposed.

## Supabase

Required from the project owner:

- One empty Supabase project in the desired region.
- The direct administrative PostgreSQL connection string for the one-time
  migration/load. The direct endpoint may require an IPv6-capable x64 runner.
- A newly generated password for the `mcp_runtime` role. This is distinct from
  the administrative password and is used only by Cloudflare Hyperdrive.

Run the ETL loader, record `pg_database_size`, and stop if it exceeds 450 MB.
The preferred operating target is 400 MB or less. Verify that `mcp_runtime`
cannot select from `core`, `history`, `meta`, or `semantic`, and can execute
only the nine public `api_v1` functions.

## Cloudflare

Required from the project owner:

- Account ID and an API token scoped to create/update one Worker, one
  Hyperdrive configuration, the selected route/custom domain, observability,
  and rate-limit bindings.
- The final public MCP URL: `https://dc-property-mcp.quoindata.com/mcp`.

The deployed Worker uses Hyperdrive with the **Supabase direct** connection string for
`mcp_runtime`; do not point Hyperdrive at Supavisor. Put the returned
configuration ID in `wrangler.jsonc`. Configure general and tighter
`search_properties` rate limiters.

## WorkOS

Required from the project owner:

- AuthKit production domain: `ripe-theater-06.authkit.app`.
- Confirmation that public sign-up and email verification are enabled.
- The final MCP URL registered as a Resource Indicator.

In WorkOS Connect configuration, enable Client ID Metadata Document (CIMD).
Enable Dynamic Client Registration as a compatibility option for clients that
have not adopted CIMD. The Worker validates the AuthKit issuer, JWKS signature,
and exact resource audience; it never accepts an unverified token.

## Release gates

- Migrations apply and all three exact row-count gates pass.
- PostgreSQL total size is within the storage gate.
- Runtime table reads fail; allowlisted function calls succeed.
- Five evidence examples open a human-verifiable official result.
- WorkOS sign-up, email verification, consent, token refresh, and logout pass.
- ChatGPT and Claude can discover OAuth metadata and call all nine tools.
- Ambiguous address requests return candidates without collateral facts.
- Malformed filters cannot create arbitrary SQL or unbounded exports.
- Logs contain no access tokens, database URLs, owner/mailing payloads, or
  source-session URLs.
- Worker type-checks and all unit tests pass; both npm trees have zero known
  vulnerabilities.
- The exact uploaded Worker version passes health, security-header, OAuth,
  origin, and unauthenticated-boundary smoke tests before it receives traffic.
- The previous Worker version ID is recorded and automatic rollback is armed.

## Official implementation references

- WorkOS: https://workos.com/docs/authkit/mcp
- Cloudflare Hyperdrive with Supabase:
  https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/
- Cloudflare remote MCP:
  https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- Supabase PostgreSQL connections:
  https://supabase.com/docs/guides/database/connecting-to-postgres
