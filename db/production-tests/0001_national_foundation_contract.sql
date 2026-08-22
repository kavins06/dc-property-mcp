begin;

do $contract$
declare
  v_active bigint;
  v_count bigint;
  v_bad bigint;
begin
  if pg_catalog.to_regnamespace('geo') is null then
    raise exception 'geo schema is missing';
  end if;

  select count(*) into v_active
  from core.property_account_current
  where not is_deleted;

  foreach v_count in array array[
    (select count(*) from meta.property_identity),
    (select count(*) from meta.property_identifier),
    (select count(*) from meta.generation_property)
  ] loop
    if v_count <> v_active then
      raise exception 'national identity count %, expected %', v_count, v_active;
    end if;
  end loop;

  select count(*) into v_bad
  from meta.generation_property gp
  join core.property_account_current p on p.account_id = gp.source_account_id
  where p.is_deleted;
  if v_bad <> 0 then
    raise exception 'deleted D.C. accounts entered the national generation';
  end if;

  if (select count(*) from meta.production_migration) <> 1
     or (select migration_key from meta.production_migration)
        <> 'national-foundation-v1'
     or (select migration_sha256 from meta.production_migration)
        !~ '^[0-9a-f]{64}$' then
    raise exception 'production migration ledger is incomplete';
  end if;

  if (select count(*) from meta.publication_set_pointer) <> 1
     or (select count(*) from meta.publication_set_member) <> 1
     or not exists (
       select 1
       from meta.publication_set_pointer pp
       join meta.publication_set p using (publication_set_id)
       join meta.publication_set_member m using (publication_set_id)
       where pp.pointer_name = 'national-v1'
         and p.contract_version = 'national-v1'
         and p.publication_status = 'active'
         and m.area_uid = 'area_us_dc'
         and m.availability_status = 'available'
         and m.generation_id is not null
     ) then
    raise exception 'initial publication is not exactly D.C.-only';
  end if;

  select count(*) into v_bad
  from pg_catalog.pg_index
  where indrelid in (
    select c.oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('geo', 'meta')
  )
    and (not indisvalid or not indisready);
  if v_bad <> 0 then
    raise exception 'national foundation has invalid or unready indexes';
  end if;

  select count(*) into v_bad
  from pg_catalog.pg_constraint c
  join pg_catalog.pg_class r on r.oid = c.conrelid
  join pg_catalog.pg_namespace n on n.oid = r.relnamespace
  where n.nspname in ('geo', 'meta') and not c.convalidated;
  if v_bad <> 0 then
    raise exception 'national foundation has unvalidated constraints';
  end if;

  select count(*) into v_bad
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where (
      n.nspname = 'geo'
      or (n.nspname = 'meta' and c.relname in (
        'production_migration', 'issuing_authority', 'authority_scope',
        'release_generation', 'generation_source',
        'generation_jurisdiction', 'property_identity',
        'property_identifier', 'generation_property',
        'generation_coverage', 'publication_set', 'publication_set_member',
        'publication_set_pointer', 'legacy_dc_binding'
      ))
    )
    and c.relkind in ('r', 'p')
    and pg_catalog.pg_get_userbyid(c.relowner) <> 'data_owner';
  if v_bad <> 0 then
    raise exception 'national table ownership drifted on % objects', v_bad;
  end if;

  if pg_catalog.has_table_privilege(
       'mcp_runtime', 'meta.property_identity', 'select'
     )
     or not pg_catalog.has_function_privilege(
       'mcp_runtime', 'api_v1.list_national_jurisdictions(text)', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'mcp_runtime',
       'api_v1.get_national_jurisdiction_availability(text,text)',
       'execute'
     ) then
    raise exception 'runtime privilege boundary is incorrect';
  end if;
end;
$contract$;

set local role dc_property_admin;

do $publication_guard$
begin
  begin
    insert into meta.publication_set (
      contract_version, publication_sha256, publication_status
    )
    values ('national-v1', repeat('0', 64), 'draft');
    raise exception 'publication guard accepted an unapproved write';
  exception
    when sqlstate '55000' then null;
  end;
end;
$publication_guard$;

reset role;
set local role mcp_runtime;

do $runtime_contract$
declare
  v_dc jsonb;
  v_va jsonb;
begin
  select api_v1.get_national_jurisdiction_availability('DC', null)
    into v_dc;
  select api_v1.get_national_jurisdiction_availability('VA', null)
    into v_va;

  if v_dc->>'availability' <> 'available'
     or v_dc->>'area_uid' <> 'area_us_dc' then
    raise exception 'D.C. is not available through the national contract';
  end if;
  if v_va->>'availability' <> 'unavailable'
     or nullif(v_va->>'reason', '') is null then
    raise exception 'unpublished jurisdiction availability is dishonest';
  end if;
  if pg_catalog.jsonb_array_length(
       api_v1.list_national_jurisdictions(null)
     ) <> 1 then
    raise exception 'runtime publication contains a non-D.C. member';
  end if;

  begin
    perform 1 from meta.property_identity limit 1;
    raise exception 'mcp_runtime read a national base table';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into geo.area (area_uid, area_kind, official_name)
    values ('area_forbidden', 'state', 'Forbidden');
    raise exception 'mcp_runtime wrote a national base table';
  exception
    when insufficient_privilege then null;
  end;
end;
$runtime_contract$;

reset role;
rollback;
