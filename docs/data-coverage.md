# Data coverage and limitations

Assessment periods currently available from complete ITSPE snapshots:

| Tax year | Stage |
| ---: | --- |
| 2016 | prior |
| 2017 | current |
| 2018 | proposed |
| 2020 | prior |
| 2021 | current |
| 2022 | proposed |
| 2025 | prior |
| 2026 | current |
| 2027 | proposed |

Complete all-account assessment extracts were not found for 2019, 2023, or
2024. Current ITSPE tax source slots cover approximately 2016-2026 and retain
`CY1`, `CY2`, and `PY1`-`PY10` separately.

The official Tax System Property Sales (CAMA) export contributes 421,445
source records, of which 421,436 link to 215,408 current accounts and 9 remain
as explicit unlinked diagnostics. The reported sale-date range is 1900-01-01
through 2026-07-14. Sentinel dates, zero-price transfers, assessor sale codes,
and source values are preserved and flagged rather than silently rewritten.

CAMA is assessor sale history, not a Recorder of Deeds chain of title. The
latest ITSPE deed fields remain assessor-reported context. No complete
tax-bill PDF archive, deed-image/index chain, leases, NOI, occupancy,
building-area inventory, zoning-compliance determination, title conclusion,
lien-priority conclusion, or geometry has been collected.

The 2019, 2023, and 2024 complete-assessment gaps cannot be repaired without a
new authoritative archive, FOIA production, or licensed partner file. The
connector does not interpolate missing government records.
