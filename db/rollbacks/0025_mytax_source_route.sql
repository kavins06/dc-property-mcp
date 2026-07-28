begin;

set local role api_owner;

do $rollback$
declare
  v_function record;
  v_definition text;
  v_current_url constant text :=
    'https://mytax.dc.gov/_/#2';
  v_previous_url constant text :=
    'https://mytax.dc.gov/?Link=PropertySearch&Check=1';
begin
  for v_function in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
      and p.prokind = 'f'
      and strpos(pg_get_functiondef(p.oid), v_current_url) > 0
  loop
    select pg_get_functiondef(v_function.oid)
    into v_definition;
    execute replace(v_definition, v_current_url, v_previous_url);
  end loop;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
      and p.prokind = 'f'
      and strpos(pg_get_functiondef(p.oid), v_current_url) > 0
  ) then
    raise exception 'Current MyTax route remains after rollback';
  end if;

  select pg_get_functiondef(
    'api_v1.get_source_evidence(text[])'::regprocedure::oid
  )
  into v_definition;

  if strpos(v_definition, v_previous_url) = 0 then
    raise exception
      'Previous MyTax route was not restored in the source-evidence API';
  end if;
end;
$rollback$;

comment on function api_v1.get_source_evidence(text[]) is
  'Validates source references and returns official human-facing verification portals.';

reset role;

update meta.verification_route
set url_template = replace(
  url_template,
  'https://mytax.dc.gov/_/#2',
  'https://mytax.dc.gov/?Link=PropertySearch&Check=1'
)
where strpos(url_template, 'https://mytax.dc.gov/_/#2') > 0;

commit;
