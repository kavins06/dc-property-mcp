begin;

do $contract$
declare
  v_assessment_ref text;
  v_tax_ref text;
  v_result jsonb;
  v_source jsonb;
begin
  v_assessment_ref := api_v1.get_assessment_history(
    '5576    0001', null
  )#>>'{assessments,0,total_value_dollars,source_refs,0}';
  v_tax_ref := api_v1.get_tax_and_balance_history(
    '5576    0001', null
  )#>>'{current_summary,total_liabilities_reported_cents,source_refs,0}';

  select api_v1.get_source_evidence(array[
    v_assessment_ref,
    v_tax_ref
  ]) into v_result;

  v_source := v_result#>'{sources,0}';

  if v_result->>'status' is distinct from 'ok'
     or jsonb_array_length(v_result->'evidence') <> 2
     or jsonb_array_length(v_result->'sources') <> 1 then
    raise exception 'Tax/assessment sources were not grouped: %', v_result;
  end if;

  if v_source->>'link' is distinct from
       'https://mytax.dc.gov/?Link=PropertySearch&Check=1'
     or v_source#>>'{fallback,link}' is distinct from
       'https://mytax.dc.gov/_/#2'
     or v_source#>>'{property,square}' is distinct from '5576'
     or v_source#>>'{property,suffix}' is distinct from ''
     or v_source#>>'{property,lot}' is distinct from '0001'
     or v_source#>>'{property,address}' is distinct from
       '2220 Q ST SE, Washington, DC'
     or v_source->'property' ? 'ssl'
     or v_source ? 'steps'
     or not (v_source->'covers' ? 'Prior assessment')
     or not (v_source->'covers' ? 'Property tax, balance, or bill')
     or strpos(v_source::text, 'source_ref') > 0
     or strpos(v_source::text, 'field_key') > 0
     or strpos(v_source::text, 'source_sha256') > 0 then
    raise exception 'Human source route, lookup, or redaction is wrong: %',
      v_source;
  end if;

  if not has_function_privilege(
    'mcp_runtime',
    'api_v1.get_source_evidence(text[])',
    'execute'
  ) or has_function_privilege(
    'public',
    'api_v1.get_source_evidence(text[])',
    'execute'
  ) then
    raise exception 'Source-evidence privileges changed';
  end if;
end;
$contract$;

rollback;
