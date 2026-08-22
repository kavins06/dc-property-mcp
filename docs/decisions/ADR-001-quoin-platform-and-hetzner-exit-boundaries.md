# ADR-001: Quoin platform boundaries and staged Hetzner migration

## Status

Accepted

## Date

2026-08-21

## Scope

This decision applies only to the Quoin property-data product: the public
marketing site, authenticated customer platform, property MCP service, and the
D.C./Maryland/Virginia property database. CMBS and unrelated products are
explicitly out of scope.

Maryland and Virginia remain local and unpublished until the owner gives a
separate publication approval. This decision does not authorize a production
load, publication, deployment, public exposure, or Git push.

## Context

Quoin currently has overlapping website, platform, MCP, database, research,
and handoff repositories. The production D.C. property service also depends on
PostgreSQL and object storage hosted by Hetzner. The intended destination is a
smaller, auditable system in which:

- the marketing site and customer platform are operationally isolated;
- the customer experiences one Quoin product rather than disconnected sites;
- the browser never receives database credentials;
- Cloudflare remains the controlled API and MCP boundary;
- Neon becomes the managed PostgreSQL system of record;
- GitHub controls source, review, releases, and deployment authorization; and
- Hetzner Object Storage remains the private object archive during and after
  the database migration; and
- retiring Hetzner compute preserves a tested database rollback until Neon has
  completed validation and a soak period.

## Decision

### 1. Use two production repositories

#### `quoin-web`

Use one GitHub repository containing two independently deployed applications
and one platform API:

```text
quoin-web/
|-- apps/
|   |-- marketing/       # quoindata.com
|   `-- platform/        # app.quoindata.com
`-- workers/
    `-- platform-api/    # api.quoindata.com
```

- Marketing and platform are separate applications and Vercel projects.
- Marketing is public, static-oriented, SEO-focused, and has no WorkOS,
  Stripe, D1, or database secrets.
- Platform is authenticated and owns customer account, billing, entitlement,
  documentation, and MCP onboarding experiences.
- The Cloudflare platform API integrates WorkOS, Stripe, and D1 entitlement
  state.
- Shared packages are not created speculatively. Add a shared UI package only
  after real duplicated components justify it.
- Split the two applications into separate GitHub repositories only if they
  later have different teams, access permissions, or release ownership.

#### `quoin-property`

Rename the current `dc-property-mcp` repository after the infrastructure
migration is complete. It remains the single owner of:

- PostgreSQL schema and migrations;
- D.C., Maryland, and Virginia property data contracts;
- acquisition, ETL, loaders, and quality gates;
- release manifests and publication controls; and
- the property MCP Cloudflare Worker at `mcp.quoindata.com`.

Do not create a separate database repository. Raw datasets and database dumps
must not be committed to Git.

### 2. Keep runtime responsibilities narrow

```text
Browser
  `-> Vercel marketing/platform
        `-> Cloudflare platform API
              |-> WorkOS identity
              |-> Stripe billing
              `-> D1 entitlements

MCP client
  `-> Cloudflare property MCP Worker
        |-> WorkOS token validation
        |-> D1 entitlement check
        `-> Hyperdrive
              `-> Neon PostgreSQL
```

- GitHub is the engineering control plane, not a runtime or data store.
- Vercel hosts the web applications and never receives Neon credentials.
- Cloudflare owns DNS/TLS, API and MCP Workers, Hyperdrive, D1, and edge
  controls.
- Neon owns property PostgreSQL.
- Hetzner continues to own the private S3-compatible property archive. This is
  intentionally independent from the PostgreSQL migration.
- WorkOS owns identity; Stripe owns payment events; D1 owns entitlement state.
- An encrypted D-drive mirror may be maintained as an offline recovery copy,
  but completing it is not a prerequisite for the Neon cutover and it is never
  the sole durable archive.

### 3. Use explicit GitHub deployment boundaries

- Protect `main` and require passing checks before merge.
- Keep marketing and platform deployments independent even though they share a
  repository.
- Use separate preview, production, and data-production environments.
- An ordinary web or Worker deployment must never apply a database migration
  or publish a data release.
- Database migrations and data publication require explicit workflows,
  immutable inputs, validation receipts, target identity checks, and rollback
  evidence.
- Preserve redundant/research repositories as archived history after selected
  work is ported by reviewed pull request; do not merge unrelated Git histories.

## Staged infrastructure migration sequence

The following steps are ordered gates, not operations to run in parallel:

1. **Preserve and baseline Hetzner Object Storage.**
   Keep the private `quoindata` bucket on Hetzner and make no provider change
   during the database migration. Record bucket identity, object count, total
   bytes, encryption-key recovery procedure, integrity inventory, and a tested
   restore receipt. Do not delete, rewrite, or migrate objects as part of the
   Neon cutover. An encrypted D-drive mirror may run as separate, non-blocking
   backup work using copy-only semantics.
2. **Migrate only the current D.C. production database to Neon.**
   Exclude all unpublished Maryland/Virginia schema and data. Restore exact
   production schema, extensions, functions, roles, ownership, privileges,
   data, and sequences; then pass integrity, security, and API contract gates.
3. **Create a new Neon Hyperdrive and stage a 0% Cloudflare Worker candidate.**
   Do not repoint the existing Hetzner Hyperdrive. Keep the currently deployed
   Worker and Hetzner path intact as rollback. Confirm the candidate contains
   only the intended binding/configuration change.
4. **Validate and promote, then retain Hetzner PostgreSQL for rollback and
   soak.**
   Exercise the authenticated production tool catalog, compare correctness and
   latency, promote gradually, and monitor errors, resource use, and cost for
   30 to 60 days. After the soak passes and database, tunnel, monitoring, and
   scheduled-job dependencies are proven clear, retire only the Hetzner VM,
   PostgreSQL, tunnel, and related compute resources. Keep the Hetzner Object
   Storage bucket and its narrowly scoped credentials active.

Migrating the object archive to Cloudflare R2 is a separate future decision.
It must not be coupled to the Neon cutover. If approved later, copy and verify
the complete archive in R2 and the encrypted D-drive recovery copy before
deleting the Hetzner bucket or closing the Hetzner account.

Each gate requires a written receipt before the next begins. Failure at any
gate returns execution to the last known-good production path.

## Alternatives considered

### One web application for marketing and platform

Rejected because it couples public marketing releases to authenticated
customer access and broadens the platform's security and secret exposure.

### Separate GitHub repositories for marketing and platform

Deferred because the same owner and product currently share brand, navigation,
documentation, and coordinated launches. Two Vercel projects already provide
the necessary deployment and security boundary without recreating repository
sprawl.

### Direct Vercel-to-Neon access

Rejected because database access belongs behind the Cloudflare API/MCP trust
boundary. No browser or Vercel environment should receive property database
credentials.

### Repoint the existing Hyperdrive in place

Rejected because it destroys the clean, immediate Hetzner rollback path.

### Migrate object storage to Cloudflare R2 during the Neon cutover

Deferred because changing the database provider and durable object store in
the same cutover expands the failure and rollback surface. R2 can be evaluated
after Neon and the Cloudflare database path complete their soak period.

## Consequences

- Quoin presents a harmonized customer product while preserving independent
  marketing and platform failure domains.
- Only two production repositories are required for the property product.
- The database and MCP contract evolve together.
- Hetzner compute cancellation is intentionally delayed until validation and
  soak evidence prove it safe.
- The Hetzner account and Object Storage charges remain active after the
  database migration. A complete Hetzner exit requires a separately approved,
  verified object-storage migration.
- Maryland and Virginia work can continue locally without creating an implicit
  publication path.
