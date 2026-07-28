begin;

-- The canonical link relation is meta.source_record_link.  The regulatory
-- copy was never read by the API and would duplicate millions of rows.
drop table if exists regulatory.property_link;

-- Every serving identity includes its immutable source release so a later
-- snapshot can be loaded while the previous snapshot remains published.
drop index if exists meta.source_record_link_identity_uidx;
drop index if exists meta.source_record_link_exact_uidx;
drop index if exists meta.source_record_link_unresolved_uidx;

create unique index source_record_link_identity_uidx
  on meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    coalesce(account_id, 0::bigint),
    coalesce(link_scope, '')
  );

create unique index source_record_link_exact_uidx
  on meta.source_record_link (
    source_release_id,
    source_record_id
  )
  where match_quality = 'exact';

create unique index source_record_link_unresolved_uidx
  on meta.source_record_link (
    source_release_id,
    source_record_id
  )
  where link_status in ('ambiguous', 'unlinked');

alter table regulatory.record
  drop constraint if exists
    record_source_id_source_record_id_key;
alter table regulatory.record
  add constraint regulatory_record_release_identity_key
  unique (source_id, source_release_id, source_record_id);

alter table property_context.cama_building_profile
  drop constraint if exists
    cama_building_profile_source_id_source_record_id_key;
alter table property_context.cama_building_profile
  add constraint cama_building_profile_release_identity_key
  unique (source_id, source_release_id, source_record_id);

alter table property_context.energy_benchmark
  drop constraint if exists
    energy_benchmark_source_id_source_record_id_key;
alter table property_context.energy_benchmark
  add constraint energy_benchmark_release_identity_key
  unique (source_id, source_release_id, source_record_id);

alter table property_context.beps_compliance
  drop constraint if exists
    beps_compliance_source_id_source_record_id_key;
alter table property_context.beps_compliance
  add constraint beps_compliance_release_identity_key
  unique (source_id, source_release_id, source_record_id);

alter table property_context.vacant_blighted_status
  drop constraint if exists
    vacant_blighted_status_source_id_source_record_id_key;
alter table property_context.vacant_blighted_status
  add constraint vacant_blighted_status_release_identity_key
  unique (source_id, source_release_id, source_record_id);

alter table property_context.land_designation
  drop constraint if exists
    land_designation_source_id_source_record_id_key;
alter table property_context.land_designation
  add constraint land_designation_release_identity_key
  unique (source_id, source_release_id, source_record_id);

create table meta.ingest_phase_checkpoint (
  batch_id bigint not null
    references meta.ingest_batch(batch_id) on delete cascade,
  phase_name text not null check (
    phase_name in (
      'metadata',
      'source_record_links',
      'regulatory_records',
      'property_context',
      'publication'
    )
  ),
  phase_status text not null check (
    phase_status in ('completed', 'failed')
  ),
  observed_row_count bigint check (
    observed_row_count is null
    or observed_row_count >= 0
  ),
  artifact_sha256 text check (
    artifact_sha256 is null
    or artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  detail jsonb not null default '{}'::jsonb check (
    jsonb_typeof(detail) = 'object'
  ),
  completed_at timestamptz not null default now(),
  primary key (batch_id, phase_name)
);

revoke all on table meta.ingest_phase_checkpoint
  from public, mcp_runtime;

alter table meta.ingest_phase_checkpoint enable row level security;

comment on table meta.ingest_phase_checkpoint is
  'Administrative hidden-release loader checkpoints. A resume must independently verify row counts, artifact hashes, and relational gates before skipping a phase.';

create table meta.loaded_artifact_binding (
  artifact_key text primary key,
  file_name text not null,
  relation_name text not null,
  artifact_sha256 text not null check (
    artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  artifact_row_count bigint not null check (
    artifact_row_count >= 0
  ),
  mapping_sha256 text not null check (
    mapping_sha256 ~ '^[0-9a-f]{64}$'
  ),
  build_manifest_sha256 text not null check (
    build_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  verification_method text not null,
  verified_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb check (
    jsonb_typeof(detail) = 'object'
  ),
  check (nullif(btrim(artifact_key), '') is not null),
  check (nullif(btrim(file_name), '') is not null),
  check (nullif(btrim(relation_name), '') is not null),
  check (nullif(btrim(verification_method), '') is not null)
);

revoke all on table meta.loaded_artifact_binding
  from public, mcp_runtime, api_owner;

alter table meta.loaded_artifact_binding enable row level security;

comment on table meta.loaded_artifact_binding is
  'Administrative proof that a local canonical artifact and the loaded relation have the same stable identity mapping. Regulatory linking must bind to this proof before loading.';

create or replace function meta.invalidate_property_account_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  delete from meta.loaded_artifact_binding
  where artifact_key = 'property_account_current';
  return null;
end;
$function$;

revoke all on function meta.invalidate_property_account_binding()
  from public, mcp_runtime, api_owner;

create trigger invalidate_property_account_binding_on_write
after insert or update or delete
on core.property_account_current
for each statement
execute function meta.invalidate_property_account_binding();

create trigger invalidate_property_account_binding_on_truncate
after truncate
on core.property_account_current
for each statement
execute function meta.invalidate_property_account_binding();

comment on function meta.invalidate_property_account_binding() is
  'Invalidates the cryptographic account-map proof whenever the bound core relation changes; rebinding requires a full ordered comparison.';

commit;
