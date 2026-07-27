begin;

-- A full index is required here because resolve_property optionally includes
-- deleted records. A parameterized SECURITY DEFINER plan cannot prove the
-- predicate of the former partial index and otherwise falls back to a scan.
drop index if exists core.property_account_address_trgm_idx;
create index property_account_address_trgm_idx
  on core.property_account_current
  using gin (address_normalized extensions.gin_trgm_ops);

set local role api_owner;

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
  with normalized as (
    select
      nullif(
        upper(replace(replace(replace(trim(p_ssl), '-', ''), ' ', ''), E'\t', '')),
        ''
      ) as ssl,
      nullif(
        upper(regexp_replace(
          regexp_replace(trim(p_address), '[^A-Za-z0-9 ]+', ' ', 'g'),
          '\s+', ' ', 'g'
        )),
        ''
      ) as address
  ),
  candidates as (
    select
      a.*,
      case
        when n.ssl is not null and a.ssl_normalized = n.ssl then 1.0
        when n.address is not null and a.address_normalized = n.address then 0.95
        else extensions.similarity(a.address_normalized, n.address)
      end as rank_score
    from core.property_account_current a
    cross join normalized n
    where (p_include_deleted or not a.is_deleted)
      and (
        (n.ssl is not null and a.ssl_normalized = n.ssl)
        or
        (
          n.ssl is null
          and n.address is not null
          and a.address_normalized operator(extensions.%) n.address
          -- Street numbers are highly selective and prevent broad trigram
          -- scans when users spell out a suffix (for example AVENUE vs AVE).
          and (
            n.address !~ '^[0-9]+ '
            or split_part(a.address_normalized, ' ', 1) =
              split_part(n.address, ' ', 1)
          )
        )
      )
    order by rank_score desc, a.account_id
    limit least(greatest(p_limit, 1), 10)
  )
  select jsonb_build_object(
    'status',
    case
      when count(*) = 0 then 'not_found'
      when count(*) = 1 then 'resolved'
      else 'ambiguous'
    end,
    'candidates',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'account_id', c.account_id,
          'ssl', c.ssl_display,
          'address', c.premise_address,
          'unit', c.unit_number,
          'record_extract_at', c.record_extract_at
        )
        order by c.rank_score desc, c.account_id
      ),
      '[]'::jsonb
    )
  )
  from candidates c;
$$;

grant execute on function api_v1.resolve_property(text, text, boolean, integer)
  to mcp_runtime;

alter function api_v1.resolve_property(text, text, boolean, integer)
  owner to api_owner;

analyze core.property_account_current;

commit;
