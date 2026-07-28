begin;

set local role api_owner;

create or replace function api_v1._source_ref(
  p_source_id text,
  p_source_row_number bigint,
  p_field_key text,
  p_ssl text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select concat_ws(
    '|',
    replace(coalesce(p_source_id, ''), '|', ''),
    coalesce(p_source_row_number::text, ''),
    replace(coalesce(p_field_key, ''), '|', ''),
    replace(coalesce(p_ssl, ''), '|', '')
  );
$function$;

create or replace function api_v1.get_assessment_history(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with resolved as (
    select *
    from api_v1._resolve_account(p_ssl, p_address)
  ),
  account as (
    select a.*
    from core.property_account_current a
    join resolved r on r.resolved_account_id = a.account_id
  ),
  periods as (
    select
      values_by_stage.tax_year,
      values_by_stage.stage,
      values_by_stage.land_value,
      values_by_stage.improvement_value,
      values_by_stage.total_value,
      a.record_extract_at,
      a.source_row_number,
      a.ssl_normalized
    from account a
    cross join lateral (values
      (
        2025::smallint,
        'prior'::text,
        a.prior_land_value,
        a.prior_improvement_value,
        a.prior_total_value
      ),
      (
        2026::smallint,
        'current'::text,
        a.current_land_value,
        a.current_improvement_value,
        a.current_total_value
      ),
      (
        2027::smallint,
        'proposed'::text,
        a.proposed_land_value,
        a.proposed_improvement_value,
        a.proposed_total_value
      )
    ) values_by_stage(
      tax_year,
      stage,
      land_value,
      improvement_value,
      total_value
    )
  ),
  payload as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'tax_year', p.tax_year,
          'stage', p.stage,
          'record_date', p.record_extract_at,
          'source_snapshot', 'itspe_current',
          'land_value_dollars', jsonb_build_object(
            'value', p.land_value,
            'status', case
              when p.land_value is null then 'not_reported'
              else 'reported'
            end,
            'source_refs', jsonb_build_array(api_v1._source_ref(
              'itspe_current',
              p.source_row_number::bigint,
              'assessment.' || p.stage || '.land_value',
              p.ssl_normalized
            ))
          ),
          'improvement_value_dollars', jsonb_build_object(
            'value', p.improvement_value,
            'status', case
              when p.improvement_value is null then 'not_reported'
              else 'reported'
            end,
            'source_refs', jsonb_build_array(api_v1._source_ref(
              'itspe_current',
              p.source_row_number::bigint,
              'assessment.' || p.stage || '.improvement_value',
              p.ssl_normalized
            ))
          ),
          'total_value_dollars', jsonb_build_object(
            'value', p.total_value,
            'status', case
              when p.total_value is null then 'not_reported'
              else 'reported'
            end,
            'source_refs', jsonb_build_array(api_v1._source_ref(
              'itspe_current',
              p.source_row_number::bigint,
              'assessment.' || p.stage || '.total_value',
              p.ssl_normalized
            ))
          ),
          'quality_flags', case
            when p.stage = 'proposed' then
              jsonb_build_array('proposed_not_final')
            else '[]'::jsonb
          end
        )
        order by p.tax_year
      ),
      '[]'::jsonb
    ) items
    from periods p
  )
  select case
    when r.resolution_status <> 'resolved' then
      jsonb_build_object(
        'status', r.resolution_status,
        'next_tool', 'resolve_property'
      )
    else
      jsonb_build_object(
        'status', 'resolved',
        'field_dictionary', jsonb_build_object(
          'land_value_dollars', jsonb_build_object(
            'field_key_pattern', 'assessment.{stage}.land_value',
            'unit', 'USD',
            'meaning',
              'Source-reported assessed value allocated to land.'
          ),
          'improvement_value_dollars', jsonb_build_object(
            'field_key_pattern',
              'assessment.{stage}.improvement_value',
            'unit', 'USD',
            'meaning',
              'Source-reported assessed value allocated to improvements.'
          ),
          'total_value_dollars', jsonb_build_object(
            'field_key_pattern', 'assessment.{stage}.total_value',
            'unit', 'USD',
            'meaning',
              'Source-reported total assessed value for the named stage and year.'
          )
        ),
        'assessments', p.items,
        'limitations', jsonb_build_array(
          'Prior, current, and proposed are distinct source stages and must not be conflated.',
          'The proposed value is not final.',
          'An assessment is not an appraisal or lending value.'
        )
      )
  end
  from resolved r
  cross join payload p;
$function$;

reset role;

alter table semantic.property_type_vocabulary
  add column if not exists current_account_count integer
  not null default 0;

with counts as (
  select
    a.property_type source_value,
    count(*)::integer current_account_count
  from core.property_account_current a
  where not a.is_deleted
    and nullif(a.property_type, '') is not null
  group by a.property_type
)
update semantic.property_type_vocabulary v
set current_account_count = c.current_account_count
from counts c
where c.source_value = v.source_value;

delete from semantic.coverage
where entity_name = 'assessment';

insert into semantic.coverage (
  coverage_key,
  entity_name,
  tax_year,
  stage,
  availability_status,
  source_id,
  caveat
) values
(
  'assessment-2025-prior',
  'assessment',
  2025,
  'prior',
  'available',
  'itspe_current',
  null
),
(
  'assessment-2026-current',
  'assessment',
  2026,
  'current',
  'available',
  'itspe_current',
  null
),
(
  'assessment-2027-proposed',
  'assessment',
  2027,
  'proposed',
  'available',
  'itspe_current',
  'Proposed stage; not final.'
);

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
)
select
  'assessment.' || v.stage || '.' || v.value_part,
  '$.assessments[*].' || v.json_member,
  initcap(v.stage) || ' ' || v.title,
  'Source-reported ' || v.stage || '-stage ' || v.definition,
  'assessment',
  'integer',
  'USD',
  'tax-year stage and record date',
  v.source_fields,
  v.lender_synonyms,
  v.confused_with,
  'Null means the current official extract did not report a value; it is not zero.',
  'Do not combine prior, current, and proposed stages.',
  case
    when v.stage = 'proposed' then
      'A proposed assessment is not final. An assessment is not an appraisal or lending value.'
    else
      'An assessment is not an appraisal or lending value.'
  end,
  'official',
  'v0.4-current-extract',
  true,
  false
from (values
  (
    'prior',
    'land_value',
    'land_value_dollars',
    'land assessed value',
    'assessed value allocated to land.',
    array['OLDLAND']::text[],
    array['prior land assessment']::text[],
    array['current land assessment', 'appraised land value']::text[]
  ),
  (
    'prior',
    'improvement_value',
    'improvement_value_dollars',
    'improvement assessed value',
    'assessed value allocated to improvements.',
    array['OLDIMPR']::text[],
    array['prior improvement assessment']::text[],
    array['current improvement assessment', 'building value']::text[]
  ),
  (
    'prior',
    'total_value',
    'total_value_dollars',
    'total assessed value',
    'total assessed value.',
    array['OLDTOTAL']::text[],
    array['prior assessment']::text[],
    array['current assessment', 'appraised value']::text[]
  ),
  (
    'current',
    'land_value',
    'land_value_dollars',
    'land assessed value',
    'assessed value allocated to land.',
    array['PHASELAND']::text[],
    array['current land assessment']::text[],
    array['prior land assessment', 'appraised land value']::text[]
  ),
  (
    'current',
    'improvement_value',
    'improvement_value_dollars',
    'improvement assessed value',
    'assessed value allocated to improvements.',
    array['PHASEBUILD']::text[],
    array['current improvement assessment']::text[],
    array['prior improvement assessment', 'building value']::text[]
  ),
  (
    'current',
    'total_value',
    'total_value_dollars',
    'total assessed value',
    'total assessed value.',
    array['ASSESSMENT']::text[],
    array['current assessment', 'assessed value']::text[],
    array['proposed assessment', 'appraised value']::text[]
  ),
  (
    'proposed',
    'land_value',
    'land_value_dollars',
    'land assessed value',
    'assessed value allocated to land.',
    array['NEWLAND']::text[],
    array['proposed land assessment']::text[],
    array['current land assessment', 'appraised land value']::text[]
  ),
  (
    'proposed',
    'improvement_value',
    'improvement_value_dollars',
    'improvement assessed value',
    'assessed value allocated to improvements.',
    array['NEWIMPR']::text[],
    array['proposed improvement assessment']::text[],
    array['current improvement assessment', 'building value']::text[]
  ),
  (
    'proposed',
    'total_value',
    'total_value_dollars',
    'total assessed value',
    'total assessed value.',
    array['NEWTOTAL']::text[],
    array['proposed assessment']::text[],
    array['current assessment', 'appraised value']::text[]
  )
) as v(
  stage,
  value_part,
  json_member,
  title,
  definition,
  source_fields,
  lender_synonyms,
  confused_with
)
on conflict (field_key) do update
set
  json_path = excluded.json_path,
  title = excluded.title,
  definition = excluded.definition,
  source_fields = excluded.source_fields,
  lender_synonyms = excluded.lender_synonyms,
  commonly_confused_with = excluded.commonly_confused_with,
  null_semantics = excluded.null_semantics,
  aggregation_rule = excluded.aggregation_rule,
  caveat = excluded.caveat,
  formula_version = excluded.formula_version,
  exposure_allowed = excluded.exposure_allowed;

set local role api_owner;

do $block$
begin
  if to_regprocedure(
    'api_v1._get_source_evidence_v03(text[])'
  ) is null then
    alter function api_v1.get_source_evidence(text[])
      rename to _get_source_evidence_v03;
  end if;
end;
$block$;

revoke all on function api_v1._get_source_evidence_v03(text[])
  from public;
revoke all on function api_v1._get_source_evidence_v03(text[])
  from mcp_runtime;
grant execute on function api_v1._get_source_evidence_v03(text[])
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
  v_property_mismatches jsonb;
  v_field_mismatches jsonb;
  v_evidence jsonb;
begin
  v_result := api_v1._get_source_evidence_v03(p_source_refs);

  if v_result->>'status' is distinct from 'ok' then
    return v_result;
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_record_id,
      split_part(ref, '|', 4) ssl
    from unnest(p_source_refs) with ordinality requested(ref, ordinality)
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_property_mismatches
  from parsed p
  where (
    p.source_id = 'itspe_current'
    and not exists (
      select 1
      from core.property_account_current a
      where a.source_id = 'itspe_current'
        and a.source_row_number::bigint = p.source_record_id
        and a.ssl_normalized = p.ssl
    )
  ) or (
    p.source_id = 'cama_sales_current'
    and not exists (
      select 1
      from core.property_account_current a
      join history.sale_series s on s.account_id = a.account_id
      where a.ssl_normalized = p.ssl
        and exists (
          select 1
          from unnest(s.source_objectids) source_objectid
          where source_objectid::bigint = p.source_record_id
        )
    )
  ) or p.source_id not in (
    'itspe_current',
    'cama_sales_current'
  );

  if v_property_mismatches is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_property_mismatch',
        'invalid_refs', v_property_mismatches,
        'hint',
          'Use the source_ref exactly as returned by the connector; its source record and property identifier must remain bound.'
      )
    );
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 3) field_key
    from unnest(p_source_refs) with ordinality requested(ref, ordinality)
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_field_mismatches
  from parsed p
  where case
    when p.source_id = 'itspe_current' then not (
      p.field_key in ('property_account', 'search_result', 'tax_summary')
      or p.field_key ~
        '^tax\.slot\.(tax_sale_flag|tax|penalty|interest|fee|total_due|collected|balance|credit)\.(CY1|CY2|PY([1-9]|10))$'
      or exists (
        select 1
        from semantic.field_definition f
        where f.field_key = p.field_key
          and f.exposure_allowed
      )
    )
    when p.source_id = 'cama_sales_current' then
      p.field_key not in (
        'sale.history.date',
        'sale.history.price',
        'sale.history.qualified_code',
        'sale.history.sale_code',
        'sale.history.current_owner_flag'
      )
    else true
  end;

  if v_field_mismatches is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_field_mismatch',
        'invalid_refs', v_field_mismatches,
        'hint',
          'Use a field-specific source_ref returned by the connector without editing its field key.'
      )
    );
  end if;

  select coalesce(
    jsonb_agg(
      case
        when item#>>'{human_verification,portal_url}' =
          'https://dcgis.maps.arcgis.com/apps/webappviewer/index.html?id=9a5c11c11dd347cc9c05d64499cc98ee'
        then
          (
            jsonb_set(
              item,
              '{human_verification}',
              (item->'human_verification') || jsonb_build_object(
                'portal_name', 'MyTax.DC.gov Real Property Search',
                'portal_url',
                  'https://mytax.dc.gov/_/#2',
                'steps', jsonb_build_array(
                  'Open the MyTax.DC.gov Real Property Search.',
                  'Enter the supplied property address or SSL and select Search.',
                  'Under Search Results, open the matching SSL.',
                  'Review the property-detail area for the cited field.'
                )
              )
            ) - 'alternate_human_verification'
          ) || jsonb_build_object(
            'alternate_human_verification', '[]'::jsonb
          )
        else item
      end
      order by ordinality
    ),
    '[]'::jsonb
  )
  into v_evidence
  from jsonb_array_elements(
    coalesce(v_result->'evidence', '[]'::jsonb)
  ) with ordinality evidence(item, ordinality);

  return jsonb_set(v_result, '{evidence}', v_evidence);
end;
$function$;

do $block$
begin
  if to_regprocedure(
    'api_v1._describe_data_v03(text)'
  ) is null then
    alter function api_v1.describe_data(text)
      rename to _describe_data_v03;
  end if;
end;
$block$;

revoke all on function api_v1._describe_data_v03(text)
  from public;
revoke all on function api_v1._describe_data_v03(text)
  from mcp_runtime;
grant execute on function api_v1._describe_data_v03(text)
  to api_owner;

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
  v_result jsonb;
  v_property_types jsonb;
  v_use_codes jsonb;
  v_tax_classes jsonb;
  v_coverage jsonb;
  v_fields jsonb;
begin
  if v_q like '%assessment%'
     or v_q like '%valuation%'
     or v_q like '%coverage%'
     or v_q like '%year%' then
    select coalesce(
      jsonb_agg(to_jsonb(c) order by c.tax_year),
      '[]'::jsonb
    )
    into v_coverage
    from semantic.coverage c
    where c.entity_name = 'assessment';

    select coalesce(
      jsonb_object_agg(
        f.field_key,
        jsonb_build_object(
          'title', f.title,
          'definition', f.definition,
          'unit', f.unit,
          'null_semantics', f.null_semantics,
          'aggregation_rule', f.aggregation_rule,
          'caveat', f.caveat
        )
      ),
      '{}'::jsonb
    )
    into v_fields
    from semantic.field_definition f
    where f.exposure_allowed
      and f.field_key ~
        '^assessment\.(prior|current|proposed)\.';

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'The current official ITSPE extract supplies 2025 prior, 2026 current, and 2027 proposed assessment stages.',
      'best_next_tool', 'get_assessment_history',
      'coverage', v_coverage,
      'field_definitions', v_fields,
      'critical_distinction',
        'Prior, current, and proposed are different source stages; proposed is not final, and assessed value is not an appraisal or lending value.'
    );
  end if;

  if v_q like '%property_type%'
     or v_q like '%property type%'
     or v_q like '%vacant%'
     or v_q like '%filter%' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_label', v.source_value,
          'canonical_label', v.canonical_value,
          'current_accounts', v.current_account_count,
          'source_label_may_be_truncated',
            length(v.source_value) >= 30
        )
        order by v.current_account_count desc, v.source_value
      ),
      '[]'::jsonb
    )
    into v_property_types
    from semantic.property_type_vocabulary v;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'code', d.code,
          'label', d.label,
          'description', d.description,
          'current_accounts', d.current_account_count,
          'decode_status', d.decode_status,
          'official_reference_url', d.official_reference_url
        )
        order by d.code
      ),
      '[]'::jsonb
    )
    into v_use_codes
    from semantic.code_decode d
    where d.code_system = 'use_code';

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'code', d.code,
          'label', d.label,
          'description', d.description,
          'official_reference_url', d.official_reference_url
        )
        order by d.code
      ),
      '[]'::jsonb
    )
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
        'wards', jsonb_build_array(
          '1', '2', '3', '4', '5', '6', '7', '8'
        ),
        'property_types', v_property_types,
        'use_codes', case
          when v_q like '%use code%'
            or v_q like '%use_code%'
            or v_q like '%filter%' then v_use_codes
          else jsonb_build_array(jsonb_build_object(
            'note',
              'Ask describe_data about use_code to return the official-reference decode list.'
          ))
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

  v_result := api_v1._describe_data_v03(p_question);

  if v_result ? 'tools' then
    v_result := jsonb_set(
      v_result,
      '{tools,get_assessment_history}',
      to_jsonb(
        'Current official prior, current, and proposed assessment stages.'::text
      )
    );
  end if;

  if v_result ? 'human_portals' then
    v_result := jsonb_set(
      v_result,
      '{human_portals}',
      jsonb_build_array(
        'MyTax.DC.gov Real Property Search',
        'D.C. Open Data Tax System Property Sales (CAMA)',
        'D.C. Recorder of Deeds Official Records Search'
      )
    );
  end if;

  return v_result;
end;
$function$;

revoke all on function api_v1.get_source_evidence(text[])
  from public;
revoke all on function api_v1.describe_data(text)
  from public;
grant execute on function api_v1.get_source_evidence(text[])
  to mcp_runtime;
grant execute on function api_v1.describe_data(text)
  to mcp_runtime;

reset role;

delete from meta.verification_route
where source_id in (
  'itspe_2017_archive',
  'itspe_2021_archive'
);

drop table meta.snapshot_record_link;
drop table history.assessment_snapshot_record;

delete from meta.source_asset
where source_id in (
  'itspe_2017_archive',
  'itspe_2021_archive'
);

set local role api_owner;

comment on function api_v1.get_assessment_history(text, text) is
  'Returns the current official ITSPE prior/current/proposed assessment stages: tax years 2025, 2026, and 2027.';
comment on function api_v1.get_source_evidence(text[]) is
  'Validates source, record, field, and property binding before returning human-facing official verification routes.';
comment on function api_v1.describe_data(text) is
  'Fast semantic guide backed by frozen vocabularies and current-source assessment coverage.';

reset role;

commit;
