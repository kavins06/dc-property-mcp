begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quoin-national-production-migration', 0)
);

do $guard$
declare
  v_hash text := pg_catalog.current_setting('quoin.rollback_sha256', true);
  v_target text := pg_catalog.current_setting('quoin.rollback_target_class', true);
  v_active bigint;
begin
  select pg_catalog.count(*) into v_active
  from core.property_account_current where not is_deleted;

  if pg_catalog.current_database() <> 'dc_property'
     or v_hash is null or v_hash !~ '^[0-9a-f]{64}$'
     or v_target not in ('rehearsal', 'production')
     or (select pg_catalog.count(*) from meta.production_migration) <> 1
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-foundation-v1'
         and migration_sha256 = 'b84cee659122185318d3abc11c2097a00949882586b45fefa140de0a702b2ffe'
     )
     or (select pg_catalog.count(*) from geo.area) <> 2
     or (select pg_catalog.count(*) from geo.area_identifier) <> 3
     or (select pg_catalog.count(*) from geo.area_relation) <> 1
     or (select pg_catalog.count(*) from meta.release_generation) <> 1
     or (select pg_catalog.count(*) from meta.property_identity) <> v_active
     or (select pg_catalog.count(*) from meta.property_identifier) <> v_active
     or (select pg_catalog.count(*) from meta.generation_property) <> v_active
     or (select pg_catalog.count(*) from meta.publication_set) <> 1
     or (select pg_catalog.count(*) from meta.publication_set_member) <> 1
     or (select pg_catalog.count(*) from meta.publication_set_pointer) <> 1 then
    raise exception 'national foundation rollback target does not match the reviewed D.C. adapter'
      using errcode = '55000';
  end if;
end;
$guard$;

set local role api_owner;
drop function api_v1.list_national_jurisdictions(text);
drop function api_v1.get_national_jurisdiction_availability(text, text);

reset role;
set local role dc_property_admin;
grant usage on schema meta to data_owner;
set local role data_owner;

drop table meta.publication_set_pointer;
drop table meta.publication_set_member;
drop table meta.publication_set;
drop table meta.generation_coverage;
drop table meta.generation_property;
drop table meta.property_identifier;
drop table meta.property_identity;
drop table meta.generation_jurisdiction;
drop table meta.generation_source;
drop table meta.legacy_dc_binding;
drop table meta.release_generation;
drop table meta.authority_scope;
drop table meta.issuing_authority;
drop table meta.production_migration;
drop function meta.require_national_publication_approval();
drop table geo.area_relation;
drop table geo.area_identifier;
drop table geo.area;
drop schema geo;

reset role;
set local role dc_property_admin;
drop extension pgcrypto;

revoke usage on schema meta from data_owner;
reset role;

commit;
