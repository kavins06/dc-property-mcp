begin;

set local role mcp_runtime;

do $$
declare
  v_payload jsonb;
  v_ref text;
begin
  -- Exact address matches must win without running a broad fuzzy query.
  select api_v1.resolve_property(null, '1100 15th St NW', false, 10)
    into v_payload;
  assert v_payload->>'status' = 'resolved',
    'exact address did not resolve';
  assert v_payload#>>'{candidates,0,address}' like '1100 15TH ST NW%',
    'wrong exact address won';
  assert (v_payload#>>'{candidates,0,similarity_score}')::numeric = 1,
    'exact address score missing';

  select api_v1.resolve_property(
    null,
    '1000 16TH ST NW WASHINGTON DC 20036',
    false,
    10
  ) into v_payload;
  assert v_payload->>'status' in (
    'resolved', 'ambiguous', 'no_exact_match', 'not_found'
  ) and v_payload#>>'{input_normalized,address}' = '1000 16TH ST NW',
    'full postal address was not normalized or safely resolved';

  select api_v1.resolve_property(
    null,
    '1010 Massachusetts Ave NW Unit 402',
    false,
    10
  ) into v_payload;
  assert v_payload->>'status' = 'resolved',
    'unit-qualified exact address did not resolve';
  assert v_payload#>>'{candidates,0,unit}' = '402',
    'unit-qualified resolver chose the wrong unit';

  select api_v1.resolve_property(null, '555 12th St NW', false, 10)
    into v_payload;
  assert v_payload->>'status' = 'resolved',
    'exact street match remained ambiguous';

  select api_v1.resolve_property(null, '1425 15th St NW', false, 10)
    into v_payload;
  assert v_payload->>'status' = 'no_exact_match',
    'fuzzy-only response did not disclose no exact match';
  assert v_payload#>>'{candidates,0,match_kind}' = 'fuzzy_suggestion',
    'fuzzy candidate is not labeled';
  assert v_payload#>>'{candidates,0,similarity_score}' is not null,
    'fuzzy candidate lacks score';

  select api_v1.resolve_property(null, null, false, 10) into v_payload;
  assert v_payload->>'status' = 'invalid_input',
    'missing identity input is not invalid_input';

  select api_v1.get_property_snapshot(null, '1100 15th St NW')
    into v_payload;
  assert v_payload->>'status' = 'resolved',
    'detail helper discarded a valid exact address';

  select api_v1.get_property_snapshot('01070075', '2101 CONSTITUTION AVE NW')
    into v_payload;
  assert v_payload->>'status' = 'conflicting_input',
    'conflicting SSL and address were silently accepted';

  -- Invalid screening requests must not masquerade as zero matches.
  select api_v1.search_properties(
    '{"property_type":"commercial-office (large)","limit":1}'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'ok'
    and jsonb_array_length(v_payload->'results') = 1,
    'property type matching is still case-sensitive';

  select api_v1.search_properties('{"ward":"99"}'::jsonb) into v_payload;
  assert v_payload->>'status' = 'invalid_input',
    'invalid ward was not rejected';

  select api_v1.search_properties(
    '{"min_assessment":100,"max_assessment":10}'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'invalid_input',
    'inverted assessment range was not rejected';

  select api_v1.search_properties(
    '{"property_type":"Vacant Land"}'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'invalid_input'
    and v_payload#>>'{error,code}' = 'unknown_property_type',
    'unknown property type masqueraded as zero matches';

  select api_v1.search_properties(
    '{"tax_class":"99"}'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'invalid_input'
    and v_payload#>>'{error,code}' = 'unknown_tax_class',
    'unknown tax class masqueraded as zero matches';

  select api_v1.search_properties(
    '{"has_balance":false,"min_balance_cents":1}'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'invalid_input'
    and v_payload#>>'{error,code}' = 'conflicting_balance_filters',
    'conflicting balance filters masqueraded as zero matches';

  select api_v1.search_properties(
    '{"ward":"2","tax_class":"2","sort_by":"assessment_desc","limit":2}'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'ok',
    'valid lender screening query failed';
  assert v_payload ? 'total_count' and v_payload ? 'has_more',
    'screening pagination metadata is incomplete';
  assert v_payload#>>'{results,0,tax_class}' = '2',
    'screening row omits or ignores tax class';
  assert (v_payload#>>'{results,0,current_total_value_dollars}')::bigint >=
         (v_payload#>>'{results,1,current_total_value_dollars}')::bigint,
    'assessment_desc sort was not applied';

  select api_v1.describe_data(
    'What are the valid property_type values for search_properties?'
  ) into v_payload;
  assert v_payload ? 'filter_vocabulary',
    'describe_data did not answer the filter-vocabulary question';
  assert jsonb_array_length(v_payload#>'{filter_vocabulary,property_types}') > 1,
    'property-type vocabulary is empty';
  assert length(v_payload::text) < 20000,
    'describe_data topic response is still an unbounded dictionary dump';

  -- The raw source value remains visible, but the anomaly must travel with it.
  select api_v1.get_ownership_and_sale('01070075', null) into v_payload;
  assert v_payload::text like '%NORTH KOREA%',
    'source mailing value was silently rewritten';
  assert v_payload::text like '%mailing_jurisdiction_conflict%',
    'known jurisdiction conflict was not flagged';
  assert not (v_payload ? 'latest_reported_transfer'),
    'ownership payload still duplicates the sale/deed response';

  select api_v1.get_tax_and_balance_history('01070075', null) into v_payload;
  assert v_payload#>'{current_summary,total_due_cents}' is null,
    'misleading total_due key remains';
  assert v_payload#>'{current_summary,total_liabilities_reported_cents}' is not null,
    'renamed source-reported total liabilities is missing';
  assert v_payload::text like '%tax.slot.penalty.PY4%',
    'tax-slot reference is not slot-qualified';
  assert length(v_payload::text) < 30000,
    'tax history payload was not materially compacted';

  -- Invalid references return safe structure and preserve caller order.
  select api_v1.get_source_evidence(array['nonsense|nonsense|x|y'])
    into v_payload;
  assert v_payload->>'status' = 'invalid_input',
    'malformed evidence ref reached an unsafe cast';
  assert v_payload::text not like '%syntax%',
    'database error text leaked from evidence parser';

  select api_v1.get_latest_sale_and_deed('01070075', null) into v_payload;
  assert v_payload->>'status' = 'resolved',
    'sale/deed lookup failed';
  assert v_payload ? 'sale_history',
    'official CAMA sale history is missing';
  v_ref := v_payload#>>'{latest_assessor_deed,instrument_number,source_refs,0}';
  select api_v1.get_source_evidence(array[v_ref]) into v_payload;
  assert v_payload#>>'{evidence,0,human_verification,search_inputs,instrument_number}'
      is null,
    'bare instrument number was incorrectly prefilled';
  assert v_payload::text like '%reported instrument is not year-prefixed%',
    'bare instrument caveat is missing';

  select api_v1.resolve_properties_batch(
    '[{"client_id":"asset-1","ssl":"01070075"},{"client_id":"asset-2","address":"555 12th St NW"}]'::jsonb
  ) into v_payload;
  assert v_payload->>'status' = 'ok'
    and jsonb_array_length(v_payload->'results') = 2,
    'named-asset batch resolver failed';
end
$$;

reset role;
rollback;
