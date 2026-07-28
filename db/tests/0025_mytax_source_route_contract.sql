begin;

do $contract$
declare
  v_assessment jsonb;
  v_tax jsonb;
  v_evidence jsonb;
  v_assessment_ref text;
  v_tax_ref text;
  v_new_url constant text := 'https://mytax.dc.gov/_/#2';
  v_old_url constant text :=
    'https://mytax.dc.gov/?Link=PropertySearch&Check=1';
begin
  select api_v1.get_assessment_history('5576    0001', null)
  into v_assessment;
  select api_v1.get_tax_and_balance_history('5576    0001', null)
  into v_tax;

  v_assessment_ref :=
    v_assessment#>>'{assessments,0,total_value_dollars,source_refs,0}';
  v_tax_ref :=
    v_tax#>>'{current_summary,total_liabilities_reported_cents,source_refs,0}';

  if v_assessment_ref is null or v_tax_ref is null then
    raise exception
      'Could not derive assessment and tax source references';
  end if;

  select api_v1.get_source_evidence(array[
    v_assessment_ref,
    v_tax_ref
  ])
  into v_evidence;

  if v_evidence->>'status' is distinct from 'ok'
     or jsonb_array_length(v_evidence->'evidence') <> 2 then
    raise exception
      'Tax/assessment evidence lookup failed: %',
      v_evidence;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_evidence->'evidence') item
    where item#>>'{human_verification,portal_url}' is distinct from v_new_url
  ) then
    raise exception
      'Tax/assessment evidence does not use the current MyTax route: %',
      v_evidence;
  end if;

  if strpos(v_evidence::text, v_old_url) > 0 then
    raise exception
      'Obsolete MyTax route remains in evidence: %',
      v_evidence;
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
    raise exception
      'Source-evidence function privileges changed during route migration';
  end if;
end;
$contract$;

rollback;
