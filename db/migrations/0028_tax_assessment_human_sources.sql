begin;

set local role api_owner;

do $block$
begin
  if to_regprocedure(
    'api_v1._get_source_evidence_v05_base(text[])'
  ) is null then
    alter function api_v1.get_source_evidence(text[])
      rename to _get_source_evidence_v05_base;
  end if;
end;
$block$;

revoke all on function api_v1._get_source_evidence_v05_base(text[])
  from public, mcp_runtime;
grant execute on function api_v1._get_source_evidence_v05_base(text[])
  to api_owner;

create or replace function api_v1.get_source_evidence(
  p_source_refs text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_result jsonb;
  v_sources jsonb;
begin
  v_result := api_v1._get_source_evidence_v05_base(p_source_refs);

  if v_result->>'status' is distinct from 'ok' then
    return v_result;
  end if;

  with matching as (
    select
      item,
      ordinality,
      jsonb_build_object(
        'square', split_part(
          item#>>'{human_verification,search_inputs,ssl}', '-', 1
        ),
        'suffix', split_part(
          item#>>'{human_verification,search_inputs,ssl}', '-', 2
        ),
        'lot', split_part(
          item#>>'{human_verification,search_inputs,ssl}', '-', 3
        ),
        'address',
          item#>>'{human_verification,search_inputs,property_address}'
      ) property,
      case
        when item->>'field_key' like 'assessment.prior.%'
          then 'Prior assessment'
        when item->>'field_key' like 'assessment.current.%'
          then 'Current assessment'
        when item->>'field_key' like 'assessment.proposed.%'
          then 'Proposed assessment'
        when item->>'field_key' like 'assessment.%'
          then 'Property assessment'
        else 'Property tax, balance, or bill'
      end covers
    from jsonb_array_elements(coalesce(v_result->'evidence', '[]'::jsonb))
      with ordinality evidence(item, ordinality)
    where item->>'field_key' ~ '^(assessment|tax|special)\.'
      and item#>>'{human_verification,portal_url}' =
        'https://mytax.dc.gov/_/#2'
  ), grouped as (
    select
      min(ordinality) first_ordinality,
      jsonb_build_object(
        'title', 'Verify tax and assessment records on MyTax.DC.gov',
        'link',
          'https://mytax.dc.gov/?Link=PropertySearch&Check=1',
        'fallback', jsonb_build_object(
          'link', 'https://mytax.dc.gov/_/#2'
        ),
        'property', property,
        'relationship', 'Exact D.C. real-property tax account',
        'covers', jsonb_agg(distinct covers),
        'access',
          'Public real-property search; no MyTax login is required.'
      ) source
    from matching
    group by property
  )
  select coalesce(
    jsonb_agg(source order by first_ordinality),
    '[]'::jsonb
  )
  into v_sources
  from grouped;

  return v_result || jsonb_build_object('sources', v_sources);
end;
$function$;

revoke all on function api_v1.get_source_evidence(text[]) from public;
grant execute on function api_v1.get_source_evidence(text[]) to mcp_runtime;

comment on function api_v1.get_source_evidence(text[]) is
  'Validates source references, preserves internal evidence, and groups tax and assessment references into human-facing MyTax verification sources.';

reset role;

commit;
