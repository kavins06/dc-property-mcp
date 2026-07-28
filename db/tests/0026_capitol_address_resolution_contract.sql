begin;

set local role mcp_runtime;

do $contract$
declare
  v_payload jsonb;
begin
  select api_v1.resolve_property(
    null,
    '4800 E Capitol St NE in DC',
    false,
    10
  )
  into v_payload;

  if v_payload->>'status' is distinct from 'resolved'
     or v_payload#>>'{candidates,0,ssl}' <> '5140--0088' then
    raise exception
      'Abbreviated East Capitol address did not resolve exactly: %',
      v_payload;
  end if;

  select api_v1.resolve_property(
    null,
    '4800 East Capitol Street NE, Washington, DC 20019',
    false,
    10
  )
  into v_payload;

  if v_payload->>'status' is distinct from 'resolved'
     or v_payload#>>'{candidates,0,ssl}' <> '5140--0088' then
    raise exception
      'Expanded East Capitol address did not resolve exactly: %',
      v_payload;
  end if;
end;
$contract$;

rollback;
