# Fact provenance contract

Every scalar returned to an MCP client carries:

- stable semantic field key and label
- typed value and unit
- tax year/stage or other effective period
- per-record source extract/release date
- status (`reported`, `derived`, or a typed null status)
- one or more source references
- quality, conflict, and property-link-scope flags

Source references are deduplicated in each response. When expanded, they include
publisher, dataset, a human-facing official portal, exact lookup inputs, short
verification steps, retrieval/archive timestamps, source release ID, file or
release SHA-256, source row/record, and the property-link scope.

## Reference formats

ITSPE and CAMA facts retain the four-part reference:

```text
source_id|source_record_id|field_key|ssl
```

Tax-slot references include the slot in `field_key`, for example
`tax.slot.penalty.PY4`. CAMA sale references carry the official source
`OBJECTID`.

Regulatory and property-context facts use a release-pinned, tamper-evident
six-part reference:

```text
source_id|source_release_id|source_record_id|field_key|binding_sha256|ssl
```

`binding_sha256` covers canonical JSON containing the source, release, record,
persisted source-row hash, field key, and normalized SSL. Evidence expansion
requires that:

- the referenced release is the published current release for the source;
- the source record is linked to the referenced active tax account;
- the field key is valid for that record type; and
- the cryptographic binding matches.

The evidence function validates the appropriate reference format before
parsing, preserves caller order, and rejects the entire request as
`invalid_input` if any reference is malformed, stale, mismatched, or edited.
Clients must treat source references as opaque values.

## Release and linkage meaning

The regulatory manifest binds the exact core-account input, each of the 38
official source releases, and every normalized artifact by byte size, row
count, file SHA-256, and canonical-row SHA-256. Runtime queries join through
`meta.source_release_pointer`; hidden, rejected, superseded, or unapproved
releases are not served.

Only `exact_property` means an exact property link. It requires an official SSL
link with method `ssl` and confidence `1.0000`. The other link scopes are
contextual:

- `shared_building`: a building-level record may cover multiple tax accounts
- `multi_parcel`: the official premise association spans multiple parcels
- `proximity_context`: the official location is nearby, not parcel-specific

No fuzzy regulatory linkage is used. Contextual facts must keep their scope in
the answer and must not be rewritten as exact parcel facts.

## Human-verification routes

Human-verification priority:

1. A stable official document page, when one exists.
2. An official human search portal plus exact instrument number, SSL, address,
   license/permit number, building ID, or other lookup input and navigation
   steps.
3. A D.C.-authorized public-record portal plus exact lookup inputs.
4. Archived-extract provenance with an explicit warning when the current portal
   cannot reproduce the frozen historical period.

MyTax `Retrieve` URLs are session-bound and must never be persisted as durable
evidence. ArcGIS REST/FeatureServer query URLs, raw downloads, and JSON
interfaces are machine routes and must never be returned as the user-facing
evidence link. A portal that is blocked or unusable without an avoidable
machine/session URL fails the evidence gate.

For MyTax facts, the route includes the exact SSL and address for the public
Real Property Search. For CAMA sale facts, it includes the D.C. Open Data
dataset page, SSL, address, and source record ID. For deed facts, it includes
the official Recorder portal; a reported instrument is prefilled only when it
is already year-prefixed. Bare instrument values are preserved with a warning
and verified by deed year, SSL/address, and party name instead.

Regulatory routes use the official human interface appropriate to the source,
including SCOUT, TOPS MapLookup, DC PropertyQuest, Building Energy Performance
DC, DOB vacant/blighted search, DOEE well permitting, and the relevant ABCA
public license page. They include the exact source record/license/permit number,
address, SSL, square/lot, building identifier, or source-specific search inputs
available for that fact.

The evidence response also reports source-release retrieval/archive metadata.
The live portal may be newer than the frozen release and cannot override the
value and release provenance returned by the connector.
