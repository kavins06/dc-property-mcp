# Source-linked, human-verifiable API plan

Status: proposed for review; implementation is not approved by this document.

## 1. Objective

Every property fact returned by the MCP today, and by a future public API using
the same contract, must carry:

1. machine-readable provenance that tells a developer where the value came
   from; and
2. a display-ready official source that lets the developer's end user visually
   verify the value with the shortest reliable path available.

The product term is **source-linked, human-verifiable property data API**. The
technical capability is **field-level provenance** in a
**provenance-enriched API**.

## 2. Confirmed product contract

- Existing fact values and their `source_refs` remain authoritative.
- Facts keep their field-level `source_refs`; clients treat those references as
  opaque identifiers.
- Normal property-data responses include deduplicated `provenance` and
  `sources` arrays by default. A separate evidence request is not required for
  ordinary display.
- `provenance` is for developers and audit systems. It may include publisher,
  dataset/release, source record identity, retrieval/archive dates, hashes, and
  property-link scope.
- `sources` is safe to render as a visible **Source** or **Verify** action. It
  contains a human-facing official link, exact lookup inputs, relationship to
  the property, the facts covered, access constraints, and a fallback when one
  is useful.
- A source link goes directly to the exact official record only when that URL
  survives a fresh browser session. Otherwise it opens the nearest stable
  official human interface and supplies the exact inputs needed to find the
  record.
- Machine interfaces such as ArcGIS REST, FeatureServer queries, raw JSON,
  schema names, and session-bound URLs never appear in `sources`.
- Login, cookie, CAPTCHA, or verification friction is disclosed and minimized,
  but never bypassed. If the agency requires it, the source remains usable with
  an honest access note and fallback where available.
- Historical facts remain pinned to the archived release. A live portal may be
  newer, so the response must not claim that the current portal reproduces an
  older snapshot exactly.
- Contextual linkage (`shared_building`, `multi_parcel`, or
  `proximity_context`) remains visibly distinct from `exact_property`.
- Downstream integration guidance requires applications to show a visible
  Source/Verify action when they display a sourced fact. Legal or commercial
  enforcement belongs in future API terms, not in this implementation.

### Additive response shape

The existing result shape is preserved. Two top-level arrays are added only
when the response contains valid source references:

```json
{
  "status": "resolved",
  "existing_result_fields": "unchanged",
  "provenance": [
    {
      "source_ref": "opaque-reference",
      "publisher": "official publisher",
      "dataset": "official dataset or release",
      "source_record_id": "official record identity",
      "property_link_scope": "exact_property"
    }
  ],
  "sources": [
    {
      "title": "Verify this record on the official portal",
      "link": "https://official-human-interface.example/",
      "fallback": { "link": "https://official-fallback.example/" },
      "lookup": { "ssl": "0000-0000" },
      "relationship": "Exact D.C. property account",
      "covers": ["Current assessment"],
      "access": "Public search; first-party cookies are required.",
      "source_refs": ["opaque-reference"]
    }
  ]
}
```

`sources` is grouped by verification destination and lookup target so one
portal link can cover many facts without duplicating instructions. The exact
field names may be aligned with the existing evidence JSON during Task 1, but
the separation between developer provenance and display-ready sources is not
optional.

## 3. Existing system to reuse

The database already provides the hard parts:

- every served scalar carries one or more validated `source_refs`;
- `api_v1.get_source_evidence(text[])` validates those references and returns
  release-pinned evidence;
- the evidence already contains `human_verification` routes and lookup inputs
  for MyTax, CAMA/Open Data, Recorder, SCOUT, TOPS, PropertyQuest, BEAM,
  DOEE well permitting, DOB vacant/blighted records, and ABCA;
- migrations 0028 and 0029 prove the grouped human-source model for tax and
  assessment records; and
- every MCP tool already routes database calls through `worker/src/db.ts`.

The minimal design is therefore:

1. generalize `get_source_evidence` so all existing portal families produce
   the same compact `sources` contract;
2. in the Worker's shared database-call path, recursively collect and
   deduplicate returned `source_refs`, expand them once, and append
   `provenance` plus `sources` to the original result; and
3. keep `get_source_evidence` as the explicit deep-audit tool while preventing
   it from enriching itself recursively.

This avoids edits to every property SQL function and gives the current MCP and
a future REST API one reusable database contract.

## 4. Scope

### Included

- All facts currently served by the 15 MCP tools.
- The ten human-verification route families already represented in evidence:
  MyTax, CAMA/Open Data, Recorder, SCOUT, TOPS, PropertyQuest, BEAM, DOEE well
  permitting, DOB vacant/blighted search, and ABCA.
- Default enrichment of detail, complete-record, paginated history, bounded
  search, and bounded batch responses when they contain source references.
- Deduplication, response-size protection, cold-session route checks, contract
  tests, documentation, deployment, and post-deployment verification.

### Excluded

- Rebuilding, reloading, or changing the hosted source database.
- Finding or storing millions of record-specific URLs.
- A new provenance ontology, RDF/PROV-O layer, graph database, source-link
  microservice, UI, browser proxy, scraper, or portal-login automation.
- New dependencies or tables unless Task 1 proves the existing evidence cannot
  express one required field.
- Building public REST authentication, API keys, billing, quotas, or a developer
  portal. A future REST surface reuses this response contract as a separate
  project.
- Guaranteeing third-party portal uptime or exact reproduction of archived
  values by a live portal.

## 5. Project structure and conventions

Relevant files only:

```text
db/migrations/0029_mytax_cookie_bootstrap.sql  current evidence wrapper
db/migrations/0030_*.sql                       planned generalized sources
db/contracts/                                  migration contract checks
worker/src/db.ts                               shared database-call boundary
worker/src/server.ts                           MCP descriptions/version/size cap
worker/test/                                   Vitest contract checks
docs/provenance-contract.md                    durable provenance rules
docs/source-linked-api-plan.md                 this approved plan
```

Follow the repository's existing conventions: append-only numbered SQL
migrations, security-definer functions with explicit grants, JSONB contracts,
allowlisted database functions, TypeScript strict checks, Vitest, and the
existing migration validation/apply scripts. No in-place edits to an applied
migration.

## 6. Implementation plan

### Phase A — freeze the contract with representative evidence

Select one valid reference for every portal family plus representative current,
historical, exact-property, and contextual facts. Record the current evidence
shape and expected human route for each. Confirm that every required lookup
value already exists before changing schema.

Gate: approve the final compact `provenance` and `sources` examples. If existing
metadata covers all families, no schema or dependency is added.

### Phase B — generalize human-facing sources in one database function

Add migration 0030 that wraps the existing validated evidence function, reuses
each item's `human_verification` data, and emits grouped `sources` for every
portal family. Preserve evidence order, source-reference validation, exact vs.
contextual scope, release metadata, and the working MyTax cookie-bootstrap
route. Add one SQL contract covering all distinct route families.

Gate: migration validation passes and no `sources[*].link` is a machine,
session-bound, or non-human interface.

### Phase C — enrich all normal MCP results at the shared boundary

Update the shared Worker database-call path to:

1. leave errors and responses without source references unchanged;
2. recursively collect unique `source_refs` from a successful result;
3. call `get_source_evidence` once using the same database session;
4. append compact `provenance` and `sources`; and
5. skip automatic enrichment when the requested function is
   `get_source_evidence`.

Keep the current 50-reference evidence limit by processing bounded chunks only
when a normal response contains more than 50 unique references. Merge and
deduplicate chunk results in original reference order. The existing 768 KiB
response ceiling remains the final guard; enrichment must never silently drop
sources.

Gate: all normal sourced responses include both arrays by default, existing
fact payloads are unchanged, and oversized responses return the existing
explicit `response_too_large` error.

### Phase D — verify each route, document, and deploy

For each distinct route family, test the primary and fallback in a fresh browser
session. Verify that the destination is human-readable, the lookup inputs match
the returned record, avoidable login is absent, access friction is disclosed,
and historical/current limitations are honest. Route testing is per family,
not per database row.

Update the provenance contract and MCP instructions so integrators know:

- render `sources`, not machine provenance, to end users;
- show a visible Source/Verify action with the related fact;
- keep exact/contextual relationship labels; and
- do not imply that a live portal is the frozen historical source file.

Then apply the migration, deploy one Worker version, run live MCP contract
checks, and retain the normal database and Worker rollback paths.

## 7. Executable tasks

Each task is one focused session and touches at most five production files.

### Task 1 — evidence matrix and final JSON fixture

Files: this plan and one contract fixture/test file.

Acceptance:

- one valid example exists for every route family;
- exact/current, exact/historical, and contextual cases are represented;
- required source fields and grouping rules are unambiguous; and
- no new schema is proposed unless a concrete missing field is demonstrated.

Verify: run the fixture/contract check against the hosted database read-only.

### Task 2 — generalized database source projection

Files: migration 0030 and its SQL/Node contract test; provenance documentation
only if wording changes.

Acceptance:

- every valid evidence item maps to developer provenance and at least one
  display-ready source, or an explicit `unavailable_reason`;
- grouping does not lose the source-reference-to-fact mapping;
- MyTax tax/assessment behavior remains unchanged;
- validation still rejects malformed, stale, mismatched, or edited refs; and
- output contains no raw machine or session-bound human links.

Verify:

```powershell
node --env-file=.env.hosted scripts/validate-migrations.mjs db/migrations/0030_*.sql --test <0030-contract-test>
```

### Task 3 — shared default enrichment

Files: `worker/src/db.ts`, one focused Worker test, and `worker/src/server.ts`
only if descriptions/version change.

Acceptance:

- all normal sourced MCP results append `provenance` and `sources`;
- errors, identity-only responses, and `describe_data` remain unchanged when no
  source reference exists;
- `get_source_evidence` does not recurse;
- more than 50 unique refs are handled in bounded chunks;
- enrichment failure returns an explicit safe error, never data without the
  promised default sources; and
- response-size behavior remains explicit and unchanged.

Verify:

```powershell
Set-Location worker
npm run check
npm test
npm run bundle
npm audit --audit-level=moderate
```

### Task 4 — cold-session route verification

Files: one route contract/test file; migration 0030 only for proven corrections.

Acceptance:

- primary and fallback links for all route families open from a fresh session;
- exact deep links are retained only when durable;
- lookup inputs identify the intended official record;
- cookie/login/CAPTCHA requirements are accurately stated; and
- no machine interface is presented to a human.

Verify: run the route contract plus manual in-app-browser checks for all distinct
families. Record only failures and required corrections, not screenshots or a
new testing framework.

### Task 5 — release and live contract verification

Files: existing deployment checklist and release metadata only if required by
the repository's release process.

Acceptance:

- migration 0030 is applied once and its contract passes on the hosted database;
- the Worker deploy succeeds with a new version;
- representative detail, complete-record, paginated, search, batch, and direct
  evidence calls pass live;
- API consumers receive both machine provenance and display-ready sources; and
- rollback commands and the prior Worker version are recorded.

Verify:

```powershell
node --env-file=.env.hosted scripts/apply-migration.mjs db/migrations/0030_*.sql
Set-Location worker
npm run deploy
```

Run the existing hosted database, Cloudflare, MCP, and browser smoke checks
after deployment.

## 8. Success criteria

The work is complete only when:

- every sourced fact returned by a normal MCP data tool has a matching
  machine-readable provenance entry and display-ready human source by default;
- every source maps back to the facts it covers without exposing implementation
  details to end users;
- all ten route families pass fresh-session human-interface checks;
- exact, contextual, current, and archived meanings remain truthful;
- existing auth, read-only permissions, pagination, response-size limits, and
  fact values are unchanged;
- no new dependency, service, table, or per-record URL population was needed;
  and
- integration documentation tells downstream applications to place a visible
  Source/Verify action next to the sourced data.

## 9. Approval gate

Approval of this document authorizes Tasks 1–5 in order. Any discovered need
for a new table, dependency, service, portal automation, or separate REST API
returns to review before implementation.
