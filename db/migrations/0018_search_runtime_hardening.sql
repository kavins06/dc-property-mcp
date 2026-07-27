begin;

create table if not exists semantic.property_type_vocabulary (
  source_value text primary key,
  canonical_value text not null
);

insert into semantic.property_type_vocabulary (
  source_value,
  canonical_value
)
select distinct
  a.property_type,
  api_v1._canonical_property_type(a.property_type)
from core.property_account_current a
where nullif(trim(a.property_type), '') is not null
on conflict (source_value) do update
set canonical_value = excluded.canonical_value;

comment on table semantic.property_type_vocabulary is
  'Frozen source-to-canonical property-type vocabulary used to validate filters without evaluating canonicalization across every property row.';

revoke all on semantic.property_type_vocabulary from public;
revoke all on semantic.property_type_vocabulary from mcp_runtime;
grant select on semantic.property_type_vocabulary to api_owner;

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
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_unknown_keys text[];
  v_ward text;
  v_property_type text;
  v_property_type_sources text[];
  v_use_code text;
  v_tax_class text;
  v_min_assessment bigint;
  v_max_assessment bigint;
  v_has_balance boolean;
  v_min_balance bigint;
  v_has_tax_sale boolean;
  v_sale_date_from date;
  v_sale_date_to date;
  v_sort text;
  v_limit integer;
  v_cursor jsonb;
  v_cursor_id bigint;
  v_cursor_bigint bigint;
  v_cursor_date date;
  v_cursor_text text;
  v_total_count bigint;
  v_results jsonb;
  v_has_more boolean;
  v_last_id bigint;
  v_last_value text;
  v_next_cursor text;
begin
  if jsonb_typeof(v_filters) <> 'object' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'filter_object_required',
        'hint', 'Pass a JSON object containing only documented search filters.'
      )
    );
  end if;

  select array_agg(key order by key)
  into v_unknown_keys
  from jsonb_object_keys(v_filters) key
  where key <> all(array[
    'ward',
    'property_type',
    'use_code',
    'tax_class',
    'min_assessment',
    'max_assessment',
    'has_balance',
    'min_balance_cents',
    'has_tax_sale_flag',
    'sale_date_from',
    'sale_date_to',
    'sort_by',
    'cursor',
    'limit'
  ]);

  if v_unknown_keys is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_filter',
        'unknown_filters', to_jsonb(v_unknown_keys),
        'hint', 'Call describe_data with a search or filter question for the allowlisted vocabulary.'
      )
    );
  end if;

  v_ward := nullif(
    regexp_replace(coalesce(v_filters->>'ward', ''), '[^0-9]', '', 'g'),
    ''
  );
  if v_filters ? 'ward' and (
    v_ward is null or v_ward not in ('1', '2', '3', '4', '5', '6', '7', '8')
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_ward',
        'hint', 'Ward must be 1 through 8.'
      )
    );
  end if;

  v_property_type := nullif(trim(v_filters->>'property_type'), '');
  v_use_code := nullif(upper(trim(v_filters->>'use_code')), '');
  v_tax_class := nullif(upper(trim(v_filters->>'tax_class')), '');

  if v_property_type is not null then
    select array_agg(v.source_value order by v.source_value)
    into v_property_type_sources
    from semantic.property_type_vocabulary v
    where lower(v.source_value) = lower(v_property_type)
       or lower(v.canonical_value) = lower(v_property_type);

    if coalesce(cardinality(v_property_type_sources), 0) = 0 then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'unknown_property_type',
          'value', v_property_type,
          'hint', 'Call describe_data with a property_type filter question and use one of the returned source or canonical values.'
        )
      );
    end if;
  end if;

  if v_use_code is not null and not exists (
    select 1
    from semantic.code_decode d
    where d.code_system = 'use_code'
      and upper(d.code) = v_use_code
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_use_code',
        'value', v_use_code,
        'hint', 'Call describe_data with a use_code filter question and use a returned code.'
      )
    );
  end if;

  if v_tax_class is not null and not exists (
    select 1
    from semantic.code_decode d
    where d.code_system = 'tax_class'
      and upper(d.code) = v_tax_class
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_tax_class',
        'value', v_tax_class,
        'hint', 'Call describe_data with a tax_class filter question and use a returned code.'
      )
    );
  end if;

  if v_filters ? 'min_assessment' and
     coalesce(v_filters->>'min_assessment', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_min_assessment',
        'hint', 'min_assessment must be a nonnegative whole-dollar integer.'
      )
    );
  end if;
  if v_filters ? 'max_assessment' and
     coalesce(v_filters->>'max_assessment', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_max_assessment',
        'hint', 'max_assessment must be a nonnegative whole-dollar integer.'
      )
    );
  end if;
  if v_filters ? 'min_balance_cents' and
     coalesce(v_filters->>'min_balance_cents', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_min_balance',
        'hint', 'min_balance_cents must be a nonnegative integer.'
      )
    );
  end if;

  v_min_assessment := nullif(v_filters->>'min_assessment', '')::bigint;
  v_max_assessment := nullif(v_filters->>'max_assessment', '')::bigint;
  v_min_balance := nullif(v_filters->>'min_balance_cents', '')::bigint;
  if v_min_assessment is not null
     and v_max_assessment is not null
     and v_min_assessment > v_max_assessment then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'inverted_assessment_range',
        'hint', 'min_assessment cannot exceed max_assessment.'
      )
    );
  end if;

  if v_filters ? 'has_balance'
     and jsonb_typeof(v_filters->'has_balance') <> 'boolean' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_has_balance',
        'hint', 'has_balance must be true or false.'
      )
    );
  end if;
  if v_filters ? 'has_tax_sale_flag'
     and jsonb_typeof(v_filters->'has_tax_sale_flag') <> 'boolean' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_tax_sale_filter',
        'hint', 'has_tax_sale_flag must be true or false.'
      )
    );
  end if;
  v_has_balance := case
    when v_filters ? 'has_balance'
      then (v_filters->>'has_balance')::boolean
    else null
  end;
  v_has_tax_sale := case
    when v_filters ? 'has_tax_sale_flag'
      then (v_filters->>'has_tax_sale_flag')::boolean
    else null
  end;
  if v_has_balance is false and coalesce(v_min_balance, 0) > 0 then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'conflicting_balance_filters',
        'hint', 'has_balance=false cannot be combined with a positive min_balance_cents.'
      )
    );
  end if;

  begin
    if v_filters ? 'sale_date_from' then
      if coalesce(v_filters->>'sale_date_from', '') !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise invalid_datetime_format;
      end if;
      v_sale_date_from := (v_filters->>'sale_date_from')::date;
    end if;
    if v_filters ? 'sale_date_to' then
      if coalesce(v_filters->>'sale_date_to', '') !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise invalid_datetime_format;
      end if;
      v_sale_date_to := (v_filters->>'sale_date_to')::date;
    end if;
  exception when others then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_sale_date',
        'hint', 'Sale dates must be valid ISO dates in YYYY-MM-DD format.'
      )
    );
  end;
  if v_sale_date_from is not null
     and v_sale_date_to is not null
     and v_sale_date_from > v_sale_date_to then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'inverted_sale_date_range',
        'hint', 'sale_date_from cannot be later than sale_date_to.'
      )
    );
  end if;

  v_sort := coalesce(nullif(v_filters->>'sort_by', ''), 'account_id_asc');
  if v_sort not in (
    'assessment_desc',
    'balance_desc',
    'sale_date_desc',
    'address_asc',
    'account_id_asc'
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_sort',
        'hint', 'Use assessment_desc, balance_desc, sale_date_desc, address_asc, or account_id_asc.'
      )
    );
  end if;

  if v_filters ? 'limit'
     and coalesce(v_filters->>'limit', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_limit',
        'hint', 'limit must be an integer from 1 through 50.'
      )
    );
  end if;
  v_limit := least(
    greatest(coalesce((v_filters->>'limit')::integer, 20), 1),
    50
  );

  if nullif(v_filters->>'cursor', '') is not null then
    begin
      v_cursor := (v_filters->>'cursor')::jsonb;
      if jsonb_typeof(v_cursor) <> 'object'
         or v_cursor->>'sort_by' <> v_sort
         or coalesce(v_cursor->>'account_id', '') !~ '^[0-9]+$' then
        raise invalid_parameter_value;
      end if;
      v_cursor_id := (v_cursor->>'account_id')::bigint;
      if v_sort in ('assessment_desc', 'balance_desc') then
        if coalesce(v_cursor->>'value', '') !~ '^-?[0-9]+$' then
          raise invalid_parameter_value;
        end if;
        v_cursor_bigint := (v_cursor->>'value')::bigint;
      elsif v_sort = 'sale_date_desc' then
        if coalesce(v_cursor->>'value', '') !~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise invalid_parameter_value;
        end if;
        v_cursor_date := (v_cursor->>'value')::date;
      elsif v_sort = 'address_asc' then
        v_cursor_text := v_cursor->>'value';
        if v_cursor_text is null then
          raise invalid_parameter_value;
        end if;
      end if;
    exception when others then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'invalid_cursor',
          'hint', 'Use the next_cursor returned by the preceding page without editing it.'
        )
      );
    end;
  end if;

  select count(*)::bigint
  into v_total_count
  from core.property_account_current a
  where not a.is_deleted
    and (
      v_ward is null
      or a.ward = v_ward
    )
    and (
      v_property_type is null
      or a.property_type = any(v_property_type_sources)
    )
    and (v_use_code is null or a.use_code = v_use_code)
    and (v_tax_class is null or a.tax_class = v_tax_class)
    and (
      v_min_assessment is null
      or a.current_total_value >= v_min_assessment
    )
    and (
      v_max_assessment is null
      or a.current_total_value <= v_max_assessment
    )
    and (
      v_has_balance is null
      or (coalesce(a.total_balance_cents, 0) > 0) = v_has_balance
    )
    and (
      v_min_balance is null
      or a.total_balance_cents >= v_min_balance
    )
    and (
      v_has_tax_sale is null
      or exists (
        select 1
        from history.tax_sale_flag f
        where f.account_id = a.account_id
      ) = v_has_tax_sale
    )
    and (
      v_sale_date_from is null
      or a.latest_sale_date >= v_sale_date_from
    )
    and (
      v_sale_date_to is null
      or a.latest_sale_date <= v_sale_date_to
    );

  with ordered as (
    select
      a.*,
      api_v1._canonical_property_type(a.property_type)
        property_type_canonical,
      api_v1._display_address(a.premise_address) premise_address_display,
      exists (
        select 1
        from history.tax_sale_flag f
        where f.account_id = a.account_id
      ) has_tax_sale_flag_value,
      (
        select array_agg(f.flag order by f.slot_ordinal)
        from history.tax_sale_flag f
        where f.account_id = a.account_id
      ) tax_sale_flags_value,
      row_number() over (
        order by
          case when v_sort = 'assessment_desc'
            then coalesce(a.current_total_value::bigint, -9223372036854775808)
          end desc,
          case when v_sort = 'balance_desc'
            then coalesce(a.total_balance_cents, -9223372036854775808)
          end desc,
          case when v_sort = 'sale_date_desc'
            then coalesce(a.latest_sale_date, date '0001-01-01')
          end desc,
          case when v_sort = 'address_asc'
            then coalesce(api_v1._display_address(a.premise_address), '')
          end asc,
          case when v_sort = 'account_id_asc' then a.account_id end asc,
          a.account_id asc
      ) page_ordinal
    from core.property_account_current a
    where not a.is_deleted
      and (
        v_ward is null
        or a.ward = v_ward
      )
      and (
        v_property_type is null
        or a.property_type = any(v_property_type_sources)
      )
      and (v_use_code is null or a.use_code = v_use_code)
      and (v_tax_class is null or a.tax_class = v_tax_class)
      and (
        v_min_assessment is null
        or a.current_total_value >= v_min_assessment
      )
      and (
        v_max_assessment is null
        or a.current_total_value <= v_max_assessment
      )
      and (
        v_has_balance is null
        or (coalesce(a.total_balance_cents, 0) > 0) = v_has_balance
      )
      and (
        v_min_balance is null
        or a.total_balance_cents >= v_min_balance
      )
      and (
        v_has_tax_sale is null
        or exists (
          select 1
          from history.tax_sale_flag f
          where f.account_id = a.account_id
        ) = v_has_tax_sale
      )
      and (
        v_sale_date_from is null
        or a.latest_sale_date >= v_sale_date_from
      )
      and (
        v_sale_date_to is null
        or a.latest_sale_date <= v_sale_date_to
      )
      and (
        v_cursor is null
        or (
          v_sort = 'assessment_desc'
          and (
            coalesce(
              a.current_total_value::bigint,
              -9223372036854775808
            ) < v_cursor_bigint
            or (
              coalesce(
                a.current_total_value::bigint,
                -9223372036854775808
              ) = v_cursor_bigint
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'balance_desc'
          and (
            coalesce(a.total_balance_cents, -9223372036854775808) <
              v_cursor_bigint
            or (
              coalesce(a.total_balance_cents, -9223372036854775808) =
                v_cursor_bigint
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'sale_date_desc'
          and (
            coalesce(a.latest_sale_date, date '0001-01-01') < v_cursor_date
            or (
              coalesce(a.latest_sale_date, date '0001-01-01') =
                v_cursor_date
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'address_asc'
          and (
            coalesce(api_v1._display_address(a.premise_address), '') >
              v_cursor_text
            or (
              coalesce(api_v1._display_address(a.premise_address), '') =
                v_cursor_text
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'account_id_asc'
          and a.account_id > v_cursor_id
        )
      )
    order by
      case when v_sort = 'assessment_desc'
        then coalesce(a.current_total_value::bigint, -9223372036854775808)
      end desc,
      case when v_sort = 'balance_desc'
        then coalesce(a.total_balance_cents, -9223372036854775808)
      end desc,
      case when v_sort = 'sale_date_desc'
        then coalesce(a.latest_sale_date, date '0001-01-01')
      end desc,
      case when v_sort = 'address_asc'
        then coalesce(api_v1._display_address(a.premise_address), '')
      end asc,
      case when v_sort = 'account_id_asc' then a.account_id end asc,
      a.account_id asc
    limit v_limit + 1
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'account_id', account_id,
        'ssl', ssl_display,
        'premise_address', premise_address_display,
        'ward', ward,
        'property_type_source', property_type,
        'property_type_canonical', property_type_canonical,
        'use_code', use_code,
        'tax_class', tax_class,
        'current_total_value_dollars', current_total_value,
        'total_balance_cents', total_balance_cents,
        'has_tax_sale_flag', has_tax_sale_flag_value,
        'tax_sale_flags', coalesce(to_jsonb(tax_sale_flags_value), '[]'::jsonb),
        'latest_sale_date', latest_sale_date,
        'record_date', record_extract_at,
        'source_refs', jsonb_build_array(api_v1._source_ref(
          source_id,
          source_row_number,
          'search_result',
          ssl_normalized
        )),
        'quality_flags', api_v1._property_quality_flags(
          mailing_city_state_zip,
          current_total_value,
          current_improvement_value,
          latest_sale_price_dollars,
          property_type,
          premise_address
        )
      )
      order by page_ordinal
    ) filter (where page_ordinal <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    max(account_id) filter (where page_ordinal = v_limit),
    max(case v_sort
      when 'assessment_desc' then coalesce(
        current_total_value::bigint,
        -9223372036854775808
      )::text
      when 'balance_desc' then coalesce(
        total_balance_cents,
        -9223372036854775808
      )::text
      when 'sale_date_desc' then coalesce(
        latest_sale_date,
        date '0001-01-01'
      )::text
      when 'address_asc' then coalesce(premise_address_display, '')
      else account_id::text
    end) filter (where page_ordinal = v_limit)
  into
    v_results,
    v_has_more,
    v_last_id,
    v_last_value
  from ordered;

  if v_has_more then
    v_next_cursor := jsonb_build_object(
      'sort_by', v_sort,
      'value', v_last_value,
      'account_id', v_last_id
    )::text;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'results', v_results,
    'total_count', v_total_count,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'sort_by', v_sort,
    'limit', v_limit,
    'empty_result_note', case
      when v_total_count = 0 then
        'No current property accounts matched these validated exact filters.'
      else null
    end,
    'privacy_note',
      'Owner names and mailing addresses are intentionally excluded from screening results.',
    'balance_note',
      'A source-reported balance or tax-sale flag is screening data, not a payoff, lien-priority, or title conclusion.'
  );
end;
$function$;


revoke all on function api_v1.search_properties(jsonb) from public;
grant execute on function api_v1.search_properties(jsonb) to mcp_runtime;
alter function api_v1.search_properties(jsonb) owner to api_owner;

comment on function api_v1.search_properties(jsonb) is
  'Validated lender screening with direct normalized filter comparisons, deterministic sorting, exact total counts, keyset cursors, and no owner or mailing output.';

reset role;

commit;
