begin;

set local role api_owner;

do $contract$
declare
  v_payload jsonb;
  v_result jsonb;
  v_invalid jsonb;
  v_source jsonb;
  v_assessment_ref text;
  v_tax_ref text;
  v_sale_ref text;
  v_deed_ref text;
  v_property_ref text;
  v_regulatory_refs text[];
  v_regulatory_routes text[];
  v_refs text[];
  v_pattern text;
  v_failures text[] := array[]::text[];
  v_source_count integer;
  v_distinct_route_count integer;
  v_i integer;
begin
  select api_v1.get_assessment_history('5576    0001', null)
    into v_payload;
  v_assessment_ref :=
    v_payload#>>'{assessments,0,total_value_dollars,source_refs,0}';

  select api_v1.get_tax_and_balance_history('5576    0001', null)
    into v_payload;
  v_tax_ref :=
    v_payload#>>'{current_summary,total_liabilities_reported_cents,source_refs,0}';

  select api_v1.get_latest_sale_and_deed('3562    0059', null)
    into v_payload;
  v_sale_ref :=
    v_payload#>>'{sale_history,0,sale_price_dollars,source_refs,0}';
  v_deed_ref :=
    v_payload#>>'{latest_assessor_deed,instrument_number,source_refs,0}';

  select api_v1.get_property_snapshot('5576    0001', null)
    into v_payload;
  v_property_ref :=
    v_payload#>>'{classification,property_type_source,source_refs,0}';

  if v_assessment_ref is null
     or v_tax_ref is null
     or v_sale_ref is null
     or v_deed_ref is null
     or v_property_ref is null then
    raise exception
      'Could not derive the existing MyTax, CAMA, Recorder, and assessment-map fixtures';
  end if;

  -- Select one linked record per regulatory route family. The account is
  -- selected from the record link itself, so the test does not require one
  -- property to carry every source family.
  with candidate_links as (
    select distinct on (route_family)
      l.source_id,
      l.source_release_id,
      l.source_record_id,
      l.account_id,
      route_family
    from semantic.source_family_definition f
    cross join lateral (
      select l.*
      from meta.source_release_pointer rp
      join meta.source_release rel
        on rel.release_id = rp.release_id
       and rel.release_status = 'published'
       and rel.quality_status = 'passed'
      join meta.source_record_link l
        on l.source_release_id = rp.release_id
       and l.source_id = rp.source_id
       and l.link_status = 'linked'
      join core.property_account_current account
        on account.account_id = l.account_id
       and not account.is_deleted
       and account.ssl_normalized is not null
      where f.exposure_allowed
        and f.portal_family in (
          'scout',
          'tops',
          'propertyquest',
          'beam',
          'doee_well',
          'dob_vacant',
          'abca'
        )
        and rp.pointer_name = 'current'
        and rp.source_id ~ f.source_id_pattern
        and (
          f.portal_family <> 'scout'
          or rp.source_id !~ '^ddot_'
        )
      order by l.source_record_link_id
      limit 1
    ) l
    cross join lateral (select f.portal_family route_family) family
    order by route_family, l.source_record_link_id
  ),
  record_identity as (
    select
      l.route_family,
      l.source_id,
      l.source_release_id,
      l.source_record_id,
      coalesce(
        r.source_row_sha256,
        c.source_row_sha256,
        en.source_row_sha256,
        be.source_row_sha256,
        vb.source_row_sha256,
        ld.source_row_sha256
      ) source_row_sha256,
      coalesce(
        r.record_kind,
        case when c.source_record_id is not null
          then 'cama_building_profile' end,
        case when en.source_record_id is not null
          then 'energy_benchmark' end,
        case when be.source_record_id is not null
          then 'beps' end,
        case when vb.source_record_id is not null
          then 'vacant_blighted' end,
        case when ld.source_record_id is not null
          then 'land_designation' end
      ) record_type,
      l.account_id
    from candidate_links l
    left join regulatory.record r
      on r.source_id = l.source_id
     and r.source_release_id = l.source_release_id
     and r.source_record_id = l.source_record_id
    left join property_context.cama_building_profile c
      on c.source_id = l.source_id
     and c.source_release_id = l.source_release_id
     and c.source_record_id = l.source_record_id
    left join property_context.energy_benchmark en
      on en.source_id = l.source_id
     and en.source_release_id = l.source_release_id
     and en.source_record_id = l.source_record_id
    left join property_context.beps_compliance be
      on be.source_id = l.source_id
     and be.source_release_id = l.source_release_id
     and be.source_record_id = l.source_record_id
    left join property_context.vacant_blighted_status vb
      on vb.source_id = l.source_id
     and vb.source_release_id = l.source_release_id
     and vb.source_record_id = l.source_record_id
    left join property_context.land_designation ld
      on ld.source_id = l.source_id
     and ld.source_release_id = l.source_release_id
     and ld.source_record_id = l.source_record_id
  ),
  candidates as (
    select distinct on (i.route_family)
      i.route_family,
      api_v1._regulatory_source_ref(
        i.source_id,
        i.source_release_id,
        i.source_record_id,
        i.source_row_sha256,
        f.field_key,
        a.ssl_normalized
      ) source_ref
    from record_identity i
    join core.property_account_current a
      on a.account_id = i.account_id
     and not a.is_deleted
     and a.ssl_normalized is not null
    join semantic.regulatory_field_binding f
      on i.record_type = any(f.record_types)
    order by i.route_family, f.field_key
  )
  select
    array_agg(source_ref order by route_family),
    array_agg(route_family order by route_family)
    into v_regulatory_refs, v_regulatory_routes
  from candidates
  where source_ref is not null;

  v_refs := array[
    v_assessment_ref,
    v_tax_ref,
    v_sale_ref,
    v_deed_ref,
    v_property_ref
  ] || coalesce(v_regulatory_refs, '{}'::text[]);

  v_result := api_v1.get_source_evidence(v_refs);

  if v_result->>'status' is distinct from 'ok'
     or jsonb_array_length(v_result->'evidence') <> cardinality(v_refs)
     or jsonb_array_length(coalesce(v_result->'sources', '[]'::jsonb)) < 10 then
    v_failures := array_append(
      v_failures,
      format(
        'valid mixed-family evidence mismatch: status=%s refs=%s evidence=%s sources=%s routes=%s error=%s',
        v_result->>'status',
        cardinality(v_refs),
        jsonb_array_length(coalesce(v_result->'evidence', '[]'::jsonb)),
        jsonb_array_length(coalesce(v_result->'sources', '[]'::jsonb)),
        array_to_string(v_regulatory_routes, ','),
        coalesce(v_result->'error', 'null'::jsonb)
      )
    );
  end if;

  -- The projection is additive: evidence order and opaque references remain
  -- exactly the references requested by the caller.
  for v_i in 1..cardinality(v_refs) loop
    if v_result#>>array['evidence', (v_i - 1)::text, 'source_ref']
       is distinct from v_refs[v_i] then
      v_failures := array_append(
        v_failures,
        'evidence order or source_ref identity changed'
      );
      exit;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_result->'sources', '[]'::jsonb)) item
    where nullif(item->>'title', '') is null
       or nullif(item->>'link', '') is null
       or jsonb_typeof(item->'lookup') <> 'object'
       or jsonb_typeof(item->'property') <> 'object'
       or nullif(item->>'relationship', '') is null
       or nullif(item->>'property_link_scope', '') is null
       or jsonb_typeof(item->'covers') <> 'array'
       or jsonb_typeof(item->'covered_fields') <> 'array'
       or nullif(item->>'access', '') is null
       or jsonb_typeof(item->'source_refs') <> 'array'
       or jsonb_array_length(item->'source_refs') < 1
  ) then
    v_failures := array_append(
      v_failures,
      'a generalized source is missing a required display or reference field'
    );
  end if;

  select
    count(*),
    count(distinct jsonb_build_object(
      'link', item->>'link',
      'lookup', item->'lookup',
      'property_link_scope', item->>'property_link_scope',
      'relationship', item->>'relationship'
    ))
  into v_source_count, v_distinct_route_count
  from jsonb_array_elements(coalesce(v_result->'sources', '[]'::jsonb)) item;

  if v_source_count <> v_distinct_route_count then
    v_failures := array_append(
      v_failures,
      'sources contains duplicate route and lookup groups'
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_result->'evidence', '[]'::jsonb)) evidence
    where not exists (
      select 1
      from jsonb_array_elements(coalesce(v_result->'sources', '[]'::jsonb)) source
      where source->'source_refs' ? (evidence->>'source_ref')
    )
  ) then
    v_failures := array_append(
      v_failures,
      'a valid evidence reference was lost from the generalized sources'
    );
  end if;

  -- MyTax keeps the cookie-bootstrap route and OTR fallback while the
  -- underlying human_verification evidence remains unchanged.
  select item
    into v_source
  from jsonb_array_elements(v_result->'sources') item
  where item->>'link' = 'https://mytax.dc.gov/_/?Link=PropertySearch'
    and item#>>'{fallback,link}' =
      'https://otr.cfo.dc.gov/page/real-property-tax-database-search'
    and item->'source_refs' ? v_assessment_ref
    and item->'source_refs' ? v_tax_ref
  limit 1;

  if v_source is null
     or v_source#>>'{property,square}' is distinct from '5576'
     or v_source#>>'{property,lot}' is distinct from '0001'
     or v_source#>>'{lookup,ssl}' is null
     or v_source#>>'{lookup,property_address}' is null
     or jsonb_typeof(v_source->'steps') <> 'array'
     or jsonb_array_length(v_source->'steps') < 1
     or not (v_source->'covers' ? 'Prior assessment')
     or not (v_source->'covers' ? 'Property tax, balance, or bill')
     or v_result#>>'{evidence,0,human_verification,portal_url}' is distinct from
       'https://mytax.dc.gov/_/#2' then
    v_failures := array_append(
      v_failures,
      'MyTax route, fallback, grouping, lookup, or evidence preservation regressed'
    );
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_result->'sources') item
    where item->>'link' =
      'https://opendata.dc.gov/datasets/DCGIS::tax-system-property-sales-cama'
      and item->'source_refs' ? v_sale_ref
      and item->>'link' not like 'https://mytax.dc.gov/%'
  ) or not exists (
    select 1
    from jsonb_array_elements(v_result->'sources') item
    where item->>'link' = 'https://washington.dc.publicsearch.us/'
      and item->'source_refs' ? v_deed_ref
  ) or exists (
    select 1
    from jsonb_array_elements(v_result->'sources') item
    where item->'source_refs' ? v_sale_ref
      and item->>'link' like 'https://mytax.dc.gov/%'
  ) then
    v_failures := array_append(
      v_failures,
      'CAMA/Open Data or Recorder source was not projected with its opaque ref'
    );
  end if;

  foreach v_pattern in array array[
    '^https://scout\.dob\.dc\.gov/$',
    '^https://tops\.ddot\.dc\.gov/DDOTPermitSystem/DDOTPermitOnline/MapLookup\.aspx$',
    '^https://propertyquest\.dc\.gov/$',
    '^https://buildingperformancedc\.org/$',
    '^https://opendata\.dc\.gov/datasets/DCGIS::dc-well-permits$',
    '^https://dob\.dc\.gov/vacantbuildings$',
    '^https://abca\.dc\.gov/(node/(612672|1657531|1751426)|page/licensing)$'
  ] loop
    if not exists (
      select 1
      from jsonb_array_elements(v_result->'sources') item
      where item->>'link' ~ v_pattern
    ) then
      v_failures := array_append(
        v_failures,
        'missing generalized human route: ' || v_pattern
      );
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'sources') item
    where item->>'link' =
      'https://opendata.dc.gov/datasets/DCGIS::dc-well-permits'
      and (
        item->>'access' !~* 'application/login'
        or item#>>'{fallback,link}' is distinct from
          'https://doee.dc.gov/service/wellpermits'
        or (item->'steps')::text !~* 'not a public permit lookup'
      )
  ) then
    v_failures := array_append(
      v_failures,
      'DOEE well source does not disclose its Open Data/login workflow'
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_result->'sources') item
    where item->>'link' = 'https://buildingperformancedc.org/'
      and item->>'access' !~* 'javascript.*current.*newer'
  ) or exists (
    select 1
    from jsonb_array_elements(v_result->'sources') item
    where item->>'link' = 'https://dob.dc.gov/vacantbuildings'
      and item->>'access' !~* 'javascript.*current.*change'
  ) then
    v_failures := array_append(
      v_failures,
      'DOB or BEAM source lacks the JS/current-status caveat'
    );
  end if;

  if (coalesce(v_result->'sources', '[]'::jsonb))::text ~*
       '(services\.arcgis\.com|featureserver|mapserver|/rest/|/api/|\.csv([?#]|$)|\.json([?#]|$)|/_/retrieve/|[?&](session|token|sid|jsessionid)=[^&"]*)' then
    v_failures := array_append(
      v_failures,
      'machine, raw, or session-bound URL leaked into sources'
    );
  end if;

  v_invalid := api_v1.get_source_evidence(array['nonsense|nonsense|x|y']);
  if v_invalid->>'status' is distinct from 'invalid_input'
     or v_invalid ? 'sources' then
    v_failures := array_append(
      v_failures,
      'invalid source references were not rejected without a sources projection'
    );
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
    v_failures := array_append(
      v_failures,
      'source-evidence function privileges changed'
    );
  end if;

  if cardinality(v_failures) > 0 then
    raise exception '0030 generalized human sources contract failures: %',
      array_to_string(v_failures, '; ');
  end if;
end;
$contract$;

reset role;

rollback;
