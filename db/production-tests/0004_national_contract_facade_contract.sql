begin;

do $contract$
begin
  if (select pg_catalog.count(*) from meta.production_migration) <> 4
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-contract-facade-v1'
         and migration_sha256 ~ '^[0-9a-f]{64}$'
     ) then
    raise exception 'national contract facade ledger is incomplete';
  end if;
end;
$contract$;

set local role mcp_runtime;

do $runtime_contract$
declare
  v_result jsonb;
begin
  v_result := api_v1.list_national_subjurisdictions('MD');
  if v_result->>'status' <> 'ok'
     or pg_catalog.jsonb_array_length(v_result->'jurisdictions') <> 24
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(v_result->'jurisdictions') item
       where item->>'availability' <> 'unavailable'
     ) then
    raise exception 'Maryland discovery contract is invalid';
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_result->'jurisdictions') item
    where item->>'fips_code' = '24031'
      and item->>'name' = 'Montgomery County'
      and item->>'area_kind' = 'county'
  ) then
    raise exception 'Maryland canonical jurisdiction is missing';
  end if;

  v_result := api_v1.list_national_subjurisdictions('VA');
  if v_result->>'status' <> 'ok'
     or pg_catalog.jsonb_array_length(v_result->'jurisdictions') <> 133 then
    raise exception 'Virginia discovery contract is invalid';
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_result->'jurisdictions') item
    where item->>'fips_code' = '51510'
      and item->>'name' = 'Alexandria city'
      and item->>'area_kind' = 'independent_city'
  ) then
    raise exception 'Virginia canonical jurisdiction is missing';
  end if;

  v_result := api_v1.resolve_national_property(
    'national-v1', 'MD', '24031', 'tax_account', 'fixture', null
  );
  if v_result->>'status' <> 'unavailable'
     or v_result->>'availability' <> 'unavailable'
     or v_result->'matches' <> '[]'::jsonb then
    raise exception 'unpublished Maryland did not fail closed';
  end if;

  v_result := api_v1.get_national_property(
    'national-v1', 'DC', '11001', 'tax_account', '01070075', null
  );
  if v_result->>'status' <> 'route_required'
     or v_result->>'availability' <> 'available'
     or v_result->>'error_code' <> 'dc_legacy_route_required'
     or v_result->>'reason' not like 'Use the existing D.C.%' then
    raise exception 'D.C. national compatibility did not retain the legacy route';
  end if;

  if api_v1.resolve_national_property(
    'national-v1', 'MD', '24031', 'tax_account', repeat('x', 257), null
  )->>'error_code' <> 'invalid_property_identity' then
    raise exception 'direct national identity length limit is missing';
  end if;

  if api_v1.get_national_building(
    'national-v1', 'MD', '24031', repeat('x', 513), null, null
  )->>'error_code' <> 'building_lookup_key_too_long' then
    raise exception 'direct national building length limit is missing';
  end if;

  v_result := api_v1.search_national_properties(
    'national-v1', 'VA', '51510', 'parcel', null, null, 20, null
  );
  if v_result->>'status' <> 'unavailable'
     or v_result->'records' <> '[]'::jsonb
     or v_result->'next_cursor' <> 'null'::jsonb then
    raise exception 'unpublished Virginia search did not fail closed';
  end if;

  if api_v1.resolve_national_property(
    'dmv-v2.0', 'MD', '24031', 'tax_account', 'fixture', null
  )->>'status' <> 'invalid_request' then
    raise exception 'contract mismatch did not fail closed';
  end if;
end;
$runtime_contract$;

reset role;

do $privilege_contract$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'api_v1.list_national_subjurisdictions(text)',
    'api_v1.resolve_national_property(text,text,text,text,text,text)',
    'api_v1.get_national_property(text,text,text,text,text,text)',
    'api_v1.get_national_building(text,text,text,text,text,text)',
    'api_v1.search_national_properties(text,text,text,text,text,text,integer,text)'
  ] loop
    if not pg_catalog.has_function_privilege('mcp_runtime', v_signature, 'execute')
       or pg_catalog.has_function_privilege('public', v_signature, 'execute') then
      raise exception 'national facade grant is invalid for %', v_signature;
    end if;
  end loop;

  if pg_catalog.has_function_privilege(
       'mcp_runtime', 'api_v1._national_jurisdiction_context(text,text,text)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'public', 'api_v1._national_jurisdiction_context(text,text,text)', 'execute'
     )
     or pg_catalog.has_table_privilege('mcp_runtime', 'geo.area', 'select') then
    raise exception 'national facade least privilege is invalid';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
      and p.proname in (
        'list_national_subjurisdictions', '_national_jurisdiction_context',
        'resolve_national_property', 'get_national_property',
        'get_national_building', 'search_national_properties'
      )
      and (
        pg_catalog.pg_get_userbyid(p.proowner) <> 'api_owner'
        or not p.prosecdef
        or pg_catalog.array_to_string(p.proconfig, ',') !~
          '^search_path=pg_catalog, (api_v1|geo, meta), pg_temp$'
      )
  ) or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
      and p.proname in (
        'list_national_subjurisdictions', '_national_jurisdiction_context',
        'resolve_national_property', 'get_national_property',
        'get_national_building', 'search_national_properties'
      )
  ) <> 6 then
    raise exception 'national facade ownership or security-definer contract is invalid';
  end if;
end;
$privilege_contract$;

rollback;
