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
     or (select pg_catalog.count(*) from meta.production_migration) <> 4
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-contract-facade-v1'
         and migration_sha256 = 'e5f7f15ac71b0051220b50387c532886d8a81a8f0beeee1365dc5d3009998318'
     ) then
    raise exception 'national contract facade rollback target is invalid'
      using errcode = '55000';
  end if;
end;
$guard$;

set local role api_owner;
drop function api_v1.search_national_properties(text, text, text, text, text, text, integer, text);
drop function api_v1.get_national_building(text, text, text, text, text, text);
drop function api_v1.get_national_property(text, text, text, text, text, text);
drop function api_v1.resolve_national_property(text, text, text, text, text, text);
drop function api_v1._national_jurisdiction_context(text, text, text);
drop function api_v1.list_national_subjurisdictions(text);

reset role;
set local role dc_property_admin;
grant usage on schema meta to data_owner;
set local role data_owner;
delete from meta.production_migration
where migration_key = 'national-contract-facade-v1';

reset role;
set local role dc_property_admin;
revoke usage on schema meta from data_owner;
reset role;

commit;
