# Data coverage and limitations

## Property accounts, assessments, taxes, and sales

Assessment periods available from the current official ITSPE extract:

| Tax year | Stage |
| ---: | --- |
| 2025 | prior |
| 2026 | current |
| 2027 | proposed |

These values are carried directly on `core.property_account_current`; there is
no separately built or loaded assessment-history artifact. Current ITSPE tax
source slots remain a distinct dataset and retain `CY1`, `CY2`, and
`PY1`-`PY10` separately.

The official Tax System Property Sales (CAMA) export contributes 421,445
source records, of which 421,436 link to 215,408 current accounts and 9 remain
as explicit unlinked diagnostics. The reported sale-date range is 1900-01-01
through 2026-07-14. Sentinel dates, zero-price transfers, assessor sale codes,
and source values are preserved and flagged rather than silently rewritten.

## Regulatory, permit, license, and building data

The current regulatory release freezes 38 official sources:

- 18 annual DOB building-permit feeds, 2009 through 2026
- one DOB certificate-of-occupancy feed and one home-occupancy-permit feed
- one DLCP basic-business-license feed
- seven DDOT/TOPS public-space sources
- one DOEE well-permit feed
- three ABCA alcohol/cannabis licensed-location feeds
- three current CAMA building-profile feeds
- two DOEE energy/BEPS feeds
- one DOB vacant/blighted-address feed

The release contains 3,623,995 official source rows. It serves 2,600,666
normalized records through 5,862,456 property-account links:

| Link/result class | Count | Meaning |
| --- | ---: | --- |
| exact SSL-derived records | 945,074 | `exact_property`, method `ssl`, confidence `1.0000` |
| contextual records | 1,655,592 | shared-building, multi-parcel, or proximity context |
| capped ambiguous records | 27,145 | excluded because address association exceeded the 64-account cap |
| unlinked source records | 996,184 | retained in raw acquisition, excluded from serving |

No fuzzy record-to-property matching is used. Only `exact_property` is a
parcel-specific assertion. `shared_building`, `multi_parcel`, and
`proximity_context` are useful underwriting context but must not be restated as
facts about one tax account. An empty tool result means no linked record was
loaded for that source release, not proof that no public record exists.

The four regulatory tools cover:

- `get_permit_history`: building, occupancy, public-space, home-occupancy, and
  well-permit records
- `get_license_history`: DLCP and ABCA licensed activity at a reported premise
- `get_inspection_and_enforcement_history`: official inspection and
  enforcement/violation context with agency identity preserved
- `get_building_and_land_profile`: exact CAMA characteristics plus contextual
  energy, BEPS, and vacant/blighted information

Every served record is pinned to a frozen source release and carries fact-level
source references that expand to an official human portal, exact search inputs,
and verification steps. The live portal may be newer than the frozen release.

## Underwriting limitations

CAMA is assessor sale history, not a Recorder of Deeds chain of title. The
latest ITSPE deed fields remain assessor-reported context. Permit issuance is
not proof of completed or code-compliant work. A license at a premise is not
proof of property ownership, a current lease, or tenant occupancy. Energy and
BEPS records may describe a shared building rather than one tax account.

No complete tax-bill PDF archive, deed-image/index chain, leases, NOI,
tenant roster, independently verified rentable area, zoning-compliance
determination, title conclusion, lien-priority conclusion, survey, appraisal,
or complete parcel geometry has been collected. Official CAMA building
characteristics and certificates of occupancy are available, but they do not
replace physical, legal, zoning, or appraisal diligence.

The connector does not interpolate assessment stages or treat a proposed value
as final.
