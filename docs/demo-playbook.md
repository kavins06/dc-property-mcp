# Institutional verification playbook

This is a repeatable lender-facing verification path. Run the release gates
immediately before a review and use values returned by the live tools; this
playbook defines checks, not substitute property facts.

## Preflight

```powershell
node scripts\verify-live.mjs 0.4.1
node --env-file=.env.hosted scripts\verify-runtime.mjs
python scripts\check_evidence.py
node scripts\verify-authenticated-mcp.mjs
```

Confirm that the live MCP advertises exactly 15 tools and that the authenticated
client can call every tool. Do not proceed if identity resolution, OAuth,
release-pinned evidence, exact/contextual linkage, or safe-error probes fail.

## Act 1: exhaustive single-property retrieval

Ask for all available data on `4800 E Capitol St NE in DC`. Confirm the model
calls `get_complete_property_record`, resolves SSL `5140--0088`, returns all
nine sections, and reports complete coverage with no continuation. The release
regression expects 42 permits, 4 licenses, 1 inspection/enforcement record, and
15 building/land records. It must not stop after tax history or describe the
other available domains as unqueried.

## Act 2: cited collateral facts

Anchor property: 1801 K Street NW, SSL `0107--0075`.

1. Call `resolve_property` independently with the SSL and address. Show that an
   exact match resolves without unrelated fuzzy candidates.
2. Call `resolve_properties_batch` with two caller-named assets. Confirm input
   order and `client_id` are preserved.
3. Call `get_property_snapshot`. Explain that the entity is a D.C. tax account,
   not a guaranteed one-to-one physical parcel.
4. Call `get_assessment_history`. Show only the active assessment scope:
   TY2025 prior, TY2026 current, and TY2027 proposed. Do not describe proposed
   value as final or imply a separate historical-assessment table.
5. Call `get_tax_and_balance_history`. Distinguish
   `total_liabilities_reported_cents` from amount currently owed.
6. Call `get_latest_sale_and_deed` and `get_ownership_and_sale`. Explain that
   CAMA is assessor sale history, not a Recorder chain of title, and show that
   the mailing-jurisdiction conflict remains visible for human review.

## Act 3: permits, licenses, and building context

Call all four regulatory tools with the resolved SSL:

1. `get_permit_history`
2. `get_license_history`
3. `get_inspection_and_enforcement_history`
4. `get_building_and_land_profile`

For returned records, point out:

- publisher/agency, source release, record type, status, and effective dates
- `exact_property` only for SSL-derived confidence `1.0000`
- `shared_building`, `multi_parcel`, and `proximity_context` as contextual,
  never exact tax-account facts
- a permit is not proof of completed/compliant work
- a premise license is not proof of ownership, tenancy, or an active lease
- an empty result means no linked record in the frozen release, not proof that
  no public record exists

## Act 4: lender screening and semantic guidance

Call `search_properties` with:

```json
{
  "ward": "2",
  "property_type": "Commercial-Office (Large)",
  "tax_class": "2",
  "min_assessment": 100000000,
  "sort_by": "assessment_desc",
  "limit": 10
}
```

Point out the validated filters, deterministic ranking, `total_count`,
`has_more`, and absence of owner names and mailing addresses. Resolve and
inspect one named result; do not use screening as a bulk export.

If a user asks for a filter, field, coverage, or regulatory-data question in
natural language, call `describe_data` first. Confirm it recommends the narrow
tool and returns valid vocabulary and inference boundaries.

## Act 5: one-click human evidence and refusal behavior

1. Send representative ITSPE, CAMA, permit/license, and building-context refs
   to `get_source_evidence`.
2. Open each returned official human portal and follow its exact SSL, address,
   square/lot, source-record, permit/license, building-ID, or navigation
   instructions.
3. Confirm the response includes frozen source-release/retrieval metadata and
   link scope. Explain that a live portal may be newer than the cited release.
4. Reject any ArcGIS REST/FeatureServer, raw JSON/download, session-bound MyTax,
   blocked, or otherwise non-human evidence URL.
5. Show one rejected invalid ward, one inverted value range, one malformed
   source ref, one invalid regulatory filter, and one conflicting SSL/address
   pair. Each response must be structured and contain no SQL, driver, hostname,
   or credential text.
6. Close with the connector's boundary: it does not conclude title, lien
   existence/priority, appraisal value, NOI, DSCR, occupancy, zoning
   compliance, permit completion, or code compliance.

## Portfolio follow-up

Use `resolve_properties_batch` for a caller-supplied tape of 1–50 named assets.
It preserves `client_id` and input order. Follow resolved rows with narrow
detail tools; do not promise a universe export or a Recorder title product.
