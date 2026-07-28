begin;

set local role api_owner;

create or replace function api_v1._normalize_address_query(
  p_address text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select api_v1._normalize_address_query_v04_base(p_address);
$function$;

revoke all on function api_v1._normalize_address_query(text)
  from public, mcp_runtime;
grant execute on function api_v1._normalize_address_query(text)
  to api_owner;

comment on function api_v1._normalize_address_query(text) is
  'Normalizes user-entered D.C. addresses.';

reset role;

commit;
