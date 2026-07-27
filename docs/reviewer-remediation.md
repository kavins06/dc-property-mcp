# Reviewer remediation record

This record maps the 2026-07-27 institutional review to the v0.3.0 release.
Automated assertions live in `db/tests/reviewer_regressions.sql`; Worker
boundary tests live under `worker/test/`.

| Finding | v0.3.0 disposition |
| --- | --- |
| C1 | Exact-first normalized address resolution; bounded fuzzy fallback; sanitized timeout and database errors. |
| C2 | Exact matches resolve outright; fuzzy suggestions are labeled and scored; statuses distinguish resolved, ambiguous, no exact match, and not found. |
| C3 | Case-insensitive canonical filters; ward/vocabulary/range validation; invalid requests cannot masquerade as zero matches. |
| C4 | `describe_data(question)` performs compact keyword routing and returns filter vocabulary, decodes, coverage, limitations, and best-next-tool guidance. |
| C5 | Source mailing values remain unchanged and carry `mailing_jurisdiction_conflict`; additional type/value and sale/assessment checks were added. |
| C6 | Evidence refs are validated before parsing; malformed refs return `invalid_input`; the Worker strips SQL/driver/connection details from all errors. |
| C7 | Assessment and tax history use shared response metadata and aligned compact series instead of repeating full fact envelopes. |
| C8 | Tax-slot source fields include the slot, such as `tax.slot.penalty.PY4`. |
| C9 | The API exposes `total_liabilities_reported_cents` with the official “total of all liabilities” meaning and a not-current-amount-owed caveat. |
| C10 | Bare assessor instrument values are preserved but never prefilled as complete instrument IDs; the evidence route uses deed year, SSL/address, and party name with a warning. |
| C11 | Screening adds tax class, balance, tax-sale, sale-date, deterministic sort, total count, `has_more`, and balance fields while preserving the privacy boundary. |
| C12 | Detail functions preserve `invalid_input`, `ambiguous`, `no_exact_match`, `not_found`, and `conflicting_input` distinctions. |
| C13 | Conflicting SSL and address inputs are rejected explicitly. |
| C14 | Complete 2019, 2023, and 2024 assessment extracts remain unavailable; the gap is explicit and no values are interpolated. |
| C15 | Clean display addresses and canonical property-type labels are returned; source strings that hit published length limits remain available with quality flags. |
| C16 | Ownership no longer duplicates sale history; the snapshot transfer is slim; the focused sale/deed tool owns the full CAMA history. |
| C17 | Raw source codes are paired with documented use, tax-class, and special-assessment decodes. |
| C18 | Zero-price and sentinel-date caveats travel with every transfer/sale response family. |

## Additions completed

- Delinquency and tax-sale screening
- Source-preserving plausibility flags
- Bounded named-asset batch resolution
- Full linked official CAMA assessor sale history
- Sorting and total-count screening metadata
- A scripted, pre-verified demo path

## Authoritative-source limits

Two roadmap items cannot be truthfully manufactured from the collected public
records:

- Complete 2019, 2023, and 2024 assessment snapshots require a new official
  archive, FOIA production, or licensed source.
- CAMA sale history is not Recorder of Deeds chain-of-title or lien data.
  Title and lien conclusions require an official instrument-index/image
  workflow and professional review.

These are exposed as limitations in the semantic layer and tool outputs rather
than hidden behind inferred values.
