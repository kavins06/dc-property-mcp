begin;

create or replace function api_v1._get_mar_source_evidence(
  p_ref text
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_parts text[] := string_to_array(p_ref, '|');
  v_source_id text;
  v_release_id bigint;
  v_record_id bigint;
  v_field_key text;
  v_binding text;
  v_ssl text;
  v_row record;
  v_evidence jsonb;
begin
  if cardinality(v_parts) <> 6
     or v_parts[1] not in (
       'mar_address_ssl_current', 'mar_residential_unit_current'
     )
     or v_parts[2] !~ '^[0-9]+$'
     or v_parts[3] !~ '^[0-9]+$'
     or v_parts[4] not in ('mar.address_ssl', 'mar.unit_condo_ssl')
     or v_parts[5] !~ '^[0-9a-f]{64}$'
     or v_parts[6] is distinct from api_v1._normalize_ssl(v_parts[6])
     or (v_parts[1] = 'mar_address_ssl_current'
         and v_parts[4] <> 'mar.address_ssl')
     or (v_parts[1] = 'mar_residential_unit_current'
         and v_parts[4] <> 'mar.unit_condo_ssl') then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'malformed_source_ref',
        'invalid_refs', jsonb_build_array(p_ref)
      )
    );
  end if;

  v_source_id := v_parts[1];
  v_release_id := v_parts[2]::bigint;
  v_record_id := v_parts[3]::bigint;
  v_field_key := v_parts[4];
  v_binding := v_parts[5];
  v_ssl := v_parts[6];

  if v_field_key = 'mar.address_ssl' then
    select
      x.source_row_sha256,
      a.address_source_value property_address,
      null::text unit_number,
      s.publisher,
      s.dataset_name,
      s.source_class,
      rel.snapshot_retrieved_at,
      rel.sha256 release_sha256
    into v_row
    from core.mar_address_ssl_current x
    join core.mar_address_current a on a.mar_id = x.mar_id
    join meta.source_asset s on s.source_id = x.source_id
    join meta.source_release_pointer rp
      on rp.source_id = x.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = x.source_release_id
    join meta.source_release rel
      on rel.release_id = x.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where x.source_id = v_source_id
      and x.source_release_id = v_release_id
      and x.source_record_id = v_record_id
      and x.ssl_normalized = v_ssl
      and v_binding = api_v1._regulatory_binding_sha256(
        x.source_id, x.source_release_id, x.source_record_id,
        x.source_row_sha256, v_field_key, x.ssl_normalized
      );
  else
    select
      u.source_row_sha256,
      u.primary_address property_address,
      u.unit_number,
      s.publisher,
      s.dataset_name,
      s.source_class,
      rel.snapshot_retrieved_at,
      rel.sha256 release_sha256
    into v_row
    from core.mar_residential_unit_current u
    join meta.source_asset s on s.source_id = u.source_id
    join meta.source_release_pointer rp
      on rp.source_id = u.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = u.source_release_id
    join meta.source_release rel
      on rel.release_id = u.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where u.source_id = v_source_id
      and u.source_release_id = v_release_id
      and u.source_record_id = v_record_id
      and u.condo_ssl_normalized = v_ssl
      and v_binding = api_v1._regulatory_binding_sha256(
        u.source_id, u.source_release_id, u.source_record_id,
        u.source_row_sha256, v_field_key, u.condo_ssl_normalized
      );
  end if;

  if not found then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_binding_mismatch',
        'invalid_refs', jsonb_build_array(p_ref),
        'hint', 'Request a fresh parcel source_ref without editing it.'
      )
    );
  end if;

  v_evidence := jsonb_build_object(
    'source_ref', p_ref,
    'field_key', v_field_key,
    'publisher', v_row.publisher,
    'dataset_name', v_row.dataset_name,
    'source_class', v_row.source_class,
    'property_link', jsonb_build_object(
      'scope', 'exact_property',
      'method', 'official_mar_cross_reference',
      'match_quality', 'exact',
      'confidence', 1.0,
      'interpretation',
        'The official MAR record explicitly associates this address or unit with the supplied SSL; it does not establish common ownership or one collateral asset.'
    ),
    'human_verification', jsonb_build_object(
      'portal_name', 'D.C. Master Address Repository (MAR 2)',
      'portal_url', 'https://mar2.data.dc.gov/',
      'access', 'Public human interface; no sign-in should be required.',
      'search_inputs', jsonb_strip_nulls(jsonb_build_object(
        'property_address', v_row.property_address,
        'unit', v_row.unit_number,
        'ssl', v_ssl,
        'field_to_verify', v_field_key
      )),
      'steps', jsonb_build_array(
        'Open the official MAR 2 viewer.',
        'Search with the supplied address or SSL.',
        'Compare the returned address, unit when supplied, and SSL.'
      )
    ),
    'provenance', jsonb_build_object(
      'source_id', v_source_id,
      'source_release_id', v_release_id,
      'source_record_id', v_record_id,
      'snapshot_retrieved_at', v_row.snapshot_retrieved_at,
      'release_sha256', v_row.release_sha256
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'evidence', v_evidence,
    'source', jsonb_build_object(
      'title', 'D.C. Master Address Repository (MAR 2)',
      'link', 'https://mar2.data.dc.gov/',
      'fallback', jsonb_build_object('link', 'https://propertyquest.dc.gov/'),
      'lookup', v_evidence#>'{human_verification,search_inputs}',
      'relationship', v_evidence#>>'{property_link,interpretation}',
      'property_link_scope', 'exact_property',
      'covers', jsonb_build_array('Official address-to-SSL relationship'),
      'covered_fields', jsonb_build_array(v_field_key),
      'access', 'Public human interface; no sign-in should be required.',
      'steps', v_evidence#>'{human_verification,steps}',
      'source_refs', jsonb_build_array(p_ref)
    )
  );
end;
$function$;

create or replace function api_v1.get_source_evidence(
  p_source_refs text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_count integer := coalesce(cardinality(p_source_refs), 0);
  v_ref text;
  v_result jsonb;
  v_old_refs text[];
  v_old_result jsonb := jsonb_build_object(
    'status', 'ok', 'evidence', '[]'::jsonb, 'sources', '[]'::jsonb
  );
  v_mar_evidence jsonb := '[]'::jsonb;
  v_mar_sources jsonb := '[]'::jsonb;
  v_combined jsonb;
begin
  if v_count < 1 or v_count > 50 then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_count',
        'hint', 'Pass between 1 and 50 source_refs exactly as returned by the connector.'
      )
    );
  end if;

  select array_agg(ref order by ordinality)
  into v_old_refs
  from unnest(p_source_refs) with ordinality requested(ref, ordinality)
  where split_part(ref, '|', 4) not like 'mar.%';

  if v_old_refs is not null then
    v_old_result := api_v1._get_source_evidence_v06_base(v_old_refs);
    if v_old_result->>'status' is distinct from 'ok' then
      return v_old_result;
    end if;
  end if;

  foreach v_ref in array p_source_refs loop
    if split_part(v_ref, '|', 4) like 'mar.%' then
      v_result := api_v1._get_mar_source_evidence(v_ref);
      if v_result->>'status' is distinct from 'ok' then
        return v_result;
      end if;
      v_mar_evidence := v_mar_evidence || jsonb_build_array(v_result->'evidence');
      v_mar_sources := v_mar_sources || jsonb_build_array(v_result->'source');
    end if;
  end loop;

  with all_items as (
    select item
    from jsonb_array_elements(
      coalesce(v_old_result->'evidence', '[]'::jsonb) || v_mar_evidence
    ) item
  ), ordered as (
    select requested.ordinality, found.item
    from unnest(p_source_refs) with ordinality requested(ref, ordinality)
    join lateral (
      select item
      from all_items
      where item->>'source_ref' = requested.ref
      limit 1
    ) found on true
  )
  select coalesce(jsonb_agg(item order by ordinality), '[]'::jsonb)
  into v_combined
  from ordered;

  return jsonb_build_object(
    'status', 'ok',
    'evidence', v_combined,
    'sources', coalesce(v_old_result->'sources', '[]'::jsonb) || v_mar_sources
  );
end;
$function$;

revoke all on function api_v1._get_mar_source_evidence(text) from public;
revoke all on function api_v1.get_source_evidence(text[]) from public;
grant execute on function api_v1._get_mar_source_evidence(text) to api_owner;
grant execute on function api_v1.get_source_evidence(text[]) to mcp_runtime;

alter function api_v1._get_mar_source_evidence(text) owner to api_owner;
alter function api_v1.get_source_evidence(text[]) owner to api_owner;

commit;
