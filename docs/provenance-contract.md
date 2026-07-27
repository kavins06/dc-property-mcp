# Fact provenance contract

Every scalar returned to an MCP client carries:

- stable semantic field key and label
- typed value and unit
- tax year/stage or other effective period
- per-record source extract date
- status (`reported`, `derived`, or a typed null status)
- one or more source references
- quality and conflict flags

Source references are deduplicated in each response. When expanded, they
include publisher, dataset, a human-facing official portal, exact lookup
inputs, short verification steps, retrieval/archive timestamps, file SHA-256,
and source row.

The canonical reference shape is:

```text
source_id|source_record_id|field_key|ssl
```

Tax-slot references include the slot in `field_key`, for example
`tax.slot.penalty.PY4`. CAMA sale references carry the official source
`OBJECTID`. The evidence function validates all four components before
parsing, preserves caller order, and rejects the entire request as
`invalid_input` if any reference is malformed.

Human-verification priority:

1. A stable official document page, when one exists.
2. An official human search portal plus exact instrument number, SSL, or
   address and navigation steps.
3. A D.C.-authorized public-record portal plus exact lookup inputs.
4. Archived-extract provenance with an explicit warning when the current
   portal cannot reproduce the historical period.

MyTax `Retrieve` URLs are session-bound and must never be persisted as durable
evidence. ArcGIS REST/FeatureServer query URLs are machine interfaces and must
never be returned as the user-facing evidence link. Live portal values may be
newer than the frozen dataset.

For MyTax facts, the route includes the exact SSL and address for the public
Real Property Search. For CAMA sale facts, it includes the D.C. Open Data
dataset page, SSL, address, and source record ID. For deed facts, the route
includes the official Recorder portal; a reported instrument is prefilled only
when it is already year-prefixed. Bare instrument values are preserved with a
warning and verified by deed year, SSL/address, and party name instead.
