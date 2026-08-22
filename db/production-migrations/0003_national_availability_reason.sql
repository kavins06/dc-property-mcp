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
     or exists (
       select 1 from meta.production_migration
       where migration_key = 'national-availability-reason-v1'
     ) then
    raise exception 'national availability correction target is invalid'
      using errcode = '55000';
  end if;
end;
$guard$;

set local role api_owner;

create or replace function api_v1.list_national_jurisdictions(
  p_state_code text default null
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, geo, meta
as $function$
  with active_publication as (
    select p.publication_set_id, p.contract_version
    from meta.publication_set_pointer pp
    join meta.publication_set p using (publication_set_id)
    where pp.pointer_name = 'national-v1' and p.publication_status = 'active'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'area_uid', a.area_uid, 'name', a.official_name, 'area_kind', a.area_kind,
    'country_code', a.country_code, 'state_code', a.state_code,
    'availability', coalesce(m.availability_status, 'unavailable'),
    'reason', case
      when m.availability_status = 'available' then m.availability_reason
      else coalesce(m.availability_reason, 'No public property records are available for this jurisdiction yet.')
    end,
    'contract_version', coalesce(p.contract_version, 'national-v1')
  ) order by a.state_code, a.official_name, a.area_uid), '[]'::jsonb)
  from geo.area a
  left join active_publication p on true
  left join meta.publication_set_member m
    on m.publication_set_id = p.publication_set_id and m.area_uid = a.area_uid
  where a.area_kind in ('state', 'district', 'territory')
    and (p_state_code is null or a.state_code = upper(btrim(p_state_code)));
$function$;

create or replace function api_v1.get_national_jurisdiction_availability(
  p_state_code text,
  p_area_uid text default null
)
returns jsonb language sql stable security definer
set search_path = pg_catalog, geo, meta
as $function$
  with active_publication as (
    select p.publication_set_id, p.contract_version
    from meta.publication_set_pointer pp
    join meta.publication_set p using (publication_set_id)
    where pp.pointer_name = 'national-v1' and p.publication_status = 'active'
  )
  select coalesce((
    select jsonb_build_object(
      'area_uid', a.area_uid, 'name', a.official_name, 'area_kind', a.area_kind,
      'state_code', a.state_code,
      'availability', coalesce(m.availability_status, 'unavailable'),
      'reason', case
        when m.availability_status = 'available' then m.availability_reason
        else coalesce(m.availability_reason, 'No public property records are available for this jurisdiction yet.')
      end,
      'contract_version', coalesce(p.contract_version, 'national-v1')
    )
    from geo.area a
    left join active_publication p on true
    left join meta.publication_set_member m
      on m.publication_set_id = p.publication_set_id and m.area_uid = a.area_uid
    where a.state_code = upper(btrim(p_state_code))
      and (p_area_uid is null or a.area_uid = p_area_uid)
    order by case when a.area_uid = 'area_us_' || lower(btrim(p_state_code)) then 0 else 1 end, a.area_uid
    limit 1
  ), jsonb_build_object(
    'area_uid', p_area_uid, 'state_code', upper(btrim(p_state_code)),
    'availability', 'unavailable',
    'reason', 'No public property records are available for this jurisdiction yet.',
    'contract_version', 'national-v1'
  ));
$function$;

reset role;
set local role dc_property_admin;
grant usage on schema meta to data_owner;
set local role data_owner;
insert into meta.production_migration (
  migration_key, migration_sha256, target_class
) values (
  'national-availability-reason-v1',
  pg_catalog.current_setting('quoin.migration_sha256'),
  pg_catalog.current_setting('quoin.migration_target_class')
);

reset role;
set local role dc_property_admin;
revoke usage on schema meta from data_owner;
reset role;

commit;
