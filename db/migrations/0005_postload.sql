begin;

insert into meta.snapshot_record_link (
  assessment_record_id, account_id, link_status, link_method, confidence, conflict_detail
)
select
  h.assessment_record_id,
  h.account_id,
  case
    when h.account_id is not null then 'exact'
    when h.ssl_normalized is null or h.ssl_normalized = '' then 'unlinked'
    when d.source_ssl_count > 1 then 'ambiguous'
    else 'unlinked'
  end,
  case
    when h.account_id is not null then 'normalized_ssl_exact'
    when h.ssl_normalized is null or h.ssl_normalized = '' then 'missing_ssl'
    when d.source_ssl_count > 1 then 'duplicate_ssl_within_snapshot'
    else 'no_current_account_match'
  end,
  case when h.account_id is not null then 1.0000 else null end,
  case
    when d.source_ssl_count > 1 then jsonb_build_object(
      'source_id', h.source_id,
      'ssl_normalized', h.ssl_normalized,
      'candidate_snapshot_rows', d.source_ssl_count
    )
    else null
  end
from history.assessment_snapshot_record h
left join (
  select source_id, ssl_normalized, count(*) source_ssl_count
  from history.assessment_snapshot_record
  where ssl_normalized is not null and ssl_normalized <> ''
  group by source_id, ssl_normalized
) d using (source_id, ssl_normalized)
where h.account_id is null
on conflict (assessment_record_id) do update set
  account_id = excluded.account_id,
  link_status = excluded.link_status,
  link_method = excluded.link_method,
  confidence = excluded.confidence,
  conflict_detail = excluded.conflict_detail;

create index if not exists property_account_exact_address_idx
  on core.property_account_current (address_normalized, unit_number);
create index if not exists property_account_address_trgm_idx
  on core.property_account_current
  using gin (address_normalized extensions.gin_trgm_ops)
  where not is_deleted;
create index if not exists assessment_account_idx
  on history.assessment_snapshot_record (account_id);

analyze core.property_account_current;
analyze history.assessment_snapshot_record;
analyze history.tax_series;
analyze meta.snapshot_record_link;

commit;
