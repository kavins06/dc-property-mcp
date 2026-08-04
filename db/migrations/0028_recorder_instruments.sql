begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists recorder;

revoke all on schema recorder from public, mcp_runtime;
grant usage on schema recorder to api_owner;

create table recorder.collection_run (
  run_id bigint generated always as identity primary key,
  manifest_sha256 text not null unique check (
    manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  authorization_ref text not null check (
    nullif(btrim(authorization_ref), '') is not null
    and length(authorization_ref) <= 200
  ),
  date_from date not null,
  date_to date not null,
  row_count bigint not null check (row_count >= 0),
  detail_mode text not null check (
    detail_mode in ('none', 'secured', 'all')
  ),
  status text not null default 'loading' check (
    status in ('loading', 'published', 'rejected')
  ),
  manifest jsonb not null check (
    jsonb_typeof(manifest) = 'object'
  ),
  started_at timestamptz not null default now(),
  published_at timestamptz,
  error_summary text,
  check (date_from <= date_to),
  check (
    (status = 'published' and published_at is not null)
    or (status <> 'published' and published_at is null)
  )
);

create table recorder.instrument (
  document_id bigint primary key check (document_id > 0),
  instrument_number text not null unique,
  document_type text not null,
  recorded_date date not null,
  recorded_at_local timestamp without time zone,
  recorded_timezone text not null default 'America/New_York' check (
    recorded_timezone = 'America/New_York'
  ),
  book_type text,
  roll_book text,
  frame_page text,
  indexed_consideration_cents bigint check (
    indexed_consideration_cents is null
    or indexed_consideration_cents >= 0
  ),
  page_count integer check (
    page_count is null or page_count > 0
  ),
  detail_status text not null check (
    detail_status in ('index_only', 'complete', 'failed')
  ),
  detail_error_code text,
  source_url text not null,
  current_payload_sha256 text not null check (
    current_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  first_seen_run_id bigint not null
    references recorder.collection_run(run_id),
  last_seen_run_id bigint not null
    references recorder.collection_run(run_id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (
    source_url =
      'https://washington.dc.publicsearch.us/doc/' || document_id::text
  )
);

create index recorder_instrument_date_idx
  on recorder.instrument (recorded_date desc, document_id desc);

create index recorder_instrument_type_date_idx
  on recorder.instrument (
    upper(document_type),
    recorded_date desc,
    document_id desc
  );

create table recorder.instrument_version (
  version_id bigint generated always as identity primary key,
  document_id bigint not null
    references recorder.instrument(document_id) on delete cascade,
  collection_run_id bigint not null
    references recorder.collection_run(run_id),
  payload_sha256 text not null check (
    payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  normalized_payload jsonb not null check (
    jsonb_typeof(normalized_payload) = 'object'
  ),
  observed_at timestamptz not null default now(),
  unique (document_id, payload_sha256)
);

create index recorder_instrument_version_run_idx
  on recorder.instrument_version (collection_run_id);

create table recorder.instrument_party (
  document_id bigint not null
    references recorder.instrument(document_id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  party_name text not null check (
    nullif(btrim(party_name), '') is not null
  ),
  party_role text not null check (
    party_role in ('GRANTOR', 'GRANTEE', 'OTHER')
  ),
  normalized_party_name text not null,
  primary key (document_id, ordinal)
);

create index recorder_instrument_party_name_idx
  on recorder.instrument_party (normalized_party_name);

create table recorder.instrument_legal (
  document_id bigint not null
    references recorder.instrument(document_id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  square text not null check (nullif(btrim(square), '') is not null),
  low_lot text not null check (nullif(btrim(low_lot), '') is not null),
  high_lot text not null check (nullif(btrim(high_lot), '') is not null),
  normalized_square text not null,
  normalized_low_lot text not null,
  normalized_high_lot text not null,
  primary key (document_id, ordinal)
);

create index recorder_instrument_legal_lookup_idx
  on recorder.instrument_legal (
    normalized_square,
    normalized_low_lot,
    normalized_high_lot
  );

create table recorder.instrument_relation (
  document_id bigint not null
    references recorder.instrument(document_id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  related_instrument_number text not null check (
    nullif(btrim(related_instrument_number), '') is not null
  ),
  relation_type text,
  primary key (document_id, ordinal)
);

create index recorder_instrument_relation_number_idx
  on recorder.instrument_relation (related_instrument_number);

create table recorder.property_link (
  property_link_id bigint generated always as identity primary key,
  document_id bigint not null,
  legal_ordinal integer not null,
  account_id bigint
    references core.property_account_current(account_id),
  link_status text not null check (
    link_status in ('exact', 'ambiguous', 'unlinked', 'range_unlinked')
  ),
  link_method text not null check (
    link_method in ('normalized_square_lot', 'lot_range_not_expanded')
  ),
  linked_at timestamptz not null default now(),
  foreign key (document_id, legal_ordinal)
    references recorder.instrument_legal(document_id, ordinal)
    on delete cascade,
  check (
    (link_status in ('exact', 'ambiguous') and account_id is not null)
    or (
      link_status in ('unlinked', 'range_unlinked')
      and account_id is null
    )
  )
);

create unique index recorder_property_link_identity_uidx
  on recorder.property_link (
    document_id,
    legal_ordinal,
    coalesce(account_id, 0::bigint),
    link_status
  );

create index recorder_property_link_account_idx
  on recorder.property_link (
    account_id,
    document_id
  )
  where account_id is not null;

create or replace function api_v1.get_recorder_instrument_history(
  p_ssl text default null,
  p_address text default null,
  p_options jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_resolution record;
  v_options jsonb := coalesce(p_options, '{}'::jsonb);
  v_unknown text[];
  v_limit integer := 20;
  v_cursor_date date;
  v_cursor_document_id bigint;
  v_payload jsonb;
begin
  select *
  into v_resolution
  from api_v1._resolve_account(p_ssl, p_address);

  if v_resolution.resolution_status <> 'resolved' then
    return jsonb_build_object(
      'status', v_resolution.resolution_status,
      'next_tool', 'resolve_property'
    );
  end if;

  select array_agg(key order by key)
  into v_unknown
  from jsonb_object_keys(v_options) key
  where key not in ('limit', 'cursor', 'document_types');

  if v_unknown is not null then
    raise exception 'Unsupported Recorder options: %', v_unknown
      using errcode = '22023';
  end if;

  if v_options ? 'limit' then
    v_limit := (v_options->>'limit')::integer;
  end if;
  if v_limit < 1 or v_limit > 50 then
    raise exception 'Recorder limit must be between 1 and 50'
      using errcode = '22023';
  end if;

  if v_options ? 'cursor' then
    if (v_options->>'cursor')
      !~ '^\d{4}-\d{2}-\d{2}:[0-9]+$' then
      raise exception 'Invalid Recorder cursor'
        using errcode = '22023';
    end if;
    v_cursor_date := split_part(v_options->>'cursor', ':', 1)::date;
    v_cursor_document_id :=
      split_part(v_options->>'cursor', ':', 2)::bigint;
  end if;

  with all_matched as materialized (
    select
      i.*,
      l.link_status,
      l.link_method
    from recorder.property_link l
    join recorder.instrument i
      on i.document_id = l.document_id
    where l.account_id = v_resolution.resolved_account_id
      and (
        not (v_options ? 'document_types')
        or upper(i.document_type) in (
          select upper(value)
          from jsonb_array_elements_text(
            v_options->'document_types'
          ) value
        )
      )
  ),
  matched as materialized (
    select *
    from all_matched i
    where v_cursor_date is null
      or (i.recorded_date, i.document_id)
        < (v_cursor_date, v_cursor_document_id)
  ),
  page as materialized (
    select *
    from matched
    order by recorded_date desc, document_id desc
    limit v_limit + 1
  ),
  visible as materialized (
    select *
    from page
    order by recorded_date desc, document_id desc
    limit v_limit
  )
  select jsonb_build_object(
    'status', 'resolved',
    'record_scope',
      'Official D.C. Recorder of Deeds indexed instruments linked by exact normalized Square/Lot where available.',
    'total_count', (select count(*) from all_matched),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'document_id', i.document_id,
          'instrument_number', i.instrument_number,
          'document_type', i.document_type,
          'recorded_date', i.recorded_date,
          'recorded_at_local', i.recorded_at_local,
          'recorded_timezone', i.recorded_timezone,
          'book_type', i.book_type,
          'roll_book', i.roll_book,
          'frame_page', i.frame_page,
          'indexed_consideration_cents',
            i.indexed_consideration_cents,
          'page_count', i.page_count,
          'detail_status', i.detail_status,
          'parties', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'name', p.party_name,
                'role', lower(p.party_role)
              )
              order by p.ordinal
            )
            from recorder.instrument_party p
            where p.document_id = i.document_id
          ), '[]'::jsonb),
          'legals', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'square', g.square,
                'low_lot', g.low_lot,
                'high_lot', g.high_lot
              )
              order by g.ordinal
            )
            from recorder.instrument_legal g
            where g.document_id = i.document_id
          ), '[]'::jsonb),
          'related_instruments', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'instrument_number',
                  r.related_instrument_number,
                'relation_type', r.relation_type
              )
              order by r.ordinal
            )
            from recorder.instrument_relation r
            where r.document_id = i.document_id
          ), '[]'::jsonb),
          'property_link', jsonb_build_object(
            'status', i.link_status,
            'method', i.link_method
          ),
          'source', jsonb_build_object(
            'publisher',
              'District of Columbia Office of Tax and Revenue, Recorder of Deeds',
            'url', i.source_url,
            'last_observed_at', i.last_seen_at
          )
        )
        order by i.recorded_date desc, i.document_id desc
      )
      from visible i
    ), '[]'::jsonb),
    'has_more', (select count(*) > v_limit from page),
    'next_cursor', case
      when (select count(*) > v_limit from page) then (
        select i.recorded_date::text || ':' || i.document_id::text
        from visible i
        order by i.recorded_date, i.document_id
        limit 1
      )
    end,
    'collection_coverage', (
      select jsonb_build_object(
        'date_from', min(date_from),
        'date_to', max(date_to),
        'published_runs',
          count(*) filter (where status = 'published')
      )
      from recorder.collection_run
      where status = 'published'
    ),
    'limitations', jsonb_build_array(
      'This is an indexed instrument history, not a title opinion, title insurance commitment, or guarantee of lien priority.',
      'Indexed consideration is preserved as reported and is not automatically labeled as original principal or current loan balance.',
      'A TRUST grantee can be a trustee, beneficiary, nominee, or lender depending on the instrument; party role alone does not justify a lender inference.',
      'Releases, satisfactions, assignments, modifications, and related instruments must be reviewed together to assess present status.',
      'Lot ranges are retained but are not automatically expanded into property links.'
    )
  )
  into v_payload;

  return v_payload;
end;
$function$;

revoke all on all tables in schema recorder
  from public, mcp_runtime;
revoke all on all sequences in schema recorder
  from public, mcp_runtime;
grant select on all tables in schema recorder to api_owner;

alter default privileges in schema recorder
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema recorder
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema recorder
  grant select on tables to api_owner;

revoke all on function api_v1.get_recorder_instrument_history(
  text,
  text,
  jsonb
) from public;
grant execute on function api_v1.get_recorder_instrument_history(
  text,
  text,
  jsonb
) to mcp_runtime;

alter function api_v1.get_recorder_instrument_history(
  text,
  text,
  jsonb
) owner to api_owner;

comment on schema recorder is
  'Normalized D.C. Recorder index observations collected under documented authorization; no authentication state or purchased document images are stored.';
comment on column recorder.instrument.indexed_consideration_cents is
  'Recorder index consideration exactly as reported. It is not automatically a loan amount, original principal, payoff, or current balance.';
comment on function api_v1.get_recorder_instrument_history(
  text,
  text,
  jsonb
) is
  'Returns bounded, source-linked Recorder instrument history for one resolved property without inferring title, lien priority, lender identity, or current debt.';

commit;
