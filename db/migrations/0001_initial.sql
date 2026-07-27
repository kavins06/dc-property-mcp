begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists meta;
create schema if not exists core;
create schema if not exists history;
create schema if not exists semantic;
create schema if not exists api_v1;

revoke all on schema public from public;
revoke create on schema public from public;

create table if not exists meta.source_asset (
  source_id text primary key,
  publisher text not null,
  dataset_name text not null,
  source_class text not null check (
    source_class in ('live_official','official_snapshot','archived_official_snapshot')
  ),
  official_landing_url text,
  official_download_url text,
  r2_object_key text,
  bytes bigint not null check (bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer not null check (row_count >= 0),
  archive_capture_at timestamptz,
  dataset_retrieved_at timestamptz,
  extract_date_min date,
  extract_date_max date,
  limitations text
);

create table if not exists meta.ingest_batch (
  batch_id bigint generated always as identity primary key,
  status text not null check (status in ('loading','validated','published','rejected')),
  input_manifest_sha256 text not null,
  etl_version text not null,
  migration_version text not null,
  started_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  validation_report_key text,
  database_size_bytes bigint
);

create table if not exists meta.verification_route (
  route_id bigint generated always as identity primary key,
  source_id text not null references meta.source_asset,
  priority smallint not null,
  route_kind text not null check (
    route_kind in (
      'direct_official_record','direct_official_document','official_search',
      'official_dataset','archived_official_snapshot','vendor_public_records'
    )
  ),
  url_template text not null,
  allowed_fields text[],
  required_lookup_keys text[] not null default '{}',
  instructions text[],
  stable boolean not null,
  requires_session boolean not null default false,
  last_tested_at timestamptz,
  last_test_status text
);

create table if not exists core.property_account_current (
  account_id bigint primary key,
  source_id text not null references meta.source_asset,
  source_row_number integer not null,
  raw_objectid text,
  raw_internalid text,
  ssl_raw text not null,
  ssl_normalized text not null,
  ssl_display text not null,
  square text,
  suffix text,
  lot text,
  predecessor_ssl text,
  parent_lot text,
  is_deleted boolean not null default false,
  premise_address text,
  address_normalized text,
  unit_number text,
  ward text,
  neighborhood_code text,
  neighborhood_name text,
  sub_neighborhood text,
  property_type text,
  tri_group text,
  use_code text,
  tax_class text,
  tax_rate numeric(10,6),
  land_area bigint,
  owner_name text,
  owner_name_2 text,
  care_of_name text,
  mailing_address_1 text,
  mailing_address_2 text,
  mailing_city_state_zip text,
  owner_occupancy_flag text,
  mortgage_company_source_label text,
  homestead_code text,
  mixed_use_flag text,
  cooperative_units integer,
  prior_land_value bigint,
  prior_improvement_value bigint,
  prior_total_value bigint,
  current_land_value bigint,
  current_improvement_value bigint,
  current_total_value bigint,
  proposed_land_value bigint,
  proposed_improvement_value bigint,
  proposed_total_value bigint,
  cap_current_value bigint,
  cap_proposed_value bigint,
  annual_tax_cents bigint,
  total_due_cents bigint,
  total_collected_cents bigint,
  total_balance_cents bigint,
  last_payment_date date,
  bid_name text,
  bid_total_due_cents bigint,
  bid_collected_cents bigint,
  bid_balance_cents bigint,
  sews_total_due_cents bigint,
  sews_collected_cents bigint,
  sews_balance_cents bigint,
  pace_total_due_cents bigint,
  pace_collected_cents bigint,
  pace_balance_cents bigint,
  swwsad_total_due_cents bigint,
  swwsad_collected_cents bigint,
  swwsad_balance_cents bigint,
  latest_sale_price_dollars bigint,
  latest_sale_date date,
  latest_sale_type text,
  latest_sale_acceptance_code text,
  latest_deed_date date,
  latest_instrument_number text,
  record_extract_at date,
  unique (ssl_normalized)
);

create table if not exists history.assessment_snapshot_record (
  assessment_record_id bigint primary key,
  source_id text not null references meta.source_asset,
  source_row_number integer not null,
  account_id bigint references core.property_account_current,
  ssl_raw text,
  ssl_normalized text,
  source_internalid text,
  source_objectid text,
  source_globalid text,
  record_extract_at date,
  archive_capture_at timestamptz,
  dataset_retrieved_at timestamptz,
  prior_tax_year smallint,
  prior_land_value bigint,
  prior_improvement_value bigint,
  prior_total_value bigint,
  current_tax_year smallint,
  current_land_value bigint,
  current_improvement_value bigint,
  current_total_value bigint,
  proposed_tax_year smallint,
  proposed_land_value bigint,
  proposed_improvement_value bigint,
  proposed_total_value bigint
);

create table if not exists meta.snapshot_record_link (
  assessment_record_id bigint primary key
    references history.assessment_snapshot_record on delete cascade,
  account_id bigint references core.property_account_current,
  link_status text not null check (link_status in ('exact','inferred','ambiguous','unlinked')),
  link_method text not null,
  confidence numeric(5,4),
  conflict_detail jsonb
);

create table if not exists history.tax_series (
  account_id bigint primary key references core.property_account_current,
  source_id text not null references meta.source_asset,
  source_row_number integer not null,
  record_extract_at date,
  slot_codes text[] not null,
  tax_years smallint[] not null,
  tax_sale_flags text[] not null,
  tax_cents bigint[] not null,
  penalty_cents bigint[] not null,
  interest_cents bigint[] not null,
  fee_cents bigint[] not null,
  total_due_cents bigint[] not null,
  collected_cents bigint[] not null,
  balance_cents bigint[] not null,
  credit_cents bigint[] not null,
  check (
    cardinality(slot_codes) = cardinality(tax_years)
    and cardinality(slot_codes) = cardinality(tax_sale_flags)
    and cardinality(slot_codes) = cardinality(tax_cents)
    and cardinality(slot_codes) = cardinality(penalty_cents)
    and cardinality(slot_codes) = cardinality(interest_cents)
    and cardinality(slot_codes) = cardinality(fee_cents)
    and cardinality(slot_codes) = cardinality(total_due_cents)
    and cardinality(slot_codes) = cardinality(collected_cents)
    and cardinality(slot_codes) = cardinality(balance_cents)
    and cardinality(slot_codes) = cardinality(credit_cents)
  )
);

create table if not exists semantic.field_definition (
  field_key text primary key,
  json_path text not null,
  title text not null,
  definition text not null,
  entity_name text not null,
  data_type text not null,
  unit text,
  time_grain text,
  source_fields text[] not null,
  lender_synonyms text[] not null default '{}',
  commonly_confused_with text[] not null default '{}',
  null_semantics text not null,
  aggregation_rule text,
  caveat text,
  definition_status text not null check (
    definition_status in ('official','source_label_only','derived')
  ),
  formula_version text,
  exposure_allowed boolean not null default true,
  search_filter_allowed boolean not null default false
);

create table if not exists semantic.coverage (
  coverage_key text primary key,
  entity_name text not null,
  tax_year smallint,
  stage text,
  availability_status text not null,
  source_id text references meta.source_asset,
  caveat text
);

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
          'account_id', q.account_id,
          'ssl', q.ssl_display,
          'address', q.premise_address,
          'unit', q.unit_number,
          'record_extract_at', q.record_extract_at
        )
        order by q.rank_score desc, q.account_id
      ),
      '[]'::jsonb
    )
  )
  from (
    select a.*, case
      when p_ssl is not null and a.ssl_normalized =
        upper(replace(replace(replace(trim(p_ssl), '-', ''), ' ', ''), E'\t', ''))
        then 1.0
      when p_address is not null and a.address_normalized =
        upper(regexp_replace(regexp_replace(trim(p_address), '[^A-Za-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'))
        then 0.95
      else extensions.similarity(
        a.address_normalized,
        upper(regexp_replace(regexp_replace(coalesce(trim(p_address), ''), '[^A-Za-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'))
      )
    end as rank_score
    from core.property_account_current a
    where (p_include_deleted or not a.is_deleted)
      and (
        (p_ssl is not null and a.ssl_normalized =
          upper(replace(replace(replace(trim(p_ssl), '-', ''), ' ', ''), E'\t', '')))
        or
        (p_address is not null and a.address_normalized operator(extensions.%)
          upper(regexp_replace(regexp_replace(trim(p_address), '[^A-Za-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g')))
      )
    order by rank_score desc, a.account_id
    limit least(greatest(p_limit, 1), 10)
  ) q;
$$;

revoke all on all tables in schema meta, core, history, semantic from public;
revoke all on all functions in schema api_v1 from public;

comment on table core.property_account_current is
  'Current D.C. property-tax accounts. An account is not guaranteed to be one physical parcel.';
comment on table history.assessment_snapshot_record is
  'One source record per raw ITSPE snapshot, preserving historical duplicates and conflicts.';
comment on table history.tax_series is
  'Tax source slots preserved without unsupported annual aggregation.';

commit;
