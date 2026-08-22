begin;

do $contract$
begin
  if (select pg_catalog.count(*) from meta.production_migration) <> 3
     or not exists (
       select 1 from meta.production_migration
       where migration_key = 'national-availability-reason-v1'
         and migration_sha256 ~ '^[0-9a-f]{64}$'
     ) then
    raise exception 'national availability correction ledger is incomplete';
  end if;
end;
$contract$;

set local role mcp_runtime;

do $runtime_contract$
declare
  v_dc jsonb;
  v_md jsonb;
begin
  v_dc := api_v1.get_national_jurisdiction_availability('DC', null);
  v_md := api_v1.get_national_jurisdiction_availability('MD', null);

  if v_dc->>'availability' <> 'available'
     or v_dc->>'reason' is not null then
    raise exception 'available D.C. carries an unavailable reason';
  end if;
  if v_md->>'availability' <> 'unavailable'
     or nullif(v_md->>'reason', '') is null then
    raise exception 'unavailable Maryland lacks a reason';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      api_v1.list_national_jurisdictions(null)
    ) item
    where item->>'availability' = 'available'
      and item->>'reason' is not null
  ) then
    raise exception 'an available jurisdiction carries an unavailable reason';
  end if;
end;
$runtime_contract$;

reset role;
rollback;
