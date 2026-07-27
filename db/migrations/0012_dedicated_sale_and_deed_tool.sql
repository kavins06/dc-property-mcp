begin;
set local role api_owner;

create or replace function api_v1.get_latest_sale_and_deed(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with payload as (
    select api_v1.get_ownership_and_sale(p_ssl, p_address) value
  )
  select case
    when value->>'status' <> 'resolved' then value
    else jsonb_build_object(
      'status', 'resolved',
      'latest_sale_and_deed', value->'latest_reported_transfer',
      'record_scope', 'Latest sale/deed fields reported by the current D.C. ITSPE assessor extract.',
      'limitations', jsonb_build_array(
        'This is the latest transfer carried by the assessor extract, not a complete sales history.',
        'A zero sale price can represent a non-market or nominal transfer and must not be treated as missing.',
        'Use get_source_evidence on a returned source reference for MyTax and Recorder verification routes.'
      )
    )
  end
  from payload;
$$;

create or replace function api_v1.describe_data(
  p_question text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'status', 'ok',
    'question', p_question,
    'entity', 'D.C. property-tax account (not guaranteed to equal one physical parcel)',
    'recommended_sequence', jsonb_build_array(
      'resolve_property',
      'get_property_snapshot',
      'Use get_latest_sale_and_deed for a sale, transfer, deed, price, or instrument-number question',
      'Use another domain-specific history tool if needed',
      'get_source_evidence for human portal verification'
    ),
    'tools', jsonb_build_object(
      'resolve_property', 'Identity resolution and ambiguity handling.',
      'get_property_snapshot', 'Lender-oriented current quick look, including a compact latest-transfer summary.',
      'get_assessment_history', 'Available prior/current/proposed assessment stages and gaps.',
      'get_tax_and_balance_history', 'Current totals and preserved raw tax slots.',
      'get_ownership_and_sale', 'Current assessor owner/mailing fields plus the latest reported transfer.',
      'get_latest_sale_and_deed', 'Dedicated latest sale/deed lookup: price, sale date/type, acceptance classification, deed date, and instrument number.',
      'search_properties', 'Bounded screening by allowlisted non-owner filters.',
      'get_source_evidence', 'Human-facing D.C. portal routes and exact lookup instructions for returned source references.'
    ),
    'coverage', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.tax_year, c.stage)
      from semantic.coverage c
    ), '[]'::jsonb),
    'field_definitions', coalesce((
      select jsonb_object_agg(f.field_key, jsonb_build_object(
        'title', f.title,
        'definition', f.definition,
        'unit', f.unit,
        'time_grain', f.time_grain,
        'null_semantics', f.null_semantics,
        'aggregation_rule', f.aggregation_rule,
        'caveat', f.caveat
      ))
      from semantic.field_definition f
      where f.exposure_allowed
    ), '{}'::jsonb),
    'unsupported_inferences', jsonb_build_array(
      'title or lien priority',
      'complete transfer history',
      'NOI, DSCR, occupancy, rent roll, or debt',
      'building area or condition unless a separately sourced fact is added',
      'zoning compliance',
      'credit decision or property valuation opinion'
    )
  );
$$;

revoke all on function api_v1.get_latest_sale_and_deed(text, text) from public;
grant execute on function api_v1.get_latest_sale_and_deed(text, text) to mcp_runtime;

comment on function api_v1.get_latest_sale_and_deed(text, text) is
  'Dedicated latest assessor-reported sale and deed response with fact-level provenance.';

alter function api_v1.get_latest_sale_and_deed(text, text) owner to api_owner;
alter function api_v1.describe_data(text) owner to api_owner;

commit;
