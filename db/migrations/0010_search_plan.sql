begin;

set local role api_owner;

create or replace function api_v1.search_properties(
  p_filters jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_ward text := nullif(trim(p_filters->>'ward'), '');
  v_property_type text := nullif(trim(p_filters->>'property_type'), '');
  v_use_code text := nullif(trim(p_filters->>'use_code'), '');
  v_min_assessment bigint := nullif(p_filters->>'min_assessment', '')::bigint;
  v_max_assessment bigint := nullif(p_filters->>'max_assessment', '')::bigint;
  v_cursor bigint := case
    when coalesce(p_filters->>'cursor', '') ~ '^[0-9]+$'
    then (p_filters->>'cursor')::bigint
    else 0
  end;
  v_limit integer := least(
    greatest(coalesce((p_filters->>'limit')::integer, 20), 1),
    50
  );
  v_sql text;
  v_result jsonb;
begin
  -- Only fixed, allowlisted predicate fragments are concatenated. User values
  -- remain bind parameters. This gives reused Hyperdrive sessions a custom,
  -- index-friendly plan without creating a SQL-injection surface.
  v_sql := $query$
    with matches as (
      select
        a.*,
        api_v1._source_ref(
          a.source_id,
          a.source_row_number,
          'search_result',
          a.ssl_normalized
        ) ref
      from core.property_account_current a
      where not a.is_deleted
        and a.account_id > $1
  $query$;

  if v_ward is not null then
    v_sql := v_sql || ' and a.ward = $2';
  end if;
  if v_property_type is not null then
    v_sql := v_sql || ' and a.property_type = $3';
  end if;
  if v_use_code is not null then
    v_sql := v_sql || ' and a.use_code = $4';
  end if;
  if v_min_assessment is not null then
    v_sql := v_sql || ' and a.current_total_value >= $5';
  end if;
  if v_max_assessment is not null then
    v_sql := v_sql || ' and a.current_total_value <= $6';
  end if;

  v_sql := v_sql || $query$
      order by a.account_id
      limit ($7 + 1)
    ),
    page as (
      select *
      from matches
      limit $7
    )
    select jsonb_build_object(
      'status', 'ok',
      'results', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'account_id', account_id,
            'ssl', ssl_display,
            'premise_address', premise_address,
            'ward', ward,
            'property_type', property_type,
            'use_code', use_code,
            'current_total_value_dollars', current_total_value,
            'record_date', record_extract_at,
            'source_refs', jsonb_build_array(ref)
          )
          order by account_id
        )
        from page
      ), '[]'::jsonb),
      'next_cursor', case
        when (select count(*) from matches) > $7
        then (select max(account_id)::text from page)
      end,
      'limit', $7,
      'privacy_note',
        'Owner names and mailing addresses are intentionally excluded from screening results.'
    )
  $query$;

  execute v_sql into v_result using
    v_cursor,
    v_ward,
    v_property_type,
    v_use_code,
    v_min_assessment,
    v_max_assessment,
    v_limit;

  return v_result;
end;
$function$;

grant execute on function api_v1.search_properties(jsonb) to mcp_runtime;
alter function api_v1.search_properties(jsonb) owner to api_owner;

commit;
