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
  v_result jsonb;
  v_sources jsonb;
begin
  v_result := api_v1._get_source_evidence_v05_base(p_source_refs);

  if v_result->>'status' is distinct from 'ok' then
    return v_result;
  end if;

  with evidence_items as (
    select
      item,
      ordinality,
      item->>'source_ref' source_ref,
      item->>'field_key' field_key,
      item->'human_verification' human_verification,
      item->'property_link' property_link
    from jsonb_array_elements(coalesce(v_result->'evidence', '[]'::jsonb))
      with ordinality evidence(item, ordinality)
  ),
  routed as (
    select
      e.*,
      case
        when e.field_key like 'sale.history.%' then
          'D.C. Open Data - Tax System Property Sales (CAMA)'
        else coalesce(
          nullif(e.human_verification->>'portal_name', ''),
          'Verify this record on the official portal'
        )
      end title,
      case
        when e.field_key like 'sale.history.%'
          or e.human_verification->>'portal_url' like
            'https://opendata.dc.gov/datasets/%tax-system-property-sales-cama%'
          or e.human_verification->>'portal_name' ilike '%CAMA%'
          then 'https://opendata.dc.gov/datasets/DCGIS::tax-system-property-sales-cama'
        when e.human_verification->>'portal_url' like
          'https://mytax.dc.gov/%'
          or e.human_verification->>'portal_name' ilike '%mytax%'
          then 'https://mytax.dc.gov/_/?Link=PropertySearch'
        when e.human_verification->>'portal_name' ilike '%DOEE Well%'
          or e.human_verification->>'portal_url' like
            'https://doee.dc.gov/service/%'
          then 'https://opendata.dc.gov/datasets/DCGIS::dc-well-permits'
        else e.human_verification->>'portal_url'
      end link,
      coalesce(
        e.human_verification->'search_inputs',
        '{}'::jsonb
      ) - 'field_to_verify' lookup,
      coalesce(
        e.property_link->>'interpretation',
        case coalesce(e.property_link->>'scope', 'exact_property')
          when 'exact_property' then
            'The source record is linked to this exact D.C. tax account.'
          when 'shared_building' then
            'Building-level or shared-premise context; it can apply to multiple tax accounts and is not an exact parcel assertion.'
          when 'multi_parcel' then
            'The official record spans or references multiple parcels; it is contextual for this tax account.'
          when 'proximity_context' then
            'Nearby or spatial context only; it is not asserted as a fact about this exact parcel.'
          else
            'Link scope was not recognized; do not treat the record as exact.'
        end
      ) relationship,
      coalesce(e.property_link->>'scope', 'exact_property') property_link_scope,
      case
        when e.human_verification->>'portal_name' ilike '%Recorder%'
          or e.human_verification->>'portal_url' =
            'https://washington.dc.publicsearch.us/'
          then 'Free registration may be required to search and view document images; portal or copy fees may apply.'
        when e.human_verification->>'portal_name' ilike '%DOEE Well%'
          or e.human_verification->>'portal_url' like
            'https://doee.dc.gov/service/%'
          then 'The official Open Data landing is public. The DOEE service page is an application/login workflow, not a public permit lookup.'
        when e.human_verification->>'portal_name' ilike '%Building Energy%'
          then 'Public dashboard; JavaScript may be required, and current dashboard values can be newer than the dated source release.'
        when e.human_verification->>'portal_name' ilike '%Vacant%'
          then 'Public dashboard; JavaScript may be required, and the current classification can change after the dated source release.'
        else coalesce(
          nullif(e.human_verification->>'access', ''),
          'Open the official human interface and use the supplied lookup inputs.'
        )
      end access,
      jsonb_strip_nulls(jsonb_build_object(
        'square', split_part(e.human_verification#>>'{search_inputs,ssl}', '-', 1),
        'suffix', split_part(e.human_verification#>>'{search_inputs,ssl}', '-', 2),
        'lot', split_part(e.human_verification#>>'{search_inputs,ssl}', '-', 3),
        'address', e.human_verification#>>'{search_inputs,property_address}'
      )) property,
      case
        when e.field_key like 'assessment.prior.%'
          then 'Prior assessment'
        when e.field_key like 'assessment.current.%'
          then 'Current assessment'
        when e.field_key like 'assessment.proposed.%'
          then 'Proposed assessment'
        when e.field_key like 'assessment.%'
          then 'Property assessment'
        when e.field_key like 'tax.%'
          or e.field_key like 'special.%'
          then 'Property tax, balance, or bill'
        else e.field_key
      end cover,
      case
        when e.field_key like 'sale.history.%' then jsonb_build_array(
          'Open the human-facing D.C. Open Data Tax System Property Sales (CAMA) dataset.',
          'Use the supplied SSL, address, or source record ID to identify the property and sale row.',
          'Match the sale date and price, then compare the cited sale field.'
        )
        when e.human_verification->>'portal_name' ilike '%DOEE Well%'
          or e.human_verification->>'portal_url' like
            'https://doee.dc.gov/service/%'
          then jsonb_build_array(
            'Open the official D.C. Open Data page for DC Well Permits.',
            'Use the supplied permit, source record ID, or address to identify the cited source row.',
            'Use the DOEE service page only for current agency follow-up; it is an application/login workflow, not a public permit lookup.'
          )
        when e.human_verification->>'portal_name' ilike
          '%Medical Cannabis%'
          then jsonb_build_array(
            'Open the official ABCA medical-cannabis licensee page.',
            'Search with the supplied licensed entity, trade name, or premise address; refine by ward and license type when those fields are exposed. Use a license number only when it is explicitly present in the lookup inputs.',
            'Compare the matching licensed-location entry with the cited field and current status.'
          )
        else e.human_verification->'steps'
      end verification_steps,
      case
        when e.human_verification->>'portal_url' like
          'https://mytax.dc.gov/%'
          or e.human_verification->>'portal_name' ilike '%mytax%'
          then coalesce(
            (
              select case
                when alternate->>'portal_url' like 'https://mytax.dc.gov/%'
                  then 'https://mytax.dc.gov/_/?Link=PropertySearch'
                else alternate->>'portal_url'
              end
              from jsonb_array_elements(
                coalesce(e.item->'alternate_human_verification', '[]'::jsonb)
              ) with ordinality alternatives(alternate, alternate_ordinality)
              where nullif(alternate->>'portal_url', '') is not null
                and alternate->>'portal_url' !~* '(services\.arcgis\.com|featureserver|mapserver|/rest/|/api/|\.csv([?#]|$)|\.json([?#]|$)|/_/retrieve/|[?&](session|token|sid|jsessionid)=[^&"]*)'
              order by alternate_ordinality
              limit 1
            ),
            'https://otr.cfo.dc.gov/page/real-property-tax-database-search'
          )
        when e.human_verification->>'portal_name' ilike '%DOEE Well%'
          or e.human_verification->>'portal_url' like
            'https://doee.dc.gov/service/%'
          then 'https://doee.dc.gov/service/wellpermits'
        else (
          select case
            when alternate->>'portal_url' like 'https://mytax.dc.gov/%'
              then 'https://mytax.dc.gov/_/?Link=PropertySearch'
            else alternate->>'portal_url'
          end
          from jsonb_array_elements(
            coalesce(e.item->'alternate_human_verification', '[]'::jsonb)
          ) with ordinality alternatives(alternate, alternate_ordinality)
          where nullif(alternate->>'portal_url', '') is not null
            and alternate->>'portal_url' !~* '(services\.arcgis\.com|featureserver|mapserver|/rest/|/api/|\.csv([?#]|$)|\.json([?#]|$)|/_/retrieve/|[?&](session|token|sid|jsessionid)=[^&"]*)'
          order by alternate_ordinality
          limit 1
        )
      end fallback_link
    from evidence_items e
    where nullif(e.human_verification->>'portal_url', '') is not null
      and e.human_verification->>'portal_url' !~* '(services\.arcgis\.com|featureserver|mapserver|/rest/|/api/|\.csv([?#]|$)|\.json([?#]|$)|/_/retrieve/|[?&](session|token|sid|jsessionid)=[^&"]*)'
  ),
  grouped as (
    select
      jsonb_build_object(
        'title', title,
        'link', link,
        'fallback_link', fallback_link,
        'lookup', lookup,
        'property', property,
        'relationship', relationship,
        'property_link_scope', property_link_scope,
        'access', access
      ) route,
      min(ordinality) first_ordinality,
      jsonb_agg(distinct to_jsonb(cover) order by to_jsonb(cover))
        covers,
      jsonb_agg(distinct to_jsonb(field_key) order by to_jsonb(field_key))
        covered_fields,
      jsonb_agg(distinct to_jsonb(source_ref) order by to_jsonb(source_ref))
        source_refs,
      (
        jsonb_agg(r.verification_steps order by r.ordinality)
          filter (where r.verification_steps is not null)
      )->0 verification_steps
    from routed r
    group by
      r.title,
      r.link,
      r.fallback_link,
      r.lookup,
      r.property,
      r.relationship,
      r.property_link_scope,
      r.access
  )
  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'title', route->>'title',
          'link', route->>'link',
          'fallback', case
            when route->>'fallback_link' is not null then
              jsonb_build_object('link', route->>'fallback_link')
          end,
          'lookup', route->'lookup',
          'property', route->'property',
          'relationship', route->>'relationship',
          'property_link_scope', route->>'property_link_scope',
          'covers', covers,
          'covered_fields', covered_fields,
          'access', route->>'access',
          'steps', verification_steps,
          'source_refs', source_refs
        )
      ) order by first_ordinality
    ),
    '[]'::jsonb
  )
  into v_sources
  from grouped;

  return v_result || jsonb_build_object('sources', v_sources);
end;
$function$;

revoke all on function api_v1.get_source_evidence(text[]) from public;
grant execute on function api_v1.get_source_evidence(text[]) to mcp_runtime;

comment on function api_v1.get_source_evidence(text[]) is
  'Validates source references, preserves internal evidence, and groups all existing human-verification routes into deduplicated display-ready sources.';

reset role;

commit;
