begin;

do $contract$
declare
  v_count bigint;
begin
  if (select count(*) from geo.area) <> 3275 then
    raise exception 'national area seed does not contain 3,275 areas';
  end if;
  if (
    select count(*) from geo.area
    where area_kind in ('state', 'district', 'territory')
  ) <> 52 then
    raise exception 'national state/district/territory roster does not contain 52 areas';
  end if;
  if (
    select count(*) from geo.area
    where area_kind in ('county', 'county_equivalent', 'independent_city')
  ) <> 3222 then
    raise exception 'national county-equivalent roster does not contain 3,222 areas';
  end if;
  if (select count(*) from geo.area_identifier) <> 9823
     or (select count(*) from geo.area_relation) <> 3274 then
    raise exception 'national geography identifiers or parent relations are incomplete';
  end if;
  if (select count(*) from geo.area where state_code = 'MD' and area_kind in ('county', 'county_equivalent', 'independent_city')) <> 24
     or (select count(*) from geo.area where state_code = 'VA' and area_kind in ('county', 'county_equivalent', 'independent_city')) <> 133 then
    raise exception 'Maryland or Virginia jurisdiction roster is incomplete';
  end if;
  if (select area_kind from geo.area where area_uid = 'area_us_va_county_51510') <> 'independent_city'
     or (select area_kind from geo.area where area_uid = 'area_us_md_county_24510') <> 'independent_city' then
    raise exception 'independent-city classification is incorrect';
  end if;
  if (select count(*) from meta.production_migration) not in (2, 3)
     or exists (
       select 1 from meta.production_migration
       where migration_key not in (
         'national-foundation-v1',
         'national-geography-2025',
         'national-availability-reason-v1'
       )
     )
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-geography-2025'
         and migration_sha256 ~ '^[0-9a-f]{64}$'
     )
     or exists (
       select 1 from meta.production_migration
       where migration_key = 'national-availability-reason-v1'
         and migration_sha256 <> 'b151a3bb896b5f4b21dc8efb55af54546dd37c6397c0c70573a81f24e72ccaab'
     ) then
    raise exception 'national geography migration ledger is incomplete';
  end if;
  if (select count(*) from meta.publication_set_member) <> 1
     or not exists (
       select 1 from meta.publication_set_member
       where area_uid = 'area_us_dc' and availability_status = 'available'
     ) then
    raise exception 'geography seed changed D.C.-only publication membership';
  end if;
end;
$contract$;

set local role mcp_runtime;

do $runtime_contract$
declare
  v_all jsonb := api_v1.list_national_jurisdictions(null);
  v_md jsonb := api_v1.get_national_jurisdiction_availability('MD', null);
  v_va_city jsonb := api_v1.get_national_jurisdiction_availability(
    'VA', 'area_us_va_county_51510'
  );
begin
  if pg_catalog.jsonb_array_length(v_all) <> 52 then
    raise exception 'national jurisdiction discovery does not return 52 areas';
  end if;
  if (
    select count(*)
    from pg_catalog.jsonb_array_elements(v_all) item
    where item->>'availability' = 'available'
  ) <> 1 then
    raise exception 'a non-D.C. jurisdiction became available';
  end if;
  if v_md->>'availability' <> 'unavailable'
     or v_va_city->>'availability' <> 'unavailable'
     or v_va_city->>'area_kind' <> 'independent_city' then
    raise exception 'unpublished Maryland/Virginia availability is incorrect';
  end if;
end;
$runtime_contract$;

reset role;
rollback;
