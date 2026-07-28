begin;

set local role api_owner;

do $migration$
declare
  v_function record;
  v_definition text;
  v_replaced integer := 0;
  v_old_url constant text :=
    'https://mytax.dc.gov/?Link=PropertySearch&Check=1';
  v_new_url constant text :=
    'https://mytax.dc.gov/_/#2';
begin
  for v_function in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
      and p.prokind = 'f'
      and strpos(pg_get_functiondef(p.oid), v_old_url) > 0
  loop
    select pg_get_functiondef(v_function.oid)
    into v_definition;
    execute replace(v_definition, v_old_url, v_new_url);
    v_replaced := v_replaced + 1;
  end loop;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
      and p.prokind = 'f'
      and strpos(pg_get_functiondef(p.oid), v_old_url) > 0
  ) then
    raise exception 'Obsolete MyTax route remains in an API function';
  end if;

  select pg_get_functiondef(
    'api_v1.get_source_evidence(text[])'::regprocedure::oid
  )
  into v_definition;

  if v_replaced = 0 and strpos(v_definition, v_new_url) = 0 then
    raise exception
      'No known MyTax route exists in the source-evidence API';
  end if;
end;
$migration$;

comment on function api_v1.get_source_evidence(text[]) is
  'Validates source references and returns official human-facing verification portals; tax and assessment evidence uses the current MyTax real-property route.';

reset role;

update meta.verification_route
set url_template = replace(
  url_template,
  'https://mytax.dc.gov/?Link=PropertySearch&Check=1',
  'https://mytax.dc.gov/_/#2'
)
where strpos(
  url_template,
  'https://mytax.dc.gov/?Link=PropertySearch&Check=1'
) > 0;

commit;
