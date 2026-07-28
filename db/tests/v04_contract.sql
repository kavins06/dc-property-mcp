begin;

set local role mcp_runtime;

do $$
declare
  v_payload jsonb;
  v_assessment_ref text;
  v_tax_ref text;
  v_sale_ref text;
  v_deed_ref text;
  v_property_ref text;
  v_forged_ref text;
  v_failures text[] := array[]::text[];
begin
  -- v0.4 intentionally exposes one coherent prior/current/proposed sequence.
  select api_v1.get_assessment_history('5576    0001', null)
    into v_payload;

  if v_payload->>'status' is distinct from 'resolved' then
    v_failures := array_append(
      v_failures,
      'assessment fixture did not resolve'
    );
  end if;

  if jsonb_array_length(coalesce(v_payload->'assessments', '[]'::jsonb)) <> 3
     or (
       select coalesce(
         jsonb_agg(
           jsonb_build_object(
             'tax_year', (item->>'tax_year')::integer,
             'stage', item->>'stage'
           )
           order by (item->>'tax_year')::integer, item->>'stage'
         ),
         '[]'::jsonb
       )
       from jsonb_array_elements(
         coalesce(v_payload->'assessments', '[]'::jsonb)
       ) item
     ) <> '[
       {"tax_year": 2025, "stage": "prior"},
       {"tax_year": 2026, "stage": "current"},
       {"tax_year": 2027, "stage": "proposed"}
     ]'::jsonb then
    v_failures := array_append(
      v_failures,
      'assessment history is not exactly 2025 prior, 2026 current, and 2027 proposed'
    );
  end if;

  if v_payload ? 'known_complete_year_gaps'
     or v_payload::text ~*
       '(itspe_2017_archive|itspe_2021_archive|archive|coverage[_ ]gap|missing complete)' then
    v_failures := array_append(
      v_failures,
      'assessment response still exposes obsolete archive or gap language'
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(
      coalesce(v_payload->'assessments', '[]'::jsonb)
    ) item
    where item->>'source_snapshot' is distinct from 'itspe_current'
  ) then
    v_failures := array_append(
      v_failures,
      'assessment response still exposes a non-current source snapshot'
    );
  end if;

  select item#>>'{total_value_dollars,source_refs,0}'
    into v_assessment_ref
  from jsonb_array_elements(
    coalesce(v_payload->'assessments', '[]'::jsonb)
  ) item
  where (item->>'tax_year')::integer = 2026
    and item->>'stage' = 'current'
  limit 1;

  if v_assessment_ref is null
     or split_part(v_assessment_ref, '|', 1) <> 'itspe_current'
     or split_part(v_assessment_ref, '|', 4) <> '55760001' then
    v_failures := array_append(
      v_failures,
      'current assessment lacks an exact-property current-source reference'
    );
  end if;

  select api_v1.describe_data(
    'What assessment years and stages are available?'
  ) into v_payload;

  if v_payload::text ~*
       '(2016.{0,20}2018|2020.{0,20}2022|2019|2023|2024|archive|explicit gaps?|missing complete)'
     or v_payload::text like '%itspe_2017_archive%'
     or v_payload::text like '%itspe_2021_archive%' then
    v_failures := array_append(
      v_failures,
      'assessment semantic response still advertises obsolete years, archives, or gaps'
    );
  end if;

  -- Tax behavior remains intact while the assessment implementation changes.
  select api_v1.get_tax_and_balance_history('01070075', null)
    into v_payload;

  if v_payload->>'status' is distinct from 'resolved'
     or jsonb_array_length(
       coalesce(v_payload->'source_slots', '[]'::jsonb)
     ) <> 12
     or not (v_payload#>'{current_summary}' ? 'annual_tax_cents')
     or not (
       v_payload#>'{current_summary}' ? 'total_liabilities_reported_cents'
     )
     or not (v_payload#>'{current_summary}' ? 'total_collected_cents')
     or not (v_payload#>'{current_summary}' ? 'total_balance_cents')
     or v_payload#>'{current_summary}' ? 'total_due_cents' then
    v_failures := array_append(
      v_failures,
      'existing tax summary or 12-slot history contract regressed'
    );
  end if;

  v_tax_ref := v_payload#>>'{slot_provenance,example}';
  if v_tax_ref is null
     or v_tax_ref not like 'itspe_current|%|tax.slot.%|01070075' then
    v_failures := array_append(
      v_failures,
      'existing tax slot provenance contract regressed'
    );
  end if;

  -- The known-sale fixture protects the existing CAMA/deed behavior.
  select api_v1.get_latest_sale_and_deed('3562    0059', null)
    into v_payload;

  if v_payload->>'status' is distinct from 'resolved'
     or v_payload#>>'{sale_history,0,sale_price_dollars,value}'
       is distinct from '745000'
     or v_payload#>>'{sale_history,0,sale_date,value}'
       is distinct from '2026-06-15'
     or v_payload#>>'{latest_assessor_deed,instrument_number,value}'
       is distinct from '2026058413' then
    v_failures := array_append(
      v_failures,
      'existing CAMA sale/deed fixture regressed'
    );
  end if;

  v_sale_ref :=
    v_payload#>>'{sale_history,0,sale_price_dollars,source_refs,0}';
  v_deed_ref :=
    v_payload#>>'{latest_assessor_deed,instrument_number,source_refs,0}';

  select api_v1.get_property_snapshot('5576    0001', null)
    into v_payload;
  v_property_ref :=
    v_payload#>>'{classification,property_type_source,source_refs,0}';

  -- Exercise every currently supported evidence family and reject URLs that
  -- are machine endpoints or transient document-retrieval sessions.
  select api_v1.get_source_evidence(array[
    v_assessment_ref,
    v_tax_ref,
    v_sale_ref,
    v_deed_ref,
    v_property_ref
  ]) into v_payload;

  if v_payload->>'status' is distinct from 'ok'
     or jsonb_array_length(
       coalesce(v_payload->'evidence', '[]'::jsonb)
     ) <> 5 then
    v_failures := array_append(
      v_failures,
      'valid assessment, tax, sale, deed, and property evidence refs did not expand'
    );
  end if;

  if v_payload::text ~*
       '(services\.arcgis\.com|featureserver|mapserver|/rest/|[?&]f=(json|pjson|geojson|html)|/_/retrieve/|file__=|params__=)' then
    v_failures := array_append(
      v_failures,
      'machine-readable or session-bound URL leaked into human evidence'
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(
      coalesce(v_payload->'evidence', '[]'::jsonb)
    ) evidence
    where coalesce(evidence#>>'{human_verification,portal_url}', '')
      !~ '^https://'
  ) then
    v_failures := array_append(
      v_failures,
      'an evidence item lacks an HTTPS human portal URL'
    );
  end if;

  -- A source record and its parcel identity are one integrity boundary.
  -- Editing only the SSL suffix must never produce evidence for another parcel.
  v_forged_ref := regexp_replace(
    v_assessment_ref,
    '\|[^|]+$',
    '|35620059'
  );
  select api_v1.get_source_evidence(array[v_forged_ref])
    into v_payload;

  if v_payload->>'status' is distinct from 'invalid_input'
     or v_payload#>>'{error,code}'
       is distinct from 'source_ref_property_mismatch' then
    v_failures := array_append(
      v_failures,
      'cross-property source-ref forgery was not rejected'
    );
  end if;

  if cardinality(v_failures) > 0 then
    raise exception 'v0.4 contract failures: %', array_to_string(
      v_failures,
      '; '
    );
  end if;
end
$$;

reset role;
rollback;
