import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

import { adminDatabaseConfig } from "../../scripts/lib/hosted-db.mjs";
import {
  sha256,
  validateInstrument,
  validateManifest,
} from "./contract.mjs";

const args = process.argv.slice(2);
const manifestArgument = args[0];
const hashIndex = args.indexOf("--manifest-sha256");
const expectedManifestHash =
  hashIndex >= 0 ? args[hashIndex + 1]?.toLowerCase() : null;
if (
  !manifestArgument ||
  hashIndex < 0 ||
  hashIndex + 2 !== args.length ||
  !/^[0-9a-f]{64}$/.test(expectedManifestHash ?? "")
) {
  throw new Error(
    "Usage: node src/load.mjs <manifest.json> --manifest-sha256 <sha256>",
  );
}

const manifestPath = resolve(manifestArgument);
const artifactRoot = resolve(manifestPath, "..");
const manifestContents = await readFile(manifestPath, "utf8");
const observedManifestHash = sha256(manifestContents);
if (observedManifestHash !== expectedManifestHash) {
  throw new Error("Recorder manifest SHA-256 does not match.");
}
const manifest = validateManifest(JSON.parse(manifestContents));

async function safeArtifactPath(page) {
  const path = resolve(artifactRoot, page.path);
  const candidate = relative(artifactRoot, path);
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) {
    throw new Error(`Recorder page path escapes the artifact root: ${page.path}`);
  }
  const canonicalRoot = await realpath(artifactRoot);
  const canonicalPath = await realpath(path);
  const canonicalCandidate = relative(canonicalRoot, canonicalPath);
  if (
    !canonicalCandidate ||
    canonicalCandidate.startsWith("..") ||
    isAbsolute(canonicalCandidate)
  ) {
    throw new Error(`Recorder page symlink escapes the artifact root: ${page.path}`);
  }
  const contents = await readFile(canonicalPath, "utf8");
  if (sha256(contents) !== page.sha256) {
    throw new Error(`Recorder page SHA-256 drifted: ${page.path}`);
  }
  const records = contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => validateInstrument(JSON.parse(line)));
  if (records.length !== page.rows) {
    throw new Error(`Recorder page row count drifted: ${page.path}`);
  }
  return canonicalPath;
}

const pagePaths = [];
for (const page of manifest.pages) {
  pagePaths.push(await safeArtifactPath(page));
}

class JsonlToCsvColumn extends Transform {
  constructor() {
    super();
    this.buffer = "";
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line) this.push(`"${line.replaceAll('"', '""')}"\n`);
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer) {
      this.push(`"${this.buffer.replaceAll('"', '""')}"\n`);
    }
    callback();
  }
}

const client = new pg.Client({
  ...adminDatabaseConfig(process.env),
  statement_timeout: 0,
  application_name: "dc-property-recorder-loader",
});
let runId = null;
let inTransaction = false;
let advisoryLocked = false;

await client.connect();
try {
  await client.query(
    "select pg_advisory_lock(hashtext('dc-property-recorder-load-v1'))",
  );
  advisoryLocked = true;
  const existing = await client.query(
    `
      select run_id, status
      from recorder.collection_run
      where manifest_sha256 = $1
    `,
    [observedManifestHash],
  );
  if (existing.rows[0]?.status === "published") {
    process.stdout.write(
      `Recorder manifest is already published as run ${existing.rows[0].run_id}.\n`,
    );
    process.exitCode = 0;
  } else {
    const run = await client.query(
      `
        insert into recorder.collection_run (
          manifest_sha256,
          authorization_ref,
          date_from,
          date_to,
          row_count,
          detail_mode,
          status,
          manifest,
          error_summary
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'loading',
          $7::jsonb,
          null
        )
        on conflict (manifest_sha256) do update
        set
          status = 'loading',
          error_summary = null,
          started_at = now()
        where recorder.collection_run.status = 'rejected'
        returning run_id
      `,
      [
        observedManifestHash,
        manifest.authorization_ref,
        manifest.date_from,
        manifest.date_to,
        manifest.row_count,
        manifest.collection_policy.detail_mode,
        JSON.stringify(manifest),
      ],
    );
    if (run.rows.length !== 1) {
      throw new Error("Recorder run is already loading in another process.");
    }
    runId = run.rows[0].run_id;

    await client.query(`
      create temporary table stage_recorder_payload (
        payload jsonb not null
      ) on commit preserve rows
    `);
    for (const path of pagePaths) {
      const copy = client.query(
        copyFrom(
          "copy stage_recorder_payload (payload) from stdin with (format csv)",
        ),
      );
      await pipeline(
        createReadStream(path),
        new JsonlToCsvColumn(),
        copy,
      );
    }

    await client.query("begin");
    inTransaction = true;
    const staged = await client.query(`
      select
        count(*)::bigint rows,
        count(distinct payload->>'document_id')::bigint documents,
        count(distinct payload->>'instrument_number')::bigint instruments,
        count(*) filter (
          where payload->>'source_url' <>
            'https://washington.dc.publicsearch.us/doc/' ||
              payload->>'document_id'
        )::bigint invalid_urls
      from stage_recorder_payload
    `);
    const counts = staged.rows[0];
    if (
      Number(counts.rows) !== manifest.row_count ||
      Number(counts.documents) !== manifest.row_count ||
      Number(counts.instruments) !== manifest.row_count ||
      Number(counts.invalid_urls) !== 0
    ) {
      throw new Error(
        `Recorder staging gate failed: ${JSON.stringify(counts)}`,
      );
    }

    await client.query(`
      create temporary table stage_recorder_effective
      on commit drop
      as
      select
        s.payload,
        (
          i.document_id is null
          or i.detail_status <> 'complete'
          or s.payload->>'detail_status' = 'complete'
        ) replace_detail
      from stage_recorder_payload s
      left join recorder.instrument i
        on i.document_id = (s.payload->>'document_id')::bigint
    `);

    await client.query(
      `
        insert into recorder.instrument (
          document_id,
          instrument_number,
          document_type,
          recorded_date,
          recorded_at_local,
          recorded_timezone,
          book_type,
          roll_book,
          frame_page,
          indexed_consideration_cents,
          page_count,
          detail_status,
          detail_error_code,
          source_url,
          current_payload_sha256,
          first_seen_run_id,
          last_seen_run_id
        )
        select
          (payload->>'document_id')::bigint,
          payload->>'instrument_number',
          payload->>'document_type',
          (payload->>'recorded_date')::date,
          nullif(payload->>'recorded_at_local', '')::timestamp,
          payload->>'recorded_timezone',
          payload->>'book_type',
          payload->>'roll_book',
          payload->>'frame_page',
          nullif(payload->>'consideration_cents', '')::bigint,
          nullif(payload->>'page_count', '')::integer,
          payload->>'detail_status',
          payload->>'detail_error_code',
          payload->>'source_url',
          encode(extensions.digest(payload::text, 'sha256'), 'hex'),
          $1,
          $1
        from stage_recorder_effective
        on conflict (document_id) do update
        set
          instrument_number = excluded.instrument_number,
          document_type = excluded.document_type,
          recorded_date = excluded.recorded_date,
          recorded_at_local = case
            when recorder.instrument.detail_status <> 'complete'
              or excluded.detail_status = 'complete'
              then excluded.recorded_at_local
            else recorder.instrument.recorded_at_local
          end,
          book_type = coalesce(
            excluded.book_type,
            recorder.instrument.book_type
          ),
          roll_book = coalesce(
            excluded.roll_book,
            recorder.instrument.roll_book
          ),
          frame_page = coalesce(
            excluded.frame_page,
            recorder.instrument.frame_page
          ),
          indexed_consideration_cents = case
            when recorder.instrument.detail_status <> 'complete'
              or excluded.detail_status = 'complete'
              then excluded.indexed_consideration_cents
            else recorder.instrument.indexed_consideration_cents
          end,
          page_count = case
            when recorder.instrument.detail_status <> 'complete'
              or excluded.detail_status = 'complete'
              then excluded.page_count
            else recorder.instrument.page_count
          end,
          detail_status = case
            when recorder.instrument.detail_status = 'complete'
              and excluded.detail_status <> 'complete'
              then recorder.instrument.detail_status
            else excluded.detail_status
          end,
          detail_error_code = case
            when recorder.instrument.detail_status = 'complete'
              and excluded.detail_status <> 'complete'
              then recorder.instrument.detail_error_code
            else excluded.detail_error_code
          end,
          source_url = excluded.source_url,
          current_payload_sha256 = case
            when recorder.instrument.detail_status <> 'complete'
              or excluded.detail_status = 'complete'
              then excluded.current_payload_sha256
            else recorder.instrument.current_payload_sha256
          end,
          last_seen_run_id = excluded.last_seen_run_id,
          last_seen_at = now()
      `,
      [runId],
    );

    await client.query(
      `
        insert into recorder.instrument_version (
          document_id,
          collection_run_id,
          payload_sha256,
          normalized_payload
        )
        select
          (payload->>'document_id')::bigint,
          $1,
          encode(extensions.digest(payload::text, 'sha256'), 'hex'),
          payload
        from stage_recorder_effective
        on conflict (document_id, payload_sha256) do nothing
      `,
      [runId],
    );

    await client.query(`
      delete from recorder.instrument_party p
      using stage_recorder_effective s
      where s.replace_detail
        and p.document_id = (s.payload->>'document_id')::bigint;

      insert into recorder.instrument_party (
        document_id,
        ordinal,
        party_name,
        party_role,
        normalized_party_name
      )
      select
        (s.payload->>'document_id')::bigint,
        p.ordinality::integer,
        p.value->>'name',
        upper(p.value->>'role'),
        upper(regexp_replace(
          p.value->>'name',
          '[^A-Za-z0-9]+',
          '',
          'g'
        ))
      from stage_recorder_effective s
      cross join lateral jsonb_array_elements(
        s.payload->'parties'
      ) with ordinality p(value, ordinality)
      where s.replace_detail;

      delete from recorder.instrument_relation r
      using stage_recorder_effective s
      where s.replace_detail
        and r.document_id = (s.payload->>'document_id')::bigint;

      insert into recorder.instrument_relation (
        document_id,
        ordinal,
        related_instrument_number,
        relation_type
      )
      select
        (s.payload->>'document_id')::bigint,
        r.ordinality::integer,
        r.value->>'instrument_number',
        r.value->>'relation_type'
      from stage_recorder_effective s
      cross join lateral jsonb_array_elements(
        s.payload->'related_instruments'
      ) with ordinality r(value, ordinality)
      where s.replace_detail;

      delete from recorder.instrument_legal g
      using stage_recorder_effective s
      where s.replace_detail
        and g.document_id = (s.payload->>'document_id')::bigint;

      insert into recorder.instrument_legal (
        document_id,
        ordinal,
        square,
        low_lot,
        high_lot,
        normalized_square,
        normalized_low_lot,
        normalized_high_lot
      )
      select
        (s.payload->>'document_id')::bigint,
        g.ordinality::integer,
        g.value->>'square',
        g.value->>'low_lot',
        coalesce(
          g.value->>'high_lot',
          g.value->>'low_lot'
        ),
        upper(regexp_replace(
          g.value->>'square',
          '[^A-Za-z0-9]+',
          '',
          'g'
        )),
        upper(regexp_replace(
          g.value->>'low_lot',
          '[^A-Za-z0-9]+',
          '',
          'g'
        )),
        upper(regexp_replace(
          coalesce(
            g.value->>'high_lot',
            g.value->>'low_lot'
          ),
          '[^A-Za-z0-9]+',
          '',
          'g'
        ))
      from stage_recorder_effective s
      cross join lateral jsonb_array_elements(
        s.payload->'legals'
      ) with ordinality g(value, ordinality)
      where s.replace_detail;
    `);

    await client.query(`
      delete from recorder.property_link l
      using stage_recorder_effective s
      where s.replace_detail
        and l.document_id = (s.payload->>'document_id')::bigint;

      with candidate as materialized (
        select
          g.document_id,
          g.ordinal legal_ordinal,
          a.account_id,
          count(*) over (
            partition by g.document_id, g.ordinal
          ) candidate_count
        from recorder.instrument_legal g
        join stage_recorder_effective s
          on s.replace_detail
          and (s.payload->>'document_id')::bigint = g.document_id
        join core.property_account_current a
          on upper(regexp_replace(
            coalesce(a.square, '') ||
              coalesce(a.suffix, '') ||
              coalesce(a.lot, ''),
            '[^A-Za-z0-9]+',
            '',
            'g'
          )) = g.normalized_square || g.normalized_low_lot
        where g.normalized_low_lot = g.normalized_high_lot
      )
      insert into recorder.property_link (
        document_id,
        legal_ordinal,
        account_id,
        link_status,
        link_method
      )
      select
        document_id,
        legal_ordinal,
        account_id,
        case
          when candidate_count = 1 then 'exact'
          else 'ambiguous'
        end,
        'normalized_square_lot'
      from candidate;

      insert into recorder.property_link (
        document_id,
        legal_ordinal,
        account_id,
        link_status,
        link_method
      )
      select
        g.document_id,
        g.ordinal,
        null,
        case
          when g.normalized_low_lot <> g.normalized_high_lot
            then 'range_unlinked'
          else 'unlinked'
        end,
        case
          when g.normalized_low_lot <> g.normalized_high_lot
            then 'lot_range_not_expanded'
          else 'normalized_square_lot'
        end
      from recorder.instrument_legal g
      join stage_recorder_effective s
        on s.replace_detail
        and (s.payload->>'document_id')::bigint = g.document_id
      where not exists (
        select 1
        from recorder.property_link l
        where l.document_id = g.document_id
          and l.legal_ordinal = g.ordinal
      );
    `);

    const gate = await client.query(
      `
        select
          count(*) filter (
            where i.last_seen_run_id = $1
          )::bigint observed_instruments,
          count(*) filter (
            where i.last_seen_run_id = $1
              and not exists (
                select 1
                from recorder.instrument_version v
                where v.document_id = i.document_id
                  and v.collection_run_id = $1
              )
          )::bigint missing_versions,
          count(*) filter (
            where i.last_seen_run_id = $1
              and i.source_url <>
                'https://washington.dc.publicsearch.us/doc/' ||
                  i.document_id::text
          )::bigint invalid_urls
        from recorder.instrument i
      `,
      [runId],
    );
    if (
      Number(gate.rows[0].observed_instruments) !== manifest.row_count ||
      Number(gate.rows[0].missing_versions) !== 0 ||
      Number(gate.rows[0].invalid_urls) !== 0
    ) {
      throw new Error(
        `Recorder publication gate failed: ${JSON.stringify(gate.rows[0])}`,
      );
    }

    await client.query(
      `
        update recorder.collection_run
        set
          status = 'published',
          published_at = now()
        where run_id = $1
      `,
      [runId],
    );
    await client.query("commit");
    inTransaction = false;
    process.stdout.write(
      `Published Recorder run ${runId}: ${manifest.row_count} instruments.\n`,
    );
    for (const table of [
      "recorder.instrument",
      "recorder.instrument_party",
      "recorder.instrument_legal",
      "recorder.instrument_relation",
      "recorder.property_link",
    ]) {
      await client.query(`analyze ${table}`).catch(() => undefined);
    }
  }
} catch (error) {
  if (inTransaction) {
    await client.query("rollback").catch(() => undefined);
    inTransaction = false;
  }
  if (runId !== null) {
    await client
      .query(
        `
          update recorder.collection_run
          set
            status = 'rejected',
            error_summary = $2
          where run_id = $1
            and status <> 'published'
        `,
        [runId, String(error.message).slice(0, 2000)],
      )
      .catch(() => undefined);
  }
  throw error;
} finally {
  if (advisoryLocked) {
    await client
      .query(
        "select pg_advisory_unlock(hashtext('dc-property-recorder-load-v1'))",
      )
      .catch(() => undefined);
  }
  await client.end().catch(() => undefined);
}
