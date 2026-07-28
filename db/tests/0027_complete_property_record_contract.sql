begin;

set local role mcp_runtime;

do $contract$
declare
  v_payload jsonb;
  v_started_at timestamptz := clock_timestamp();
  v_section text;
begin
  select api_v1.get_complete_property_record(
    null,
    '4800 E Capitol St NE in DC'
  )
  into v_payload;

  if v_payload->>'status' is distinct from 'resolved'
     or v_payload#>>'{identity_resolution,candidates,0,ssl}'
       <> '5140--0088' then
    raise exception
      'Complete record did not resolve the incident property: %',
      v_payload;
  end if;

  if (v_payload#>>'{coverage,complete}')::boolean is distinct from true
     or jsonb_array_length(
       v_payload#>'{coverage,included_sections}'
     ) <> 9
     or v_payload#>>'{coverage,record_counts,permits}' <> '42'
     or v_payload#>>'{coverage,record_counts,licenses}' <> '4'
     or v_payload#>>'{coverage,record_counts,inspections_and_enforcement}'
       <> '1'
     or v_payload#>>'{coverage,record_counts,building_and_land}' <> '15'
     or v_payload#>'{coverage,continuations}' <> '{}'::jsonb then
    raise exception
      'Complete record omitted or truncated incident data: %',
      v_payload->'coverage';
  end if;

  foreach v_section in array array[
    'property_snapshot',
    'assessment_history',
    'tax_and_balance_history',
    'ownership_and_sale',
    'sale_and_deed_history',
    'permit_history',
    'license_history',
    'inspection_and_enforcement_history',
    'building_and_land_profile'
  ]
  loop
    if v_payload#>>array['sections', v_section, 'status']
       is distinct from 'resolved' then
      raise exception
        'Complete record section % is not resolved: %',
        v_section,
        v_payload#>array['sections', v_section];
    end if;
  end loop;

  if octet_length(v_payload::text) >= 768 * 1024 then
    raise exception
      'Incident complete record exceeds the MCP response limit: % bytes',
      octet_length(v_payload::text);
  end if;

  if clock_timestamp() - v_started_at > interval '8 seconds' then
    raise exception
      'Incident complete record exceeds the Worker query timeout';
  end if;

  if not has_function_privilege(
    'mcp_runtime',
    'api_v1.get_complete_property_record(text,text)',
    'execute'
  ) or has_function_privilege(
    'public',
    'api_v1.get_complete_property_record(text,text)',
    'execute'
  ) then
    raise exception
      'Complete-record function privileges are not least-privileged';
  end if;
end;
$contract$;

rollback;
