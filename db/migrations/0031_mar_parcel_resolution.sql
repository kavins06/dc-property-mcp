begin;

insert into meta.source_asset (
  source_id, publisher, dataset_name, source_class,
  official_landing_url, official_download_url, bytes, sha256, row_count,
  limitations, source_system, source_dataset_identifier,
  source_layer_identifier, source_record_id_field, snapshot_policy,
  source_metadata
) values
  (
    'mar_address_current',
    'D.C. Office of the Chief Technology Officer / DC GIS',
    'Master Address Repository - Address Table',
    'live_official', 'https://opendata.dc.gov/',
    'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Location_WebMercator/MapServer/6',
    0, repeat('0', 64), 0,
    'Official address identities; the base SSL is not the complete many-to-many relationship.',
    'ArcGIS REST', 'DCGIS_DATA/Location_WebMercator', 6, 'OBJECTID',
    'replace_current',
    '{"human_portal_url":"https://mar2.data.dc.gov/","human_portal_name":"D.C. Master Address Repository (MAR 2)"}'::jsonb
  ),
  (
    'mar_address_ssl_current',
    'D.C. Office of the Chief Technology Officer / DC GIS',
    'Master Address Repository - Address SSL XREF',
    'live_official', 'https://opendata.dc.gov/',
    'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Location_WebMercator/MapServer/7',
    0, repeat('0', 64), 0,
    'Official many-to-many address-to-SSL cross-reference; not evidence of common ownership or one collateral asset.',
    'ArcGIS REST', 'DCGIS_DATA/Location_WebMercator', 7, 'OBJECTID',
    'replace_current',
    '{"human_portal_url":"https://mar2.data.dc.gov/","human_portal_name":"D.C. Master Address Repository (MAR 2)"}'::jsonb
  ),
  (
    'mar_residential_unit_current',
    'D.C. Office of the Chief Technology Officer / DC GIS',
    'Master Address Repository - Residential Units',
    'live_official', 'https://opendata.dc.gov/',
    'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer/68',
    0, repeat('0', 64), 0,
    'Only a populated official CONDO_SSL narrows a unit to a condominium property identifier.',
    'ArcGIS REST', 'DCGIS_DATA/Property_and_Land_WebMercator', 68,
    'OBJECTID', 'replace_current',
    '{"human_portal_url":"https://mar2.data.dc.gov/","human_portal_name":"D.C. Master Address Repository (MAR 2)"}'::jsonb
  )
on conflict (source_id) do update set
  publisher = excluded.publisher,
  dataset_name = excluded.dataset_name,
  official_landing_url = excluded.official_landing_url,
  official_download_url = excluded.official_download_url,
  limitations = excluded.limitations,
  source_system = excluded.source_system,
  source_dataset_identifier = excluded.source_dataset_identifier,
  source_layer_identifier = excluded.source_layer_identifier,
  source_record_id_field = excluded.source_record_id_field,
  snapshot_policy = excluded.snapshot_policy,
  source_metadata = excluded.source_metadata;

create table core.mar_address_current (
  mar_id bigint primary key check (mar_id > 0),
  address_source_value text not null check (
    nullif(btrim(address_source_value), '') is not null
  ),
  address_normalized text not null check (
    nullif(btrim(address_normalized), '') is not null
  ),
  status text,
  base_ssl_normalized text,
  source_id text not null check (source_id = 'mar_address_current'),
  source_release_id bigint not null references meta.source_release(release_id),
  source_record_id bigint not null check (source_record_id > 0),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  unique (source_id, source_release_id, source_record_id)
);

create index mar_address_normalized_idx
  on core.mar_address_current (address_normalized, mar_id);

create table core.mar_address_ssl_current (
  mar_id bigint not null references core.mar_address_current(mar_id)
    on delete cascade,
  ssl_normalized text not null check (
    nullif(btrim(ssl_normalized), '') is not null
  ),
  square text,
  suffix text,
  lot text,
  lot_type text,
  common_ownership_lot text,
  parcel text,
  reservation text,
  source_id text not null check (source_id = 'mar_address_ssl_current'),
  source_release_id bigint not null references meta.source_release(release_id),
  source_record_id bigint not null check (source_record_id > 0),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  primary key (mar_id, ssl_normalized),
  unique (source_id, source_release_id, source_record_id)
);

create index mar_address_ssl_lookup_idx
  on core.mar_address_ssl_current (ssl_normalized, mar_id);

create table core.mar_residential_unit_current (
  unit_id bigint primary key check (unit_id > 0),
  mar_id bigint not null references core.mar_address_current(mar_id)
    on delete cascade,
  full_address text not null,
  full_address_normalized text not null,
  primary_address text not null,
  unit_number text not null,
  unit_type text,
  condo_ssl_normalized text,
  status text,
  source_id text not null check (
    source_id = 'mar_residential_unit_current'
  ),
  source_release_id bigint not null references meta.source_release(release_id),
  source_record_id bigint not null check (source_record_id > 0),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  unique (source_id, source_release_id, source_record_id)
);

create index mar_residential_unit_address_idx
  on core.mar_residential_unit_current (
    full_address_normalized,
    unit_id
  );

create index mar_residential_unit_mar_idx
  on core.mar_residential_unit_current (mar_id, unit_number);

revoke all on core.mar_address_current from public, mcp_runtime;
revoke all on core.mar_address_ssl_current from public, mcp_runtime;
revoke all on core.mar_residential_unit_current from public, mcp_runtime;
grant select on core.mar_address_current to api_owner;
grant select on core.mar_address_ssl_current to api_owner;
grant select on core.mar_residential_unit_current to api_owner;

comment on table core.mar_address_ssl_current is
  'Current official MAR many-to-many address-to-SSL relationships; not an ownership or collateral grouping.';

set local role api_owner;

create or replace function api_v1._mar_source_ref(
  p_source_id text,
  p_source_release_id bigint,
  p_source_record_id bigint,
  p_source_row_sha256 text,
  p_field_key text,
  p_ssl text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select concat_ws(
    '|',
    replace(coalesce(p_source_id, ''), '|', ''),
    p_source_release_id,
    p_source_record_id,
    replace(coalesce(p_field_key, ''), '|', ''),
    api_v1._regulatory_binding_sha256(
      p_source_id,
      p_source_release_id,
      p_source_record_id,
      p_source_row_sha256,
      p_field_key,
      p_ssl
    ),
    replace(coalesce(p_ssl, ''), '|', '')
  );
$$;

create or replace function api_v1._mar_parcel_resolution(
  p_ssl text,
  p_address text,
  p_include_deleted boolean,
  p_offset integer,
  p_limit integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_ssl text := api_v1._normalize_ssl(p_ssl);
  v_address text := api_v1._normalize_address_query(p_address);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_mar_id bigint;
  v_mar_count integer;
  v_unit_id bigint;
  v_unit_ssl text;
  v_total integer := 0;
  v_parcels jsonb := '[]'::jsonb;
  v_relationship text;
begin
  if v_ssl is not null then
    v_relationship := 'official_ssl';
    with selected as (
      select
        x.*,
        a.account_id,
        a.ssl_display,
        a.premise_address
      from core.property_account_current a
      left join lateral (
        select x.*
        from core.mar_address_ssl_current x
        where x.ssl_normalized = a.ssl_normalized
        order by x.mar_id, x.source_record_id
        limit 1
      ) x on true
      where a.ssl_normalized = v_ssl
        and (p_include_deleted or not a.is_deleted)
    )
    select
      count(*)::integer,
      coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'ssl', s.ssl_display,
        'ssl_normalized', v_ssl,
        'lot_type', s.lot_type,
        'account_id', s.account_id,
        'account_available', true,
        'relationship', 'exact',
        'source_refs', case
          when s.source_record_id is not null then jsonb_build_array(
            api_v1._mar_source_ref(
              s.source_id, s.source_release_id, s.source_record_id,
              s.source_row_sha256, 'mar.address_ssl', v_ssl
            )
          )
          else '[]'::jsonb
        end
      ))), '[]'::jsonb)
    into v_total, v_parcels
    from selected s;
  elsif v_address is not null then
    select u.unit_id, u.mar_id, u.condo_ssl_normalized
    into v_unit_id, v_mar_id, v_unit_ssl
    from core.mar_residential_unit_current u
    where u.full_address_normalized = v_address
      and u.condo_ssl_normalized is not null
      and (
        p_include_deleted
        or upper(coalesce(u.status, 'ACTIVE')) not in ('RETIRE', 'RETIRED')
      )
    order by u.unit_id
    limit 1;

    if v_unit_id is not null then
      v_relationship := 'official_mar_unit_condo_ssl';
      select
        count(*)::integer,
        coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'ssl', coalesce(a.ssl_display, u.condo_ssl_normalized),
          'ssl_normalized', u.condo_ssl_normalized,
          'lot_type', coalesce(x.lot_type, 'CONDO'),
          'account_id', a.account_id,
          'account_available', a.account_id is not null,
          'relationship', 'exact',
          'unit_id', u.unit_id,
          'unit_number', u.unit_number,
          'source_refs', jsonb_build_array(api_v1._mar_source_ref(
            u.source_id, u.source_release_id, u.source_record_id,
            u.source_row_sha256, 'mar.unit_condo_ssl', u.condo_ssl_normalized
          ))
        ))), '[]'::jsonb)
      into v_total, v_parcels
      from core.mar_residential_unit_current u
      left join core.mar_address_ssl_current x
        on x.mar_id = u.mar_id
       and x.ssl_normalized = u.condo_ssl_normalized
      left join core.property_account_current a
        on a.ssl_normalized = u.condo_ssl_normalized
       and (p_include_deleted or not a.is_deleted)
      where u.unit_id = v_unit_id;
    else
      select count(*)::integer, min(a.mar_id)
      into v_mar_count, v_mar_id
      from core.mar_address_current a
      where a.address_normalized = v_address
        and (
          p_include_deleted
          or upper(coalesce(a.status, 'ACTIVE')) not in ('RETIRE', 'RETIRED')
        );

      if v_mar_count = 1 then
        v_relationship := 'official_mar_address_ssl_cross_reference';
        select count(*)::integer
        into v_total
        from core.mar_address_ssl_current x
        where x.mar_id = v_mar_id;

        select coalesce(jsonb_agg(parcel order by ssl_normalized), '[]'::jsonb)
        into v_parcels
        from (
          select
            x.ssl_normalized,
            jsonb_strip_nulls(jsonb_build_object(
              'ssl', coalesce(a.ssl_display, x.ssl_normalized),
              'ssl_normalized', x.ssl_normalized,
              'lot_type', x.lot_type,
              'account_id', a.account_id,
              'account_available', a.account_id is not null,
              'relationship', 'exact',
              'source_refs', jsonb_build_array(api_v1._mar_source_ref(
                x.source_id, x.source_release_id, x.source_record_id,
                x.source_row_sha256, 'mar.address_ssl', x.ssl_normalized
              ))
            )) parcel
          from core.mar_address_ssl_current x
          left join core.property_account_current a
            on a.ssl_normalized = x.ssl_normalized
           and (p_include_deleted or not a.is_deleted)
          where x.mar_id = v_mar_id
          order by x.ssl_normalized
          offset v_offset
          limit v_limit
        ) page;
      elsif v_mar_count > 1 then
        v_relationship := 'multiple_official_addresses';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'relationship', coalesce(v_relationship, 'not_established'),
    'mar_id', v_mar_id,
    'total_count', v_total,
    'offset', v_offset,
    'returned_count', jsonb_array_length(v_parcels),
    'has_more', v_offset + jsonb_array_length(v_parcels) < v_total,
    'parcels', v_parcels
  );
end;
$function$;

do $block$
begin
  if to_regprocedure(
    'api_v1._resolve_property_v04_base(text,text,boolean,integer)'
  ) is null then
    alter function api_v1.resolve_property(text, text, boolean, integer)
      rename to _resolve_property_v04_base;
  end if;
end;
$block$;

revoke all on function api_v1._resolve_property_v04_base(
  text, text, boolean, integer
) from public, mcp_runtime;
grant execute on function api_v1._resolve_property_v04_base(
  text, text, boolean, integer
) to api_owner;

create or replace function api_v1.resolve_property(
  p_ssl text,
  p_address text,
  p_include_deleted boolean,
  p_limit integer,
  p_parcel_offset integer,
  p_parcel_limit integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_base jsonb;
  v_parcel jsonb;
  v_total integer;
  v_candidates jsonb;
begin
  if coalesce(p_parcel_offset, 0) < 0
     or coalesce(p_parcel_limit, 25) < 1
     or coalesce(p_parcel_limit, 25) > 100 then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'parcel_page',
        'hint', 'parcel_offset must be nonnegative and parcel_limit must be between 1 and 100.'
      )
    );
  end if;

  v_base := api_v1._resolve_property_v04_base(
    p_ssl, p_address, p_include_deleted, p_limit
  );
  if v_base->>'status' in ('invalid_input', 'conflicting_input') then
    return v_base;
  end if;

  v_parcel := api_v1._mar_parcel_resolution(
    p_ssl, p_address, p_include_deleted, p_parcel_offset, p_parcel_limit
  );
  v_total := (v_parcel->>'total_count')::integer;

  if p_ssl is not null then
    return v_base || jsonb_build_object('parcel_resolution', v_parcel);
  end if;

  if v_parcel->>'relationship' = 'official_mar_unit_condo_ssl'
     and v_total = 1
     and (v_parcel#>>'{parcels,0,account_available}')::boolean then
    select jsonb_build_array(jsonb_build_object(
      'account_id', a.account_id,
      'ssl', a.ssl_display,
      'address', api_v1._display_address(a.premise_address),
      'address_source_value', a.premise_address,
      'unit', nullif(a.unit_number, ''),
      'match_kind', 'mar_unit_exact',
      'similarity_score', 1.0,
      'record_extract_at', a.record_extract_at,
      'quality_flags', '[]'::jsonb
    ))
    into v_candidates
    from core.property_account_current a
    where a.account_id = (v_parcel#>>'{parcels,0,account_id}')::bigint;

    return jsonb_build_object(
      'status', 'resolved',
      'input_normalized', jsonb_build_object(
        'address', api_v1._normalize_address_query(p_address)
      ),
      'total_candidates', 1,
      'candidates', v_candidates,
      'parcel_resolution', v_parcel
    );
  end if;

  if v_parcel->>'relationship' =
       'official_mar_address_ssl_cross_reference'
     and v_total > 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'account_id', (item->>'account_id')::bigint,
      'ssl', item->>'ssl',
      'match_kind', 'mar_address_ssl_exact',
      'similarity_score', 1.0
    ) order by item->>'ssl_normalized'), '[]'::jsonb)
    into v_candidates
    from jsonb_array_elements(v_parcel->'parcels') item
    where item->>'account_id' is not null;

    return jsonb_build_object(
      'status', case
        when v_total = 1
          and jsonb_array_length(v_candidates) = 1 then 'resolved'
        else 'ambiguous'
      end,
      'ambiguity_reason', case
        when v_total > 1 then 'multiple_official_parcels'
        when jsonb_array_length(v_candidates) = 0
          then 'official_parcel_without_tax_account'
      end,
      'input_normalized', jsonb_build_object(
        'address', api_v1._normalize_address_query(p_address)
      ),
      'total_candidates', v_total,
      'candidates', v_candidates,
      'hint', case when v_total > 1 then
        'The official MAR address is associated with multiple SSLs. Select the intended SSL.'
      end,
      'parcel_resolution', v_parcel
    );
  end if;

  return v_base || jsonb_build_object('parcel_resolution', v_parcel);
end;
$function$;

create or replace function api_v1.resolve_property(
  p_ssl text default null,
  p_address text default null,
  p_include_deleted boolean default false,
  p_limit integer default 10
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select api_v1.resolve_property(
    p_ssl, p_address, p_include_deleted, p_limit, 0, 25
  );
$$;

revoke all on function api_v1.resolve_property(
  text, text, boolean, integer, integer, integer
) from public;
revoke all on function api_v1.resolve_property(
  text, text, boolean, integer
) from public;
grant execute on function api_v1.resolve_property(
  text, text, boolean, integer, integer, integer
) to mcp_runtime;
grant execute on function api_v1.resolve_property(
  text, text, boolean, integer
) to mcp_runtime;

do $block$
begin
  if to_regprocedure(
    'api_v1._get_source_evidence_v06_base(text[])'
  ) is null then
    alter function api_v1.get_source_evidence(text[])
      rename to _get_source_evidence_v06_base;
  end if;
end;
$block$;

revoke all on function api_v1._get_source_evidence_v06_base(text[])
  from public, mcp_runtime;
grant execute on function api_v1._get_source_evidence_v06_base(text[])
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
  v_count integer := coalesce(cardinality(p_source_refs), 0);
  v_mar_refs text[];
  v_old_refs text[];
  v_old_result jsonb := jsonb_build_object(
    'status', 'ok', 'evidence', '[]'::jsonb, 'sources', '[]'::jsonb
  );
  v_mar_evidence jsonb;
  v_mar_sources jsonb;
  v_combined jsonb;
  v_invalid jsonb;
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

  select
    array_agg(ref order by ordinality) filter (
      where split_part(ref, '|', 4) like 'mar.%'
    ),
    array_agg(ref order by ordinality) filter (
      where split_part(ref, '|', 4) not like 'mar.%'
    )
  into v_mar_refs, v_old_refs
  from unnest(p_source_refs) with ordinality requested(ref, ordinality);

  if v_mar_refs is null then
    return api_v1._get_source_evidence_v06_base(p_source_refs);
  end if;

  with parsed as (
    select
      ref,
      string_to_array(ref, '|') parts
    from unnest(v_mar_refs) ref
  )
  select jsonb_agg(to_jsonb(ref))
  into v_invalid
  from parsed
  where cardinality(parts) <> 6
    or parts[1] not in (
      'mar_address_ssl_current', 'mar_residential_unit_current'
    )
    or parts[2] !~ '^[0-9]+$'
    or parts[3] !~ '^[0-9]+$'
    or parts[4] not in ('mar.address_ssl', 'mar.unit_condo_ssl')
    or parts[5] !~ '^[0-9a-f]{64}$'
    or parts[6] is distinct from api_v1._normalize_ssl(parts[6]);

  if v_invalid is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'malformed_source_ref',
        'invalid_refs', v_invalid
      )
    );
  end if;

  with parsed as (
    select
      ref,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 5) binding_sha256,
      split_part(ref, '|', 6) ssl
    from unnest(v_mar_refs) ref
  ),
  identity as (
    select
      x.source_id, x.source_release_id, x.source_record_id,
      x.source_row_sha256, 'mar.address_ssl' field_key,
      x.ssl_normalized ssl, a.address_source_value property_address,
      null::text unit_number
    from core.mar_address_ssl_current x
    join core.mar_address_current a on a.mar_id = x.mar_id
    union all
    select
      u.source_id, u.source_release_id, u.source_record_id,
      u.source_row_sha256, 'mar.unit_condo_ssl',
      u.condo_ssl_normalized, u.primary_address, u.unit_number
    from core.mar_residential_unit_current u
    where u.condo_ssl_normalized is not null
  )
  select jsonb_agg(to_jsonb(p.ref))
  into v_invalid
  from parsed p
  where not exists (
    select 1
    from identity i
    join meta.source_release_pointer rp
      on rp.source_id = i.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = i.source_release_id
    join meta.source_release rel
      on rel.release_id = i.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where i.source_id = p.source_id
      and i.source_release_id = p.source_release_id
      and i.source_record_id = p.source_record_id
      and i.field_key = p.field_key
      and i.ssl = p.ssl
      and p.binding_sha256 = api_v1._regulatory_binding_sha256(
        i.source_id, i.source_release_id, i.source_record_id,
        i.source_row_sha256, i.field_key, i.ssl
      )
  );

  if v_invalid is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_binding_mismatch',
        'invalid_refs', v_invalid,
        'hint', 'Request a fresh parcel source_ref without editing it.'
      )
    );
  end if;

  if v_old_refs is not null then
    v_old_result := api_v1._get_source_evidence_v06_base(v_old_refs);
    if v_old_result->>'status' is distinct from 'ok' then
      return v_old_result;
    end if;
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 6) ssl
    from unnest(v_mar_refs) with ordinality requested(ref, ordinality)
  ),
  identity as (
    select
      x.source_id, x.source_release_id, x.source_record_id,
      x.source_row_sha256, 'mar.address_ssl' field_key,
      x.ssl_normalized ssl, a.address_source_value property_address,
      null::text unit_number
    from core.mar_address_ssl_current x
    join core.mar_address_current a on a.mar_id = x.mar_id
    union all
    select
      u.source_id, u.source_release_id, u.source_record_id,
      u.source_row_sha256, 'mar.unit_condo_ssl',
      u.condo_ssl_normalized, u.primary_address, u.unit_number
    from core.mar_residential_unit_current u
    where u.condo_ssl_normalized is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_ref', p.ref,
    'field_key', p.field_key,
    'publisher', s.publisher,
    'dataset_name', s.dataset_name,
    'source_class', s.source_class,
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
        'property_address', i.property_address,
        'unit', i.unit_number,
        'ssl', p.ssl,
        'field_to_verify', p.field_key
      )),
      'steps', jsonb_build_array(
        'Open the official MAR 2 viewer.',
        'Search with the supplied address or SSL.',
        'Compare the returned address, unit when supplied, and SSL.'
      )
    ),
    'provenance', jsonb_build_object(
      'source_id', p.source_id,
      'source_release_id', p.source_release_id,
      'source_record_id', p.source_record_id,
      'snapshot_retrieved_at', rel.snapshot_retrieved_at,
      'release_sha256', rel.sha256
    )
  ) order by p.ordinality), '[]'::jsonb)
  into v_mar_evidence
  from parsed p
  join identity i
    on i.source_id = p.source_id
   and i.source_release_id = p.source_release_id
   and i.source_record_id = p.source_record_id
   and i.field_key = p.field_key
   and i.ssl = p.ssl
  join meta.source_asset s on s.source_id = p.source_id
  join meta.source_release rel on rel.release_id = p.source_release_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'title', 'D.C. Master Address Repository (MAR 2)',
    'link', 'https://mar2.data.dc.gov/',
    'fallback', jsonb_build_object('link', 'https://propertyquest.dc.gov/'),
    'lookup', item#>'{human_verification,search_inputs}',
    'relationship', item#>>'{property_link,interpretation}',
    'property_link_scope', 'exact_property',
    'covers', jsonb_build_array('Official address-to-SSL relationship'),
    'covered_fields', jsonb_build_array(item->>'field_key'),
    'access', 'Public human interface; no sign-in should be required.',
    'steps', item#>'{human_verification,steps}',
    'source_refs', jsonb_build_array(item->>'source_ref')
  )), '[]'::jsonb)
  into v_mar_sources
  from jsonb_array_elements(v_mar_evidence) item;

  with all_items as (
    select item
    from jsonb_array_elements(
      coalesce(v_old_result->'evidence', '[]'::jsonb) || v_mar_evidence
    ) item
  ),
  ordered as (
    select requested.ordinality, found.item
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
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

revoke all on function api_v1.get_source_evidence(text[]) from public;
grant execute on function api_v1.get_source_evidence(text[]) to mcp_runtime;

alter function api_v1._mar_source_ref(
  text, bigint, bigint, text, text, text
) owner to api_owner;
alter function api_v1._mar_parcel_resolution(
  text, text, boolean, integer, integer
) owner to api_owner;
alter function api_v1.resolve_property(
  text, text, boolean, integer, integer, integer
) owner to api_owner;
alter function api_v1.resolve_property(
  text, text, boolean, integer
) owner to api_owner;
alter function api_v1.get_source_evidence(text[]) owner to api_owner;

comment on function api_v1.resolve_property(
  text, text, boolean, integer, integer, integer
) is
  'Resolves existing tax-account identity and adds paginated official MAR parcel relationships without promoting fuzzy matches.';

reset role;

commit;
