begin;

set local role api_owner;

do $migration$
begin
  if to_regprocedure(
    'api_v1._normalize_address_query_v04_base(text)'
  ) is null then
    alter function api_v1._normalize_address_query(text)
      rename to _normalize_address_query_v04_base;
  end if;
end;
$migration$;

revoke all on function api_v1._normalize_address_query_v04_base(text)
  from public, mcp_runtime;
grant execute on function api_v1._normalize_address_query_v04_base(text)
  to api_owner;

create or replace function api_v1._normalize_address_query(
  p_address text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  with base as (
    select api_v1._normalize_address_query_v04_base(p_address) value
  ),
  dc_phrase_removed as (
    select regexp_replace(
      value,
      '\s+IN\s+DC\s*$',
      '',
      'i'
    ) value
    from base
  ),
  capitol_street_expanded as (
    select regexp_replace(
      regexp_replace(
        regexp_replace(
          value,
          '\mE\s+CAPITOL\M',
          'EAST CAPITOL',
          'g'
        ),
        '\mN\s+CAPITOL\M',
        'NORTH CAPITOL',
        'g'
      ),
      '\mS\s+CAPITOL\M',
      'SOUTH CAPITOL',
      'g'
    ) value
    from dc_phrase_removed
  )
  select value
  from capitol_street_expanded;
$function$;

revoke all on function api_v1._normalize_address_query(text)
  from public, mcp_runtime;
grant execute on function api_v1._normalize_address_query(text)
  to api_owner;

comment on function api_v1._normalize_address_query(text) is
  'Normalizes user-entered D.C. addresses while preserving canonical Capitol street names and removing a trailing natural-language IN DC phrase.';

reset role;

commit;
