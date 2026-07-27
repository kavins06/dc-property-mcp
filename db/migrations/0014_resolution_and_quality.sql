begin;

set local role api_owner;

create or replace function api_v1._normalize_ssl(
  p_ssl text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select nullif(
    upper(
      replace(
        replace(
          replace(trim(coalesce(p_ssl, '')), '-', ''),
          ' ',
          ''
        ),
        E'\t',
        ''
      )
    ),
    ''
  );
$$;

create or replace function api_v1._normalize_address_query(
  p_address text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  with cleaned as (
    select upper(regexp_replace(
      regexp_replace(trim(coalesce(p_address, '')), '[^A-Za-z0-9 ]+', ' ', 'g'),
      '\s+',
      ' ',
      'g'
    )) value
  ),
  units_removed as (
    select regexp_replace(
      value,
      '\m(UNIT|APARTMENT|APT|SUITE|STE)\M',
      ' ',
      'g'
    ) value
    from cleaned
  ),
  suffixes as (
    select regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(
                              regexp_replace(
                                regexp_replace(
                                  regexp_replace(
                                    regexp_replace(
                                      regexp_replace(
                                        regexp_replace(
                                          regexp_replace(value, '\mNORTHWEST\M', 'NW', 'g'),
                                          '\mNORTHEAST\M', 'NE', 'g'
                                        ),
                                        '\mSOUTHWEST\M', 'SW', 'g'
                                      ),
                                      '\mSOUTHEAST\M', 'SE', 'g'
                                    ),
                                    '\mSTREET\M', 'ST', 'g'
                                  ),
                                  '\mAVENUE\M', 'AVE', 'g'
                                ),
                                '\mBOULEVARD\M', 'BLVD', 'g'
                              ),
                              '\mROAD\M', 'RD', 'g'
                            ),
                            '\mDRIVE\M', 'DR', 'g'
                          ),
                          '\mPLACE\M', 'PL', 'g'
                        ),
                        '\mCOURT\M', 'CT', 'g'
                      ),
                      '\mLANE\M', 'LN', 'g'
                    ),
                    '\mTERRACE\M', 'TER', 'g'
                  ),
                  '\mPARKWAY\M', 'PKWY', 'g'
                ),
                '\mHIGHWAY\M', 'HWY', 'g'
              ),
              '\mCIRCLE\M', 'CIR', 'g'
            ),
            '\mTRAIL\M', 'TRL', 'g'
          ),
          '\mNORTH\M', 'N', 'g'
        ),
        '\mSOUTH\M', 'S', 'g'
      ),
      '\mEAST\M', 'E', 'g'
    ) value
    from units_removed
  ),
  west_done as (
    select regexp_replace(value, '\mWEST\M', 'W', 'g') value
    from suffixes
  ),
  city_removed as (
    select regexp_replace(
      value,
      '\s+WASHINGTON\s+(DC|D\s+C)(\s+[0-9]{3,5}(\s+[0-9]{4})?)?\s*$',
      '',
      'i'
    ) value
    from west_done
  ),
  zip_removed as (
    select regexp_replace(
      value,
      '\s+[0-9]{5}(\s+[0-9]{4})?\s*$',
      ''
    ) value
    from city_removed
  )
  select nullif(trim(regexp_replace(value, '\s+', ' ', 'g')), '')
  from zip_removed;
$$;

create or replace function api_v1._display_address(
  p_source_address text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case
    when nullif(trim(p_source_address), '') is null then null
    else concat(
      trim(regexp_replace(
        regexp_replace(
          p_source_address,
          '\s+WASHINGTON\s+DC.*$',
          '',
          'i'
        ),
        '\s+#\s+',
        ' UNIT ',
        'g'
      )),
      ', Washington, DC'
    )
  end;
$$;

create or replace function api_v1._property_quality_flags(
  p_mailing_city_state_zip text,
  p_current_total_value bigint,
  p_current_improvement_value bigint,
  p_latest_sale_price bigint,
  p_property_type text,
  p_premise_address text
) returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(flag) order by flag), '[]'::jsonb)
  from (
    select 'mailing_jurisdiction_conflict' flag
    where upper(coalesce(p_mailing_city_state_zip, '')) like '%SEOUL%'
      and upper(coalesce(p_mailing_city_state_zip, '')) like '%NORTH KOREA%'

    union all

    select 'sale_price_assessment_outlier'
    where p_current_total_value > 0
      and p_latest_sale_price > 0
      and (
        p_latest_sale_price::numeric / p_current_total_value::numeric < 0.05
        or p_latest_sale_price::numeric / p_current_total_value::numeric > 20
      )

    union all

    select 'vacant_type_improvement_value_conflict'
    where p_property_type ilike 'Vacant%'
      and coalesce(p_current_improvement_value, 0) > 0

    union all

    select 'property_type_source_length_limit'
    where length(coalesce(p_property_type, '')) >= 30

    union all

    select 'premise_address_source_length_limit'
    where length(coalesce(p_premise_address, '')) >= 50
  ) flags;
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
  with ref as (
    select string_to_array(p_source_ref, '|') parts
  ),
  flags as (
    select case
      when p_field_key = 'ownership.mailing_city_state_zip'
        and upper(coalesce(p_value::text, '')) like '%SEOUL%'
        and upper(coalesce(p_value::text, '')) like '%NORTH KOREA%'
        then jsonb_build_array('mailing_jurisdiction_conflict')
      when p_field_key = 'classification.property_type'
        and length(coalesce(p_value::text, '')) >= 30
        then jsonb_build_array('property_type_source_length_limit')
      when p_field_key = 'property.premise_address'
        and length(coalesce(p_value::text, '')) >= 50
        then jsonb_build_array('premise_address_source_length_limit')
      when p_field_key = 'classification.property_type_canonical'
        then jsonb_build_array('derived_display_label')
      else '[]'::jsonb
    end value
  )
  select jsonb_build_object(
    'value', to_jsonb(p_value),
    'field_key', p_field_key,
    'title', f.title,
    'unit', f.unit,
    'record_date', p_record_date,
    'status', case when p_value is null then 'not_reported' else 'reported' end,
    'source_refs', jsonb_build_array(
      case
        when cardinality(ref.parts) >= 4 then concat_ws(
          '|',
          ref.parts[1],
          ref.parts[2],
          replace(coalesce(p_field_key, ''), '|', ''),
          ref.parts[4]
        )
        else p_source_ref
      end
    ),
    'quality_flags', flags.value,
    'caveat', f.caveat
  )
  from ref
  cross join flags
  left join semantic.field_definition f on f.field_key = p_field_key;
$$;

create or replace function api_v1.resolve_property(
  p_ssl text default null,
  p_address text default null,
  p_include_deleted boolean default false,
  p_limit integer default 10
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_ssl text := api_v1._normalize_ssl(p_ssl);
  v_address text := api_v1._normalize_address_query(p_address);
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 10);
  v_account_id bigint;
  v_exact_count integer;
  v_candidates jsonb;
  v_fuzzy_count integer;
  v_house_number text;
  v_address_matches boolean;
begin
  if v_ssl is null and v_address is null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'identity_required',
        'hint', 'Provide an SSL or a street address.'
      )
    );
  end if;

  if v_ssl is not null then
    select a.account_id
    into v_account_id
    from core.property_account_current a
    where (p_include_deleted or not a.is_deleted)
      and a.ssl_normalized = v_ssl;

    if v_account_id is null then
      return jsonb_build_object(
        'status', 'not_found',
        'input_normalized', jsonb_strip_nulls(jsonb_build_object(
          'ssl', v_ssl,
          'address', v_address
        )),
        'candidates', '[]'::jsonb,
        'hint', 'Check the SSL in MyTax.DC.gov or try the street address.'
      );
    end if;

    if v_address is not null then
      select a.address_normalized like v_address || '%'
      into v_address_matches
      from core.property_account_current a
      where a.account_id = v_account_id;

      if not coalesce(v_address_matches, false) then
        return jsonb_build_object(
          'status', 'conflicting_input',
          'error', jsonb_build_object(
            'code', 'ssl_address_conflict',
            'hint', 'The SSL and address identify different records. Correct one input or send only the trusted identifier.'
          ),
          'input_normalized', jsonb_build_object(
            'ssl', v_ssl,
            'address', v_address
          ),
          'candidates', '[]'::jsonb
        );
      end if;
    end if;

    select jsonb_build_array(jsonb_build_object(
      'account_id', a.account_id,
      'ssl', a.ssl_display,
      'address', api_v1._display_address(a.premise_address),
      'address_source_value', a.premise_address,
      'unit', nullif(a.unit_number, ''),
      'match_kind', 'ssl_exact',
      'similarity_score', 1.0,
      'record_extract_at', a.record_extract_at,
      'quality_flags', case
        when length(coalesce(a.premise_address, '')) >= 50
          then jsonb_build_array('premise_address_source_length_limit')
        else '[]'::jsonb
      end
    ))
    into v_candidates
    from core.property_account_current a
    where a.account_id = v_account_id;

    return jsonb_build_object(
      'status', 'resolved',
      'input_normalized', jsonb_strip_nulls(jsonb_build_object(
        'ssl', v_ssl,
        'address', v_address
      )),
      'total_candidates', 1,
      'candidates', v_candidates
    );
  end if;

  select count(*)::integer
  into v_exact_count
  from core.property_account_current a
  where (p_include_deleted or not a.is_deleted)
    and a.address_normalized like v_address || '%';

  if v_exact_count > 0 then
    select coalesce(jsonb_agg(candidate order by account_id), '[]'::jsonb)
    into v_candidates
    from (
      select
        a.account_id,
        jsonb_build_object(
          'account_id', a.account_id,
          'ssl', a.ssl_display,
          'address', api_v1._display_address(a.premise_address),
          'address_source_value', a.premise_address,
          'unit', nullif(a.unit_number, ''),
          'match_kind', 'address_exact',
          'similarity_score', 1.0,
          'record_extract_at', a.record_extract_at,
          'quality_flags', case
            when length(coalesce(a.premise_address, '')) >= 50
              then jsonb_build_array('premise_address_source_length_limit')
            else '[]'::jsonb
          end
        ) candidate
      from core.property_account_current a
      where (p_include_deleted or not a.is_deleted)
        and a.address_normalized like v_address || '%'
      order by a.account_id
      limit v_limit
    ) exact_rows;

    return jsonb_build_object(
      'status', case when v_exact_count = 1 then 'resolved' else 'ambiguous' end,
      'input_normalized', jsonb_build_object('address', v_address),
      'total_candidates', v_exact_count,
      'candidates', v_candidates,
      'hint', case
        when v_exact_count > 1 then
          'Multiple exact account addresses share this street address. Add the unit number or use an SSL.'
        else null
      end
    );
  end if;

  v_house_number := split_part(v_address, ' ', 1);
  if v_house_number !~ '^[0-9]+[A-Z]?$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'street_number_required',
        'hint', 'Include the street number, street name, and quadrant, or use the SSL.'
      ),
      'candidates', '[]'::jsonb
    );
  end if;

  with pool as materialized (
    select a.*
    from core.property_account_current a
    where (p_include_deleted or not a.is_deleted)
      and a.address_normalized like v_house_number || ' %'
    order by a.account_id
    limit 500
  ),
  scored as (
    select
      p.*,
      greatest(
        extensions.similarity(
          left(p.address_normalized, length(v_address)),
          v_address
        ),
        extensions.similarity(p.address_normalized, v_address)
      ) score
    from pool p
  ),
  plausible as (
    select *, count(*) over () total_count
    from scored
    where score >= 0.18
  ),
  limited as (
    select *
    from plausible
    order by score desc, account_id
    limit v_limit
  )
  select
    coalesce(max(total_count), 0)::integer,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'account_id', account_id,
        'ssl', ssl_display,
        'address', api_v1._display_address(premise_address),
        'address_source_value', premise_address,
        'unit', nullif(unit_number, ''),
        'match_kind', 'fuzzy_suggestion',
        'similarity_score', round(score::numeric, 4),
        'record_extract_at', record_extract_at,
        'quality_flags', case
          when length(coalesce(premise_address, '')) >= 50
            then jsonb_build_array('premise_address_source_length_limit')
          else '[]'::jsonb
        end
      )
      order by score desc, account_id
    ), '[]'::jsonb)
  into v_fuzzy_count, v_candidates
  from limited;

  if v_fuzzy_count = 0 then
    return jsonb_build_object(
      'status', 'not_found',
      'input_normalized', jsonb_build_object('address', v_address),
      'total_candidates', 0,
      'candidates', '[]'::jsonb,
      'hint', 'No exact or plausible same-number address was found. Check the quadrant or use the SSL.'
    );
  end if;

  return jsonb_build_object(
    'status', 'no_exact_match',
    'input_normalized', jsonb_build_object('address', v_address),
    'total_candidates', v_fuzzy_count,
    'candidates', v_candidates,
    'hint', 'No exact address exists in the current extract. These are scored same-number suggestions only; do not use collateral facts until one identity is confirmed.'
  );
end;
$function$;

create or replace function api_v1._resolve_account(
  p_ssl text,
  p_address text
) returns table (resolution_status text, resolved_account_id bigint)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with payload as (
    select api_v1.resolve_property(p_ssl, p_address, false, 2) value
  )
  select
    value->>'status',
    case
      when value->>'status' = 'resolved'
        then (value#>>'{candidates,0,account_id}')::bigint
      else null
    end
  from payload;
$$;

create or replace function api_v1.resolve_properties_batch(
  p_items jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_count integer;
  v_results jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'array_required',
        'hint', 'Pass an array of named assets.'
      )
    );
  end if;

  v_count := jsonb_array_length(p_items);
  if v_count < 1 or v_count > 50 then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'batch_size',
        'hint', 'Pass between 1 and 50 named assets per call.'
      )
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) <> 'object'
      or nullif(trim(item->>'client_id'), '') is null
      or (
        nullif(trim(item->>'ssl'), '') is null
        and nullif(trim(item->>'address'), '') is null
      )
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_named_asset',
        'hint', 'Every item needs a nonblank client_id and either an SSL or address.'
      )
    );
  end if;

  if exists (
    select item->>'client_id'
    from jsonb_array_elements(p_items) item
    group by item->>'client_id'
    having count(*) > 1
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'duplicate_client_id',
        'hint', 'client_id values must be unique within the batch.'
      )
    );
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'client_id', item->>'client_id',
      'resolution', api_v1.resolve_property(
        nullif(trim(item->>'ssl'), ''),
        nullif(trim(item->>'address'), ''),
        false,
        5
      )
    )
    order by ordinality
  )
  into v_results
  from jsonb_array_elements(p_items) with ordinality requested(item, ordinality);

  return jsonb_build_object(
    'status', 'ok',
    'requested_count', v_count,
    'results', v_results,
    'scope_note', 'Bounded resolution of caller-supplied named assets; this is not a universe export.'
  );
end;
$function$;

revoke all on function api_v1.resolve_property(text, text, boolean, integer)
  from public;
revoke all on function api_v1.resolve_properties_batch(jsonb) from public;
grant execute on function api_v1.resolve_property(text, text, boolean, integer)
  to mcp_runtime;
grant execute on function api_v1.resolve_properties_batch(jsonb)
  to mcp_runtime;

alter function api_v1._normalize_ssl(text) owner to api_owner;
alter function api_v1._normalize_address_query(text) owner to api_owner;
alter function api_v1._display_address(text) owner to api_owner;
alter function api_v1._property_quality_flags(
  text, bigint, bigint, bigint, text, text
) owner to api_owner;
alter function api_v1._fact(anyelement, text, date, text) owner to api_owner;
alter function api_v1.resolve_property(text, text, boolean, integer)
  owner to api_owner;
alter function api_v1._resolve_account(text, text) owner to api_owner;
alter function api_v1.resolve_properties_batch(jsonb) owner to api_owner;

reset role;

-- Prefix address matching uses the existing full GIN trigram index. Removing
-- the redundant exact-address btree recovers roughly 14 MB of free-tier headroom.
drop index if exists core.property_account_exact_address_idx;

analyze core.property_account_current;

commit;
