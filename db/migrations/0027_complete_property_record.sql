begin;

set local role api_owner;

create or replace function api_v1.get_complete_property_record(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with identity as (
    select api_v1.resolve_property(
      p_ssl,
      p_address,
      false,
      10
    ) result
  ),
  target as (
    select
      result identity_resolution,
      case
        when result->>'status' = 'resolved'
          then result#>>'{candidates,0,ssl}'
      end resolved_ssl
    from identity
  ),
  details as (
    select
      t.identity_resolution,
      api_v1.get_property_snapshot(
        t.resolved_ssl,
        null
      ) snapshot,
      api_v1.get_assessment_history(
        t.resolved_ssl,
        null
      ) assessment_history,
      api_v1.get_tax_and_balance_history(
        t.resolved_ssl,
        null
      ) tax_and_balance_history,
      api_v1.get_ownership_and_sale(
        t.resolved_ssl,
        null
      ) ownership_and_sale,
      api_v1.get_latest_sale_and_deed(
        t.resolved_ssl,
        null
      ) sale_and_deed_history,
      api_v1.get_permit_history(
        t.resolved_ssl,
        null,
        '{"limit":50}'::jsonb
      ) permit_history,
      api_v1.get_license_history(
        t.resolved_ssl,
        null,
        '{"limit":25}'::jsonb
      ) license_history,
      api_v1.get_inspection_and_enforcement_history(
        t.resolved_ssl,
        null,
        '{"limit":25}'::jsonb
      ) inspection_and_enforcement_history,
      api_v1.get_building_and_land_profile(
        t.resolved_ssl,
        null,
        '{"limit":25}'::jsonb
      ) building_and_land_profile
    from target t
    where t.resolved_ssl is not null
  )
  select case
    when t.resolved_ssl is null then jsonb_build_object(
      'status', t.identity_resolution->>'status',
      'identity_resolution', t.identity_resolution,
      'next_action',
        'Confirm one exact property identity before requesting facts.'
    )
    else jsonb_build_object(
      'status', 'resolved',
      'identity_resolution', d.identity_resolution,
      'coverage', jsonb_build_object(
        'requested_scope', 'all available property data',
        'complete',
          not coalesce(
            (d.permit_history->>'has_more')::boolean,
            false
          )
          and not coalesce(
            (d.license_history->>'has_more')::boolean,
            false
          )
          and not coalesce(
            (
              d.inspection_and_enforcement_history->>'has_more'
            )::boolean,
            false
          )
          and not coalesce(
            (
              d.building_and_land_profile->>'has_more'
            )::boolean,
            false
          ),
        'included_sections', jsonb_build_array(
          'property_snapshot',
          'assessment_history',
          'tax_and_balance_history',
          'ownership_and_sale',
          'sale_and_deed_history',
          'permit_history',
          'license_history',
          'inspection_and_enforcement_history',
          'building_and_land_profile'
        ),
        'record_counts', jsonb_build_object(
          'permits',
            coalesce(
              (d.permit_history->>'total_count')::bigint,
              0
            ),
          'licenses',
            coalesce(
              (d.license_history->>'total_count')::bigint,
              0
            ),
          'inspections_and_enforcement',
            coalesce(
              (
                d.inspection_and_enforcement_history
                  ->>'total_count'
              )::bigint,
              0
            ),
          'building_and_land',
            coalesce(
              (
                d.building_and_land_profile->>'total_count'
              )::bigint,
              0
            )
        ),
        'continuations', jsonb_strip_nulls(jsonb_build_object(
          'get_permit_history', case
            when coalesce(
              (d.permit_history->>'has_more')::boolean,
              false
            ) then jsonb_build_object(
              'cursor', d.permit_history->>'next_cursor'
            )
          end,
          'get_license_history', case
            when coalesce(
              (d.license_history->>'has_more')::boolean,
              false
            ) then jsonb_build_object(
              'cursor', d.license_history->>'next_cursor'
            )
          end,
          'get_inspection_and_enforcement_history', case
            when coalesce(
              (
                d.inspection_and_enforcement_history
                  ->>'has_more'
              )::boolean,
              false
            ) then jsonb_build_object(
              'cursor',
                d.inspection_and_enforcement_history
                  ->>'next_cursor'
            )
          end,
          'get_building_and_land_profile', case
            when coalesce(
              (
                d.building_and_land_profile->>'has_more'
              )::boolean,
              false
            ) then jsonb_build_object(
              'cursor',
                d.building_and_land_profile->>'next_cursor'
            )
          end
        )),
        'evidence_note',
          'Fact source_refs are included. Expand selected refs with get_source_evidence when human verification links are needed.'
      ),
      'sections', jsonb_build_object(
        'property_snapshot', d.snapshot,
        'assessment_history', d.assessment_history,
        'tax_and_balance_history', d.tax_and_balance_history,
        'ownership_and_sale', d.ownership_and_sale,
        'sale_and_deed_history', d.sale_and_deed_history,
        'permit_history', d.permit_history,
        'license_history', d.license_history,
        'inspection_and_enforcement_history',
          d.inspection_and_enforcement_history,
        'building_and_land_profile',
          d.building_and_land_profile
      )
    )
  end
  from target t
  left join details d on true;
$function$;

revoke all on function api_v1.get_complete_property_record(text, text)
  from public;
grant execute on function api_v1.get_complete_property_record(text, text)
  to mcp_runtime;

comment on function api_v1.get_complete_property_record(text, text) is
  'Returns all nine property-data sections for one exact identity, with explicit completeness and per-section continuation metadata.';

reset role;

commit;
