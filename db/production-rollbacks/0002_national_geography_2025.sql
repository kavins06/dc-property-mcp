begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quoin-national-production-migration', 0)
);

do $guard$
declare
  v_hash text := pg_catalog.current_setting('quoin.rollback_sha256', true);
  v_target text := pg_catalog.current_setting('quoin.rollback_target_class', true);
begin
  if pg_catalog.current_database() <> 'dc_property'
     or v_hash is null or v_hash !~ '^[0-9a-f]{64}$'
     or v_target not in ('rehearsal', 'production')
     or (select pg_catalog.count(*) from meta.production_migration) <> 2
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-foundation-v1'
         and migration_sha256 = 'b84cee659122185318d3abc11c2097a00949882586b45fefa140de0a702b2ffe'
     )
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-geography-2025'
         and migration_sha256 = '04c01e855b78a43e78ef6c43b48f9d52937bd188451f0178c4063d9942a3e87d'
     )
     or (select pg_catalog.count(*) from geo.area) <> 3275
     or (select pg_catalog.count(*) from geo.area_identifier) <> 9823
     or (select pg_catalog.count(*) from geo.area_relation) <> 3274
     or (select pg_catalog.count(*) from meta.publication_set_member) <> 1 then
    raise exception 'national geography rollback target does not match the reviewed seed'
      using errcode = '55000';
  end if;
end;
$guard$;

set local role api_owner;

create or replace function api_v1.list_national_jurisdictions(
  p_state_code text default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, geo, meta
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'area_uid', a.area_uid,
        'name', a.official_name,
        'area_kind', a.area_kind,
        'country_code', a.country_code,
        'state_code', a.state_code,
        'availability', m.availability_status,
        'reason', m.availability_reason,
        'contract_version', p.contract_version
      ) order by a.state_code nulls first, a.official_name, a.area_uid
    ),
    '[]'::jsonb
  )
  from meta.publication_set_pointer pp
  join meta.publication_set p
    on p.publication_set_id = pp.publication_set_id
   and p.publication_status = 'active'
  join meta.publication_set_member m
    on m.publication_set_id = p.publication_set_id
  join geo.area a on a.area_uid = m.area_uid
  where pp.pointer_name = 'national-v1'
    and (p_state_code is null or a.state_code = upper(btrim(p_state_code)));
$function$;

create or replace function api_v1.get_national_jurisdiction_availability(
  p_state_code text,
  p_area_uid text default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, geo, meta
as $function$
  select coalesce(
    (
      select jsonb_build_object(
        'area_uid', a.area_uid,
        'name', a.official_name,
        'area_kind', a.area_kind,
        'state_code', a.state_code,
        'availability', m.availability_status,
        'reason', m.availability_reason,
        'contract_version', p.contract_version
      )
      from meta.publication_set_pointer pp
      join meta.publication_set p
        on p.publication_set_id = pp.publication_set_id
       and p.publication_status = 'active'
      join meta.publication_set_member m
        on m.publication_set_id = p.publication_set_id
      join geo.area a on a.area_uid = m.area_uid
      where pp.pointer_name = 'national-v1'
        and a.state_code = upper(btrim(p_state_code))
        and (p_area_uid is null or a.area_uid = p_area_uid)
      order by a.area_uid
      limit 1
    ),
    jsonb_build_object(
      'area_uid', p_area_uid,
      'state_code', upper(btrim(p_state_code)),
      'availability', 'unavailable',
      'reason', 'No public property records are available for this jurisdiction yet.',
      'contract_version', 'national-v1'
    )
  );
$function$;

reset role;
set local role dc_property_admin;
grant usage on schema meta to data_owner;
set local role data_owner;

delete from geo.area_relation
where child_area_uid not in ('area_us', 'area_us_dc');

delete from geo.area_identifier
where area_uid not in ('area_us', 'area_us_dc')
   or (area_uid = 'area_us_dc' and identifier_namespace = 'GEOIDFQ');

delete from geo.area
where area_uid not in ('area_us', 'area_us_dc');

delete from meta.production_migration
where migration_key = 'national-geography-2025';

reset role;
set local role dc_property_admin;
revoke usage on schema meta from data_owner;
reset role;

commit;
