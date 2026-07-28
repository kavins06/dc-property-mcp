begin;

do $$
declare
  v_failures text[] := array[]::text[];
  v_table record;
  v_source_id text;
  v_release_id bigint;
  v_record_id bigint;
  v_context_record_id bigint;
  v_exact_link_id bigint;
  v_context_link_id bigint;
  v_api_visible_count bigint;
  v_account_ids bigint[];
  v_token text :=
    md5(clock_timestamp()::text || random()::text);
begin
  foreach v_source_id in array array[
    'meta.source_release',
    'meta.source_release_pointer',
    'meta.ingest_quality_result',
    'meta.source_record_link',
    'regulatory.record',
    'regulatory.building_permit',
    'regulatory.business_license',
    'regulatory.certificate_of_occupancy',
    'regulatory.inspection',
    'regulatory.enforcement_action',
    'property_context.cama_building_profile',
    'property_context.energy_benchmark',
    'property_context.energy_benchmark_property_link',
    'property_context.beps_compliance',
    'property_context.beps_property_link',
    'property_context.vacant_blighted_status',
    'property_context.land_designation',
    'property_context.land_designation_property_link',
    'core.property_public_record_summary'
  ] loop
    if to_regclass(v_source_id) is null then
      v_failures := array_append(
        v_failures,
        'missing table ' || v_source_id
      );
    end if;
  end loop;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'meta'
      and table_name = 'source_record_link'
    group by table_schema, table_name
    having array_agg(column_name::text) @> array[
      'source_id',
      'source_release_id',
      'source_record_id',
      'account_id',
      'link_status',
      'link_scope',
      'link_method',
      'match_quality',
      'link_confidence'
    ]
  ) then
    v_failures := array_append(
      v_failures,
      'canonical source-record link dimensions are incomplete'
    );
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema in ('regulatory', 'property_context')
      and column_name in (
        'source_record_id',
        'source_row_number',
        'mar_id',
        'source_mar_id'
      )
      and data_type <> 'bigint'
  ) then
    v_failures := array_append(
      v_failures,
      'a source/MAR identifier is not bigint'
    );
  end if;

  if exists (
    select 1
    from information_schema.tables t
    where t.table_type = 'BASE TABLE'
      and t.table_schema in ('regulatory', 'property_context')
      and exists (
        select 1
        from information_schema.columns c
        where c.table_schema = t.table_schema
          and c.table_name = t.table_name
          and c.column_name = 'source_record_id'
      )
      and not exists (
        select 1
        from information_schema.columns c
        where c.table_schema = t.table_schema
          and c.table_name = t.table_name
          and c.column_name = 'source_row_sha256'
          and c.data_type = 'text'
      )
  ) then
    v_failures := array_append(
      v_failures,
      'a materialized source table lacks its source-row hash'
    );
  end if;

  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'regulatory.record'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%certificate_of_occupancy%'
      and pg_get_constraintdef(c.oid) like
        '%public_space_construction_permit%'
      and pg_get_constraintdef(c.oid) like '%special_tree_permit%'
      and pg_get_constraintdef(c.oid) like '%alcohol_license%'
      and pg_get_constraintdef(c.oid) like '%cannabis_license%'
  ) then
    v_failures := array_append(
      v_failures,
      'regulatory record kinds do not cover the acquired source families'
    );
  end if;

  for v_table in
    select n.nspname table_schema, c.relname table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and (
        n.nspname in ('regulatory', 'property_context')
        or (
          n.nspname = 'meta'
          and c.relname in (
            'source_release',
            'source_release_pointer',
            'ingest_quality_result',
            'source_record_link'
          )
        )
        or (
          n.nspname = 'core'
          and c.relname = 'property_public_record_summary'
        )
      )
      and (
        not c.relrowsecurity
        or not exists (
          select 1
          from pg_policy p
          where p.polrelid = c.oid
            and p.polname = 'api_owner_read'
            and p.polcmd = 'r'
            and p.polroles = array[to_regrole('api_owner')::oid]
            and pg_get_expr(p.polqual, p.polrelid) = 'true'
        )
      )
  loop
    v_failures := array_append(
      v_failures,
      format(
        '%I.%I lacks its API-owner-only read policy',
        v_table.table_schema,
        v_table.table_name
      )
    );
  end loop;

  for v_table in
    select t.table_schema, t.table_name
    from information_schema.tables t
    where t.table_type = 'BASE TABLE'
      and (
        t.table_schema in ('regulatory', 'property_context')
        or (
          t.table_schema = 'meta'
          and t.table_name in (
            'source_release',
            'source_release_pointer',
            'ingest_quality_result',
            'source_record_link'
          )
        )
        or (
          t.table_schema = 'core'
          and t.table_name = 'property_public_record_summary'
        )
      )
  loop
    if has_table_privilege(
      'mcp_runtime',
      format('%I.%I', v_table.table_schema, v_table.table_name),
      'select'
    ) then
      v_failures := array_append(
        v_failures,
        'runtime has direct SELECT on ' ||
          format('%I.%I', v_table.table_schema, v_table.table_name)
      );
    end if;
  end loop;

  if has_schema_privilege('mcp_runtime', 'regulatory', 'usage')
     or has_schema_privilege(
       'mcp_runtime',
       'property_context',
       'usage'
     ) then
    v_failures := array_append(
      v_failures,
      'runtime has direct usage on a new data schema'
    );
  end if;

  select source_id
  into v_source_id
  from meta.source_asset
  order by source_id
  limit 1;

  select array_agg(account_id order by account_id)
  into v_account_ids
  from (
    select account_id
    from core.property_account_current
    order by account_id
    limit 2
  ) accounts;

  if v_source_id is null or cardinality(v_account_ids) <> 2 then
    v_failures := array_append(
      v_failures,
      'production fixtures required for constraint checks are unavailable'
    );
  else
    insert into meta.source_release (
      source_id,
      release_key,
      release_status,
      quality_status,
      snapshot_retrieved_at,
      archive_object_key,
      bytes,
      row_count,
      sha256,
      schema_sha256
    ) values (
      v_source_id,
      '__schema_contract__' || v_token,
      'validated',
      'passed',
      clock_timestamp(),
      '__schema_contract__/' || v_token,
      0,
      0,
      v_token || v_token,
      reverse(v_token) || reverse(v_token)
    )
    returning release_id into v_release_id;

    insert into regulatory.record (
      source_id,
      source_release_id,
      source_record_id,
      source_row_sha256,
      record_kind,
      record_number
    ) values (
      v_source_id,
      v_release_id,
      4000000000,
      v_token || v_token,
      'building_permit',
      '__schema_contract_exact__'
    )
    returning record_id into v_record_id;

    insert into regulatory.record (
      source_id,
      source_release_id,
      source_record_id,
      source_row_sha256,
      record_kind,
      record_number
    ) values (
      v_source_id,
      v_release_id,
      4000000001,
      reverse(v_token) || reverse(v_token),
      'public_space_construction_permit',
      '__schema_contract_context__'
    )
    returning record_id into v_context_record_id;

    insert into meta.source_record_link (
      source_id,
      source_release_id,
      source_record_id,
      account_id,
      link_status,
      link_scope,
      link_method,
      match_quality,
      link_confidence
    ) values (
      v_source_id,
      v_release_id,
      4000000000,
      v_account_ids[1],
      'linked',
      'exact_property',
      'ssl',
      'exact',
      1
    )
    returning source_record_link_id into v_exact_link_id;

    insert into meta.source_record_link (
      source_id,
      source_release_id,
      source_record_id,
      account_id,
      link_status,
      link_scope,
      link_method,
      match_quality,
      link_confidence
    ) values (
      v_source_id,
      v_release_id,
      4000000001,
      v_account_ids[1],
      'linked',
      'shared_building',
      'ubid',
      'contextual',
      0.8
    )
    returning source_record_link_id into v_context_link_id;

    insert into meta.source_record_link (
      source_id,
      source_release_id,
      source_record_id,
      account_id,
      link_status,
      link_scope,
      link_method,
      match_quality,
      link_confidence
    ) values (
      v_source_id,
      v_release_id,
      4000000001,
      v_account_ids[2],
      'linked',
      'shared_building',
      'ubid',
      'contextual',
      0.8
    );

    begin
      execute 'set local role api_owner';
      select count(*)
      into v_api_visible_count
      from regulatory.record
      where source_release_id = v_release_id;
      execute 'reset role';
    exception when others then
      execute 'reset role';
      raise;
    end;

    if v_api_visible_count <> 2 then
      v_failures := array_append(
        v_failures,
        'API owner cannot read the RLS-protected serving records'
      );
    end if;

    begin
      insert into meta.source_record_link (
        source_id,
        source_release_id,
        source_record_id,
        account_id,
        link_status,
        link_scope,
        link_method,
        match_quality,
        link_confidence
      ) values (
        v_source_id,
        v_release_id,
        4000000002,
        v_account_ids[1],
        'linked',
        'shared_building',
        'ubid',
        'exact',
        1
      );
      v_failures := array_append(
        v_failures,
        'shared-building context was accepted as exact'
      );
    exception when check_violation then
      null;
    end;

    begin
      insert into meta.source_record_link (
        source_id,
        source_release_id,
        source_record_id,
        account_id,
        link_status,
        match_quality
      ) values (
        v_source_id,
        v_release_id,
        4000000003,
        v_account_ids[1],
        'unlinked',
        'unlinked'
      );
      v_failures := array_append(
        v_failures,
        'an unlinked source record accepted an account_id'
      );
    exception when check_violation then
      null;
    end;
  end if;

  if cardinality(v_failures) > 0 then
    raise exception '0021 schema contract failures: %',
      array_to_string(v_failures, '; ');
  end if;
end
$$;

rollback;
