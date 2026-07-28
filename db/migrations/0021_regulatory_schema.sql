begin;

create schema if not exists regulatory;
create schema if not exists property_context;

revoke all on schema regulatory from public;
revoke all on schema property_context from public;
revoke all on schema regulatory from mcp_runtime;
revoke all on schema property_context from mcp_runtime;

grant usage on schema regulatory, property_context to api_owner;

alter table meta.source_asset
  add column source_system text,
  add column source_dataset_identifier text,
  add column source_layer_identifier bigint,
  add column source_record_id_field text,
  add column source_updated_at_field text,
  add column snapshot_policy text,
  add column source_metadata jsonb not null default '{}'::jsonb,
  add constraint source_asset_layer_identifier_nonnegative
    check (
      source_layer_identifier is null
      or source_layer_identifier >= 0
    ),
  add constraint source_asset_snapshot_policy_valid
    check (
      snapshot_policy is null
      or snapshot_policy in (
        'replace_current',
        'append_immutable',
        'periodic_snapshot',
        'one_time_archive'
      )
    ),
  add constraint source_asset_metadata_object
    check (jsonb_typeof(source_metadata) = 'object');

alter table meta.ingest_batch
  add column quality_status text not null default 'not_recorded',
  add column quality_check_count bigint not null default 0,
  add column quality_warning_count bigint not null default 0,
  add column quality_error_count bigint not null default 0,
  add column quality_report_sha256 text,
  add constraint ingest_batch_quality_status_valid
    check (
      quality_status in (
        'not_recorded',
        'pending',
        'passed',
        'failed'
      )
    ),
  add constraint ingest_batch_quality_counts_nonnegative
    check (
      quality_check_count >= 0
      and quality_warning_count >= 0
      and quality_error_count >= 0
      and quality_warning_count <= quality_check_count
      and quality_error_count <= quality_check_count
    ),
  add constraint ingest_batch_quality_report_sha256_valid
    check (
      quality_report_sha256 is null
      or quality_report_sha256 ~ '^[0-9a-f]{64}$'
    );

create table meta.source_release (
  release_id bigint generated always as identity primary key,
  source_id text not null
    references meta.source_asset(source_id),
  ingest_batch_id bigint
    references meta.ingest_batch(batch_id),
  release_key text not null,
  release_status text not null default 'staged' check (
    release_status in (
      'staged',
      'validated',
      'published',
      'superseded',
      'rejected'
    )
  ),
  quality_status text not null default 'pending' check (
    quality_status in (
      'pending',
      'passed',
      'failed'
    )
  ),
  snapshot_retrieved_at timestamptz not null,
  source_updated_at timestamptz,
  data_effective_at timestamptz,
  data_date_min date,
  data_date_max date,
  official_download_url text,
  archive_object_key text not null,
  content_type text,
  bytes bigint not null check (bytes >= 0),
  row_count bigint not null check (row_count >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  schema_sha256 text not null check (
    schema_sha256 ~ '^[0-9a-f]{64}$'
  ),
  row_hash_algorithm text not null default 'sha256' check (
    row_hash_algorithm = 'sha256'
  ),
  release_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(release_metadata) = 'object'
  ),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, release_key),
  unique (source_id, sha256),
  unique (source_id, release_id),
  check (
    data_date_min is null
    or data_date_max is null
    or data_date_min <= data_date_max
  ),
  check (
    release_status not in ('published', 'superseded')
    or (
      quality_status = 'passed'
      and published_at is not null
    )
  ),
  check (
    release_status in ('published', 'superseded')
    or published_at is null
  ),
  check (nullif(btrim(release_key), '') is not null),
  check (nullif(btrim(archive_object_key), '') is not null)
);

create index source_release_batch_idx
  on meta.source_release (ingest_batch_id)
  where ingest_batch_id is not null;

create index source_release_status_idx
  on meta.source_release (
    source_id,
    release_status,
    snapshot_retrieved_at desc
  );

create table meta.source_release_pointer (
  source_id text not null
    references meta.source_asset(source_id),
  pointer_name text not null check (
    pointer_name in ('current', 'candidate', 'previous')
  ),
  release_id bigint not null,
  set_by_batch_id bigint
    references meta.ingest_batch(batch_id),
  set_at timestamptz not null default now(),
  pointer_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(pointer_metadata) = 'object'
  ),
  primary key (source_id, pointer_name),
  unique (source_id, release_id),
  foreign key (source_id, release_id)
    references meta.source_release(source_id, release_id)
);

create index source_release_pointer_release_idx
  on meta.source_release_pointer (release_id);

create index source_release_pointer_batch_idx
  on meta.source_release_pointer (set_by_batch_id)
  where set_by_batch_id is not null;

create table meta.ingest_quality_result (
  quality_result_id bigint generated always as identity primary key,
  batch_id bigint not null
    references meta.ingest_batch(batch_id) on delete cascade,
  release_id bigint
    references meta.source_release(release_id) on delete cascade,
  check_scope text not null check (
    check_scope in ('batch', 'release', 'table', 'record')
  ),
  check_name text not null,
  severity text not null check (
    severity in ('info', 'warning', 'error')
  ),
  outcome text not null check (
    outcome in ('passed', 'failed', 'skipped')
  ),
  relation_name text,
  expected_value jsonb,
  observed_value jsonb,
  affected_row_count bigint check (
    affected_row_count is null
    or affected_row_count >= 0
  ),
  sample_source_record_ids bigint[] not null default '{}'::bigint[],
  detail jsonb not null default '{}'::jsonb check (
    jsonb_typeof(detail) = 'object'
  ),
  checked_at timestamptz not null default now(),
  check (nullif(btrim(check_name), '') is not null),
  check (
    check_scope <> 'release'
    or release_id is not null
  ),
  check (cardinality(sample_source_record_ids) <= 100)
);

create unique index ingest_quality_result_identity_uidx
  on meta.ingest_quality_result (
    batch_id,
    coalesce(release_id, 0::bigint),
    check_scope,
    check_name
  );

create index ingest_quality_result_release_idx
  on meta.ingest_quality_result (release_id)
  where release_id is not null;

create table meta.source_record_link (
  source_record_link_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  account_id bigint
    references core.property_account_current(account_id),
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text check (
    link_scope is null
    or link_scope in (
      'exact_property',
      'shared_building',
      'multi_parcel',
      'proximity_context'
    )
  ),
  link_method text check (
    link_method is null
    or link_method in (
      'ssl',
      'mar_id',
      'ubid',
      'normalized_address',
      'point_in_parcel',
      'polygon_overlap',
      'proximity'
    )
  ),
  match_quality text not null check (
    match_quality in (
      'exact',
      'contextual',
      'ambiguous',
      'unlinked'
    )
  ),
  link_confidence numeric(5,4) check (
    link_confidence is null
    or link_confidence between 0 and 1
  ),
  match_basis jsonb not null default '{}'::jsonb check (
    jsonb_typeof(match_basis) = 'object'
  ),
  linked_at timestamptz not null default now(),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id),
  check (
    (link_status = 'linked' and account_id is not null)
    or (link_status in ('ambiguous', 'unlinked') and account_id is null)
  ),
  check (
    (link_status = 'linked' and match_quality in ('exact', 'contextual'))
    or (link_status = 'ambiguous' and match_quality = 'ambiguous')
    or (link_status = 'unlinked' and match_quality = 'unlinked')
  ),
  check (
    match_quality <> 'exact'
    or (
      link_status = 'linked'
      and link_scope = 'exact_property'
      and link_method in (
        'ssl',
        'mar_id',
        'normalized_address',
        'point_in_parcel'
      )
      and link_confidence = 1
    )
  ),
  check (
    match_quality <> 'contextual'
    or (
      link_status = 'linked'
      and link_scope in (
        'shared_building',
        'multi_parcel',
        'proximity_context'
      )
      and link_method is not null
      and link_confidence > 0
      and link_confidence < 1
    )
  ),
  check (
    link_status <> 'ambiguous'
    or (
      link_scope is not null
      and link_method is not null
    )
  ),
  check (
    link_status <> 'unlinked'
    or (
      link_scope is null
      and link_method is null
      and link_confidence is null
    )
  )
);

create unique index source_record_link_identity_uidx
  on meta.source_record_link (
    source_id,
    source_record_id,
    coalesce(account_id, 0::bigint),
    coalesce(link_scope, '')
  );

create unique index source_record_link_exact_uidx
  on meta.source_record_link (source_id, source_record_id)
  where match_quality = 'exact';

create unique index source_record_link_unresolved_uidx
  on meta.source_record_link (source_id, source_record_id)
  where link_status in ('ambiguous', 'unlinked');

create index source_record_link_account_idx
  on meta.source_record_link (
    account_id,
    source_id,
    source_record_id
  )
  where account_id is not null;

create index source_record_link_release_idx
  on meta.source_record_link (source_release_id);

create table regulatory.record (
  record_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  source_row_number bigint check (
    source_row_number is null
    or source_row_number > 0
  ),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  record_kind text not null check (
    record_kind in (
      'building_permit',
      'certificate_of_occupancy',
      'business_license',
      'inspection',
      'enforcement_action',
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'home_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'well_permit',
      'alcohol_license',
      'cannabis_license'
    )
  ),
  source_record_key text,
  record_number text,
  record_status text,
  record_status_date date,
  premise_address text,
  address_normalized text,
  ssl_raw text,
  ssl_normalized text,
  mar_id bigint check (mar_id is null or mar_id > 0),
  ward text,
  latitude numeric(9,6) check (
    latitude is null
    or latitude between -90 and 90
  ),
  longitude numeric(9,6) check (
    longitude is null
    or longitude between -180 and 180
  ),
  source_created_at timestamptz,
  source_updated_at timestamptz,
  extra_attributes jsonb not null default '{}'::jsonb check (
    jsonb_typeof(extra_attributes) = 'object'
  ),
  ingested_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  unique (record_id, record_kind),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id),
  check (
    (latitude is null and longitude is null)
    or (latitude is not null and longitude is not null)
  ),
  check (
    address_normalized is null
    or nullif(btrim(address_normalized), '') is not null
  ),
  check (
    ssl_normalized is null
    or nullif(btrim(ssl_normalized), '') is not null
  )
);

create index regulatory_record_number_idx
  on regulatory.record (record_kind, record_number)
  where record_number is not null;

create index regulatory_record_ssl_idx
  on regulatory.record (ssl_normalized)
  where ssl_normalized is not null;

create index regulatory_record_mar_idx
  on regulatory.record (mar_id)
  where mar_id is not null;

create index regulatory_record_address_idx
  on regulatory.record (address_normalized)
  where address_normalized is not null;

create index regulatory_record_status_idx
  on regulatory.record (record_kind, record_status)
  where record_status is not null;

create table regulatory.property_link (
  property_link_id bigint generated always as identity primary key,
  source_record_link_id bigint not null unique
    references meta.source_record_link(source_record_link_id)
    on delete cascade,
  record_id bigint not null
    references regulatory.record(record_id) on delete cascade,
  account_id bigint
    references core.property_account_current(account_id),
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text not null check (
    link_scope in (
      'tax_account',
      'parcel',
      'building',
      'shared_premise',
      'address_only',
      'unknown'
    )
  ),
  link_method text not null check (
    link_method in (
      'exact_ssl',
      'mar_crosswalk',
      'unique_exact_address',
      'multiple_ssl_context',
      'spatial_intersection',
      'none'
    )
  ),
  match_quality text not null check (
    match_quality in (
      'exact',
      'contextual',
      'ambiguous',
      'unlinked'
    )
  ),
  source_ssl_normalized text,
  source_mar_id bigint check (
    source_mar_id is null
    or source_mar_id > 0
  ),
  source_address_normalized text,
  match_confidence numeric(5,4) check (
    match_confidence is null
    or match_confidence between 0 and 1
  ),
  link_context jsonb not null default '{}'::jsonb check (
    jsonb_typeof(link_context) = 'object'
  ),
  linked_at timestamptz not null default now(),
  unique (record_id, account_id),
  check (
    (link_status = 'linked' and account_id is not null)
    or (link_status in ('ambiguous', 'unlinked') and account_id is null)
  ),
  check (
    (link_status = 'linked' and match_quality in ('exact', 'contextual'))
    or (link_status = 'ambiguous' and match_quality = 'ambiguous')
    or (link_status = 'unlinked' and match_quality = 'unlinked')
  ),
  check (
    match_quality <> 'exact'
    or (
      link_status = 'linked'
      and link_scope in ('tax_account', 'parcel')
      and link_method in (
        'exact_ssl',
        'mar_crosswalk',
        'unique_exact_address'
      )
      and match_confidence = 1
    )
  ),
  check (
    match_quality <> 'contextual'
    or (
      link_status = 'linked'
      and link_scope in (
        'building',
        'shared_premise',
        'address_only'
      )
      and link_method in (
        'mar_crosswalk',
        'unique_exact_address',
        'multiple_ssl_context',
        'spatial_intersection'
      )
      and match_confidence > 0
      and match_confidence < 1
    )
  ),
  check (
    link_status <> 'ambiguous'
    or (
      link_scope <> 'tax_account'
      or link_method <> 'exact_ssl'
    )
  ),
  check (
    link_status <> 'unlinked'
    or (
      link_scope = 'unknown'
      and link_method = 'none'
      and match_confidence is null
    )
  ),
  check (
    link_method <> 'exact_ssl'
    or source_ssl_normalized is not null
  ),
  check (
    link_method <> 'mar_crosswalk'
    or source_mar_id is not null
  ),
  check (
    link_method <> 'unique_exact_address'
    or source_address_normalized is not null
  ),
  check (
    link_method <> 'multiple_ssl_context'
    or (
      source_ssl_normalized is not null
      or source_address_normalized is not null
    )
  )
);

create unique index regulatory_property_link_unresolved_uidx
  on regulatory.property_link (record_id)
  where link_status in ('ambiguous', 'unlinked');

create unique index regulatory_property_link_exact_uidx
  on regulatory.property_link (record_id)
  where match_quality = 'exact';

create index regulatory_property_link_account_idx
  on regulatory.property_link (account_id, record_id)
  where account_id is not null;

create table regulatory.building_permit (
  record_id bigint primary key,
  record_kind text not null default 'building_permit' check (
    record_kind = 'building_permit'
  ),
  permit_type text,
  permit_subtype text,
  work_type text,
  work_description text,
  application_date date,
  issue_date date,
  expiration_date date,
  finaled_date date,
  estimated_cost_dollars numeric(16,2) check (
    estimated_cost_dollars is null
    or estimated_cost_dollars >= 0
  ),
  permit_fee_cents bigint check (
    permit_fee_cents is null
    or permit_fee_cents >= 0
  ),
  owner_name text,
  applicant_name text,
  contractor_name text,
  contractor_license_number text,
  proposed_use text,
  existing_use text,
  number_of_stories numeric(6,2) check (
    number_of_stories is null
    or number_of_stories >= 0
  ),
  number_of_units integer check (
    number_of_units is null
    or number_of_units >= 0
  ),
  floor_area_square_feet numeric(16,2) check (
    floor_area_square_feet is null
    or floor_area_square_feet >= 0
  ),
  foreign key (record_id, record_kind)
    references regulatory.record(record_id, record_kind)
    on delete cascade
);

create index building_permit_issue_date_idx
  on regulatory.building_permit (issue_date desc)
  where issue_date is not null;

create table regulatory.business_license (
  record_id bigint primary key,
  record_kind text not null default 'business_license' check (
    record_kind = 'business_license'
  ),
  license_category text,
  license_type text,
  entity_name text,
  trade_name text,
  applicant_name text,
  activity_description text,
  issue_date date,
  start_date date,
  expiration_date date,
  is_active boolean,
  foreign key (record_id, record_kind)
    references regulatory.record(record_id, record_kind)
    on delete cascade
);

create index business_license_expiration_date_idx
  on regulatory.business_license (expiration_date desc)
  where expiration_date is not null;

create index business_license_entity_idx
  on regulatory.business_license (entity_name)
  where entity_name is not null;

create table regulatory.certificate_of_occupancy (
  record_id bigint primary key,
  record_kind text not null default 'certificate_of_occupancy' check (
    record_kind = 'certificate_of_occupancy'
  ),
  certificate_number text,
  related_building_permit_number text,
  occupancy_use text,
  proposed_use text,
  existing_use text,
  occupancy_load integer check (
    occupancy_load is null
    or occupancy_load >= 0
  ),
  floors_occupied text,
  dwelling_units integer check (
    dwelling_units is null
    or dwelling_units >= 0
  ),
  issue_date date,
  expiration_date date,
  foreign key (record_id, record_kind)
    references regulatory.record(record_id, record_kind)
    on delete cascade
);

create index certificate_of_occupancy_issue_date_idx
  on regulatory.certificate_of_occupancy (issue_date desc)
  where issue_date is not null;

create table regulatory.inspection (
  record_id bigint primary key,
  record_kind text not null default 'inspection' check (
    record_kind = 'inspection'
  ),
  inspection_type text,
  inspection_result text,
  scheduled_at timestamptz,
  completed_at timestamptz,
  inspector_unit text,
  inspection_score numeric(8,3),
  violation_count integer check (
    violation_count is null
    or violation_count >= 0
  ),
  notes text,
  foreign key (record_id, record_kind)
    references regulatory.record(record_id, record_kind)
    on delete cascade
);

create index inspection_completed_at_idx
  on regulatory.inspection (completed_at desc)
  where completed_at is not null;

create index inspection_result_idx
  on regulatory.inspection (inspection_result)
  where inspection_result is not null;

create table regulatory.enforcement_action (
  record_id bigint primary key,
  record_kind text not null default 'enforcement_action' check (
    record_kind = 'enforcement_action'
  ),
  case_number text,
  action_type text,
  violation_codes text[] not null default '{}'::text[],
  description text,
  opened_date date,
  issued_date date,
  compliance_due_date date,
  closed_date date,
  fine_cents bigint check (
    fine_cents is null
    or fine_cents >= 0
  ),
  resolution text,
  foreign key (record_id, record_kind)
    references regulatory.record(record_id, record_kind)
    on delete cascade
);

create index enforcement_action_case_idx
  on regulatory.enforcement_action (case_number)
  where case_number is not null;

create index enforcement_action_open_idx
  on regulatory.enforcement_action (opened_date desc)
  where closed_date is null;

create table property_context.cama_building_profile (
  building_profile_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  source_row_number bigint check (
    source_row_number is null
    or source_row_number > 0
  ),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_record_link_id bigint not null unique
    references meta.source_record_link(source_record_link_id),
  account_id bigint
    references core.property_account_current(account_id),
  ssl_raw text,
  ssl_normalized text,
  mar_id bigint check (mar_id is null or mar_id > 0),
  premise_address text,
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text not null check (
    link_scope in ('tax_account', 'unknown')
  ),
  link_method text not null check (
    link_method in ('exact_ssl', 'none')
  ),
  match_quality text not null check (
    match_quality in ('exact', 'ambiguous', 'unlinked')
  ),
  match_confidence numeric(5,4) check (
    match_confidence is null
    or match_confidence between 0 and 1
  ),
  link_context jsonb not null default '{}'::jsonb check (
    jsonb_typeof(link_context) = 'object'
  ),
  building_ordinal integer check (
    building_ordinal is null
    or building_ordinal > 0
  ),
  building_type text,
  use_description text,
  year_built smallint check (
    year_built is null
    or year_built between 1600 and 2200
  ),
  year_renovated smallint check (
    year_renovated is null
    or year_renovated between 1600 and 2200
  ),
  stories numeric(6,2) check (
    stories is null
    or stories >= 0
  ),
  bedrooms integer check (
    bedrooms is null
    or bedrooms >= 0
  ),
  full_bathrooms integer check (
    full_bathrooms is null
    or full_bathrooms >= 0
  ),
  half_bathrooms integer check (
    half_bathrooms is null
    or half_bathrooms >= 0
  ),
  gross_building_area_square_feet numeric(16,2) check (
    gross_building_area_square_feet is null
    or gross_building_area_square_feet >= 0
  ),
  living_area_square_feet numeric(16,2) check (
    living_area_square_feet is null
    or living_area_square_feet >= 0
  ),
  grade text,
  condition text,
  exterior_wall text,
  roof_type text,
  heat_type text,
  air_conditioning_type text,
  extra_attributes jsonb not null default '{}'::jsonb check (
    jsonb_typeof(extra_attributes) = 'object'
  ),
  ingested_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id),
  check (
    (
      link_status = 'linked'
      and account_id is not null
      and ssl_normalized is not null
      and link_scope = 'tax_account'
      and link_method = 'exact_ssl'
      and match_quality = 'exact'
      and match_confidence = 1
    )
    or (
      link_status = 'ambiguous'
      and account_id is null
      and ssl_normalized is not null
      and link_scope = 'tax_account'
      and link_method = 'exact_ssl'
      and match_quality = 'ambiguous'
    )
    or (
      link_status = 'unlinked'
      and account_id is null
      and link_scope = 'unknown'
      and link_method = 'none'
      and match_quality = 'unlinked'
      and match_confidence is null
    )
  )
);

create index cama_building_profile_account_idx
  on property_context.cama_building_profile (
    account_id,
    building_ordinal
  )
  where account_id is not null;

create table property_context.energy_benchmark (
  energy_benchmark_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  source_row_number bigint check (
    source_row_number is null
    or source_row_number > 0
  ),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_building_id text,
  mar_id bigint check (mar_id is null or mar_id > 0),
  premise_address text,
  address_normalized text,
  reporting_year smallint not null check (
    reporting_year between 2000 and 2200
  ),
  reporting_status text,
  property_name text,
  primary_property_type text,
  gross_floor_area_square_feet numeric(18,2) check (
    gross_floor_area_square_feet is null
    or gross_floor_area_square_feet >= 0
  ),
  energy_star_score smallint check (
    energy_star_score is null
    or energy_star_score between 0 and 100
  ),
  site_eui_kbtu_per_square_foot numeric(14,4) check (
    site_eui_kbtu_per_square_foot is null
    or site_eui_kbtu_per_square_foot >= 0
  ),
  source_eui_kbtu_per_square_foot numeric(14,4) check (
    source_eui_kbtu_per_square_foot is null
    or source_eui_kbtu_per_square_foot >= 0
  ),
  weather_normalized_site_eui numeric(14,4) check (
    weather_normalized_site_eui is null
    or weather_normalized_site_eui >= 0
  ),
  total_ghg_emissions_metric_tons numeric(18,4) check (
    total_ghg_emissions_metric_tons is null
    or total_ghg_emissions_metric_tons >= 0
  ),
  electricity_kwh numeric(20,4) check (
    electricity_kwh is null
    or electricity_kwh >= 0
  ),
  natural_gas_therms numeric(20,4) check (
    natural_gas_therms is null
    or natural_gas_therms >= 0
  ),
  water_gallons numeric(20,4) check (
    water_gallons is null
    or water_gallons >= 0
  ),
  extra_attributes jsonb not null default '{}'::jsonb check (
    jsonb_typeof(extra_attributes) = 'object'
  ),
  ingested_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id)
);

create index energy_benchmark_building_year_idx
  on property_context.energy_benchmark (
    source_building_id,
    reporting_year desc
  )
  where source_building_id is not null;

create index energy_benchmark_mar_idx
  on property_context.energy_benchmark (mar_id)
  where mar_id is not null;

create table property_context.energy_benchmark_property_link (
  energy_benchmark_link_id bigint generated always as identity primary key,
  source_record_link_id bigint not null unique
    references meta.source_record_link(source_record_link_id)
    on delete cascade,
  energy_benchmark_id bigint not null
    references property_context.energy_benchmark(energy_benchmark_id)
    on delete cascade,
  account_id bigint
    references core.property_account_current(account_id),
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text not null check (
    link_scope in (
      'building',
      'shared_premise',
      'address_only',
      'unknown'
    )
  ),
  link_method text not null check (
    link_method in (
      'mar_crosswalk',
      'unique_exact_address',
      'multiple_ssl_context',
      'spatial_intersection',
      'none'
    )
  ),
  match_quality text not null check (
    match_quality in ('contextual', 'ambiguous', 'unlinked')
  ),
  match_confidence numeric(5,4) check (
    match_confidence is null
    or match_confidence between 0 and 1
  ),
  link_context jsonb not null default '{}'::jsonb check (
    jsonb_typeof(link_context) = 'object'
  ),
  unique (energy_benchmark_id, account_id),
  check (
    (
      link_status = 'linked'
      and account_id is not null
      and link_scope in (
        'building',
        'shared_premise',
        'address_only'
      )
      and link_method <> 'none'
      and match_quality = 'contextual'
      and match_confidence > 0
      and match_confidence < 1
    )
    or (
      link_status = 'ambiguous'
      and account_id is null
      and link_method <> 'none'
      and match_quality = 'ambiguous'
    )
    or (
      link_status = 'unlinked'
      and account_id is null
      and link_scope = 'unknown'
      and link_method = 'none'
      and match_quality = 'unlinked'
      and match_confidence is null
    )
  )
);

create unique index energy_benchmark_link_unresolved_uidx
  on property_context.energy_benchmark_property_link (
    energy_benchmark_id
  )
  where link_status in ('ambiguous', 'unlinked');

create index energy_benchmark_link_account_idx
  on property_context.energy_benchmark_property_link (
    account_id,
    energy_benchmark_id
  )
  where account_id is not null;

create table property_context.beps_compliance (
  beps_compliance_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  source_row_number bigint check (
    source_row_number is null
    or source_row_number > 0
  ),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_building_id text,
  mar_id bigint check (mar_id is null or mar_id > 0),
  premise_address text,
  address_normalized text,
  compliance_cycle text not null,
  compliance_status text,
  compliance_pathway text,
  baseline_year smallint check (
    baseline_year is null
    or baseline_year between 2000 and 2200
  ),
  target_year smallint check (
    target_year is null
    or target_year between 2000 and 2200
  ),
  baseline_metric numeric(18,4),
  target_metric numeric(18,4),
  reported_metric numeric(18,4),
  determination_date date,
  compliance_deadline date,
  penalty_cents bigint check (
    penalty_cents is null
    or penalty_cents >= 0
  ),
  extra_attributes jsonb not null default '{}'::jsonb check (
    jsonb_typeof(extra_attributes) = 'object'
  ),
  ingested_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id),
  check (nullif(btrim(compliance_cycle), '') is not null)
);

create index beps_compliance_building_cycle_idx
  on property_context.beps_compliance (
    source_building_id,
    compliance_cycle
  )
  where source_building_id is not null;

create table property_context.beps_property_link (
  beps_property_link_id bigint generated always as identity primary key,
  source_record_link_id bigint not null unique
    references meta.source_record_link(source_record_link_id)
    on delete cascade,
  beps_compliance_id bigint not null
    references property_context.beps_compliance(beps_compliance_id)
    on delete cascade,
  account_id bigint
    references core.property_account_current(account_id),
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text not null check (
    link_scope in (
      'building',
      'shared_premise',
      'address_only',
      'unknown'
    )
  ),
  link_method text not null check (
    link_method in (
      'mar_crosswalk',
      'unique_exact_address',
      'multiple_ssl_context',
      'spatial_intersection',
      'none'
    )
  ),
  match_quality text not null check (
    match_quality in ('contextual', 'ambiguous', 'unlinked')
  ),
  match_confidence numeric(5,4) check (
    match_confidence is null
    or match_confidence between 0 and 1
  ),
  link_context jsonb not null default '{}'::jsonb check (
    jsonb_typeof(link_context) = 'object'
  ),
  unique (beps_compliance_id, account_id),
  check (
    (
      link_status = 'linked'
      and account_id is not null
      and link_scope in (
        'building',
        'shared_premise',
        'address_only'
      )
      and link_method <> 'none'
      and match_quality = 'contextual'
      and match_confidence > 0
      and match_confidence < 1
    )
    or (
      link_status = 'ambiguous'
      and account_id is null
      and link_method <> 'none'
      and match_quality = 'ambiguous'
    )
    or (
      link_status = 'unlinked'
      and account_id is null
      and link_scope = 'unknown'
      and link_method = 'none'
      and match_quality = 'unlinked'
      and match_confidence is null
    )
  )
);

create unique index beps_property_link_unresolved_uidx
  on property_context.beps_property_link (beps_compliance_id)
  where link_status in ('ambiguous', 'unlinked');

create index beps_property_link_account_idx
  on property_context.beps_property_link (
    account_id,
    beps_compliance_id
  )
  where account_id is not null;

create table property_context.vacant_blighted_status (
  vacant_blighted_status_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  source_row_number bigint check (
    source_row_number is null
    or source_row_number > 0
  ),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  source_record_link_id bigint not null unique
    references meta.source_record_link(source_record_link_id),
  account_id bigint
    references core.property_account_current(account_id),
  ssl_raw text,
  ssl_normalized text,
  mar_id bigint check (mar_id is null or mar_id > 0),
  premise_address text,
  address_normalized text,
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text not null check (
    link_scope in (
      'tax_account',
      'parcel',
      'building',
      'shared_premise',
      'address_only',
      'unknown'
    )
  ),
  link_method text not null check (
    link_method in (
      'exact_ssl',
      'mar_crosswalk',
      'unique_exact_address',
      'multiple_ssl_context',
      'spatial_intersection',
      'none'
    )
  ),
  match_quality text not null check (
    match_quality in (
      'exact',
      'contextual',
      'ambiguous',
      'unlinked'
    )
  ),
  match_confidence numeric(5,4) check (
    match_confidence is null
    or match_confidence between 0 and 1
  ),
  link_context jsonb not null default '{}'::jsonb check (
    jsonb_typeof(link_context) = 'object'
  ),
  classification text not null check (
    classification in (
      'vacant',
      'blighted',
      'vacant_and_blighted',
      'exempt',
      'not_vacant',
      'unknown'
    )
  ),
  source_classification text,
  status text,
  effective_date date,
  expiration_date date,
  exemption_reason text,
  extra_attributes jsonb not null default '{}'::jsonb check (
    jsonb_typeof(extra_attributes) = 'object'
  ),
  ingested_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id),
  check (
    (link_status = 'linked' and account_id is not null)
    or (link_status in ('ambiguous', 'unlinked') and account_id is null)
  ),
  check (
    (link_status = 'linked' and match_quality in ('exact', 'contextual'))
    or (link_status = 'ambiguous' and match_quality = 'ambiguous')
    or (link_status = 'unlinked' and match_quality = 'unlinked')
  ),
  check (
    match_quality <> 'exact'
    or (
      link_scope in ('tax_account', 'parcel')
      and link_method in (
        'exact_ssl',
        'mar_crosswalk',
        'unique_exact_address'
      )
      and match_confidence = 1
    )
  ),
  check (
    match_quality <> 'contextual'
    or (
      link_scope in (
        'building',
        'shared_premise',
        'address_only'
      )
      and link_method in (
        'mar_crosswalk',
        'unique_exact_address',
        'multiple_ssl_context',
        'spatial_intersection'
      )
      and match_confidence > 0
      and match_confidence < 1
    )
  ),
  check (
    link_status <> 'unlinked'
    or (
      link_scope = 'unknown'
      and link_method = 'none'
      and match_confidence is null
    )
  )
);

create index vacant_blighted_status_account_idx
  on property_context.vacant_blighted_status (
    account_id,
    effective_date desc
  )
  where account_id is not null;

create index vacant_blighted_active_idx
  on property_context.vacant_blighted_status (
    classification,
    effective_date desc
  )
  where classification in (
    'vacant',
    'blighted',
    'vacant_and_blighted'
  );

create table property_context.land_designation (
  land_designation_id bigint generated always as identity primary key,
  source_id text not null,
  source_release_id bigint not null,
  source_record_id bigint not null check (source_record_id > 0),
  source_row_number bigint check (
    source_row_number is null
    or source_row_number > 0
  ),
  source_row_sha256 text not null check (
    source_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  designation_system text not null,
  designation_type text not null,
  designation_code text,
  designation_name text,
  designation_status text,
  issuing_authority text,
  effective_date date,
  expiration_date date,
  geometry_source_reference text,
  source_ssl_normalized text,
  source_mar_id bigint check (
    source_mar_id is null
    or source_mar_id > 0
  ),
  source_address text,
  extra_attributes jsonb not null default '{}'::jsonb check (
    jsonb_typeof(extra_attributes) = 'object'
  ),
  ingested_at timestamptz not null default now(),
  unique (source_id, source_record_id),
  foreign key (source_id, source_release_id)
    references meta.source_release(source_id, release_id),
  check (nullif(btrim(designation_system), '') is not null),
  check (nullif(btrim(designation_type), '') is not null)
);

create index land_designation_type_idx
  on property_context.land_designation (
    designation_system,
    designation_type,
    designation_code
  );

create table property_context.land_designation_property_link (
  land_designation_link_id bigint generated always as identity primary key,
  source_record_link_id bigint not null unique
    references meta.source_record_link(source_record_link_id)
    on delete cascade,
  land_designation_id bigint not null
    references property_context.land_designation(land_designation_id)
    on delete cascade,
  account_id bigint
    references core.property_account_current(account_id),
  link_status text not null check (
    link_status in ('linked', 'ambiguous', 'unlinked')
  ),
  link_scope text not null check (
    link_scope in (
      'tax_account',
      'parcel',
      'building',
      'shared_premise',
      'address_only',
      'unknown'
    )
  ),
  link_method text not null check (
    link_method in (
      'exact_ssl',
      'mar_crosswalk',
      'unique_exact_address',
      'multiple_ssl_context',
      'spatial_intersection',
      'none'
    )
  ),
  match_quality text not null check (
    match_quality in (
      'exact',
      'contextual',
      'ambiguous',
      'unlinked'
    )
  ),
  match_confidence numeric(5,4) check (
    match_confidence is null
    or match_confidence between 0 and 1
  ),
  intersection_area_ratio numeric(8,7) check (
    intersection_area_ratio is null
    or intersection_area_ratio between 0 and 1
  ),
  link_context jsonb not null default '{}'::jsonb check (
    jsonb_typeof(link_context) = 'object'
  ),
  unique (land_designation_id, account_id),
  check (
    (link_status = 'linked' and account_id is not null)
    or (link_status in ('ambiguous', 'unlinked') and account_id is null)
  ),
  check (
    (link_status = 'linked' and match_quality in ('exact', 'contextual'))
    or (link_status = 'ambiguous' and match_quality = 'ambiguous')
    or (link_status = 'unlinked' and match_quality = 'unlinked')
  ),
  check (
    match_quality <> 'exact'
    or (
      link_scope in ('tax_account', 'parcel')
      and link_method in (
        'exact_ssl',
        'mar_crosswalk',
        'unique_exact_address'
      )
      and match_confidence = 1
    )
  ),
  check (
    match_quality <> 'contextual'
    or (
      link_scope in (
        'building',
        'shared_premise',
        'address_only'
      )
      and link_method in (
        'mar_crosswalk',
        'unique_exact_address',
        'multiple_ssl_context',
        'spatial_intersection'
      )
      and match_confidence > 0
      and match_confidence < 1
    )
  ),
  check (
    link_status <> 'unlinked'
    or (
      link_scope = 'unknown'
      and link_method = 'none'
      and match_confidence is null
    )
  )
);

create unique index land_designation_link_unresolved_uidx
  on property_context.land_designation_property_link (
    land_designation_id
  )
  where link_status in ('ambiguous', 'unlinked');

create unique index land_designation_link_exact_uidx
  on property_context.land_designation_property_link (
    land_designation_id
  )
  where match_quality = 'exact';

create index land_designation_link_account_idx
  on property_context.land_designation_property_link (
    account_id,
    land_designation_id
  )
  where account_id is not null;

create table core.property_public_record_summary (
  account_id bigint primary key
    references core.property_account_current(account_id)
    on delete cascade,
  source_release_ids bigint[] not null,
  building_permit_count bigint check (
    building_permit_count is null
    or building_permit_count >= 0
  ),
  open_building_permit_count bigint check (
    open_building_permit_count is null
    or open_building_permit_count >= 0
  ),
  latest_building_permit_issue_date date,
  business_license_count bigint check (
    business_license_count is null
    or business_license_count >= 0
  ),
  active_business_license_count bigint check (
    active_business_license_count is null
    or active_business_license_count >= 0
  ),
  latest_business_license_expiration_date date,
  occupancy_permit_count bigint check (
    occupancy_permit_count is null
    or occupancy_permit_count >= 0
  ),
  latest_occupancy_permit_issue_date date,
  inspection_count bigint check (
    inspection_count is null
    or inspection_count >= 0
  ),
  adverse_inspection_count bigint check (
    adverse_inspection_count is null
    or adverse_inspection_count >= 0
  ),
  latest_inspection_date date,
  enforcement_action_count bigint check (
    enforcement_action_count is null
    or enforcement_action_count >= 0
  ),
  open_enforcement_action_count bigint check (
    open_enforcement_action_count is null
    or open_enforcement_action_count >= 0
  ),
  latest_enforcement_action_date date,
  cama_building_profile_count bigint check (
    cama_building_profile_count is null
    or cama_building_profile_count >= 0
  ),
  latest_energy_benchmark_year smallint check (
    latest_energy_benchmark_year is null
    or latest_energy_benchmark_year between 2000 and 2200
  ),
  latest_energy_star_score smallint check (
    latest_energy_star_score is null
    or latest_energy_star_score between 0 and 100
  ),
  beps_compliance_status text,
  vacant_blighted_classification text check (
    vacant_blighted_classification is null
    or vacant_blighted_classification in (
      'vacant',
      'blighted',
      'vacant_and_blighted',
      'exempt',
      'not_vacant',
      'unknown'
    )
  ),
  land_designation_count bigint check (
    land_designation_count is null
    or land_designation_count >= 0
  ),
  land_designation_codes text[] not null default '{}'::text[],
  data_as_of timestamptz not null,
  summary_row_sha256 text not null check (
    summary_row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  refreshed_at timestamptz not null default now(),
  check (cardinality(source_release_ids) > 0),
  check (
    coalesce(building_permit_count, 0)
    + coalesce(business_license_count, 0)
    + coalesce(occupancy_permit_count, 0)
    + coalesce(inspection_count, 0)
    + coalesce(enforcement_action_count, 0)
    + coalesce(cama_building_profile_count, 0)
    + coalesce(land_designation_count, 0) > 0
    or latest_energy_benchmark_year is not null
    or beps_compliance_status is not null
    or vacant_blighted_classification is not null
  ),
  check (
    open_building_permit_count is null
    or building_permit_count is null
    or open_building_permit_count <= building_permit_count
  ),
  check (
    active_business_license_count is null
    or business_license_count is null
    or active_business_license_count <= business_license_count
  ),
  check (
    adverse_inspection_count is null
    or inspection_count is null
    or adverse_inspection_count <= inspection_count
  ),
  check (
    open_enforcement_action_count is null
    or enforcement_action_count is null
    or open_enforcement_action_count <= enforcement_action_count
  )
);

create index property_public_record_open_enforcement_idx
  on core.property_public_record_summary (
    open_enforcement_action_count desc,
    account_id
  )
  where open_enforcement_action_count > 0;

create index property_public_record_vacancy_idx
  on core.property_public_record_summary (
    vacant_blighted_classification,
    account_id
  )
  where vacant_blighted_classification in (
    'vacant',
    'blighted',
    'vacant_and_blighted'
  );

alter table meta.source_release enable row level security;
alter table meta.source_release_pointer enable row level security;
alter table meta.ingest_quality_result enable row level security;
alter table meta.source_record_link enable row level security;
alter table regulatory.record enable row level security;
alter table regulatory.property_link enable row level security;
alter table regulatory.building_permit enable row level security;
alter table regulatory.business_license enable row level security;
alter table regulatory.certificate_of_occupancy enable row level security;
alter table regulatory.inspection enable row level security;
alter table regulatory.enforcement_action enable row level security;
alter table property_context.cama_building_profile
  enable row level security;
alter table property_context.energy_benchmark enable row level security;
alter table property_context.energy_benchmark_property_link
  enable row level security;
alter table property_context.beps_compliance enable row level security;
alter table property_context.beps_property_link enable row level security;
alter table property_context.vacant_blighted_status
  enable row level security;
alter table property_context.land_designation enable row level security;
alter table property_context.land_designation_property_link
  enable row level security;
alter table core.property_public_record_summary
  enable row level security;

do $block$
declare
  v_relation regclass;
begin
  foreach v_relation in array array[
    'meta.source_release'::regclass,
    'meta.source_release_pointer'::regclass,
    'meta.ingest_quality_result'::regclass,
    'meta.source_record_link'::regclass,
    'regulatory.record'::regclass,
    'regulatory.property_link'::regclass,
    'regulatory.building_permit'::regclass,
    'regulatory.business_license'::regclass,
    'regulatory.certificate_of_occupancy'::regclass,
    'regulatory.inspection'::regclass,
    'regulatory.enforcement_action'::regclass,
    'property_context.cama_building_profile'::regclass,
    'property_context.energy_benchmark'::regclass,
    'property_context.energy_benchmark_property_link'::regclass,
    'property_context.beps_compliance'::regclass,
    'property_context.beps_property_link'::regclass,
    'property_context.vacant_blighted_status'::regclass,
    'property_context.land_designation'::regclass,
    'property_context.land_designation_property_link'::regclass,
    'core.property_public_record_summary'::regclass
  ]
  loop
    execute format(
      'create policy api_owner_read on %s for select to api_owner using (true)',
      v_relation
    );
  end loop;
end;
$block$;

revoke all on meta.source_release from public, mcp_runtime;
revoke all on meta.source_release_pointer
  from public, mcp_runtime;
revoke all on meta.ingest_quality_result
  from public, mcp_runtime;
revoke all on meta.source_record_link
  from public, mcp_runtime;
revoke all on all tables in schema regulatory
  from public, mcp_runtime;
revoke all on all tables in schema property_context
  from public, mcp_runtime;
revoke all on core.property_public_record_summary
  from public, mcp_runtime;
revoke all on all sequences in schema meta
  from public, mcp_runtime;
revoke all on all sequences in schema regulatory
  from public, mcp_runtime;
revoke all on all sequences in schema property_context
  from public, mcp_runtime;

grant select on meta.source_release to api_owner;
grant select on meta.source_release_pointer to api_owner;
grant select on meta.ingest_quality_result to api_owner;
grant select on meta.source_record_link to api_owner;
grant select on all tables in schema regulatory to api_owner;
grant select on all tables in schema property_context to api_owner;
grant select on core.property_public_record_summary to api_owner;

alter default privileges in schema regulatory
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema property_context
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema meta
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema regulatory
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema property_context
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema meta
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema regulatory
  grant select on tables to api_owner;
alter default privileges in schema property_context
  grant select on tables to api_owner;
alter default privileges in schema meta
  grant select on tables to api_owner;

set local role data_owner;

alter default privileges in schema regulatory
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema property_context
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema meta
  revoke all on tables from public, mcp_runtime;
alter default privileges in schema regulatory
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema property_context
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema meta
  revoke all on sequences from public, mcp_runtime;
alter default privileges in schema regulatory
  grant select on tables to api_owner;
alter default privileges in schema property_context
  grant select on tables to api_owner;
alter default privileges in schema meta
  grant select on tables to api_owner;

reset role;

comment on table meta.source_release is
  'Content-addressed metadata for an immutable retrieved source snapshot. A published release must have passed quality checks.';
comment on table meta.source_release_pointer is
  'Mutable current/candidate/previous pointers over immutable source releases; pointer changes are ingest-batch attributable.';
comment on table meta.ingest_quality_result is
  'Machine-checkable, batch-scoped ingest quality outcomes with bounded source-record samples.';
comment on table meta.source_record_link is
  'Canonical source-record-to-property registry. exact_property is the only exact scope; shared-building, multi-parcel, and proximity links are contextual.';
comment on table regulatory.record is
  'Source-faithful public regulatory record envelope. Source identifiers are bigint and source rows are content hashed.';
comment on table regulatory.property_link is
  'Auditable regulatory-to-property resolution. Linked does not imply exact: building/shared-premise links remain contextual and may map one source record to multiple tax accounts.';
comment on table property_context.cama_building_profile is
  'Source-faithful CAMA building characteristics; a linked row is allowed only through an exact SSL-to-tax-account match.';
comment on table property_context.energy_benchmark is
  'Annual building-level energy benchmark facts. Tax-account attribution is stored separately and never labeled exact.';
comment on table property_context.beps_compliance is
  'Building Energy Performance Standards compliance facts by source release and compliance cycle.';
comment on table property_context.vacant_blighted_status is
  'Vacant, blighted, exemption, and negative classifications with explicit property-link quality.';
comment on table property_context.land_designation is
  'Extensible official land designation facts; designation systems and types are data, not schema columns.';
comment on table core.property_public_record_summary is
  'Sparse, derived per-account rollup for properties having at least one regulatory or context signal. Null means not summarized, not zero.';

commit;
