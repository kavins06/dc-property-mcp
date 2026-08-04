begin;

set local role api_owner;

alter function api_v1.get_complete_property_record(text, text)
  rename to _get_complete_property_record_v04;

revoke all on function api_v1._get_complete_property_record_v04(
  text,
  text
) from public, mcp_runtime;

create or replace function api_v1.get_complete_property_record(
  p_ssl text default null,
  p_address text default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with prior as materialized (
    select api_v1._get_complete_property_record_v04(
      p_ssl,
      p_address
    ) payload
  ),
  recorder_history as materialized (
    select api_v1.get_recorder_instrument_history(
      p_ssl,
      p_address,
      '{"limit":50}'::jsonb
    ) payload
    from prior
    where prior.payload->>'status' = 'resolved'
  )
  select case
    when prior.payload->>'status' <> 'resolved' then prior.payload
    else prior.payload || jsonb_build_object(
      'coverage',
        prior.payload->'coverage' || jsonb_build_object(
          'complete',
            coalesce(
              (prior.payload#>>'{coverage,complete}')::boolean,
              false
            )
            and not coalesce(
              (recorder_history.payload->>'has_more')::boolean,
              false
            ),
          'included_sections',
            prior.payload#>'{coverage,included_sections}'
            || jsonb_build_array('recorder_instrument_history'),
          'record_counts',
            prior.payload#>'{coverage,record_counts}'
            || jsonb_build_object(
              'recorder_instruments',
                coalesce(
                  (recorder_history.payload->>'total_count')::bigint,
                  0
                )
            ),
          'continuations',
            prior.payload#>'{coverage,continuations}'
            || case
              when coalesce(
                (recorder_history.payload->>'has_more')::boolean,
                false
              ) then jsonb_build_object(
                'get_recorder_instrument_history',
                  jsonb_build_object(
                    'cursor',
                      recorder_history.payload->>'next_cursor'
                  )
              )
              else '{}'::jsonb
            end
        ),
      'sections',
        prior.payload->'sections' || jsonb_build_object(
          'recorder_instrument_history',
          recorder_history.payload
        )
    )
  end
  from prior
  left join recorder_history on true;
$function$;

revoke all on function api_v1.get_complete_property_record(text, text)
  from public;
grant execute on function api_v1.get_complete_property_record(text, text)
  to mcp_runtime;

comment on function api_v1.get_complete_property_record(text, text) is
  'Returns all ten property-data sections for one exact identity, including bounded official Recorder index history with explicit completeness and continuation metadata.';

reset role;

commit;
