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

  v_result := api_v1.get_source_evidence(array[
    v_assessment_ref,
    v_tax_ref
  ]);
  v_source := v_result#>'{sources,0}';

  if v_result->>'status' is distinct from 'ok'
     or jsonb_array_length(v_result->'sources') <> 1
     or v_source->>'link' is distinct from
       'https://mytax.dc.gov/_/?Link=PropertySearch'
     or v_source#>>'{fallback,link}' is distinct from
       'https://otr.cfo.dc.gov/page/real-property-tax-database-search'
     or v_source#>>'{property,square}' is distinct from '5576'
     or v_source#>>'{property,lot}' is distinct from '0001'
     or strpos(v_source::text, 'Check=1') > 0 then
    raise exception 'MyTax bootstrap source is wrong: %', v_result;
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
