# Spec: Authoritative property-to-parcel resolution

Status: proposed for review. This document approves no implementation or
deployment by itself.

## Objective

Make property identity searches return the complete set of official D.C. lots
associated with the searched address instead of treating one tax-account row as
the whole property.

The serving model remains explicit:

- an SSL identifies a D.C. property lot or tax account;
- a MAR address can relate to zero, one, or many SSLs;
- an SSL can relate to multiple MAR addresses;
- a residential unit can identify one condominium SSL when the official unit
  record supplies it; and
- an address-level grouping is a search result, not a new legal-property entity.

Success means an API consumer can search an address, see every official parcel
association, select the intended SSL when necessary, and visually verify the
relationship through an official human-facing D.C. source.

## Confirmed scope

### Authoritative sources

Use current snapshots of these existing official DC GIS datasets:

1. MAR Address Table, layer 6:
   `DCGIS_DATA/Location_WebMercator/MapServer/6`
2. MAR Address SSL XREF, layer 7:
   `DCGIS_DATA/Location_WebMercator/MapServer/7`
3. MAR Residential Units, layer 68:
   `DCGIS_DATA/Property_and_Land_WebMercator/MapServer/68`

The Address SSL XREF is authoritative for the many-to-many address-to-SSL
relationship. Residential Units is authoritative for unit-specific condominium
SSL narrowing. Existing property-account data remains authoritative for tax and
assessment facts.

### Included

- Acquire, validate, normalize, and release the three source snapshots using the
  existing ArcGIS acquisition pipeline.
- Persist current MAR addresses, address-to-SSL relationships, and residential
  unit-to-condominium-SSL relationships.
- Resolve exact address and unit searches through MAR identifiers before using
  existing normalized-address suggestions.
- Add a paginated `parcels` collection to property-resolution responses.
- Preserve lot classifications such as `TAX LOT`, `RECORD LOT`, `PARCEL`,
  `RESERVATION`, and `CONDO`; do not flatten them into one meaning.
- Join an associated SSL to `core.property_account_current` when available, but
  retain official parcel associations that have no current tax-account row.
- Extend existing source-linked provenance so every returned parcel association
  has opaque `source_refs`, developer provenance, and a human-facing official
  verification source.

### Excluded

- Parcel polygons, PostGIS, spatial intersection, maps, and boundary downloads.
- A synthetic `property_id` or a canonical ownership/property entity.
- Ownership grouping, assemblage inference, collateral conclusions, or title
  conclusions.
- Fuzzy address matches promoted to exact parcel relationships.
- Real-time dependence on DC GIS during an API request.
- A new service, dependency, queue, scheduler, or frontend.

VPM Parcel Lots geometry can be added later if a product requirement calls for
maps or boundaries. It is not needed to return the exact official SSL set.

## Public behavior

### Resolution rules

1. **SSL input:** preserve existing exact SSL resolution. Return that SSL as the
   selected parcel. Related addresses do not broaden an exact SSL request.
2. **Exact address input:** match an active MAR address and return every current
   Address SSL XREF association for its `mar_id`.
3. **Address plus unit:** when an active Residential Units row supplies a
   `condo_ssl`, return that condominium SSL as the selected parcel and include
   the address-level lot set as contextual `related_parcels` metadata.
4. **One associated SSL:** preserve `status: resolved` and the existing single
   account candidate behavior.
5. **Multiple associated SSLs:** preserve `status: ambiguous`, set
   `ambiguity_reason: multiple_official_parcels`, and return the official parcel
   collection so the caller can select an SSL. Multiple official parcels are not
   fuzzy suggestions.
6. **Multiple MAR address matches:** preserve ambiguity and identify it as
   `multiple_official_addresses`; do not merge their parcels.
7. **No MAR match:** retain the existing same-house-number fuzzy suggestions,
   labeled `fuzzy_suggestion`. Their `parcels` collection is empty because a
   suggestion is not parcel evidence.
8. **Conflicting SSL and address:** retain the current fail-closed
   `ssl_address_conflict` response.
9. **Retired addresses or units:** excluded by default and included only when
   the existing `include_deleted` behavior explicitly requests historical
   identity records.

### Additive response contract

Existing fields and candidate structures remain. A successful or ambiguous
official resolution adds:

```json
{
  "parcel_resolution": {
    "relationship": "official_mar_address_ssl_cross_reference",
    "mar_id": 123456,
    "total_count": 2,
    "offset": 0,
    "returned_count": 2,
    "has_more": false,
    "parcels": [
      {
        "ssl": "0107-0075",
        "ssl_normalized": "01070075",
        "lot_type": "TAX LOT",
        "account_id": 123,
        "account_available": true,
        "relationship": "exact",
        "source_refs": ["opaque-reference"]
      }
    ]
  }
}
```

Rules:

- `account_id` is nullable because an official MAR parcel association can exist
  without a current row in the tax-account extract.
- `relationship: exact` means the official MAR cross-reference explicitly
  relates the address or unit to that SSL. It does not assert common ownership,
  one building, one improvement, or one collateral asset.
- `lot_type` is the source value, not an inferred classification.
- `parcel_limit` defaults to 25 and is bounded to 1–100.
- `parcel_offset` defaults to zero.
- Results are ordered by normalized SSL for stable pagination.
- Pagination never truncates silently; `total_count` and `has_more` are always
  present.
- `resolve_properties_batch` returns at most the first 10 parcel associations
  per item plus `total_count` and `has_more`; callers retrieve a full individual
  result when needed.
- `get_complete_property_record` continues only when one account is resolved.
  When an address has multiple official parcels, it returns the enriched
  resolution response and requires the caller to choose an SSL.

### Source-linked contract

- Machine ArcGIS URLs are acquisition metadata and developer provenance only.
- Display-ready `sources` use the stable MAR 2 or PropertyQuest human interface
  with the exact address, unit, and SSL lookup inputs.
- The source relationship is labeled as an official address-to-SSL or
  unit-to-condominium-SSL cross-reference.
- Source release, retrieval date, source record ID, row hash, and covered fields
  remain available through `provenance`.
- Enrichment fails closed under the existing `provenance_unavailable` behavior;
  parcel sources are never silently omitted.

## Data model

Use three current-state tables; no new abstraction layer is required:

```sql
core.mar_address_current (
  mar_id bigint primary key,
  address_source_value text not null,
  address_normalized text not null,
  status text,
  base_ssl_normalized text,
  source_release_id bigint not null,
  source_record_id bigint not null,
  row_sha256 text not null
)

core.mar_address_ssl_current (
  mar_id bigint not null references core.mar_address_current,
  ssl_normalized text not null,
  square text,
  suffix text,
  lot text,
  lot_type text,
  common_ownership_lot text,
  parcel text,
  reservation text,
  source_release_id bigint not null,
  source_record_id bigint not null,
  row_sha256 text not null,
  primary key (mar_id, ssl_normalized)
)

core.mar_residential_unit_current (
  unit_id bigint primary key,
  mar_id bigint not null references core.mar_address_current,
  unit_number text not null,
  unit_type text,
  condo_ssl_normalized text,
  status text,
  source_release_id bigint not null,
  source_record_id bigint not null,
  row_sha256 text not null
)
```

Indexes are limited to the request path:

- `mar_address_current(address_normalized)`
- `mar_address_ssl_current(ssl_normalized)`
- `mar_residential_unit_current(mar_id, unit_number)`

No foreign key from MAR SSL values to `property_account_current` is allowed;
missing tax-account rows must not delete an official parcel association.

## Tech stack

- Python 3.12 standard library for ETL normalization and validation.
- Existing ArcGIS acquisition helpers in `etl/src/dc_property_etl`.
- Existing Node.js loader with `pg`, `csv-parse`, and `pg-copy-streams`.
- PostgreSQL functions under `api_v1` for resolution and pagination.
- Existing Cloudflare Worker, MCP SDK, Zod validation, and provenance enrichment.
- No new dependency or platform component.

## Commands

```powershell
# ETL tests
python -m unittest discover -s .\etl\tests -p "test_*.py" -v

# Loader tests
Set-Location .\loader
npm test

# Validate the database migration without applying it
Set-Location "C:\Quoin DC"
node --env-file=.env.hosted scripts\validate-migrations.mjs `
  db\migrations\0031_mar_parcel_resolution.sql `
  --test db\tests\0031_mar_parcel_resolution_contract.sql

# Worker checks
Set-Location .\worker
npm run check
npm test
npm run bundle

# Read-only hosted verification
Set-Location "C:\Quoin DC"
node --env-file=.env.hosted scripts\verify-runtime.mjs
node --env-file=.env.hosted scripts\check-resolve-performance.mjs
```

## Project structure

- `etl/src/dc_property_etl/` — source registration, acquisition, normalization,
  and deterministic artifact generation.
- `etl/tests/` — source and normalization contract tests.
- `loader/` — transactional loading of generated current snapshots.
- `db/migrations/0031_mar_parcel_resolution.sql` — tables, API functions,
  permissions, and source-evidence support.
- `db/tests/0031_mar_parcel_resolution_contract.sql` — database contract.
- `worker/src/server.ts` — additive pagination inputs and tool description.
- `worker/test/` — MCP input and response behavior.
- `docs/` — public contract, architecture, coverage, and operations updates.

## Code style

Follow the existing deterministic normalization and JSON-building patterns:

```sql
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'ssl', a.ssl_display,
      'lot_type', x.lot_type,
      'account_id', a.account_id
    )
    order by x.ssl_normalized
  ),
  '[]'::jsonb
)
from core.mar_address_ssl_current x
left join core.property_account_current a
  on a.ssl_normalized = x.ssl_normalized
where x.mar_id = p_mar_id;
```

- Preserve raw source values alongside normalized identifiers.
- Normalize SSLs with the existing `_normalize_ssl` behavior.
- Use snake_case in PostgreSQL and Python; follow existing TypeScript formatting.
- Return explicit statuses and hints instead of nullable ambiguity.
- Keep acquisition and human verification URLs separate.

## Testing strategy

One focused contract at each existing boundary is sufficient.

### ETL

- Reject malformed SSLs and non-integral MAR/unit identifiers.
- Preserve source `lot_type` and unit classification.
- Deduplicate identical `(mar_id, ssl)` relationships deterministically.
- Fail on conflicting duplicate keys, missing required source fields, incomplete
  pagination, or a source changing during acquisition.
- Produce byte-deterministic artifacts and release metadata.

### Loader and database

- Load all three snapshots in one transaction and preserve the prior release if
  any validation fails.
- Cover one address-to-one-SSL, one address-to-many-SSLs, many-addresses-to-one-
  SSL, condo unit narrowing, missing account row, retired record, and malformed
  input.
- Confirm fuzzy suggestions never receive exact parcel relationships.
- Confirm SSL/address conflicts remain fail-closed.
- Confirm pagination is stable, complete, and never duplicates an SSL.
- Confirm runtime role permissions expose functions but not base tables.

### Worker and live verification

- Existing requests without parcel pagination parameters remain valid.
- New limits reject negative offsets, zero limits, and limits above 100.
- Batch responses remain bounded.
- Parcel `source_refs` are recursively enriched once and never expose machine
  URLs in `sources`.
- Representative live checks include a single-family lot, a multi-lot address,
  a condominium building, a condominium unit, and an SSL absent from the
  property-account extract.
- Existing response-size and security checks remain authoritative.

## Boundaries

### Always

- Treat MAR relationships as many-to-many.
- Preserve exact versus contextual labels.
- Keep source releases and row hashes auditable.
- Run ETL, loader, database, Worker, security, and live regression checks before
  deployment.
- Deploy data and API changes in a backward-compatible order.

### Ask first

- Adding VPM geometry or PostGIS.
- Creating a synthetic property/building identity.
- Changing the meaning of `status: resolved` or increasing batch limits.
- Scheduling automatic refreshes more frequently than the existing operational
  release process.

### Never

- Infer parcels from address similarity, ownership names, or proximity.
- Drop an official MAR association because no tax-account row exists.
- Treat all SSLs at one address as commonly owned or as one collateral asset.
- Expose machine ArcGIS endpoints as end-user verification links.
- Silently truncate parcel collections or provenance.
- Commit credentials or modify an applied migration.

## Success criteria

- An exact single-family address returns its complete official SSL set.
- An official multi-lot address returns every linked SSL and is not presented as
  one resolved tax account.
- A condominium building search identifies all official associated lots with
  their source lot types.
- A unit-specific search selects the official condominium SSL when supplied by
  Residential Units.
- Reverse lookup by SSL remains exact and backward compatible.
- Every parcel association has verifiable release provenance and a human-facing
  official source action.
- No fuzzy or spatial association is labeled exact.
- Pagination returns the same complete ordered set across repeated calls.
- Existing property facts, provenance, source links, and all 15 MCP tools pass
  regression tests.
- Production performance remains within the existing resolve-property budget.

## Open questions

None. The assumptions reviewed on 2026-08-05 are incorporated above. Any scope
change returns this document to specification review before planning.
