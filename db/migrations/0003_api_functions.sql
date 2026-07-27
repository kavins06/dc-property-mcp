begin;
set local role api_owner;

create or replace function api_v1._source_ref(
  p_source_id text,
  p_source_row_number integer,
  p_field_key text,
  p_ssl text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select concat_ws(
    '|',
    replace(coalesce(p_source_id, ''), '|', ''),
    coalesce(p_source_row_number::text, ''),
    replace(coalesce(p_field_key, ''), '|', ''),
    replace(coalesce(p_ssl, ''), '|', '')
  );
$$;

create or replace function api_v1._fact(
  p_value anyelement,
  p_field_key text,
  p_record_date date,
  p_source_ref text
) returns jsonb
language sql
stable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'value', to_jsonb(p_value),
    'field_key', p_field_key,
    'title', f.title,
    'unit', f.unit,
    'record_date', p_record_date,
    'status', case when p_value is null then 'not_reported' else 'reported' end,
    'source_refs', jsonb_build_array(p_source_ref),
    'quality_flags', '[]'::jsonb
  )
  from (select 1) seed
  left join semantic.field_definition f on f.field_key = p_field_key;
$$;

create or replace function api_v1._resolve_account(
  p_ssl text,
  p_address text
) returns table (resolution_status text, resolved_account_id bigint)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with normalized as (
    select
      nullif(
        upper(replace(replace(replace(trim(p_ssl), '-', ''), ' ', ''), E'\t', '')),
        ''
      ) as ssl,
      nullif(
        upper(regexp_replace(
          regexp_replace(trim(p_address), '[^A-Za-z0-9 ]+', ' ', 'g'),
          '\s+', ' ', 'g'
        )),
        ''
      ) as address
  ),
  matches as (
    select a.account_id
    from core.property_account_current a
    cross join normalized n
    where not a.is_deleted
      and (
        (n.ssl is not null and a.ssl_normalized = n.ssl)
        or
        (n.ssl is null and n.address is not null and a.address_normalized = n.address)
      )
  )
  select
    case count(*) when 0 then 'not_found' when 1 then 'resolved' else 'ambiguous' end,
    case when count(*) = 1 then min(account_id) end
  from matches;
$$;

create or replace function api_v1._tax_value(
  p_account_id bigint,
  p_values integer[],
  p_value_index integer
) returns bigint
language sql
stable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    (
      select o.value_cents
      from history.tax_value_overflow o
      where o.account_id = p_account_id
        and o.value_index = p_value_index
    ),
    p_values[p_value_index]::bigint
  );
$$;

create or replace function api_v1.resolve_property(
  p_ssl text default null,
  p_address text default null,
  p_include_deleted boolean default false,
  p_limit integer default 10
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'status',
    case
      when count(*) = 0 then 'not_found'
      when count(*) = 1 then 'resolved'
      else 'ambiguous'
    end,
    'candidates',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'account_id', q.account_id,
          'ssl', q.ssl_display,
          'address', q.premise_address,
          'unit', q.unit_number,
          'record_extract_at', q.record_extract_at
        )
        order by q.rank_score desc, q.account_id
      ),
      '[]'::jsonb
    )
  )
  from (
    select a.*, case
      when p_ssl is not null and a.ssl_normalized =
        upper(replace(replace(replace(trim(p_ssl), '-', ''), ' ', ''), E'\t', ''))
        then 1.0
      when p_address is not null and a.address_normalized =
        upper(regexp_replace(
          regexp_replace(trim(p_address), '[^A-Za-z0-9 ]+', ' ', 'g'),
          '\s+', ' ', 'g'
        ))
        then 0.95
      else extensions.similarity(
        a.address_normalized,
        upper(regexp_replace(
          regexp_replace(coalesce(trim(p_address), ''), '[^A-Za-z0-9 ]+', ' ', 'g'),
          '\s+', ' ', 'g'
        ))
      )
    end as rank_score
    from core.property_account_current a
    where (p_include_deleted or not a.is_deleted)
      and (
        (
          p_ssl is not null
          and a.ssl_normalized =
            upper(replace(replace(replace(trim(p_ssl), '-', ''), ' ', ''), E'\t', ''))
        )
        or
        (
          p_address is not null
          and a.address_normalized operator(extensions.%)
            upper(regexp_replace(
              regexp_replace(trim(p_address), '[^A-Za-z0-9 ]+', ' ', 'g'),
              '\s+', ' ', 'g'
            ))
        )
      )
    order by rank_score desc, a.account_id
    limit least(greatest(p_limit, 1), 10)
  ) q;
$$;

create or replace function api_v1.get_property_snapshot(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select a.*,
      api_v1._source_ref(a.source_id, a.source_row_number, 'property_account', a.ssl_normalized) ref
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object('status', r.resolution_status, 'next_tool', 'resolve_property')
    else jsonb_build_object(
      'status', 'resolved',
      'entity_warning', 'A D.C. property-tax account is not guaranteed to equal one physical parcel.',
      'identity', jsonb_build_object(
        'account_id', a.account_id,
        'ssl', api_v1._fact(a.ssl_display, 'property.ssl', a.record_extract_at, a.ref),
        'premise_address', api_v1._fact(a.premise_address, 'property.premise_address', a.record_extract_at, a.ref),
        'ward', api_v1._fact(a.ward, 'property.ward', a.record_extract_at, a.ref)
      ),
      'classification', jsonb_build_object(
        'property_type', api_v1._fact(a.property_type, 'classification.property_type', a.record_extract_at, a.ref),
        'use_code', api_v1._fact(a.use_code, 'classification.use_code', a.record_extract_at, a.ref),
        'tax_class', api_v1._fact(a.tax_class, 'classification.tax_class', a.record_extract_at, a.ref),
        'land_area_sqft', api_v1._fact(a.land_area, 'property.land_area', a.record_extract_at, a.ref)
      ),
      'ownership', jsonb_build_object(
        'owner_name', api_v1._fact(a.owner_name, 'ownership.owner_name', a.record_extract_at, a.ref),
        'owner_occupancy_flag', api_v1._fact(a.owner_occupancy_flag, 'ownership.owner_occupancy_flag', a.record_extract_at, a.ref)
      ),
      'valuation', jsonb_build_object(
        'current_total_value_dollars', api_v1._fact(a.current_total_value, 'assessment.current_total_value', a.record_extract_at, a.ref),
        'proposed_total_value_dollars', api_v1._fact(a.proposed_total_value, 'assessment.proposed_total_value', a.record_extract_at, a.ref)
      ),
      'tax_and_balance', jsonb_build_object(
        'annual_tax_cents', api_v1._fact(a.annual_tax_cents, 'tax.annual_tax', a.record_extract_at, a.ref),
        'total_balance_cents', api_v1._fact(a.total_balance_cents, 'tax.total_balance', a.record_extract_at, a.ref),
        'last_payment_date', api_v1._fact(a.last_payment_date, 'tax.last_payment_date', a.record_extract_at, a.ref)
      ),
      'special_balances', jsonb_build_object(
        'bid_balance_cents', api_v1._fact(a.bid_balance_cents, 'special.bid_balance', a.record_extract_at, a.ref),
        'sews_balance_cents', api_v1._fact(a.sews_balance_cents, 'special.sews_balance', a.record_extract_at, a.ref),
        'pace_balance_cents', api_v1._fact(a.pace_balance_cents, 'special.pace_balance', a.record_extract_at, a.ref),
        'swwsad_balance_cents', api_v1._fact(a.swwsad_balance_cents, 'special.swwsad_balance', a.record_extract_at, a.ref)
      ),
      'latest_transfer', jsonb_build_object(
        'sale_price_dollars', api_v1._fact(a.latest_sale_price_dollars, 'sale.latest_price', a.record_extract_at, a.ref),
        'sale_date', api_v1._fact(a.latest_sale_date, 'sale.latest_date', a.record_extract_at, a.ref),
        'instrument_number', api_v1._fact(a.latest_instrument_number, 'deed.latest_instrument_number', a.record_extract_at, a.ref)
      ),
      'limitations', jsonb_build_array(
        'Current owner and latest transfer fields are not a title report or lien search.',
        'Null means the source did not report a value; it does not necessarily mean zero or none.'
      )
    )
  end
  from resolved r
  left join account a on true;
$$;

create or replace function api_v1.get_assessment_history(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  rows as (
    select h.*, a.ssl_normalized,
      api_v1._source_ref(h.source_id, h.source_row_number, 'assessment', h.ssl_normalized) ref
    from history.assessment_snapshot_record h
    join resolved r on r.resolved_account_id = h.account_id
    join core.property_account_current a on a.account_id = h.account_id
  ),
  periods as (
    select tax_year, stage, land_value, improvement_value, total_value,
      record_extract_at, source_id, source_row_number, ref
    from rows
    cross join lateral (values
      (prior_tax_year, 'prior', prior_land_value, prior_improvement_value, prior_total_value),
      (current_tax_year, 'current', current_land_value, current_improvement_value, current_total_value),
      (proposed_tax_year, 'proposed', proposed_land_value, proposed_improvement_value, proposed_total_value)
    ) v(tax_year, stage, land_value, improvement_value, total_value)
    where tax_year is not null
  ),
  payload as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'tax_year', tax_year,
        'stage', stage,
        'land_value_dollars', api_v1._fact(land_value, 'assessment.land_value', record_extract_at, ref),
        'improvement_value_dollars', api_v1._fact(improvement_value, 'assessment.improvement_value', record_extract_at, ref),
        'total_value_dollars', api_v1._fact(total_value, 'assessment.total_value', record_extract_at, ref),
        'source_snapshot', source_id
      )
      order by tax_year, stage, record_extract_at
    ), '[]'::jsonb) items
    from periods
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object('status', r.resolution_status, 'next_tool', 'resolve_property')
    else jsonb_build_object(
      'status', 'resolved',
      'assessments', p.items,
      'known_complete_year_gaps', jsonb_build_array(2019, 2023, 2024),
      'coverage_note', 'Available ITSPE snapshots expose 2016-2018, 2020-2022, and 2025-2027 stages; stages are preserved as reported.',
      'limitations', jsonb_build_array(
        'Proposed, current, and prior are distinct source stages and must not be conflated.',
        'Repeated tax years from different snapshots are retained rather than silently overwritten.'
      )
    )
  end
  from resolved r cross join payload p;
$$;

create or replace function api_v1.get_tax_and_balance_history(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select a.*,
      t.tax_year_anchor, t.values_cents,
      api_v1._source_ref(
        'itspe_current',
        t.source_row_number,
        'tax',
        a.ssl_normalized
      ) ref
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
    left join history.tax_series t on t.account_id = a.account_id
  ),
  slots as (
    select
      g.slot_ordinal as ordinality,
      (array[
        'CY1','CY2','PY1','PY2','PY3','PY4',
        'PY5','PY6','PY7','PY8','PY9','PY10'
      ])[g.slot_ordinal] as slot_code,
      case
        when g.slot_ordinal <= 2 then a.tax_year_anchor
        else a.tax_year_anchor - (g.slot_ordinal - 2)
      end as tax_year,
      f.flag as tax_sale_flag,
      api_v1._tax_value(a.account_id, a.values_cents, g.slot_ordinal) as tax_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 12 + g.slot_ordinal) as penalty_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 24 + g.slot_ordinal) as interest_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 36 + g.slot_ordinal) as fee_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 48 + g.slot_ordinal) as due_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 60 + g.slot_ordinal) as collected_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 72 + g.slot_ordinal) as balance_cents,
      api_v1._tax_value(a.account_id, a.values_cents, 84 + g.slot_ordinal) as credit_cents,
      a.record_extract_at,
      a.ref
    from account a
    cross join generate_series(1, 12) g(slot_ordinal)
    left join history.tax_sale_flag f
      on f.account_id = a.account_id
      and f.slot_ordinal = g.slot_ordinal
  ),
  payload as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'slot', s.slot_code,
        'tax_year', s.tax_year,
        'tax_sale_flag', api_v1._fact(s.tax_sale_flag, 'tax.slot.tax_sale_flag', s.record_extract_at, s.ref),
        'tax_cents', api_v1._fact(s.tax_cents, 'tax.slot.tax', s.record_extract_at, s.ref),
        'penalty_cents', api_v1._fact(s.penalty_cents, 'tax.slot.penalty', s.record_extract_at, s.ref),
        'interest_cents', api_v1._fact(s.interest_cents, 'tax.slot.interest', s.record_extract_at, s.ref),
        'fee_cents', api_v1._fact(s.fee_cents, 'tax.slot.fee', s.record_extract_at, s.ref),
        'total_due_cents', api_v1._fact(s.due_cents, 'tax.slot.total_due', s.record_extract_at, s.ref),
        'collected_cents', api_v1._fact(s.collected_cents, 'tax.slot.collected', s.record_extract_at, s.ref),
        'balance_cents', api_v1._fact(s.balance_cents, 'tax.slot.balance', s.record_extract_at, s.ref),
        'credit_cents', api_v1._fact(s.credit_cents, 'tax.slot.credit', s.record_extract_at, s.ref)
      ) order by s.ordinality
    ), '[]'::jsonb) items
    from slots s
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object('status', r.resolution_status, 'next_tool', 'resolve_property')
    else jsonb_build_object(
      'status', 'resolved',
      'source_slots', p.items,
      'current_summary', jsonb_build_object(
        'annual_tax_cents', api_v1._fact(a.annual_tax_cents, 'tax.annual_tax', a.record_extract_at, a.ref),
        'total_due_cents', api_v1._fact(a.total_due_cents, 'tax.total_due', a.record_extract_at, a.ref),
        'total_collected_cents', api_v1._fact(a.total_collected_cents, 'tax.total_collected', a.record_extract_at, a.ref),
        'total_balance_cents', api_v1._fact(a.total_balance_cents, 'tax.total_balance', a.record_extract_at, a.ref)
      ),
      'aggregation_warning', 'CY1/CY2 and PY1..PY10 are source slots. No unsupported annual rollup is calculated.'
    )
  end
  from resolved r cross join payload p left join account a on true;
$$;

create or replace function api_v1.get_ownership_and_sale(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select a.*,
      api_v1._source_ref(a.source_id, a.source_row_number, 'ownership_sale', a.ssl_normalized) ref
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object('status', r.resolution_status, 'next_tool', 'resolve_property')
    else jsonb_build_object(
      'status', 'resolved',
      'owner_of_record', jsonb_build_object(
        'owner_name', api_v1._fact(a.owner_name, 'ownership.owner_name', a.record_extract_at, a.ref),
        'owner_name_2', api_v1._fact(a.owner_name_2, 'ownership.owner_name_2', a.record_extract_at, a.ref),
        'care_of_name', api_v1._fact(a.care_of_name, 'ownership.care_of_name', a.record_extract_at, a.ref),
        'mailing_address_1', api_v1._fact(a.mailing_address_1, 'ownership.mailing_address_1', a.record_extract_at, a.ref),
        'mailing_address_2', api_v1._fact(a.mailing_address_2, 'ownership.mailing_address_2', a.record_extract_at, a.ref),
        'mailing_city_state_zip', api_v1._fact(a.mailing_city_state_zip, 'ownership.mailing_city_state_zip', a.record_extract_at, a.ref)
      ),
      'latest_reported_transfer', jsonb_build_object(
        'sale_price_dollars', api_v1._fact(a.latest_sale_price_dollars, 'sale.latest_price', a.record_extract_at, a.ref),
        'sale_date', api_v1._fact(a.latest_sale_date, 'sale.latest_date', a.record_extract_at, a.ref),
        'sale_type', api_v1._fact(a.latest_sale_type, 'sale.latest_type', a.record_extract_at, a.ref),
        'acceptance_code', api_v1._fact(a.latest_sale_acceptance_code, 'sale.latest_acceptance_code', a.record_extract_at, a.ref),
        'deed_date', api_v1._fact(a.latest_deed_date, 'deed.latest_date', a.record_extract_at, a.ref),
        'instrument_number', api_v1._fact(a.latest_instrument_number, 'deed.latest_instrument_number', a.record_extract_at, a.ref)
      ),
      'limitations', jsonb_build_array(
        'Owner data is the assessor source record as of the record date.',
        'Latest reported transfer is not a complete sale history, title report, lien search, or proof of current legal ownership.'
      )
    )
  end
  from resolved r left join account a on true;
$$;

create or replace function api_v1.search_properties(
  p_filters jsonb
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with params as (
    select
      nullif(trim(p_filters->>'ward'), '') ward,
      nullif(trim(p_filters->>'property_type'), '') property_type,
      nullif(trim(p_filters->>'use_code'), '') use_code,
      nullif(p_filters->>'min_assessment', '')::bigint min_assessment,
      nullif(p_filters->>'max_assessment', '')::bigint max_assessment,
      case
        when coalesce(p_filters->>'cursor', '') ~ '^[0-9]+$'
        then (p_filters->>'cursor')::bigint
        else 0
      end cursor_id,
      least(greatest(coalesce((p_filters->>'limit')::integer, 20), 1), 50) result_limit
  ),
  matches as (
    select a.*, api_v1._source_ref(a.source_id, a.source_row_number, 'search_result', a.ssl_normalized) ref
    from core.property_account_current a cross join params p
    where not a.is_deleted
      and a.account_id > p.cursor_id
      and (p.ward is null or a.ward = p.ward)
      and (p.property_type is null or a.property_type = p.property_type)
      and (p.use_code is null or a.use_code = p.use_code)
      and (p.min_assessment is null or a.current_total_value >= p.min_assessment)
      and (p.max_assessment is null or a.current_total_value <= p.max_assessment)
    order by a.account_id
    limit (select result_limit + 1 from params)
  ),
  page as (
    select * from matches
    limit (select result_limit from params)
  )
  select jsonb_build_object(
    'status', 'ok',
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
        'account_id', account_id,
        'ssl', ssl_display,
        'premise_address', premise_address,
        'ward', ward,
        'property_type', property_type,
        'use_code', use_code,
        'current_total_value_dollars', current_total_value,
        'record_date', record_extract_at,
        'source_refs', jsonb_build_array(ref)
      ) order by account_id) from page
    ), '[]'::jsonb),
    'next_cursor', case
      when (select count(*) from matches) > (select result_limit from params)
      then (select max(account_id)::text from page)
    end,
    'limit', (select result_limit from params),
    'privacy_note', 'Owner names and mailing addresses are intentionally excluded from screening results.'
  );
$$;

create or replace function api_v1.get_source_evidence(
  p_source_refs text[]
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with requested as (
    select ref, string_to_array(ref, '|') parts
    from unnest(p_source_refs[1:50]) ref
  ),
  expanded as (
    select
      r.ref,
      r.parts[1] source_id,
      nullif(r.parts[2], '')::integer source_row_number,
      r.parts[3] field_key,
      r.parts[4] ssl,
      s.publisher,
      s.dataset_name,
      s.source_class,
      s.official_landing_url,
      s.official_download_url,
      s.archive_capture_at,
      s.dataset_retrieved_at,
      s.sha256
    from requested r
    left join meta.source_asset s on s.source_id = r.parts[1]
  )
  select jsonb_build_object(
    'status', 'ok',
    'evidence', coalesce(jsonb_agg(jsonb_build_object(
      'source_ref', e.ref,
      'field_key', e.field_key,
      'lookup_keys', jsonb_build_object('ssl', e.ssl, 'source_row_number', e.source_row_number),
      'publisher', e.publisher,
      'dataset_name', e.dataset_name,
      'source_class', e.source_class,
      'record_url', case
        when e.source_id = 'itspe_current' and e.ssl <> '' then
          'https://services.arcgis.com/neT9SoYxizqTHZPH/arcgis/rest/services/' ||
          'OCFO_ITSPE_view_05212026/FeatureServer/53/query?where=SSL%3D%27' ||
          replace(replace(e.ssl, ' ', '%20'), '''', '%27%27') ||
          '%27&outFields=*&returnGeometry=false&f=html'
        else null
      end,
      'official_landing_url', e.official_landing_url,
      'official_download_url', e.official_download_url,
      'archive_capture_at', e.archive_capture_at,
      'dataset_retrieved_at', e.dataset_retrieved_at,
      'source_sha256', e.sha256,
      'verification_instructions', case
        when e.source_id = 'itspe_current' then
          'Open the parcel-filtered official ArcGIS result and verify the named field for the supplied SSL.'
        else
          'Open the archived official snapshot and use the SSL and source row number. This is archived evidence, not a live D.C. record.'
      end
    ) order by e.ref), '[]'::jsonb)
  )
  from expanded e;
$$;

create or replace function api_v1.describe_data(
  p_question text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'status', 'ok',
    'question', p_question,
    'entity', 'D.C. property-tax account (not guaranteed to equal one physical parcel)',
    'recommended_sequence', jsonb_build_array(
      'resolve_property',
      'get_property_snapshot',
      'Use a domain-specific history tool if needed',
      'get_source_evidence for one-click verification'
    ),
    'tools', jsonb_build_object(
      'resolve_property', 'Identity resolution and ambiguity handling.',
      'get_property_snapshot', 'Lender-oriented current quick look.',
      'get_assessment_history', 'Available prior/current/proposed assessment stages and gaps.',
      'get_tax_and_balance_history', 'Current totals and preserved raw tax slots.',
      'get_ownership_and_sale', 'Current assessor owner/mailing fields and latest reported transfer.',
      'search_properties', 'Bounded screening by allowlisted non-owner filters.',
      'get_source_evidence', 'Official or archived verification routes for returned source references.'
    ),
    'coverage', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.tax_year, c.stage)
      from semantic.coverage c
    ), '[]'::jsonb),
    'field_definitions', coalesce((
      select jsonb_object_agg(f.field_key, jsonb_build_object(
        'title', f.title,
        'definition', f.definition,
        'unit', f.unit,
        'time_grain', f.time_grain,
        'null_semantics', f.null_semantics,
        'aggregation_rule', f.aggregation_rule,
        'caveat', f.caveat
      ))
      from semantic.field_definition f
      where f.exposure_allowed
    ), '{}'::jsonb),
    'unsupported_inferences', jsonb_build_array(
      'title or lien priority',
      'complete transfer history',
      'NOI, DSCR, occupancy, rent roll, or debt',
      'building area or condition unless a separately sourced fact is added',
      'zoning compliance',
      'credit decision or property valuation opinion'
    )
  );
$$;

revoke all on all functions in schema api_v1 from public;
grant execute on function api_v1.resolve_property(text, text, boolean, integer)
  to mcp_runtime;
grant execute on function api_v1.get_property_snapshot(text, text) to mcp_runtime;
grant execute on function api_v1.get_assessment_history(text, text) to mcp_runtime;
grant execute on function api_v1.get_tax_and_balance_history(text, text) to mcp_runtime;
grant execute on function api_v1.get_ownership_and_sale(text, text) to mcp_runtime;
grant execute on function api_v1.search_properties(jsonb) to mcp_runtime;
grant execute on function api_v1.get_source_evidence(text[]) to mcp_runtime;
grant execute on function api_v1.describe_data(text) to mcp_runtime;

comment on function api_v1.get_source_evidence(text[]) is
  'Expands opaque fact source references into official or accurately labeled archived verification routes.';
comment on function api_v1.search_properties(jsonb) is
  'Bounded allowlisted screening; deliberately excludes owner and mailing fields.';

alter function api_v1._source_ref(text, integer, text, text) owner to api_owner;
alter function api_v1._fact(anyelement, text, date, text) owner to api_owner;
alter function api_v1._resolve_account(text, text) owner to api_owner;
alter function api_v1._tax_value(bigint, integer[], integer) owner to api_owner;
alter function api_v1.resolve_property(text, text, boolean, integer) owner to api_owner;
alter function api_v1.get_property_snapshot(text, text) owner to api_owner;
alter function api_v1.get_assessment_history(text, text) owner to api_owner;
alter function api_v1.get_tax_and_balance_history(text, text) owner to api_owner;
alter function api_v1.get_ownership_and_sale(text, text) owner to api_owner;
alter function api_v1.search_properties(jsonb) owner to api_owner;
alter function api_v1.get_source_evidence(text[]) owner to api_owner;
alter function api_v1.describe_data(text) owner to api_owner;

commit;
