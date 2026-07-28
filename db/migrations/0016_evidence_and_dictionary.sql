begin;

set local role api_owner;

create or replace function api_v1.get_source_evidence(
  p_source_refs text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_invalid_refs jsonb;
  v_unknown_sources jsonb;
  v_result jsonb;
begin
  if coalesce(cardinality(p_source_refs), 0) < 1
     or cardinality(p_source_refs) > 50 then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_count',
        'hint', 'Pass between 1 and 50 source_refs returned by a property tool.'
      )
    );
  end if;

  select jsonb_agg(to_jsonb(ref) order by ordinality)
  into v_invalid_refs
  from unnest(p_source_refs) with ordinality requested(ref, ordinality)
  where ref is null
     or ref !~
       '^[A-Za-z0-9_:-]+\|[0-9]+\|[A-Za-z0-9_.-]+\|[A-Za-z0-9 -]+$';

  if v_invalid_refs is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'malformed_source_ref',
        'invalid_refs', v_invalid_refs,
        'hint', 'Use source_refs exactly as returned, or construct a documented compact tax-slot ref without changing its four pipe-delimited parts.'
      )
    );
  end if;

  select jsonb_agg(to_jsonb(source_id) order by source_id)
  into v_unknown_sources
  from (
    select distinct split_part(ref, '|', 1) source_id
    from unnest(p_source_refs) ref
  ) requested_sources
  where not exists (
    select 1
    from meta.source_asset s
    where s.source_id = requested_sources.source_id
  );

  if v_unknown_sources is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_source',
        'source_ids', v_unknown_sources,
        'hint', 'Use a source_ref returned by this connector.'
      )
    );
  end if;

  with requested as (
    select
      ref,
      ordinality,
      string_to_array(ref, '|') parts
    from unnest(p_source_refs) with ordinality requested(ref, ordinality)
  ),
  expanded as (
    select
      r.ref,
      r.ordinality,
      r.parts[1] source_id,
      r.parts[2]::integer source_record_id,
      r.parts[3] field_key,
      r.parts[4] ssl,
      s.publisher,
      s.dataset_name,
      s.source_class,
      s.archive_capture_at,
      s.dataset_retrieved_at,
      s.sha256,
      s.limitations source_limitations,
      a.ssl_display,
      api_v1._display_address(a.premise_address) premise_address,
      a.owner_name,
      a.latest_instrument_number,
      a.latest_deed_date,
      sale_position.position sale_position,
      sale_series.sale_dates[sale_position.position] cama_sale_date,
      sale_series.sale_prices[sale_position.position] cama_sale_price,
      case
        when r.parts[1] = 'cama_sales_current'
          or r.parts[3] like 'sale.history.%'
          then 'cama_sales'
        when r.parts[3] like 'deed.%' then 'recorder'
        when r.parts[3] like 'assessment.%'
          or r.parts[3] like 'tax.%'
          or r.parts[3] like 'special.%'
          or r.parts[3] like 'ownership.%'
          then 'mytax'
        when r.parts[3] like 'sale.%' then 'mytax_sale'
        when r.parts[3] like 'property.%'
          or r.parts[3] like 'classification.%'
          or r.parts[3] in ('property_account', 'search_result')
          then 'assessment_map'
        else 'mytax'
      end portal_family
    from requested r
    join meta.source_asset s on s.source_id = r.parts[1]
    left join core.property_account_current a
      on a.ssl_normalized = r.parts[4]
    left join history.sale_series sale_series
      on sale_series.account_id = a.account_id
      and r.parts[1] = 'cama_sales_current'
    left join lateral (
      select array_position(
        sale_series.source_objectids,
        r.parts[2]::integer
      ) position
    ) sale_position on true
  ),
  routed as (
    select
      e.*,
      case e.portal_family
        when 'recorder' then
          'D.C. Recorder of Deeds Official Records Search'
        when 'assessment_map' then
          'D.C. OTR Real Property Assessment Map'
        when 'cama_sales' then
          'D.C. Open Data — Tax System Property Sales (CAMA)'
        else 'MyTax.DC.gov Real Property Search'
      end portal_name,
      case e.portal_family
        when 'recorder' then
          'https://washington.dc.publicsearch.us/'
        when 'assessment_map' then
          'https://dcgis.maps.arcgis.com/apps/webappviewer/index.html?id=9a5c11c11dd347cc9c05d64499cc98ee'
        when 'cama_sales' then
          'https://opendata.dc.gov/datasets/DCGIS::tax-system-property-sales-cama'
        else 'https://mytax.dc.gov/_/#2'
      end portal_url,
      case
        when coalesce(e.latest_instrument_number, '') ~ '^[0-9]{10,}$'
          then e.latest_instrument_number
        else null
      end safe_instrument_number
    from expanded e
  )
  select jsonb_build_object(
    'status', 'ok',
    'evidence', coalesce(jsonb_agg(
      jsonb_build_object(
        'source_ref', e.ref,
        'field_key', e.field_key,
        'publisher', e.publisher,
        'dataset_name', e.dataset_name,
        'source_class', e.source_class,
        'human_verification', jsonb_strip_nulls(jsonb_build_object(
          'portal_name', e.portal_name,
          'portal_url', e.portal_url,
          'access', case
            when e.portal_family = 'recorder' then
              'Free registration is required to search and view document images.'
            else 'Public human interface; no sign-in should be required.'
          end,
          'search_inputs', jsonb_strip_nulls(jsonb_build_object(
            'ssl', coalesce(e.ssl_display, e.ssl),
            'property_address', e.premise_address,
            'source_record_id', case
              when e.portal_family = 'cama_sales'
                then e.source_record_id
            end,
            'sale_date', case
              when e.portal_family = 'cama_sales'
                then e.cama_sale_date
            end,
            'sale_price_dollars', case
              when e.portal_family = 'cama_sales'
                then e.cama_sale_price
            end,
            'instrument_number', case
              when e.portal_family = 'recorder'
                then e.safe_instrument_number
            end,
            'instrument_number_as_reported', case
              when e.portal_family = 'recorder'
                then e.latest_instrument_number
            end,
            'deed_year', case
              when e.portal_family = 'recorder'
                and e.latest_deed_date is not null
                then extract(year from e.latest_deed_date)::integer
            end,
            'owner_or_party_name', case
              when e.portal_family = 'recorder' then e.owner_name
            end
          )),
          'instrument_search_note', case
            when e.portal_family = 'recorder'
              and nullif(e.latest_instrument_number, '') is not null
              and e.safe_instrument_number is null
              then 'The reported instrument is not year-prefixed and was deliberately not placed in instrument_number. Search using deed year plus owner/party name, SSL, or address, and treat instrument_number_as_reported only as a cross-check.'
            when e.portal_family = 'recorder'
              and e.safe_instrument_number is not null
              then 'The reported instrument is year-prefixed and can be used as the primary Recorder search input.'
            else null
          end,
          'steps', case e.portal_family
            when 'recorder' then jsonb_build_array(
              'Open the official records search and register or sign in if prompted.',
              case
                when e.safe_instrument_number is not null then
                  'Search by the supplied year-prefixed instrument number.'
                else
                  'Do not search the bare instrument as a complete identifier. Search by the supplied deed year and owner/party name; use SSL or address to cross-check the parcel.'
              end,
              'Open the matching recorded instrument and confirm its parties, dates, legal description, document type, and image.'
            )
            when 'assessment_map' then jsonb_build_array(
              'Open the D.C. OTR assessment map.',
              'Enter the supplied property address or SSL in the search box and select the matching parcel.',
              'Review the parcel panel for the property ID, address, ward, property type, assessment, and sale fields relevant to the cited fact.'
            )
            when 'cama_sales' then jsonb_build_array(
              'Open the human-facing D.C. Open Data sale-history dataset.',
              'Open the data table and filter or search using the supplied SSL or source record ID.',
              'Match the sale date and price, then compare the qualification and sale-code fields.',
              'Use the Recorder alternate route when the recorded deed, parties, or legal description is required.'
            )
            else jsonb_build_array(
              'Open the MyTax.DC.gov Real Property Search.',
              'Enter the supplied property address or SSL and select Search.',
              'Under Search Results, open the matching SSL.',
              case
                when e.field_key like 'assessment.%' then
                  'Open the assessment/property-detail area and compare the cited assessment field and applicable tax year or stage.'
                when e.field_key like 'tax.%'
                  or e.field_key like 'special.%' then
                  'Open the tax, balance, payment, bill, or special-assessment area corresponding to the cited field and period.'
                when e.field_key like 'ownership.%' then
                  'Review the owner and mailing information shown for the selected real-property account.'
                when e.field_key like 'sale.%' then
                  'Review the sales/property-detail area. Use the Recorder alternate route when the recorded instrument is required.'
                else
                  'Review the property-detail area for the cited field.'
              end
            )
          end,
          'verification_note', case
            when e.source_class = 'archived_official_snapshot' then
              'This fact came from an archived official extract. The live portal may have changed or may not expose that historical period; compare the source date and field label.'
            when e.source_class = 'official_snapshot' then
              'This fact came from a dated official extract. The live portal can be newer, so compare the cited record date as well as the value.'
            else
              'The live human portal can change after the cited dataset retrieval or fact record date.'
          end
        )),
        'alternate_human_verification', case
          when e.portal_family in ('mytax_sale', 'cama_sales') then
            jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
              'portal_name',
                'D.C. Recorder of Deeds Official Records Search',
              'portal_url', 'https://washington.dc.publicsearch.us/',
              'access',
                'Free registration is required to search and view document images.',
              'search_inputs', jsonb_strip_nulls(jsonb_build_object(
                'ssl', coalesce(e.ssl_display, e.ssl),
                'property_address', e.premise_address,
                'instrument_number', e.safe_instrument_number,
                'instrument_number_as_reported',
                  e.latest_instrument_number,
                'deed_year', case
                  when e.latest_deed_date is not null
                    then extract(year from e.latest_deed_date)::integer
                end,
                'owner_or_party_name', e.owner_name
              )),
              'use_when',
                'Use this route to verify a recorded deed, parties, or legal description rather than an assessor-reported sale field.'
            )))
          when e.portal_family = 'assessment_map' then
            jsonb_build_array(jsonb_build_object(
              'portal_name', 'MyTax.DC.gov Real Property Search',
              'portal_url',
                'https://mytax.dc.gov/_/#2',
              'search_inputs', jsonb_strip_nulls(jsonb_build_object(
                'ssl', coalesce(e.ssl_display, e.ssl),
                'property_address', e.premise_address
              )),
              'use_when',
                'Use this route for the tax account, current assessment, ownership, billing, and payment detail.'
            ))
          else '[]'::jsonb
        end,
        'provenance', jsonb_build_object(
          'source_record_id', e.source_record_id,
          'archive_capture_at', e.archive_capture_at,
          'dataset_retrieved_at', e.dataset_retrieved_at,
          'source_sha256', e.sha256,
          'source_limitations', e.source_limitations
        )
      )
      order by e.ordinality
    ), '[]'::jsonb)
  )
  into v_result
  from routed e;

  return v_result;
end;
$function$;

create or replace function api_v1.describe_data(
  p_question text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_question text := nullif(trim(p_question), '');
  v_q text := lower(coalesce(v_question, ''));
  v_property_types jsonb;
  v_use_codes jsonb;
  v_tax_classes jsonb;
  v_special_codes jsonb;
  v_coverage jsonb;
  v_fields jsonb;
begin
  if v_q like '%property_type%'
     or v_q like '%property type%'
     or v_q like '%vacant%'
     or v_q like '%filter%' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'source_label', source_label,
        'canonical_label', canonical_label,
        'current_accounts', current_accounts,
        'source_label_may_be_truncated',
          length(source_label) >= 30
      )
      order by current_accounts desc, source_label
    ), '[]'::jsonb)
    into v_property_types
    from (
      select
        a.property_type source_label,
        api_v1._canonical_property_type(a.property_type) canonical_label,
        count(*)::integer current_accounts
      from core.property_account_current a
      where not a.is_deleted
        and nullif(a.property_type, '') is not null
      group by a.property_type
      order by count(*) desc, a.property_type
      limit 100
    ) vocabulary;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'code', d.code,
        'label', d.label,
        'description', d.description,
        'current_accounts', d.current_account_count,
        'decode_status', d.decode_status,
        'official_reference_url', d.official_reference_url
      )
      order by d.code
    ), '[]'::jsonb)
    into v_use_codes
    from semantic.code_decode d
    where d.code_system = 'use_code';

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'code', d.code,
        'label', d.label,
        'description', d.description,
        'official_reference_url', d.official_reference_url
      )
      order by d.code
    ), '[]'::jsonb)
    into v_tax_classes
    from semantic.code_decode d
    where d.code_system = 'tax_class';

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'Use an exact source_label or canonical_label; matching is case-insensitive. Vacant is a supported canonical label for the source value Vacant-True. Invalid filters return invalid_input instead of a silent empty result.',
      'best_next_tool', 'search_properties',
      'filter_vocabulary', jsonb_build_object(
        'wards', jsonb_build_array('1', '2', '3', '4', '5', '6', '7', '8'),
        'property_types', v_property_types,
        'use_codes', case
          when v_q like '%use code%' or v_q like '%use_code%'
            or v_q like '%filter%' then v_use_codes
          else jsonb_build_array(
            jsonb_build_object(
              'note',
                'Ask describe_data about use_code to return the official-reference decode list.'
            )
          )
        end,
        'tax_classes', v_tax_classes,
        'sort_by', jsonb_build_array(
          'assessment_desc',
          'balance_desc',
          'sale_date_desc',
          'address_asc',
          'account_id_asc'
        ),
        'delinquency_filters', jsonb_build_array(
          'has_balance',
          'min_balance_cents',
          'has_tax_sale_flag'
        ),
        'sale_date_filters', jsonb_build_array(
          'sale_date_from',
          'sale_date_to'
        )
      ),
      'empty_result_semantics',
        'An empty result means no current accounts matched the validated exact filters; it never means an invalid filter was silently accepted.'
    );
  end if;

  if v_q like '%use code%' or v_q like '%use_code%' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'code', d.code,
        'label', d.label,
        'description', d.description,
        'source_labels', d.source_labels,
        'current_accounts', d.current_account_count,
        'decode_status', d.decode_status,
        'official_reference_url', d.official_reference_url
      )
      order by d.code
    ), '[]'::jsonb)
    into v_use_codes
    from semantic.code_decode d
    where d.code_system = 'use_code';

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'D.C. use codes are exposed with the current ITSPE label and a link to OTR''s official Real Property Use Code Listing. Raw codes remain authoritative source values.',
      'best_next_tool', 'search_properties',
      'filter_vocabulary', jsonb_build_object(
        'use_codes', v_use_codes
      )
    );
  end if;

  if v_q like '%tax class%'
     or v_q like '%special assessment%'
     or v_q like '%bid%'
     or v_q like '%sews%'
     or v_q like '%pace%'
     or v_q like '%swwsad%' then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'code', d.code,
        'label', d.label,
        'description', d.description,
        'official_reference_url', d.official_reference_url
      )
      order by d.code
    ), '[]'::jsonb)
    into v_tax_classes
    from semantic.code_decode d
    where d.code_system = 'tax_class';

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'code', d.code,
        'label', d.label,
        'description', d.description,
        'official_reference_url', d.official_reference_url
      )
      order by d.code
    ), '[]'::jsonb)
    into v_special_codes
    from semantic.code_decode d
    where d.code_system = 'special_assessment';

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'Raw D.C. codes are preserved and paired with documented decodes. A balance is not a payoff, title, or lien-priority conclusion.',
      'best_next_tool', case
        when v_q like '%filter%' then 'search_properties'
        else 'get_property_snapshot'
      end,
      'code_decodes', jsonb_build_object(
        'tax_classes', v_tax_classes,
        'special_assessments', v_special_codes
      )
    );
  end if;

  if v_q like '%assessment%'
     or v_q like '%valuation%'
     or v_q like '%coverage%'
     or v_q like '%year%' then
    select coalesce(jsonb_agg(to_jsonb(c) order by c.tax_year, c.stage),
      '[]'::jsonb)
    into v_coverage
    from semantic.coverage c
    where c.entity_name = 'assessment';

    select coalesce(jsonb_object_agg(
      f.field_key,
      jsonb_build_object(
        'title', f.title,
        'definition', f.definition,
        'unit', f.unit,
        'null_semantics', f.null_semantics,
        'aggregation_rule', f.aggregation_rule,
        'caveat', f.caveat
      )
    ), '{}'::jsonb)
    into v_fields
    from semantic.field_definition f
    where f.exposure_allowed
      and f.field_key like 'assessment.%';

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'Complete collected ITSPE snapshots cover assessment stages for 2016–2018, 2020–2022, and 2025–2027. Complete years 2019, 2023, and 2024 remain unavailable and are never interpolated.',
      'best_next_tool', 'get_assessment_history',
      'coverage', v_coverage,
      'field_definitions', v_fields,
      'critical_distinction',
        'Prior, current, and proposed are different source stages; proposed is not final, and assessed value is not an appraisal or lending value.'
    );
  end if;

  if v_q like '%tax%'
     or v_q like '%balance%'
     or v_q like '%delinquen%'
     or v_q like '%liabilit%'
     or v_q like '%cy1%'
     or v_q like '%cy2%' then
    select coalesce(jsonb_object_agg(
      f.field_key,
      jsonb_build_object(
        'title', f.title,
        'definition', f.definition,
        'unit', f.unit,
        'null_semantics', f.null_semantics,
        'caveat', f.caveat
      )
    ), '{}'::jsonb)
    into v_fields
    from semantic.field_definition f
    where f.exposure_allowed
      and (
        f.field_key like 'tax.%'
        or f.field_key like 'special.%'
      );

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'TOTDUEAMT is exposed as total_liabilities_reported_cents because the official alias is Total of all liabilities; it is not the current amount owed. Use total_balance_cents for the source-reported balance.',
      'best_next_tool', case
        when v_q like '%screen%' or v_q like '%filter%'
          or v_q like '%delinquen%' then 'search_properties'
        else 'get_tax_and_balance_history'
      end,
      'slot_semantics', jsonb_build_object(
        'CY1', 'Current tax year, first half.',
        'CY2', 'Current tax year, second half.',
        'PY1_through_PY10',
          'Prior-year source slots, newest to oldest; not a payment ledger.'
      ),
      'screening_filters', jsonb_build_array(
        'has_balance',
        'min_balance_cents',
        'has_tax_sale_flag',
        'balance_desc'
      ),
      'field_definitions', v_fields,
      'unsupported_inference',
        'No returned tax amount establishes payoff, title, lien existence, or lien priority.'
    );
  end if;

  if v_q like '%sale%'
     or v_q like '%deed%'
     or v_q like '%transfer%'
     or v_q like '%title%'
     or v_q like '%instrument%' then
    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'get_latest_sale_and_deed returns all linked records from the official CAMA sale-history export plus the latest deed fields carried by ITSPE. CAMA is assessor sale history, not a Recorder chain of title.',
      'best_next_tool', 'get_latest_sale_and_deed',
      'coverage', jsonb_build_object(
        'source', 'Tax System Property Sales (CAMA)',
        'source_records_downloaded', 421445,
        'source_records_linked', 421436,
        'active_accounts_with_history', 215408,
        'retrieved_at', '2026-07-27T17:27:25-04:00',
        'sale_date_range_reported',
          jsonb_build_array('1900-01-01', '2026-07-14')
      ),
      'instrument_rule',
        'Only a year-prefixed instrument is safe to prefill. A bare reported instrument is retained but the evidence route uses deed year, SSL/address, and party name instead.',
      'limitations', jsonb_build_array(
        'Not a Recorder of Deeds chain of title.',
        'Not a title report or lien search.',
        'Zero prices and the 1900 sentinel date are preserved and flagged.',
        'Nine CAMA source records did not link to the current ITSPE account extract.'
      )
    );
  end if;

  if v_q like '%source%'
     or v_q like '%evidence%'
     or v_q like '%provenance%'
     or v_q like '%verify%' then
    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'Every exposed fact carries or deterministically constructs a four-part source_ref. get_source_evidence validates it before parsing and returns a human-facing official portal, exact lookup inputs, steps, source hash, and retrieval/capture date.',
      'best_next_tool', 'get_source_evidence',
      'source_ref_contract', jsonb_build_object(
        'format', 'source_id|source_record_id|field_key|ssl',
        'tax_slot_example',
          'itspe_current|7161|tax.slot.penalty.PY4|01070075',
        'rule',
          'Do not edit refs returned by tools except to construct a tax-slot ref using the supplied prefix, key, and suffix.'
      ),
      'human_portals', jsonb_build_array(
        'MyTax.DC.gov Real Property Search',
        'D.C. OTR Real Property Assessment Map',
        'D.C. Open Data Tax System Property Sales (CAMA)',
        'D.C. Recorder of Deeds Official Records Search'
      ),
      'machine_url_policy',
        'Evidence responses deliberately exclude ArcGIS REST, JSON, and session-bound MyTax retrieval URLs.'
    );
  end if;

  if v_q like '%owner%'
     or v_q like '%quality%'
     or v_q like '%north korea%'
     or v_q like '%anomal%' then
    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'The connector preserves official source values and adds review flags without silently rewriting them. OWNOCCT is correctly exposed as occupied cooperative units, not an owner-occupancy boolean.',
      'best_next_tool', 'get_ownership_and_sale',
      'quality_flags', jsonb_build_object(
        'mailing_jurisdiction_conflict',
          'The mailing locality and country conflict; the source value is preserved for human review.',
        'sale_price_assessment_outlier',
          'A positive reported sale price is below 5% or above 20x the current assessment.',
        'vacant_type_improvement_value_conflict',
          'The source property type is vacant while a positive improvement value is reported.',
        'property_type_source_length_limit',
          'The raw source label reached the published 30-character field limit; a canonical display label is also supplied.',
        'premise_address_source_length_limit',
          'The raw source address reached the published 50-character field limit; a clean street-and-unit display is also supplied.'
      ),
      'important_limit',
        'A quality flag is a review condition, not a sanctions, fraud, title, or credit conclusion.'
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'question', v_question,
    'entity',
      'D.C. property-tax account (not guaranteed to equal one physical parcel)',
    'answer',
      'Resolve identity first, use the narrowest lender tool, and send returned source_refs to get_source_evidence for human verification.',
    'recommended_sequence', jsonb_build_array(
      'resolve_property or resolve_properties_batch',
      'get_property_snapshot',
      'Use one domain history tool if needed',
      'get_source_evidence'
    ),
    'topics', jsonb_build_array(
      'search filters and property_type vocabulary',
      'use codes, tax classes, and special-assessment decodes',
      'assessment coverage',
      'tax slots, balances, and delinquency screening',
      'sale history, deeds, and instrument verification',
      'ownership and quality flags',
      'source evidence and provenance'
    ),
    'tools', jsonb_build_object(
      'resolve_property',
        'One-account exact-first identity resolution with scored fuzzy suggestions.',
      'resolve_properties_batch',
        'Bounded resolution for 1–50 caller-supplied named assets.',
      'get_property_snapshot',
        'Lender-oriented current quick look with decodes and quality flags.',
      'get_assessment_history',
        'Available prior/current/proposed assessment stages and explicit gaps.',
      'get_tax_and_balance_history',
        'Current summary and compact half-year/prior-year tax slots.',
      'get_ownership_and_sale',
        'Current assessor owner and mailing fields; no duplicate transfer block.',
      'get_latest_sale_and_deed',
        'Official CAMA sale history plus latest ITSPE deed fields.',
      'search_properties',
        'Validated, sortable screening with classification, balance, tax-sale, and sale-date filters.',
      'get_source_evidence',
        'Validated source refs expanded into human official portal playbooks.'
    ),
    'unsupported_inferences', jsonb_build_array(
      'title, lien existence, or lien priority',
      'complete Recorder chain of title',
      'NOI, DSCR, occupancy rate, rent roll, or debt',
      'building area or condition unless separately sourced',
      'zoning compliance',
      'credit decision or property valuation opinion'
    )
  );
end;
$function$;

revoke all on function api_v1.get_source_evidence(text[]) from public;
revoke all on function api_v1.describe_data(text) from public;
grant execute on function api_v1.get_source_evidence(text[])
  to mcp_runtime;
grant execute on function api_v1.describe_data(text)
  to mcp_runtime;

comment on function api_v1.get_source_evidence(text[]) is
  'Validates source references before parsing, preserves caller order, and expands them into human-facing official portals, exact lookup inputs, and verification steps.';
comment on function api_v1.describe_data(text) is
  'Compact keyword-routed semantic guide with discoverable filter vocabulary, documented codes, coverage, limitations, and best-next-tool guidance.';

alter function api_v1.get_source_evidence(text[]) owner to api_owner;
alter function api_v1.describe_data(text) owner to api_owner;

commit;
