# Institutional demo playbook

This is the repeatable twelve-minute path for a commercial-real-estate lender.
Run the release gates immediately before the meeting and use the values returned
by the live tools; the landmarks below are checks, not a substitute for the
source-backed response.

## Preflight

```powershell
node scripts\verify-live.mjs 0.3.0
node --env-file=.env.hosted scripts\verify-runtime.mjs
python scripts\check_evidence.py
```

Confirm that the live MCP advertises ten tools and that the authenticated test
client can call each tool. Do not proceed if resolution, OAuth, evidence links,
or the safe-error probes fail.

## Act 1: cited collateral facts

Anchor property: 1801 K Street NW, SSL `0107--0075`.

1. Call `resolve_property` with the address. Show that the exact match resolves
   with score 1.0 and no unrelated fuzzy candidates.
2. Call `get_property_snapshot`. Explain that the entity is a D.C. tax account,
   not a guaranteed one-to-one physical parcel.
3. Call `get_assessment_history`. The expected story in the frozen extracts is
   a $515.4 million TY2021 current assessment, $320.1 million TY2026 current
   assessment, and $259.0 million TY2027 proposed assessment.
4. Call `get_tax_and_balance_history`. Show the TY2022 penalty signal and the
   source-reported current balance. Explicitly distinguish
   `total_liabilities_reported_cents` from amount currently owed.
5. Call `get_latest_sale_and_deed`. Show the official CAMA 2015-01-14
   $445 million sale, with the limitation that CAMA is not a Recorder chain of
   title.
6. Call `get_ownership_and_sale`. Show that the official mailing value is
   preserved, while `mailing_jurisdiction_conflict` requires human review and
   is not a sanctions conclusion.

## Act 2: lender screening

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
`has_more`, and the absence of owner names and mailing addresses. Then show a
distress-oriented screen using `has_balance`, `min_balance_cents`, or
`has_tax_sale_flag`. Resolve and inspect one named result; do not use screening
as a bulk export.

If a user asks for a filter value in natural language, call `describe_data`
with that question first. It returns the exact vocabulary and best next tool.

## Act 3: evidence and refusal behavior

1. Send the returned 2015 sale-price ref and TY2022 penalty ref to
   `get_source_evidence`.
2. Open the durable human-facing CAMA or MyTax portal and follow the exact SSL,
   address, source-record, and navigation instructions.
3. Explain that archived assessment facts may no longer be reproducible in the
   live portal; the response therefore supplies the frozen file hash,
   retrieval/capture date, and archive limitation.
4. Show one rejected invalid ward, one inverted value range, one malformed
   source ref, and one conflicting SSL/address pair. Each response must be
   structured and must not contain SQL, driver, hostname, or credential text.
5. Close with the connector's refusal boundary: it does not conclude title,
   lien existence or priority, appraisal value, NOI, DSCR, occupancy, or zoning
   compliance.

## Portfolio follow-up

Use `resolve_properties_batch` for a caller-supplied tape of 1–50 named assets.
It preserves `client_id` and input order. Follow resolved rows with the narrow
detail tools; do not promise a universe export or a Recorder title product.
