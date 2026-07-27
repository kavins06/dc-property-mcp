begin;

insert into semantic.field_definition (
  field_key,
  json_path,
  title,
  definition,
  entity_name,
  data_type,
  unit,
  time_grain,
  source_fields,
  lender_synonyms,
  commonly_confused_with,
  null_semantics,
  aggregation_rule,
  caveat,
  definition_status,
  formula_version,
  exposure_allowed,
  search_filter_allowed
) values (
  'property.premise_address_display',
  '$.identity.premise_address',
  'Premise address display',
  'A human-readable D.C. street-and-unit display derived from the raw ITSPE PREMISEADD field by removing its source-truncated city/ZIP suffix.',
  'property_account',
  'text',
  null,
  'record date',
  array['PREMISEADD'],
  array['property address', 'street address'],
  array['mailing address'],
  'Null means the source did not report a premise address.',
  null,
  'Derived for display. The exact source value remains in premise_address_source.',
  'derived',
  'premise-address-display-v1',
  true,
  false
) on conflict (field_key) do update set
  json_path = excluded.json_path,
  title = excluded.title,
  definition = excluded.definition,
  caveat = excluded.caveat,
  formula_version = excluded.formula_version,
  exposure_allowed = excluded.exposure_allowed;

set local role api_owner;

create or replace function api_v1.get_property_snapshot(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select
      a.*,
      api_v1._source_ref(
        a.source_id,
        a.source_row_number,
        'property_account',
        a.ssl_normalized
      ) ref,
      api_v1._property_quality_flags(
        a.mailing_city_state_zip,
        a.current_total_value,
        a.current_improvement_value,
        a.latest_sale_price_dollars,
        a.property_type,
        a.premise_address
      ) quality_flags
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object(
        'status', r.resolution_status,
        'next_tool', 'resolve_property',
        'hint', case r.resolution_status
          when 'ambiguous' then
            'Resolve the unit or SSL before requesting collateral facts.'
          when 'no_exact_match' then
            'Confirm one fuzzy suggestion before requesting collateral facts.'
          when 'invalid_input' then
            'Provide an SSL or street address.'
          when 'conflicting_input' then
            'Correct the conflicting SSL and address.'
          else 'Verify the property identity with resolve_property.'
        end
      )
    else jsonb_build_object(
      'status', 'resolved',
      'entity_warning',
        'A D.C. property-tax account is not guaranteed to equal one physical parcel.',
      'quality_flags', a.quality_flags,
      'identity', jsonb_build_object(
        'account_id', a.account_id,
        'ssl', api_v1._fact(
          a.ssl_display,
          'property.ssl',
          a.record_extract_at,
          a.ref
        ),
        'premise_address', api_v1._fact(
          api_v1._display_address(a.premise_address),
          'property.premise_address_display',
          a.record_extract_at,
          a.ref
        ),
        'premise_address_source', api_v1._fact(
          a.premise_address,
          'property.premise_address',
          a.record_extract_at,
          a.ref
        ),
        'ward', api_v1._fact(
          a.ward,
          'property.ward',
          a.record_extract_at,
          a.ref
        )
      ),
      'classification', jsonb_build_object(
        'property_type_source', api_v1._fact(
          a.property_type,
          'classification.property_type',
          a.record_extract_at,
          a.ref
        ),
        'property_type_canonical', api_v1._fact(
          api_v1._canonical_property_type(a.property_type),
          'classification.property_type_canonical',
          a.record_extract_at,
          a.ref
        ),
        'use_code', api_v1._fact(
          a.use_code,
          'classification.use_code',
          a.record_extract_at,
          a.ref
        ),
        'tax_class', api_v1._fact(
          a.tax_class,
          'classification.tax_class',
          a.record_extract_at,
          a.ref
        ),
        'land_area_sqft', api_v1._fact(
          a.land_area,
          'property.land_area',
          a.record_extract_at,
          a.ref
        ),
        'code_decodes', jsonb_build_object(
          'use_code', (
            select jsonb_build_object(
              'code', d.code,
              'label', d.label,
              'description', d.description,
              'decode_status', d.decode_status,
              'official_reference_url', d.official_reference_url
            )
            from semantic.code_decode d
            where d.code_system = 'use_code'
              and d.code = a.use_code
          ),
          'tax_class', (
            select jsonb_build_object(
              'code', d.code,
              'label', d.label,
              'description', d.description,
              'decode_status', d.decode_status,
              'official_reference_url', d.official_reference_url
            )
            from semantic.code_decode d
            where d.code_system = 'tax_class'
              and d.code = a.tax_class
          )
        )
      ),
      'ownership', jsonb_build_object(
        'owner_name', api_v1._fact(
          a.owner_name,
          'ownership.owner_name',
          a.record_extract_at,
          a.ref
        ),
        'owner_occupied_cooperative_units', api_v1._fact(
          case
            when a.owner_occupancy_flag ~ '^[0-9]+$'
              then a.owner_occupancy_flag::integer
            else null
          end,
          'ownership.owner_occupied_cooperative_units',
          a.record_extract_at,
          a.ref
        )
      ),
      'valuation', jsonb_build_object(
        'current_total_value_dollars', api_v1._fact(
          a.current_total_value,
          'assessment.current_total_value',
          a.record_extract_at,
          a.ref
        ),
        'proposed_total_value_dollars', api_v1._fact(
          a.proposed_total_value,
          'assessment.proposed_total_value',
          a.record_extract_at,
          a.ref
        )
      ),
      'tax_and_balance', jsonb_build_object(
        'annual_tax_cents', api_v1._fact(
          a.annual_tax_cents,
          'tax.annual_tax',
          a.record_extract_at,
          a.ref
        ),
        'total_liabilities_reported_cents', api_v1._fact(
          a.total_due_cents,
          'tax.total_liabilities_reported',
          a.record_extract_at,
          a.ref
        ),
        'total_balance_cents', api_v1._fact(
          a.total_balance_cents,
          'tax.total_balance',
          a.record_extract_at,
          a.ref
        ),
        'last_payment_date', api_v1._fact(
          a.last_payment_date,
          'tax.last_payment_date',
          a.record_extract_at,
          a.ref
        )
      ),
      'special_balances', jsonb_build_object(
        'bid_balance_cents', api_v1._fact(
          a.bid_balance_cents,
          'special.bid_balance',
          a.record_extract_at,
          a.ref
        ),
        'sews_balance_cents', api_v1._fact(
          a.sews_balance_cents,
          'special.sews_balance',
          a.record_extract_at,
          a.ref
        ),
        'pace_balance_cents', api_v1._fact(
          a.pace_balance_cents,
          'special.pace_balance',
          a.record_extract_at,
          a.ref
        ),
        'swwsad_balance_cents', api_v1._fact(
          a.swwsad_balance_cents,
          'special.swwsad_balance',
          a.record_extract_at,
          a.ref
        ),
        'code_decodes', (
          select jsonb_object_agg(
            lower(d.code),
            jsonb_build_object(
              'label', d.label,
              'description', d.description,
              'official_reference_url', d.official_reference_url
            )
            order by d.code
          )
          from semantic.code_decode d
          where d.code_system = 'special_assessment'
        )
      ),
      'latest_transfer_summary', jsonb_build_object(
        'sale_price_dollars', api_v1._fact(
          a.latest_sale_price_dollars,
          'sale.latest_price',
          a.record_extract_at,
          a.ref
        ),
        'sale_date', api_v1._fact(
          a.latest_sale_date,
          'sale.latest_date',
          a.record_extract_at,
          a.ref
        ),
        'instrument_number', api_v1._fact(
          a.latest_instrument_number,
          'deed.latest_instrument_number',
          a.record_extract_at,
          a.ref
        ),
        'caveat',
          'A zero price is a reported value and can represent a nominal or non-market transfer. Use get_latest_sale_and_deed for official CAMA history and deed context.',
        'next_tool', 'get_latest_sale_and_deed'
      ),
      'limitations', jsonb_build_array(
        'Current owner and transfer fields are not a title report or lien search.',
        'Null means the source did not report a value; it does not necessarily mean zero or none.',
        'Quality flags preserve the official value and identify a review condition; they do not silently correct public records.'
      )
    )
  end
  from resolved r
  left join account a on true;
$$;

create or replace function api_v1.get_assessment_history(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  rows as (
    select h.*
    from history.assessment_snapshot_record h
    join resolved r on r.resolved_account_id = h.account_id
  ),
  periods as (
    select
      tax_year,
      stage,
      land_value,
      improvement_value,
      total_value,
      record_extract_at,
      source_id,
      source_row_number,
      ssl_normalized
    from rows
    cross join lateral (values
      (
        prior_tax_year,
        'prior',
        prior_land_value,
        prior_improvement_value,
        prior_total_value
      ),
      (
        current_tax_year,
        'current',
        current_land_value,
        current_improvement_value,
        current_total_value
      ),
      (
        proposed_tax_year,
        'proposed',
        proposed_land_value,
        proposed_improvement_value,
        proposed_total_value
      )
    ) values_by_stage(
      tax_year,
      stage,
      land_value,
      improvement_value,
      total_value
    )
    where tax_year is not null
  ),
  payload as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'tax_year', tax_year,
        'stage', stage,
        'record_date', record_extract_at,
        'source_snapshot', source_id,
        'land_value_dollars', jsonb_build_object(
          'value', land_value,
          'status', case
            when land_value is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            source_id,
            source_row_number,
            'assessment.land_value',
            ssl_normalized
          ))
        ),
        'improvement_value_dollars', jsonb_build_object(
          'value', improvement_value,
          'status', case
            when improvement_value is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            source_id,
            source_row_number,
            'assessment.improvement_value',
            ssl_normalized
          ))
        ),
        'total_value_dollars', jsonb_build_object(
          'value', total_value,
          'status', case
            when total_value is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            source_id,
            source_row_number,
            'assessment.total_value',
            ssl_normalized
          ))
        ),
        'quality_flags', case
          when stage = 'proposed' then jsonb_build_array('proposed_not_final')
          else '[]'::jsonb
        end
      )
      order by tax_year, stage, record_extract_at, source_id
    ), '[]'::jsonb) items
    from periods
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object(
        'status', r.resolution_status,
        'next_tool', 'resolve_property'
      )
    else jsonb_build_object(
      'status', 'resolved',
      'field_dictionary', jsonb_build_object(
        'land_value_dollars', jsonb_build_object(
          'field_key', 'assessment.land_value',
          'unit', 'USD',
          'meaning', 'Source-reported assessed value allocated to land.'
        ),
        'improvement_value_dollars', jsonb_build_object(
          'field_key', 'assessment.improvement_value',
          'unit', 'USD',
          'meaning',
            'Source-reported assessed value allocated to improvements.'
        ),
        'total_value_dollars', jsonb_build_object(
          'field_key', 'assessment.total_value',
          'unit', 'USD',
          'meaning',
            'Source-reported total assessed value for the named stage and year.'
        )
      ),
      'assessments', p.items,
      'known_complete_year_gaps', coalesce((
        select jsonb_agg(c.tax_year order by c.tax_year)
        from semantic.coverage c
        where c.entity_name = 'assessment'
          and c.availability_status = 'not_available'
      ), '[]'::jsonb),
      'coverage_note',
        'Available complete ITSPE snapshots expose 2016–2018, 2020–2022, and 2025–2027 stages. Missing complete years remain explicit.',
      'limitations', jsonb_build_array(
        'Proposed, current, and prior are distinct source stages and must not be conflated.',
        'Repeated tax years from different snapshots are retained rather than silently overwritten.',
        'An assessment is not an appraisal or lending value.'
      )
    )
  end
  from resolved r
  cross join payload p;
$$;

create or replace function api_v1.get_tax_and_balance_history(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select
      a.*,
      t.tax_year_anchor,
      t.values_cents,
      t.source_row_number tax_source_row_number,
      api_v1._source_ref(
        'itspe_current',
        t.source_row_number,
        'tax_summary',
        a.ssl_normalized
      ) summary_ref
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
    left join history.tax_series t on t.account_id = a.account_id
  ),
  slots as (
    select
      g.slot_ordinal,
      (array[
        'CY1', 'CY2', 'PY1', 'PY2', 'PY3', 'PY4',
        'PY5', 'PY6', 'PY7', 'PY8', 'PY9', 'PY10'
      ])[g.slot_ordinal] slot_code,
      case
        when g.slot_ordinal <= 2 then a.tax_year_anchor
        else a.tax_year_anchor - (g.slot_ordinal - 2)
      end tax_year,
      case g.slot_ordinal
        when 1 then 'current_year_first_half'
        when 2 then 'current_year_second_half'
        else 'prior_year'
      end period_semantics,
      f.flag tax_sale_flag,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        g.slot_ordinal
      ) tax_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        12 + g.slot_ordinal
      ) penalty_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        24 + g.slot_ordinal
      ) interest_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        36 + g.slot_ordinal
      ) fee_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        48 + g.slot_ordinal
      ) total_due_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        60 + g.slot_ordinal
      ) collected_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        72 + g.slot_ordinal
      ) balance_cents,
      api_v1._tax_value(
        a.account_id,
        a.values_cents,
        84 + g.slot_ordinal
      ) credit_cents
    from account a
    cross join generate_series(1, 12) g(slot_ordinal)
    left join history.tax_sale_flag f
      on f.account_id = a.account_id
      and f.slot_ordinal = g.slot_ordinal
  ),
  payload as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'slot', slot_code,
        'tax_year', tax_year,
        'period_semantics', period_semantics,
        'values', jsonb_build_array(
          tax_sale_flag,
          tax_cents,
          penalty_cents,
          interest_cents,
          fee_cents,
          total_due_cents,
          collected_cents,
          balance_cents,
          credit_cents
        )
      )
      order by slot_ordinal
    ), '[]'::jsonb) items
    from slots
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object(
        'status', r.resolution_status,
        'next_tool', 'resolve_property'
      )
    else jsonb_build_object(
      'status', 'resolved',
      'record_date', a.record_extract_at,
      'current_summary', jsonb_build_object(
        'annual_tax_cents', api_v1._fact(
          a.annual_tax_cents,
          'tax.annual_tax',
          a.record_extract_at,
          a.summary_ref
        ),
        'total_liabilities_reported_cents', api_v1._fact(
          a.total_due_cents,
          'tax.total_liabilities_reported',
          a.record_extract_at,
          a.summary_ref
        ),
        'total_collected_cents', api_v1._fact(
          a.total_collected_cents,
          'tax.total_collected',
          a.record_extract_at,
          a.summary_ref
        ),
        'total_balance_cents', api_v1._fact(
          a.total_balance_cents,
          'tax.total_balance',
          a.record_extract_at,
          a.summary_ref
        )
      ),
      'slot_field_dictionary', jsonb_build_array(
        jsonb_build_object(
          'key', 'tax_sale_flag',
          'ref_key', 'tax_sale_flag',
          'field_key', 'tax.slot.tax_sale_flag',
          'unit', null
        ),
        jsonb_build_object(
          'key', 'tax_cents',
          'ref_key', 'tax',
          'field_key', 'tax.slot.tax',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'penalty_cents',
          'ref_key', 'penalty',
          'field_key', 'tax.slot.penalty',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'interest_cents',
          'ref_key', 'interest',
          'field_key', 'tax.slot.interest',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'fee_cents',
          'ref_key', 'fee',
          'field_key', 'tax.slot.fee',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'total_due_cents',
          'ref_key', 'total_due',
          'field_key', 'tax.slot.total_due',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'collected_cents',
          'ref_key', 'collected',
          'field_key', 'tax.slot.collected',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'balance_cents',
          'ref_key', 'balance',
          'field_key', 'tax.slot.balance',
          'unit', 'cents'
        ),
        jsonb_build_object(
          'key', 'credit_cents',
          'ref_key', 'credit',
          'field_key', 'tax.slot.credit',
          'unit', 'cents'
        )
      ),
      'slot_provenance', jsonb_build_object(
        'source_ref_prefix',
          'itspe_current|' || a.tax_source_row_number::text || '|tax.slot.',
        'source_ref_suffix', '|' || a.ssl_normalized,
        'construction',
          'Values align by position with slot_field_dictionary. For each value, concatenate source_ref_prefix + that dictionary entry''s ref_key + ''.'' + the row slot + source_ref_suffix, then call get_source_evidence.',
        'example',
          'itspe_current|' || a.tax_source_row_number::text ||
          '|tax.slot.penalty.PY4|' || a.ssl_normalized
      ),
      'source_slots', p.items,
      'slot_semantics', jsonb_build_object(
        'CY1', 'Current tax year, first half.',
        'CY2', 'Current tax year, second half.',
        'PY1_through_PY10',
          'Prior-year source slots, newest to oldest. They are not a payment ledger.'
      ),
      'aggregation_warning',
        'CY1/CY2 are half-year source slots and PY1..PY10 are prior-year source slots. No unsupported annual rollup is calculated.',
      'balance_warning',
        'Total liabilities reported is not the amount currently owed. Use total_balance_cents for the source-reported balance; neither is a payoff or lien-priority conclusion.'
    )
  end
  from resolved r
  cross join payload p
  left join account a on true;
$$;

create or replace function api_v1.get_ownership_and_sale(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select
      a.*,
      api_v1._source_ref(
        a.source_id,
        a.source_row_number,
        'ownership',
        a.ssl_normalized
      ) ref,
      api_v1._property_quality_flags(
        a.mailing_city_state_zip,
        a.current_total_value,
        a.current_improvement_value,
        a.latest_sale_price_dollars,
        a.property_type,
        a.premise_address
      ) quality_flags
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object(
        'status', r.resolution_status,
        'next_tool', 'resolve_property'
      )
    else jsonb_build_object(
      'status', 'resolved',
      'quality_flags', a.quality_flags,
      'owner_of_record', jsonb_build_object(
        'owner_name', api_v1._fact(
          a.owner_name,
          'ownership.owner_name',
          a.record_extract_at,
          a.ref
        ),
        'owner_name_2', api_v1._fact(
          a.owner_name_2,
          'ownership.owner_name_2',
          a.record_extract_at,
          a.ref
        ),
        'care_of_name', api_v1._fact(
          a.care_of_name,
          'ownership.care_of_name',
          a.record_extract_at,
          a.ref
        ),
        'mailing_address_1', api_v1._fact(
          a.mailing_address_1,
          'ownership.mailing_address_1',
          a.record_extract_at,
          a.ref
        ),
        'mailing_address_2', api_v1._fact(
          a.mailing_address_2,
          'ownership.mailing_address_2',
          a.record_extract_at,
          a.ref
        ),
        'mailing_city_state_zip', api_v1._fact(
          a.mailing_city_state_zip,
          'ownership.mailing_city_state_zip',
          a.record_extract_at,
          a.ref
        ),
        'owner_occupied_cooperative_units', api_v1._fact(
          case
            when a.owner_occupancy_flag ~ '^[0-9]+$'
              then a.owner_occupancy_flag::integer
            else null
          end,
          'ownership.owner_occupied_cooperative_units',
          a.record_extract_at,
          a.ref
        )
      ),
      'sale_history_route', jsonb_build_object(
        'next_tool', 'get_latest_sale_and_deed',
        'reason',
          'Sale/deed facts are intentionally kept in one response family to avoid duplicate truth blocks.'
      ),
      'limitations', jsonb_build_array(
        'Owner data is the assessor source record as of the record date.',
        'Assessor ownership is not proof of current legal title or borrower identity.',
        'Quality flags preserve source values and identify review conditions; they are not silent corrections.'
      )
    )
  end
  from resolved r
  left join account a on true;
$$;

create or replace function api_v1.get_latest_sale_and_deed(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved as (
    select * from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select
      a.*,
      s.source_objectids,
      s.sale_dates,
      s.sale_prices,
      s.qualified_codes,
      s.sale_codes,
      s.current_owner_flags,
      api_v1._source_ref(
        a.source_id,
        a.source_row_number,
        'latest_assessor_deed',
        a.ssl_normalized
      ) assessor_ref
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
    left join history.sale_series s on s.account_id = a.account_id
  ),
  sales as (
    select
      g.ordinality,
      a.source_objectids[g.ordinality] source_objectid,
      a.sale_dates[g.ordinality] sale_date,
      a.sale_prices[g.ordinality] sale_price,
      a.qualified_codes[g.ordinality] qualified_code,
      a.sale_codes[g.ordinality] sale_code,
      a.current_owner_flags[g.ordinality] current_owner_flag,
      a.ssl_normalized
    from account a
    cross join lateral generate_subscripts(
      a.source_objectids,
      1
    ) g(ordinality)
  ),
  history_payload as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'source_record_id', source_objectid,
        'sale_date', jsonb_build_object(
          'value', sale_date,
          'status', case
            when sale_date is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            'cama_sales_current',
            source_objectid,
            'sale.history.date',
            ssl_normalized
          ))
        ),
        'sale_price_dollars', jsonb_build_object(
          'value', sale_price,
          'status', case
            when sale_price is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            'cama_sales_current',
            source_objectid,
            'sale.history.price',
            ssl_normalized
          ))
        ),
        'qualified_code', jsonb_build_object(
          'value', qualified_code,
          'status', case
            when qualified_code is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            'cama_sales_current',
            source_objectid,
            'sale.history.qualified_code',
            ssl_normalized
          ))
        ),
        'sale_code', jsonb_build_object(
          'value', sale_code,
          'status', case
            when sale_code is null then 'not_reported' else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            'cama_sales_current',
            source_objectid,
            'sale.history.sale_code',
            ssl_normalized
          ))
        ),
        'current_owner_flag', jsonb_build_object(
          'value', case current_owner_flag
            when 1 then true
            when 0 then false
            else null
          end,
          'status', case
            when current_owner_flag is null then 'not_reported'
            else 'reported'
          end,
          'source_refs', jsonb_build_array(api_v1._source_ref(
            'cama_sales_current',
            source_objectid,
            'sale.history.current_owner_flag',
            ssl_normalized
          ))
        ),
        'quality_flags', (
          select coalesce(jsonb_agg(to_jsonb(flag) order by flag), '[]'::jsonb)
          from (
            select 'source_sentinel_date' flag
            where sale_date = date '1900-01-01'
            union all
            select 'nominal_or_non_market_zero_price'
            where sale_price = 0
            union all
            select 'unqualified_sale'
            where upper(coalesce(qualified_code, '')) = 'U'
          ) sale_flags
        )
      )
      order by ordinality
    ), '[]'::jsonb) items
    from sales
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object(
        'status', r.resolution_status,
        'next_tool', 'resolve_property'
      )
    else jsonb_build_object(
      'status', 'resolved',
      'sale_history', h.items,
      'sale_history_source', jsonb_build_object(
        'dataset', 'Tax System Property Sales (CAMA)',
        'scope',
          'Official assessor sale history linked to this active assessment-roll account.',
        'dataset_retrieved_at', (
          select s.dataset_retrieved_at
          from meta.source_asset s
          where s.source_id = 'cama_sales_current'
        ),
        'source_refs_are_field_specific', true
      ),
      'latest_assessor_deed', jsonb_build_object(
        'deed_date', api_v1._fact(
          a.latest_deed_date,
          'deed.latest_date',
          a.record_extract_at,
          a.assessor_ref
        ),
        'instrument_number',
          api_v1._fact(
            a.latest_instrument_number,
            'deed.latest_instrument_number',
            a.record_extract_at,
            a.assessor_ref
          ) || jsonb_build_object(
            'search_ready',
              coalesce(a.latest_instrument_number, '') ~ '^[0-9]{10,}$',
            'quality_flags', case
              when nullif(a.latest_instrument_number, '') is not null
                and a.latest_instrument_number !~ '^[0-9]{10,}$'
                then jsonb_build_array('instrument_not_year_prefixed')
              else '[]'::jsonb
            end,
            'caveat', case
              when nullif(a.latest_instrument_number, '') is not null
                and a.latest_instrument_number !~ '^[0-9]{10,}$'
                then 'The reported instrument is not year-prefixed and is not safe to prefill in the Recorder portal. Use the deed year, SSL, address, and party name.'
              else 'Use get_source_evidence for the official Recorder search route.'
            end
          ),
        'sale_type', api_v1._fact(
          a.latest_sale_type,
          'sale.latest_type',
          a.record_extract_at,
          a.assessor_ref
        ),
        'acceptance_code', api_v1._fact(
          a.latest_sale_acceptance_code,
          'sale.latest_acceptance_code',
          a.record_extract_at,
          a.assessor_ref
        )
      ),
      'assessor_latest_sale_fallback', case
        when jsonb_array_length(h.items) = 0 then jsonb_build_object(
          'sale_price_dollars', api_v1._fact(
            a.latest_sale_price_dollars,
            'sale.latest_price',
            a.record_extract_at,
            a.assessor_ref
          ),
          'sale_date', api_v1._fact(
            a.latest_sale_date,
            'sale.latest_date',
            a.record_extract_at,
            a.assessor_ref
          )
        )
        else null
      end,
      'limitations', jsonb_build_array(
        'CAMA sale history is not a Recorder of Deeds chain of title, title report, or lien search.',
        'A zero price is preserved and can represent a nominal or non-market transfer.',
        'Qualified and sale codes are assessor classifications; they do not establish title or arm''s-length status by themselves.',
        'The dataset covers active properties on the D.C. assessment roll as of the source retrieval date.'
      )
    )
  end
  from resolved r
  cross join history_payload h
  left join account a on true;
$$;

create or replace function api_v1.search_properties(
  p_filters jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_unknown_keys text[];
  v_ward text;
  v_property_type text;
  v_use_code text;
  v_tax_class text;
  v_min_assessment bigint;
  v_max_assessment bigint;
  v_has_balance boolean;
  v_min_balance bigint;
  v_has_tax_sale boolean;
  v_sale_date_from date;
  v_sale_date_to date;
  v_sort text;
  v_limit integer;
  v_cursor jsonb;
  v_cursor_id bigint;
  v_cursor_bigint bigint;
  v_cursor_date date;
  v_cursor_text text;
  v_total_count bigint;
  v_results jsonb;
  v_has_more boolean;
  v_last_id bigint;
  v_last_value text;
  v_next_cursor text;
begin
  if jsonb_typeof(v_filters) <> 'object' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'filter_object_required',
        'hint', 'Pass a JSON object containing only documented search filters.'
      )
    );
  end if;

  select array_agg(key order by key)
  into v_unknown_keys
  from jsonb_object_keys(v_filters) key
  where key <> all(array[
    'ward',
    'property_type',
    'use_code',
    'tax_class',
    'min_assessment',
    'max_assessment',
    'has_balance',
    'min_balance_cents',
    'has_tax_sale_flag',
    'sale_date_from',
    'sale_date_to',
    'sort_by',
    'cursor',
    'limit'
  ]);

  if v_unknown_keys is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_filter',
        'unknown_filters', to_jsonb(v_unknown_keys),
        'hint', 'Call describe_data with a search or filter question for the allowlisted vocabulary.'
      )
    );
  end if;

  v_ward := nullif(
    regexp_replace(coalesce(v_filters->>'ward', ''), '[^0-9]', '', 'g'),
    ''
  );
  if v_filters ? 'ward' and (
    v_ward is null or v_ward not in ('1', '2', '3', '4', '5', '6', '7', '8')
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_ward',
        'hint', 'Ward must be 1 through 8.'
      )
    );
  end if;

  v_property_type := nullif(trim(v_filters->>'property_type'), '');
  v_use_code := nullif(upper(trim(v_filters->>'use_code')), '');
  v_tax_class := nullif(upper(trim(v_filters->>'tax_class')), '');

  if v_filters ? 'min_assessment' and
     coalesce(v_filters->>'min_assessment', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_min_assessment',
        'hint', 'min_assessment must be a nonnegative whole-dollar integer.'
      )
    );
  end if;
  if v_filters ? 'max_assessment' and
     coalesce(v_filters->>'max_assessment', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_max_assessment',
        'hint', 'max_assessment must be a nonnegative whole-dollar integer.'
      )
    );
  end if;
  if v_filters ? 'min_balance_cents' and
     coalesce(v_filters->>'min_balance_cents', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_min_balance',
        'hint', 'min_balance_cents must be a nonnegative integer.'
      )
    );
  end if;

  v_min_assessment := nullif(v_filters->>'min_assessment', '')::bigint;
  v_max_assessment := nullif(v_filters->>'max_assessment', '')::bigint;
  v_min_balance := nullif(v_filters->>'min_balance_cents', '')::bigint;
  if v_min_assessment is not null
     and v_max_assessment is not null
     and v_min_assessment > v_max_assessment then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'inverted_assessment_range',
        'hint', 'min_assessment cannot exceed max_assessment.'
      )
    );
  end if;

  if v_filters ? 'has_balance'
     and jsonb_typeof(v_filters->'has_balance') <> 'boolean' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_has_balance',
        'hint', 'has_balance must be true or false.'
      )
    );
  end if;
  if v_filters ? 'has_tax_sale_flag'
     and jsonb_typeof(v_filters->'has_tax_sale_flag') <> 'boolean' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_tax_sale_filter',
        'hint', 'has_tax_sale_flag must be true or false.'
      )
    );
  end if;
  v_has_balance := case
    when v_filters ? 'has_balance'
      then (v_filters->>'has_balance')::boolean
    else null
  end;
  v_has_tax_sale := case
    when v_filters ? 'has_tax_sale_flag'
      then (v_filters->>'has_tax_sale_flag')::boolean
    else null
  end;

  begin
    if v_filters ? 'sale_date_from' then
      if coalesce(v_filters->>'sale_date_from', '') !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise invalid_datetime_format;
      end if;
      v_sale_date_from := (v_filters->>'sale_date_from')::date;
    end if;
    if v_filters ? 'sale_date_to' then
      if coalesce(v_filters->>'sale_date_to', '') !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise invalid_datetime_format;
      end if;
      v_sale_date_to := (v_filters->>'sale_date_to')::date;
    end if;
  exception when others then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_sale_date',
        'hint', 'Sale dates must be valid ISO dates in YYYY-MM-DD format.'
      )
    );
  end;
  if v_sale_date_from is not null
     and v_sale_date_to is not null
     and v_sale_date_from > v_sale_date_to then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'inverted_sale_date_range',
        'hint', 'sale_date_from cannot be later than sale_date_to.'
      )
    );
  end if;

  v_sort := coalesce(nullif(v_filters->>'sort_by', ''), 'account_id_asc');
  if v_sort not in (
    'assessment_desc',
    'balance_desc',
    'sale_date_desc',
    'address_asc',
    'account_id_asc'
  ) then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_sort',
        'hint', 'Use assessment_desc, balance_desc, sale_date_desc, address_asc, or account_id_asc.'
      )
    );
  end if;

  if v_filters ? 'limit'
     and coalesce(v_filters->>'limit', '') !~ '^[0-9]+$' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_limit',
        'hint', 'limit must be an integer from 1 through 50.'
      )
    );
  end if;
  v_limit := least(
    greatest(coalesce((v_filters->>'limit')::integer, 20), 1),
    50
  );

  if nullif(v_filters->>'cursor', '') is not null then
    begin
      v_cursor := (v_filters->>'cursor')::jsonb;
      if jsonb_typeof(v_cursor) <> 'object'
         or v_cursor->>'sort_by' <> v_sort
         or coalesce(v_cursor->>'account_id', '') !~ '^[0-9]+$' then
        raise invalid_parameter_value;
      end if;
      v_cursor_id := (v_cursor->>'account_id')::bigint;
      if v_sort in ('assessment_desc', 'balance_desc') then
        if coalesce(v_cursor->>'value', '') !~ '^-?[0-9]+$' then
          raise invalid_parameter_value;
        end if;
        v_cursor_bigint := (v_cursor->>'value')::bigint;
      elsif v_sort = 'sale_date_desc' then
        if coalesce(v_cursor->>'value', '') !~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise invalid_parameter_value;
        end if;
        v_cursor_date := (v_cursor->>'value')::date;
      elsif v_sort = 'address_asc' then
        v_cursor_text := v_cursor->>'value';
        if v_cursor_text is null then
          raise invalid_parameter_value;
        end if;
      end if;
    exception when others then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'invalid_cursor',
          'hint', 'Use the next_cursor returned by the preceding page without editing it.'
        )
      );
    end;
  end if;

  select count(*)::bigint
  into v_total_count
  from core.property_account_current a
  where not a.is_deleted
    and (
      v_ward is null
      or a.ward = v_ward
    )
    and (
      v_property_type is null
      or lower(a.property_type) = lower(v_property_type)
      or lower(api_v1._canonical_property_type(a.property_type)) =
        lower(v_property_type)
    )
    and (v_use_code is null or a.use_code = v_use_code)
    and (v_tax_class is null or a.tax_class = v_tax_class)
    and (
      v_min_assessment is null
      or a.current_total_value >= v_min_assessment
    )
    and (
      v_max_assessment is null
      or a.current_total_value <= v_max_assessment
    )
    and (
      v_has_balance is null
      or (coalesce(a.total_balance_cents, 0) > 0) = v_has_balance
    )
    and (
      v_min_balance is null
      or a.total_balance_cents >= v_min_balance
    )
    and (
      v_has_tax_sale is null
      or exists (
        select 1
        from history.tax_sale_flag f
        where f.account_id = a.account_id
      ) = v_has_tax_sale
    )
    and (
      v_sale_date_from is null
      or a.latest_sale_date >= v_sale_date_from
    )
    and (
      v_sale_date_to is null
      or a.latest_sale_date <= v_sale_date_to
    );

  with ordered as (
    select
      a.*,
      api_v1._canonical_property_type(a.property_type)
        property_type_canonical,
      api_v1._display_address(a.premise_address) premise_address_display,
      exists (
        select 1
        from history.tax_sale_flag f
        where f.account_id = a.account_id
      ) has_tax_sale_flag_value,
      (
        select array_agg(f.flag order by f.slot_ordinal)
        from history.tax_sale_flag f
        where f.account_id = a.account_id
      ) tax_sale_flags_value,
      row_number() over (
        order by
          case when v_sort = 'assessment_desc'
            then coalesce(a.current_total_value::bigint, -9223372036854775808)
          end desc,
          case when v_sort = 'balance_desc'
            then coalesce(a.total_balance_cents, -9223372036854775808)
          end desc,
          case when v_sort = 'sale_date_desc'
            then coalesce(a.latest_sale_date, date '0001-01-01')
          end desc,
          case when v_sort = 'address_asc'
            then coalesce(api_v1._display_address(a.premise_address), '')
          end asc,
          case when v_sort = 'account_id_asc' then a.account_id end asc,
          a.account_id asc
      ) page_ordinal
    from core.property_account_current a
    where not a.is_deleted
      and (
        v_ward is null
        or a.ward = v_ward
      )
      and (
        v_property_type is null
        or lower(a.property_type) = lower(v_property_type)
        or lower(api_v1._canonical_property_type(a.property_type)) =
          lower(v_property_type)
      )
      and (v_use_code is null or a.use_code = v_use_code)
      and (v_tax_class is null or a.tax_class = v_tax_class)
      and (
        v_min_assessment is null
        or a.current_total_value >= v_min_assessment
      )
      and (
        v_max_assessment is null
        or a.current_total_value <= v_max_assessment
      )
      and (
        v_has_balance is null
        or (coalesce(a.total_balance_cents, 0) > 0) = v_has_balance
      )
      and (
        v_min_balance is null
        or a.total_balance_cents >= v_min_balance
      )
      and (
        v_has_tax_sale is null
        or exists (
          select 1
          from history.tax_sale_flag f
          where f.account_id = a.account_id
        ) = v_has_tax_sale
      )
      and (
        v_sale_date_from is null
        or a.latest_sale_date >= v_sale_date_from
      )
      and (
        v_sale_date_to is null
        or a.latest_sale_date <= v_sale_date_to
      )
      and (
        v_cursor is null
        or (
          v_sort = 'assessment_desc'
          and (
            coalesce(
              a.current_total_value::bigint,
              -9223372036854775808
            ) < v_cursor_bigint
            or (
              coalesce(
                a.current_total_value::bigint,
                -9223372036854775808
              ) = v_cursor_bigint
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'balance_desc'
          and (
            coalesce(a.total_balance_cents, -9223372036854775808) <
              v_cursor_bigint
            or (
              coalesce(a.total_balance_cents, -9223372036854775808) =
                v_cursor_bigint
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'sale_date_desc'
          and (
            coalesce(a.latest_sale_date, date '0001-01-01') < v_cursor_date
            or (
              coalesce(a.latest_sale_date, date '0001-01-01') =
                v_cursor_date
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'address_asc'
          and (
            coalesce(api_v1._display_address(a.premise_address), '') >
              v_cursor_text
            or (
              coalesce(api_v1._display_address(a.premise_address), '') =
                v_cursor_text
              and a.account_id > v_cursor_id
            )
          )
        )
        or (
          v_sort = 'account_id_asc'
          and a.account_id > v_cursor_id
        )
      )
    order by
      case when v_sort = 'assessment_desc'
        then coalesce(a.current_total_value::bigint, -9223372036854775808)
      end desc,
      case when v_sort = 'balance_desc'
        then coalesce(a.total_balance_cents, -9223372036854775808)
      end desc,
      case when v_sort = 'sale_date_desc'
        then coalesce(a.latest_sale_date, date '0001-01-01')
      end desc,
      case when v_sort = 'address_asc'
        then coalesce(api_v1._display_address(a.premise_address), '')
      end asc,
      case when v_sort = 'account_id_asc' then a.account_id end asc,
      a.account_id asc
    limit v_limit + 1
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'account_id', account_id,
        'ssl', ssl_display,
        'premise_address', premise_address_display,
        'ward', ward,
        'property_type_source', property_type,
        'property_type_canonical', property_type_canonical,
        'use_code', use_code,
        'tax_class', tax_class,
        'current_total_value_dollars', current_total_value,
        'total_balance_cents', total_balance_cents,
        'has_tax_sale_flag', has_tax_sale_flag_value,
        'tax_sale_flags', coalesce(to_jsonb(tax_sale_flags_value), '[]'::jsonb),
        'latest_sale_date', latest_sale_date,
        'record_date', record_extract_at,
        'source_refs', jsonb_build_array(api_v1._source_ref(
          source_id,
          source_row_number,
          'search_result',
          ssl_normalized
        )),
        'quality_flags', api_v1._property_quality_flags(
          mailing_city_state_zip,
          current_total_value,
          current_improvement_value,
          latest_sale_price_dollars,
          property_type,
          premise_address
        )
      )
      order by page_ordinal
    ) filter (where page_ordinal <= v_limit), '[]'::jsonb),
    count(*) > v_limit,
    max(account_id) filter (where page_ordinal = v_limit),
    max(case v_sort
      when 'assessment_desc' then coalesce(
        current_total_value::bigint,
        -9223372036854775808
      )::text
      when 'balance_desc' then coalesce(
        total_balance_cents,
        -9223372036854775808
      )::text
      when 'sale_date_desc' then coalesce(
        latest_sale_date,
        date '0001-01-01'
      )::text
      when 'address_asc' then coalesce(premise_address_display, '')
      else account_id::text
    end) filter (where page_ordinal = v_limit)
  into
    v_results,
    v_has_more,
    v_last_id,
    v_last_value
  from ordered;

  if v_has_more then
    v_next_cursor := jsonb_build_object(
      'sort_by', v_sort,
      'value', v_last_value,
      'account_id', v_last_id
    )::text;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'results', v_results,
    'total_count', v_total_count,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'sort_by', v_sort,
    'limit', v_limit,
    'empty_result_note', case
      when v_total_count = 0 then
        'No current property accounts matched these validated exact filters.'
      else null
    end,
    'privacy_note',
      'Owner names and mailing addresses are intentionally excluded from screening results.',
    'balance_note',
      'A source-reported balance or tax-sale flag is screening data, not a payoff, lien-priority, or title conclusion.'
  );
end;
$function$;

revoke all on function api_v1.get_property_snapshot(text, text) from public;
revoke all on function api_v1.get_assessment_history(text, text) from public;
revoke all on function api_v1.get_tax_and_balance_history(text, text)
  from public;
revoke all on function api_v1.get_ownership_and_sale(text, text) from public;
revoke all on function api_v1.get_latest_sale_and_deed(text, text)
  from public;
revoke all on function api_v1.search_properties(jsonb) from public;

grant execute on function api_v1.get_property_snapshot(text, text)
  to mcp_runtime;
grant execute on function api_v1.get_assessment_history(text, text)
  to mcp_runtime;
grant execute on function api_v1.get_tax_and_balance_history(text, text)
  to mcp_runtime;
grant execute on function api_v1.get_ownership_and_sale(text, text)
  to mcp_runtime;
grant execute on function api_v1.get_latest_sale_and_deed(text, text)
  to mcp_runtime;
grant execute on function api_v1.search_properties(jsonb)
  to mcp_runtime;

alter function api_v1.get_property_snapshot(text, text) owner to api_owner;
alter function api_v1.get_assessment_history(text, text) owner to api_owner;
alter function api_v1.get_tax_and_balance_history(text, text)
  owner to api_owner;
alter function api_v1.get_ownership_and_sale(text, text) owner to api_owner;
alter function api_v1.get_latest_sale_and_deed(text, text)
  owner to api_owner;
alter function api_v1.search_properties(jsonb) owner to api_owner;

commit;
