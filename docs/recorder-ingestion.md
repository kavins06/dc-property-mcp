# D.C. Recorder ingestion

This pipeline collects public Real Property index metadata from the official
D.C. Recorder of Deeds search portal under separately documented written
authorization. It does not bypass authentication or human verification,
download document images, use the portal's paid order flow, or store passwords,
cookies, bearer tokens, signed image URLs, or raw authenticated pages.

Official routes:

- Recorder office: <https://otr.cfo.dc.gov/page/recorder-deeds>
- Official records search: <https://washington.dc.publicsearch.us/>

## One-time authenticated profile

Install the pinned Node dependencies and Playwright browser, set a short
authorization reference, and open the attended login:

```powershell
cd recorder
npm ci
npx playwright install chromium
$env:DC_RECORDER_AUTHORIZATION_REF="DC Recorder written authorization, YYYY-MM-DD"
npm run login
```

The login window writes normal browser session state only to a dedicated local
profile under `%LOCALAPPDATA%\dc-property-mcp\recorder-profile` by default.
The profile is outside the repository. Override it only with
`DC_RECORDER_PROFILE_DIR`; never point it at a daily-use browser profile.

## Collection

The recent portal supports date-sliced search with 50 indexed results per
page. A bounded run enumerates each date, saves one immutable JSONL artifact per
page, and writes a manifest containing every page's row count and SHA-256.

```powershell
npm run collect -- --from=2026-07-01 --to=2026-07-31 --details=secured
```

Defaults and safeguards:

- one day (yesterday) when dates are omitted;
- no more than 31 days unless `--max-days` explicitly raises the cap, with an
  absolute cap of 366;
- at least 750 ms between detail requests, default 1,500 ms;
- `--details=secured` hydrates deed/trust/lien/mortgage/release/assignment and
  related secured-document families;
- `--details=none` collects the complete daily index only;
- `--details=all` is intentionally slower;
- HTTP 403, HTTP 429, and human-verification challenges stop the run;
- document image requests are blocked and no order actions are invoked;
- completed page artifacts are hash-validated and reused after interruption.

For a historical backfill, run oldest-to-newest in monthly windows. Start with
`--details=none` to establish index coverage, then run targeted detail
hydration. Do not claim full historical coverage until the published collection
run dates cover the intended period and quality counts reconcile.

## Publication

The loader requires the manifest hash as a separate operator-supplied value. It
recomputes the manifest and page hashes, revalidates every record, stages with
bulk `COPY`, and publishes in one transaction under an advisory lock:

```powershell
node --env-file=..\.env.hosted src/load.mjs ..\data\recorder\manifest-2026-07-01-2026-07-31.json --manifest-sha256 <sha256>
```

Publication is idempotent for an identical manifest. It preserves immutable
payload versions, never downgrades a complete detail record to index-only,
replaces child parties/legals/relations atomically, and links only a single-lot
legal row by exact normalized Square/Suffix/Lot. Lot ranges are retained as
`range_unlinked`; they are not silently expanded.

## Field semantics

- `instrument_number`, `document_type`, dates, party roles, legal rows, and
  related instruments are official index fields.
- `indexed_consideration_cents` is consideration as indexed. It is not
  automatically original principal, payoff, or current balance.
- A `GRANTEE` on a TRUST can represent a lender, beneficiary, trustee, or
  nominee depending on the document. The pipeline does not manufacture a
  `lender` field from that role.
- Present lien status and priority require reviewing releases,
  satisfactions, assignments, modifications, subordination agreements, and
  the recorded instruments themselves.
- The MCP response is an indexed instrument history, not a chain-of-title
  opinion, title insurance commitment, or legal conclusion.

## Scheduling

Run the incremental collector once daily for the prior two calendar days. The
one-day overlap captures late portal updates while document-ID upserts and
payload hashes keep publication idempotent. A scheduler must run under the
account that owns the dedicated profile and must alert rather than retry
aggressively on authentication expiry, 403/429, or human verification.
