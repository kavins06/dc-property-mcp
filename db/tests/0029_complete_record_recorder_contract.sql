begin;

set local role mcp_runtime;

do $contract$
declare
  v_payload jsonb;
begin
  select api_v1.get_complete_property_record(
    null,
    '4800 E Capitol St NE in DC'
  )
  into v_payload;

  if v_payload->>'status' is distinct from 'resolved'
     or jsonb_array_length(
       v_payload#>'{coverage,included_sections}'
     ) <> 10
     or not (
       v_payload#>'{coverage,included_sections}'
       ? 'recorder_instrument_history'
     )
     or v_payload#>'{sections,recorder_instrument_history}'
       is null
     or v_payload#>>'{sections,recorder_instrument_history,status}'
       is distinct from 'resolved'
     or v_payload#>'{coverage,record_counts,recorder_instruments}'
       is null then
    raise exception
      'Complete record omitted Recorder coverage: %',
      v_payload;
  end if;

  if octet_length(v_payload::text) >= 768 * 1024 then
    raise exception
      'Recorder complete record exceeds the MCP response limit';
  end if;
end;
$contract$;

rollback;
