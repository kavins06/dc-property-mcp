begin;
set local role api_owner;

-- Make every fact reference self-describing without changing each caller.
-- Callers may continue to pass an account/source-level reference; _fact replaces
-- its generic field segment with the fact's semantic field key.
create or replace function api_v1._fact(
  p_value anyelement,
  p_field_key text,
  p_record_date date,
  p_source_ref text
) returns jsonb
language sql
stable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  with ref as (
    select string_to_array(p_source_ref, '|') parts
  )
  select jsonb_build_object(
    'value', to_jsonb(p_value),
    'field_key', p_field_key,
    'title', f.title,
    'unit', f.unit,
    'record_date', p_record_date,
    'status', case when p_value is null then 'not_reported' else 'reported' end,
    'source_refs', jsonb_build_array(
      case
        when cardinality(ref.parts) >= 4 then concat_ws(
          '|',
          ref.parts[1],
          ref.parts[2],
          replace(coalesce(p_field_key, ''), '|', ''),
          ref.parts[4]
        )
        else p_source_ref
      end
    ),
    'quality_flags', '[]'::jsonb
  )
  from ref
  left join semantic.field_definition f on f.field_key = p_field_key;
$$;

create or replace function api_v1.get_source_evidence(
  p_source_refs text[]
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with requested as (
    select ref, string_to_array(ref, '|') parts
    from unnest(p_source_refs[1:50]) ref
  ),
  expanded as (
    select
      r.ref,
      r.parts[1] source_id,
      nullif(r.parts[2], '')::integer source_row_number,
      r.parts[3] field_key,
      r.parts[4] ssl,
      s.publisher,
      s.dataset_name,
      s.source_class,
      s.archive_capture_at,
      s.dataset_retrieved_at,
      s.sha256,
      a.ssl_display,
      a.premise_address,
      a.latest_instrument_number,
      case
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
    left join meta.source_asset s on s.source_id = r.parts[1]
    left join core.property_account_current a
      on a.ssl_normalized = r.parts[4]
  ),
  routed as (
    select
      e.*,
      case e.portal_family
        when 'recorder' then 'D.C. Recorder of Deeds Official Records Search'
        when 'assessment_map' then 'D.C. OTR Real Property Assessment Map'
        else 'MyTax.DC.gov Real Property Search'
      end portal_name,
      case e.portal_family
        when 'recorder' then 'https://washington.dc.publicsearch.us/'
        when 'assessment_map' then
          'https://dcgis.maps.arcgis.com/apps/webappviewer/index.html?id=9a5c11c11dd347cc9c05d64499cc98ee'
        else 'https://mytax.dc.gov/?Link=PropertySearch&Check=1'
      end portal_url
    from expanded e
  )
  select jsonb_build_object(
    'status', 'ok',
    'evidence', coalesce(jsonb_agg(jsonb_build_object(
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
          else 'Public search; no sign-in should be required.'
        end,
        'search_inputs', jsonb_strip_nulls(jsonb_build_object(
          'ssl', coalesce(e.ssl_display, e.ssl),
          'property_address', e.premise_address,
          'instrument_number', case
            when e.portal_family in ('recorder', 'mytax_sale')
              then e.latest_instrument_number
          end
        )),
        'steps', case e.portal_family
          when 'recorder' then jsonb_build_array(
            'Open the official records search and register or sign in if prompted.',
            'Search by the supplied instrument number. If no instrument number is available, search by SSL and the reported owner or party name.',
            'Open the matching recorded instrument and confirm its parties, dates, legal description, and document image.'
          )
          when 'assessment_map' then jsonb_build_array(
            'Open the D.C. OTR assessment map.',
            'Enter the supplied property address or SSL in the search box and select the matching parcel.',
            'Review the parcel panel for the property ID, address, ward, property type, assessment, and sale fields relevant to the cited fact.'
          )
          else jsonb_build_array(
            'Open the MyTax.DC.gov Real Property Search.',
            'Enter the supplied property address or SSL and select Search.',
            'Under Search Results, open the matching SSL.',
            case
              when e.field_key like 'assessment.%' then
                'Open the assessment/property-detail area and compare the cited assessment field and applicable tax year or stage.'
              when e.field_key like 'tax.%' or e.field_key like 'special.%' then
                'Open the tax, balance, payment, or bill area that corresponds to the cited field and period.'
              when e.field_key like 'ownership.%' then
                'Review the owner and mailing information shown for the selected real-property account.'
              when e.field_key like 'sale.%' then
                'Review the sales/property-detail area. Use the Recorder alternate route below when the recorded instrument itself is required.'
              else
                'Review the property-detail area for the cited field.'
            end
          )
        end,
        'verification_note', case
          when e.source_class = 'archived_official_snapshot' then
            'This fact came from an archived official extract. The live portal may have changed or may not expose that historical period; use the source date and field label when comparing it.'
          when e.source_class = 'official_snapshot' then
            'This fact came from a dated official extract. The live portal can be newer, so compare the cited record date as well as the value.'
          else
            'The live portal can change after the cited record date.'
        end
      )),
      'alternate_human_verification', case
        when e.portal_family = 'mytax_sale' then jsonb_build_array(
          jsonb_strip_nulls(jsonb_build_object(
            'portal_name', 'D.C. Recorder of Deeds Official Records Search',
            'portal_url', 'https://washington.dc.publicsearch.us/',
            'access', 'Free registration is required to search and view document images.',
            'search_inputs', jsonb_strip_nulls(jsonb_build_object(
              'ssl', coalesce(e.ssl_display, e.ssl),
              'property_address', e.premise_address,
              'instrument_number', e.latest_instrument_number
            )),
            'use_when', 'Use this route to verify the recorded deed or instrument rather than the assessor-reported sale field.'
          ))
        )
        when e.portal_family = 'assessment_map' then jsonb_build_array(
          jsonb_build_object(
            'portal_name', 'MyTax.DC.gov Real Property Search',
            'portal_url', 'https://mytax.dc.gov/?Link=PropertySearch&Check=1',
            'search_inputs', jsonb_strip_nulls(jsonb_build_object(
              'ssl', coalesce(e.ssl_display, e.ssl),
              'property_address', e.premise_address
            )),
            'use_when', 'Use this route for the tax account, current assessment, ownership, billing, and payment detail.'
          )
        )
        else '[]'::jsonb
      end,
      'provenance', jsonb_build_object(
        'source_row_number', e.source_row_number,
        'archive_capture_at', e.archive_capture_at,
        'dataset_retrieved_at', e.dataset_retrieved_at,
        'source_sha256', e.sha256
      )
    ) order by e.ref), '[]'::jsonb)
  )
  from routed e;
$$;

revoke all on function api_v1.get_source_evidence(text[]) from public;
grant execute on function api_v1.get_source_evidence(text[]) to mcp_runtime;

comment on function api_v1.get_source_evidence(text[]) is
  'Expands fact references into human-facing official portals, exact lookup inputs, and short verification steps; machine-readable API URLs are deliberately excluded.';

alter function api_v1._fact(anyelement, text, date, text) owner to api_owner;
alter function api_v1.get_source_evidence(text[]) owner to api_owner;

commit;
