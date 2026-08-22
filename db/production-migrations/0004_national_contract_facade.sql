begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quoin-national-production-migration', 0)
);

do $guard$
declare
  v_hash text := pg_catalog.current_setting('quoin.migration_sha256', true);
  v_target text := pg_catalog.current_setting('quoin.migration_target_class', true);
begin
  if pg_catalog.current_database() <> 'dc_property'
     or v_hash is null or v_hash !~ '^[0-9a-f]{64}$'
     or v_target not in ('rehearsal', 'production')
     or (select pg_catalog.count(*) from meta.production_migration) <> 3
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-availability-reason-v1'
         and migration_sha256 = 'b151a3bb896b5f4b21dc8efb55af54546dd37c6397c0c70573a81f24e72ccaab'
     )
     or exists (
       select 1 from meta.production_migration
       where migration_key = 'national-contract-facade-v1'
     ) then
    raise exception 'national contract facade target is invalid'
      using errcode = '55000';
  end if;
end;
$guard$;

set local role api_owner;

create function api_v1.list_national_subjurisdictions(p_state_code text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, geo, meta, pg_temp
as $function$
  with active_publication as (
    select p.publication_set_id, p.contract_version
    from meta.publication_set_pointer pp
    join meta.publication_set p using (publication_set_id)
    where pp.pointer_name = 'national-v1'
      and p.publication_status = 'active'
      and p.contract_version = 'national-v1'
  )
  select case
    when p_state_code is null or upper(btrim(p_state_code)) not in ('DC', 'MD', 'VA') then
      jsonb_build_object(
        'status', 'invalid_request',
        'error_code', 'unsupported_state_code',
        'contract_version', 'national-v1'
      )
    else jsonb_build_object(
      'status', 'ok',
      'state_code', upper(btrim(p_state_code)),
      'contract_version', coalesce((select contract_version from active_publication), 'national-v1'),
      'jurisdictions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'area_uid', a.area_uid,
          'name', a.official_name,
          'area_kind', a.area_kind,
          'state_code', a.state_code,
          'fips_code', ai.raw_identifier,
          'availability', coalesce(m.availability_status, 'unavailable'),
          'reason', case
            when m.availability_status = 'available' then m.availability_reason
            else coalesce(m.availability_reason, 'No public property records are available for this jurisdiction yet.')
          end
        ) order by ai.raw_identifier)
        from geo.area a
        join geo.area_identifier ai
          on ai.area_uid = a.area_uid
         and ai.identifier_authority = 'US_CENSUS'
         and ai.identifier_namespace = 'COUNTY_FIPS'
         and ai.valid_to is null
        left join active_publication p on true
        left join meta.publication_set_member m
          on m.publication_set_id = p.publication_set_id
         and m.area_uid = a.area_uid
        where a.state_code = upper(btrim(p_state_code))
          and a.area_kind in ('county', 'county_equivalent', 'independent_city')
      ), '[]'::jsonb)
    )
  end;
$function$;

create function api_v1._national_jurisdiction_context(
  p_contract_version text,
  p_state_code text,
  p_fips_code text
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, geo, meta, pg_temp
as $function$
declare
  v_area geo.area%rowtype;
begin
  if p_contract_version is distinct from 'national-v1' then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'contract_version_mismatch',
      'contract_version', 'national-v1'
    );
  end if;
  if p_state_code is null or upper(btrim(p_state_code)) not in ('DC', 'MD', 'VA') then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'unsupported_state_code',
      'contract_version', 'national-v1'
    );
  end if;
  if p_fips_code is null or p_fips_code !~ '^[0-9]{5}$' then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'invalid_fips_code',
      'contract_version', 'national-v1'
    );
  end if;

  select a.* into v_area
  from geo.area_identifier ai
  join geo.area a using (area_uid)
  where ai.identifier_authority = 'US_CENSUS'
    and ai.identifier_namespace = 'COUNTY_FIPS'
    and ai.raw_identifier = p_fips_code
    and ai.valid_to is null
    and a.state_code = upper(btrim(p_state_code));

  if not found then
    return jsonb_build_object(
      'status', 'unavailable', 'availability', 'unavailable',
      'error_code', 'jurisdiction_not_found',
      'reason', 'No public property records are available for this jurisdiction yet.',
      'contract_version', 'national-v1',
      'state_code', upper(btrim(p_state_code)), 'fips_code', p_fips_code
    );
  end if;

  if v_area.state_code = 'DC' then
    return jsonb_build_object(
      'status', 'route_required', 'availability', 'available',
      'error_code', 'dc_legacy_route_required',
      'reason', 'Use the existing D.C. property tools for published D.C. records.',
      'contract_version', 'national-v1',
      'jurisdiction', jsonb_build_object(
        'area_uid', v_area.area_uid, 'name', v_area.official_name,
        'area_kind', v_area.area_kind, 'state_code', v_area.state_code,
        'fips_code', p_fips_code
      )
    );
  end if;

  return jsonb_build_object(
    'status', 'unavailable', 'availability', 'unavailable',
    'error_code', 'national_property_data_unavailable',
    'reason', 'No public property records are available for this jurisdiction yet.',
    'contract_version', 'national-v1',
    'jurisdiction', jsonb_build_object(
      'area_uid', v_area.area_uid, 'name', v_area.official_name,
      'area_kind', v_area.area_kind, 'state_code', v_area.state_code,
      'fips_code', p_fips_code
    )
  );
end;
$function$;

create function api_v1.resolve_national_property(
  p_contract_version text, p_state_code text, p_fips_code text,
  p_property_kind text, p_native_id text, p_address text
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, api_v1, pg_temp
as $function$
declare v_context jsonb;
begin
  v_context := api_v1._national_jurisdiction_context(p_contract_version, p_state_code, p_fips_code);
  if v_context->>'status' = 'invalid_request' then return v_context; end if;
  if p_property_kind is null
     or p_property_kind not in ('tax_account', 'parcel', 'building', 'unit', 'land_interest', 'address')
     or pg_catalog.length(coalesce(p_native_id, '')) > 256
     or pg_catalog.length(coalesce(p_address, '')) > 160
     or (nullif(btrim(p_native_id), '') is null and nullif(btrim(p_address), '') is null) then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'invalid_property_identity',
      'contract_version', 'national-v1'
    );
  end if;
  return v_context || jsonb_build_object('property_kind', p_property_kind, 'matches', '[]'::jsonb);
end;
$function$;

create function api_v1.get_national_property(
  p_contract_version text, p_state_code text, p_fips_code text,
  p_property_kind text, p_native_id text, p_address text
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, api_v1, pg_temp
as $function$
  select api_v1.resolve_national_property(
    p_contract_version, p_state_code, p_fips_code,
    p_property_kind, p_native_id, p_address
  ) - 'matches';
$function$;

create function api_v1.get_national_building(
  p_contract_version text, p_state_code text, p_fips_code text,
  p_source_record_key text, p_native_account_id text, p_camalink text
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, api_v1, pg_temp
as $function$
declare v_context jsonb;
begin
  v_context := api_v1._national_jurisdiction_context(p_contract_version, p_state_code, p_fips_code);
  if v_context->>'status' = 'invalid_request' then return v_context; end if;
  if nullif(btrim(p_source_record_key), '') is null
     and nullif(btrim(p_native_account_id), '') is null
     and nullif(btrim(p_camalink), '') is null then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'building_lookup_key_required',
      'contract_version', 'national-v1'
    );
  end if;
  if pg_catalog.length(coalesce(p_source_record_key, '')) > 512
     or pg_catalog.length(coalesce(p_native_account_id, '')) > 256
     or pg_catalog.length(coalesce(p_camalink, '')) > 256 then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'building_lookup_key_too_long',
      'contract_version', 'national-v1'
    );
  end if;
  return v_context || jsonb_build_object('property_kind', 'building');
end;
$function$;

create function api_v1.search_national_properties(
  p_contract_version text, p_state_code text, p_fips_code text,
  p_property_kind text, p_native_id text, p_address text,
  p_limit integer, p_cursor text
)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, api_v1, pg_temp
as $function$
declare v_context jsonb;
begin
  v_context := api_v1._national_jurisdiction_context(p_contract_version, p_state_code, p_fips_code);
  if v_context->>'status' = 'invalid_request' then return v_context; end if;
  if p_property_kind is null
     or p_property_kind not in ('tax_account', 'parcel', 'building', 'unit', 'land_interest', 'address')
     or pg_catalog.length(coalesce(p_native_id, '')) > 256
     or pg_catalog.length(coalesce(p_address, '')) > 160
     or p_limit is null or p_limit not between 1 and 100
     or pg_catalog.length(coalesce(p_cursor, '')) > 2048 then
    return jsonb_build_object(
      'status', 'invalid_request', 'error_code', 'invalid_search_request',
      'contract_version', 'national-v1'
    );
  end if;
  return v_context || jsonb_build_object(
    'property_kind', p_property_kind, 'records', '[]'::jsonb, 'next_cursor', null
  );
end;
$function$;

revoke all on function api_v1.list_national_subjurisdictions(text) from public;
revoke all on function api_v1._national_jurisdiction_context(text, text, text) from public, mcp_runtime;
revoke all on function api_v1.resolve_national_property(text, text, text, text, text, text) from public;
revoke all on function api_v1.get_national_property(text, text, text, text, text, text) from public;
revoke all on function api_v1.get_national_building(text, text, text, text, text, text) from public;
revoke all on function api_v1.search_national_properties(text, text, text, text, text, text, integer, text) from public;

grant execute on function api_v1.list_national_subjurisdictions(text) to mcp_runtime;
grant execute on function api_v1.resolve_national_property(text, text, text, text, text, text) to mcp_runtime;
grant execute on function api_v1.get_national_property(text, text, text, text, text, text) to mcp_runtime;
grant execute on function api_v1.get_national_building(text, text, text, text, text, text) to mcp_runtime;
grant execute on function api_v1.search_national_properties(text, text, text, text, text, text, integer, text) to mcp_runtime;

reset role;
set local role dc_property_admin;
grant usage on schema meta to data_owner;
set local role data_owner;
insert into meta.production_migration (
  migration_key, migration_sha256, target_class
) values (
  'national-contract-facade-v1',
  pg_catalog.current_setting('quoin.migration_sha256'),
  pg_catalog.current_setting('quoin.migration_target_class')
);

reset role;
set local role dc_property_admin;
revoke usage on schema meta from data_owner;
reset role;

commit;
