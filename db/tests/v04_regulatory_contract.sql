begin;

do $$
declare
  v_failures text[] := array[]::text[];
  v_function_name text;
  v_function_signature text;
  v_case record;
  v_table record;
  v_role text;
  v_fixture_ssl text;
  v_fixture_scope text;
  v_payload jsonb;
  v_record jsonb;
  v_evidence jsonb;
  v_refs jsonb;
  v_ref text;
  v_portal_url text;
  v_duplicate_exists boolean;
  v_link_exists boolean;
  v_source_table_count integer := 0;
  v_exact_link_count bigint := 0;
  v_contextual_link_count bigint := 0;
  v_registry_ready boolean := false;
  v_api_ready boolean := true;
begin
  -- The four curated APIs intentionally share one extensible filter envelope.
  foreach v_function_name in array array[
    'get_permit_history',
    'get_license_history',
    'get_inspection_and_enforcement_history',
    'get_building_and_land_profile'
  ] loop
    v_function_signature :=
      'api_v1.' || v_function_name || '(text,text,jsonb)';
    if to_regprocedure(v_function_signature) is null then
      v_api_ready := false;
      v_failures := array_append(
        v_failures,
        'missing API function ' || v_function_signature
      );
    end if;
  end loop;

  -- One generic registry binds every official record to a property/building
  -- with an explicit exact or contextual attribution.
  if to_regclass('meta.source_record_link') is null then
    v_failures := array_append(
      v_failures,
      'missing meta.source_record_link registry'
    );
  elsif not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'meta'
      and c.table_name = 'source_record_link'
    group by c.table_schema, c.table_name
    having array_agg(c.column_name::text) @> array[
      'source_id',
      'source_record_id',
      'account_id',
      'link_scope',
      'link_method',
      'link_confidence'
    ]
  ) then
    v_failures := array_append(
      v_failures,
      'source-record registry lacks provenance or link-quality columns'
    );
  else
    v_registry_ready := true;

    execute $query$
      select
        count(*) filter (
          where link_scope = 'exact_property'
        ),
        count(*) filter (
          where link_scope in (
            'shared_building',
            'multi_parcel',
            'proximity_context'
          )
        )
      from meta.source_record_link
    $query$
    into v_exact_link_count, v_contextual_link_count;

    if v_exact_link_count = 0 or v_contextual_link_count = 0 then
      v_failures := array_append(
        v_failures,
        'source links do not exercise both exact_property and contextual scopes'
      );
    end if;

    execute $query$
      select exists (
        select 1
        from meta.source_record_link
        where link_scope not in (
          'exact_property',
          'shared_building',
          'multi_parcel',
          'proximity_context'
        )
           or link_method not in (
             'ssl',
             'mar_id',
             'ubid',
             'normalized_address',
             'point_in_parcel',
             'polygon_overlap',
             'proximity'
           )
           or link_confidence < 0
           or link_confidence > 1
      )
    $query$
    into v_duplicate_exists;

    if v_duplicate_exists then
      v_failures := array_append(
        v_failures,
        'source links contain an unlabeled scope/method or invalid confidence'
      );
    end if;

    execute $query$
      select exists (
        select 1
        from meta.source_record_link
        group by source_id, source_record_id, account_id, link_scope
        having count(*) > 1
      )
    $query$
    into v_duplicate_exists;

    if v_duplicate_exists then
      v_failures := array_append(
        v_failures,
        'duplicate source-to-property links exist'
      );
    end if;
  end if;

  -- Every materialized source-record table owns one source record exactly once.
  for v_table in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
    where c.table_schema in ('regulatory', 'property_context')
      and t.table_type = 'BASE TABLE'
      and c.column_name in ('source_id', 'source_record_id')
      and c.table_name not like '%link%'
    group by c.table_schema, c.table_name
    having count(distinct c.column_name) = 2
    order by c.table_schema, c.table_name
  loop
    v_source_table_count := v_source_table_count + 1;
    execute format(
      'select exists (
         select 1 from %I.%I
         group by source_id, source_record_id
         having count(*) > 1
       )',
      v_table.table_schema,
      v_table.table_name
    ) into v_duplicate_exists;

    if v_duplicate_exists then
      v_failures := array_append(
        v_failures,
        format(
          'duplicate source records exist in %I.%I',
          v_table.table_schema,
          v_table.table_name
        )
      );
    end if;
  end loop;

  if v_source_table_count < 2 then
    v_failures := array_append(
      v_failures,
      'fewer than two regulatory/context source-record tables are queryable'
    );
  end if;

  -- Discover real linked fixtures by source family. This remains stable when
  -- addresses or the latest source-record identifiers change.
  if v_registry_ready and v_api_ready then
    for v_case in
      select *
      from (values
        (
          'building permits',
          'building[_ ]?permit',
          'get_permit_history',
          'building_permit',
          '^https://scout\.dob\.dc\.gov'
        ),
        (
          'business licenses',
          '(basic[_ ]?business|business[_ ]?licen)',
          'get_license_history',
          'business_license',
          '^https://(mybusiness\.dc\.gov|scout\.dob\.dc\.gov)'
        ),
        (
          'certificates of occupancy',
          '(certificate[_ ]?of[_ ]?occupancy|occupancy[_ ]?certificate)',
          'get_permit_history',
          'certificate_of_occupancy',
          '^https://(scout\.dob\.dc\.gov|certifi\.dob\.dc\.gov)'
        ),
        (
          'inspections and enforcement',
          '(inspection|violation|enforcement)',
          'get_inspection_and_enforcement_history',
          'inspection',
          '^https://(scout\.dob\.dc\.gov|tops\.ddot\.dc\.gov|dob\.dc\.gov|ddot\.dc\.gov)'
        ),
        (
          'CAMA building profiles',
          '(cama.*(building|residential|commercial|condo)|(building|residential|commercial|condo).*cama)',
          'get_building_and_land_profile',
          'cama_building_profile',
          '^https://(mytax\.dc\.gov|propertyquest\.dc\.gov|dc\.gov)'
        ),
        (
          'energy benchmarking',
          '(energy.*benchmark|benchmark.*energy)',
          'get_building_and_land_profile',
          'energy_benchmark',
          '^https://([a-z0-9.-]+\.)?(dc\.gov|buildingperformancedc\.org)'
        ),
        (
          'BEPS',
          '(^|_)beps($|_)',
          'get_building_and_land_profile',
          'beps',
          '^https://([a-z0-9.-]+\.)?(dc\.gov|buildingperformancedc\.org)'
        ),
        (
          'vacant and blighted context',
          '(vacant|blight)',
          'get_building_and_land_profile',
          'vacant_blighted',
          '^https://(scout\.dob\.dc\.gov|dob\.dc\.gov|mytax\.dc\.gov|propertyquest\.dc\.gov)'
        )
      ) cases(
        source_label,
        source_pattern,
        api_function,
        record_type,
        portal_pattern
      )
    loop
      v_fixture_ssl := null;
      v_fixture_scope := null;
      v_payload := null;
      v_record := null;
      v_evidence := null;
      v_refs := null;

      execute $query$
        select a.ssl_normalized, l.link_scope
        from meta.source_record_link l
        join core.property_account_current a
          on a.account_id = l.account_id
        where l.source_id ~* $1
          and not a.is_deleted
        order by
          case when l.link_scope = 'exact_property' then 0 else 1 end,
          l.source_id,
          l.source_record_id,
          a.account_id
        limit 1
      $query$
      into v_fixture_ssl, v_fixture_scope
      using v_case.source_pattern;

      if v_fixture_ssl is null then
        v_failures := array_append(
          v_failures,
          'no linked fixture was loaded for ' || v_case.source_label
        );
        continue;
      end if;

      begin
        execute 'set local role mcp_runtime';
        execute format(
          'select api_v1.%I($1, null, $2)',
          v_case.api_function
        )
        into v_payload
        using
          v_fixture_ssl,
          jsonb_build_object(
            'record_types', jsonb_build_array(v_case.record_type),
            'limit', 500
          );
        execute 'reset role';
      exception when others then
        execute 'reset role';
        v_failures := array_append(
          v_failures,
          v_case.api_function || ' failed for a discovered ' ||
            v_case.source_label || ' fixture'
        );
        continue;
      end;

      if v_payload->>'status' is distinct from 'resolved' then
        v_failures := array_append(
          v_failures,
          v_case.api_function || ' did not resolve the discovered ' ||
            v_case.source_label || ' fixture'
        );
        continue;
      end if;

      if coalesce((v_payload->>'limit')::integer, 0) <> 50
         or jsonb_array_length(
           coalesce(v_payload->'records', '[]'::jsonb)
         ) > 50
         or not (v_payload ? 'total_count')
         or not (v_payload ? 'has_more')
         or not (v_payload ? 'next_cursor') then
        v_failures := array_append(
          v_failures,
          v_case.api_function ||
            ' does not enforce the 50-record database page contract'
        );
      end if;

      select item
      into v_record
      from jsonb_array_elements(
        coalesce(v_payload->'records', '[]'::jsonb)
      ) item
      where item->>'record_type' = v_case.record_type
      limit 1;

      if v_record is null then
        v_failures := array_append(
          v_failures,
          v_case.api_function || ' omitted its linked ' ||
            v_case.record_type || ' record'
        );
        continue;
      end if;

      if coalesce(v_record->>'source_id', '') = ''
         or coalesce(v_record->>'source_record_id', '') !~ '^[0-9]+$'
         or v_record#>>'{property_link,scope}' not in (
           'exact_property',
           'shared_building',
           'multi_parcel',
           'proximity_context'
         )
         or coalesce(
           (v_record#>>'{property_link,confidence}')::numeric,
           -1
         ) not between 0 and 1 then
        v_failures := array_append(
          v_failures,
          v_case.record_type ||
            ' lacks source identity or an explicit exact/contextual link label'
        );
      end if;

      execute $query$
        select exists (
          select 1
          from meta.source_record_link l
          join core.property_account_current a
            on a.account_id = l.account_id
          where a.ssl_normalized = $1
            and l.source_id = $2
            and l.source_record_id::text = $3
            and l.link_scope = $4
        )
      $query$
      into v_link_exists
      using
        v_fixture_ssl,
        v_record->>'source_id',
        v_record->>'source_record_id',
        v_record#>>'{property_link,scope}';

      if not v_link_exists then
        v_failures := array_append(
          v_failures,
          v_case.record_type ||
            ' returned a property-link label not backed by the link registry'
        );
      end if;

      v_refs := jsonb_path_query_array(
        v_record,
        '$.**.source_refs[*]'
      );

      if jsonb_array_length(v_refs) = 0 then
        v_failures := array_append(
          v_failures,
          v_case.record_type || ' has no field-level source refs'
        );
        continue;
      end if;

      for v_ref in
        select value
        from jsonb_array_elements_text(v_refs) refs(value)
      loop
        if split_part(v_ref, '|', 1) <>
             coalesce(v_record->>'source_id', '')
           or split_part(v_ref, '|', 2) <>
             coalesce(v_record->>'source_record_id', '')
           or split_part(v_ref, '|', 3) in (
             '',
             'property_account',
             'search_result'
           )
           or split_part(v_ref, '|', 4) <> v_fixture_ssl then
          v_failures := array_append(
            v_failures,
            v_case.record_type ||
              ' contains a source ref not bound to its source record and property'
          );
          exit;
        end if;
      end loop;

      select value
      into v_ref
      from jsonb_array_elements_text(v_refs) refs(value)
      limit 1;

      begin
        execute 'set local role mcp_runtime';
        select api_v1.get_source_evidence(array[v_ref])
          into v_evidence;
        execute 'reset role';
      exception when others then
        execute 'reset role';
        v_failures := array_append(
          v_failures,
          'evidence expansion failed for ' || v_case.record_type
        );
        continue;
      end;

      if v_evidence->>'status' is distinct from 'ok'
         or not exists (
           select 1
           from jsonb_array_elements_text(
             jsonb_path_query_array(
               v_evidence,
               '$.**.portal_url'
             )
           ) urls(value)
           where urls.value ~* v_case.portal_pattern
         ) then
        v_failures := array_append(
          v_failures,
          v_case.record_type ||
            ' lacks its approved official human verification portal'
        );
      end if;

      for v_portal_url in
        select value
        from jsonb_array_elements_text(
          jsonb_path_query_array(
            coalesce(v_evidence, '{}'::jsonb),
            '$.**.portal_url'
          )
        ) urls(value)
      loop
        if v_portal_url !~ '^https://'
           or v_portal_url ~*
             '(services\.arcgis\.com|featureserver|mapserver|/rest/|/api/|\.csv([?#]|$)|\.json([?#]|$)|[?&](f|format)=(json|pjson|geojson|csv|html)|/_/retrieve/|file__=|params__=)' then
          v_failures := array_append(
            v_failures,
            v_case.record_type ||
              ' evidence contains a machine or session-bound URL'
          );
          exit;
        end if;
      end loop;
    end loop;
  end if;

  -- Runtime can execute curated APIs but cannot read serving tables directly.
  for v_table in
    select t.table_schema, t.table_name
    from information_schema.tables t
    where t.table_type = 'BASE TABLE'
      and (
        t.table_schema in ('regulatory', 'property_context')
        or (
          t.table_schema = 'meta'
          and t.table_name in (
            'source_record_link',
            'evidence_locator'
          )
        )
      )
    order by t.table_schema, t.table_name
  loop
    foreach v_role in array array[
      'public',
      'mcp_runtime',
      'anon',
      'authenticated'
    ] loop
      if (v_role = 'public' or to_regrole(v_role) is not null)
         and has_table_privilege(
           v_role,
           format('%I.%I', v_table.table_schema, v_table.table_name),
           'select'
         ) then
        v_failures := array_append(
          v_failures,
          v_role || ' has direct SELECT on ' ||
            format('%I.%I', v_table.table_schema, v_table.table_name)
        );
      end if;
    end loop;
  end loop;

  foreach v_function_name in array array[
    'get_permit_history',
    'get_license_history',
    'get_inspection_and_enforcement_history',
    'get_building_and_land_profile'
  ] loop
    v_function_signature :=
      'api_v1.' || v_function_name || '(text,text,jsonb)';
    if to_regprocedure(v_function_signature) is not null then
      if not has_function_privilege(
        'mcp_runtime',
        v_function_signature,
        'execute'
      ) then
        v_failures := array_append(
          v_failures,
          'mcp_runtime cannot execute ' || v_function_signature
        );
      end if;

      foreach v_role in array array[
        'public',
        'anon',
        'authenticated'
      ] loop
        if (v_role = 'public' or to_regrole(v_role) is not null)
           and has_function_privilege(
             v_role,
             v_function_signature,
             'execute'
           ) then
          v_failures := array_append(
            v_failures,
            v_role || ' can execute ' || v_function_signature
          );
        end if;
      end loop;
    end if;
  end loop;

  if cardinality(v_failures) > 0 then
    raise exception 'v0.4 regulatory contract failures: %',
      array_to_string(v_failures, '; ');
  end if;
end
$$;

rollback;
