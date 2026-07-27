begin;

-- The assessment-record primary-key index occupies roughly 14 MB, but runtime
-- history reads use assessment_account_idx. Its only database dependency is a
-- diagnostic link table containing the 16,717 intentionally unlinked or
-- ambiguous snapshot records. This immutable dataset is validated by ETL and
-- post-load gates, so preserve the diagnostic rows while replacing the full
-- index with a small partial lookup index for just those records.
alter table meta.snapshot_record_link
  drop constraint if exists snapshot_record_link_assessment_record_id_fkey;

alter table history.assessment_snapshot_record
  drop constraint if exists assessment_snapshot_record_pkey;

create unique index if not exists assessment_unlinked_record_id_uidx
  on history.assessment_snapshot_record (assessment_record_id)
  where account_id is null;

comment on index history.assessment_unlinked_record_id_uidx is
  'Unique lookup for immutable unlinked/ambiguous assessment diagnostics; full-table assessment history reads use assessment_account_idx.';

comment on table meta.snapshot_record_link is
  'Immutable post-load diagnostics for unlinked or ambiguous assessment snapshot rows. Referential integrity is enforced by ETL/post-load assertions instead of a 14 MB full-history primary-key index.';

analyze history.assessment_snapshot_record;
analyze meta.snapshot_record_link;

commit;
