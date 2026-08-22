begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quoin-national-production-migration', 0)
);

do $guard$
declare
  v_hash text := pg_catalog.current_setting('quoin.migration_sha256', true);
  v_target text := pg_catalog.current_setting('quoin.migration_target_class', true);
begin
  if pg_catalog.current_database() <> 'dc_property' then
    raise exception 'national migration requires database dc_property'
      using errcode = '55000';
  end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'national migration requires its verified SHA-256 marker'
      using errcode = '55000';
  end if;
  if v_target not in ('rehearsal', 'production') then
    raise exception 'national migration target class must be rehearsal or production'
      using errcode = '55000';
  end if;
  if pg_catalog.to_regnamespace('geo') is not null
     or pg_catalog.to_regclass('meta.production_migration') is not null then
    raise exception 'national foundation is already present; use the migration ledger'
      using errcode = '55000';
  end if;
end;
$guard$;

set local role dc_property_admin;
create extension if not exists pgcrypto with schema extensions;
create schema geo;
revoke all on schema geo from public, mcp_runtime;
grant usage on schema geo to api_owner;

set local role dc_property_admin;

create table meta.production_migration (
  migration_key text primary key check (migration_key ~ '^[a-z0-9][a-z0-9._-]+$'),
  migration_sha256 text not null unique check (migration_sha256 ~ '^[0-9a-f]{64}$'),
  target_class text not null check (target_class in ('rehearsal', 'production')),
  applied_at timestamptz not null default pg_catalog.clock_timestamp(),
  applied_by name not null default session_user
);

create table geo.area (
  area_uid text primary key check (area_uid ~ '^area_[a-z0-9_]+$'),
  area_kind text not null check (
    area_kind in (
      'country', 'state', 'district', 'territory', 'county',
      'county_equivalent', 'independent_city', 'municipality', 'town',
      'tax_district', 'assessment_district'
    )
  ),
  official_name text not null check (nullif(pg_catalog.btrim(official_name), '') is not null),
  country_code text not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  state_code text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (valid_to is null or valid_from is null or valid_from < valid_to)
);

create table geo.area_identifier (
  area_identifier_id bigint generated always as identity primary key,
  area_uid text not null references geo.area(area_uid),
  identifier_authority text not null check (nullif(pg_catalog.btrim(identifier_authority), '') is not null),
  identifier_namespace text not null check (nullif(pg_catalog.btrim(identifier_namespace), '') is not null),
  raw_identifier text not null check (nullif(pg_catalog.btrim(raw_identifier), '') is not null),
  normalization_version text not null check (nullif(pg_catalog.btrim(normalization_version), '') is not null),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (valid_to is null or valid_from is null or valid_from < valid_to),
  unique (
    area_uid, identifier_authority, identifier_namespace, raw_identifier,
    valid_from, valid_to
  )
);

-- ponytail: current-row uniqueness is enough until historical identifier
-- overlaps are first ingested; add a btree_gist exclusion constraint then.
create unique index area_identifier_current_uidx
  on geo.area_identifier (
    identifier_authority, identifier_namespace, raw_identifier
  )
  where valid_to is null;

create index area_identifier_area_idx on geo.area_identifier (area_uid);

create table geo.area_relation (
  area_relation_id bigint generated always as identity primary key,
  child_area_uid text not null references geo.area(area_uid),
  parent_area_uid text not null references geo.area(area_uid),
  relationship_kind text not null check (
    relationship_kind in ('contained_by', 'administered_by', 'overlaps')
  ),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (
    child_area_uid, parent_area_uid, relationship_kind, valid_from, valid_to
  ),
  check (child_area_uid <> parent_area_uid),
  check (valid_to is null or valid_from is null or valid_from < valid_to)
);

create unique index area_relation_current_containment_uidx
  on geo.area_relation (child_area_uid)
  where relationship_kind = 'contained_by' and valid_to is null;

create table meta.issuing_authority (
  authority_uid text primary key check (authority_uid ~ '^auth_[a-z0-9_]+$'),
  authority_kind text not null check (
    authority_kind in (
      'assessor', 'tax_collector', 'recorder', 'planning', 'permitting',
      'licensing', 'state_agency', 'district_agency', 'municipal_agency',
      'other'
    )
  ),
  official_name text not null check (nullif(pg_catalog.btrim(official_name), '') is not null),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (valid_to is null or valid_from is null or valid_from < valid_to)
);

create table meta.authority_scope (
  authority_scope_id bigint generated always as identity primary key,
  authority_uid text not null references meta.issuing_authority(authority_uid),
  area_uid text not null references geo.area(area_uid),
  scope_kind text not null check (
    scope_kind in ('issues_for', 'administers', 'collects_for', 'records_for')
  ),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (authority_uid, area_uid, scope_kind, valid_from, valid_to),
  check (valid_to is null or valid_from is null or valid_from < valid_to)
);

create unique index authority_scope_current_uidx
  on meta.authority_scope (authority_uid, area_uid, scope_kind)
  where valid_to is null;

create table meta.release_generation (
  generation_id bigint generated always as identity primary key,
  scope_area_uid text not null references geo.area(area_uid),
  generation_key text not null check (nullif(pg_catalog.btrim(generation_key), '') is not null),
  generation_status text not null check (
    generation_status in ('staged', 'validated', 'published', 'superseded', 'rejected')
  ),
  contract_version text not null check (contract_version ~ '^national-v[0-9]+$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  data_effective_at timestamptz,
  validated_at timestamptz,
  published_at timestamptz,
  rejected_reason text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (scope_area_uid, generation_key),
  unique (scope_area_uid, manifest_sha256),
  check (generation_status not in ('validated', 'published', 'superseded') or validated_at is not null),
  check (generation_status not in ('published', 'superseded') or published_at is not null),
  check (generation_status <> 'rejected' or nullif(pg_catalog.btrim(rejected_reason), '') is not null)
);

create table meta.generation_source (
  generation_id bigint not null references meta.release_generation(generation_id) on delete cascade,
  release_id bigint not null references meta.source_release(release_id),
  source_purpose text not null check (nullif(pg_catalog.btrim(source_purpose), '') is not null),
  primary key (generation_id, release_id, source_purpose)
);

create table meta.generation_jurisdiction (
  generation_id bigint not null references meta.release_generation(generation_id) on delete cascade,
  area_uid text not null references geo.area(area_uid),
  roster_position integer not null check (roster_position > 0),
  primary key (generation_id, area_uid),
  unique (generation_id, roster_position)
);

create table meta.property_identity (
  property_uid text primary key check (property_uid ~ '^qprop_[0-9a-f]{64}$'),
  first_seen_generation_id bigint not null references meta.release_generation(generation_id),
  identity_status text not null default 'active' check (
    identity_status in ('active', 'retired', 'merged', 'split')
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table meta.property_identifier (
  property_identifier_id bigint generated always as identity primary key,
  property_uid text not null references meta.property_identity(property_uid),
  authority_uid text not null references meta.issuing_authority(authority_uid),
  identifier_namespace text not null check (nullif(pg_catalog.btrim(identifier_namespace), '') is not null),
  raw_identifier text not null check (nullif(pg_catalog.btrim(raw_identifier), '') is not null),
  normalized_identifier text not null check (nullif(pg_catalog.btrim(normalized_identifier), '') is not null),
  normalization_version text not null check (nullif(pg_catalog.btrim(normalization_version), '') is not null),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (valid_to is null or valid_from is null or valid_from < valid_to),
  unique (
    authority_uid, identifier_namespace, normalized_identifier,
    valid_from, valid_to
  )
);

create unique index property_identifier_current_uidx
  on meta.property_identifier (
    authority_uid, identifier_namespace, normalized_identifier
  )
  where valid_to is null;

create index property_identifier_property_idx
  on meta.property_identifier (property_uid);

create table meta.generation_property (
  generation_id bigint not null references meta.release_generation(generation_id) on delete cascade,
  property_uid text not null references meta.property_identity(property_uid),
  jurisdiction_area_uid text not null references geo.area(area_uid),
  source_account_id bigint references core.property_account_current(account_id),
  membership_status text not null default 'active' check (
    membership_status in ('active', 'retired')
  ),
  primary key (generation_id, property_uid),
  unique (generation_id, source_account_id),
  foreign key (generation_id, jurisdiction_area_uid)
    references meta.generation_jurisdiction(generation_id, area_uid)
);

create index generation_property_jurisdiction_idx
  on meta.generation_property (generation_id, jurisdiction_area_uid, property_uid);

create table meta.generation_coverage (
  generation_id bigint not null references meta.release_generation(generation_id) on delete cascade,
  area_uid text not null references geo.area(area_uid),
  domain_key text not null check (domain_key ~ '^[a-z][a-z0-9_]*$'),
  property_class text not null default 'all' check (property_class ~ '^[a-z][a-z0-9_]*$'),
  availability_status text not null check (
    availability_status in ('available', 'unavailable', 'coming_soon', 'restricted')
  ),
  availability_reason text,
  observed_record_count bigint not null default 0 check (observed_record_count >= 0),
  primary key (generation_id, area_uid, domain_key, property_class),
  foreign key (generation_id, area_uid)
    references meta.generation_jurisdiction(generation_id, area_uid),
  check (
    availability_status = 'available'
    or nullif(pg_catalog.btrim(availability_reason), '') is not null
  )
);

create table meta.publication_set (
  publication_set_id bigint generated always as identity primary key,
  contract_version text not null check (contract_version ~ '^national-v[0-9]+$'),
  publication_sha256 text not null unique check (publication_sha256 ~ '^[0-9a-f]{64}$'),
  publication_status text not null check (
    publication_status in ('draft', 'active', 'superseded')
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  activated_at timestamptz,
  check (publication_status <> 'active' or activated_at is not null)
);

create table meta.publication_set_member (
  publication_set_id bigint not null references meta.publication_set(publication_set_id) on delete cascade,
  area_uid text not null references geo.area(area_uid),
  generation_id bigint references meta.release_generation(generation_id),
  availability_status text not null check (
    availability_status in ('available', 'unavailable', 'coming_soon', 'restricted')
  ),
  availability_reason text,
  primary key (publication_set_id, area_uid),
  check ((availability_status = 'available') = (generation_id is not null)),
  check (
    availability_status = 'available'
    or nullif(pg_catalog.btrim(availability_reason), '') is not null
  )
);

create table meta.publication_set_pointer (
  pointer_name text primary key check (pointer_name ~ '^national-v[0-9]+$'),
  publication_set_id bigint not null unique references meta.publication_set(publication_set_id),
  set_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table meta.legacy_dc_binding (
  generation_id bigint primary key references meta.release_generation(generation_id) on delete cascade,
  property_account_count bigint not null check (property_account_count >= 0),
  active_property_count bigint not null check (active_property_count >= 0),
  pointer_binding_sha256 text not null check (pointer_binding_sha256 ~ '^[0-9a-f]{64}$'),
  gate2_report_sha256 text not null check (gate2_report_sha256 ~ '^[0-9a-f]{64}$'),
  bound_at timestamptz not null default pg_catalog.clock_timestamp()
);

create or replace function meta.require_national_publication_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $function$
begin
  if current_setting('quoin.national_publication_approval', true)
     is distinct from
       'NATIONAL_PUBLICATION_APPROVED:' || txid_current()::text then
    raise exception 'national publication writes require transaction-local approval'
      using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create trigger require_national_publication_approval
before insert or update or delete on meta.publication_set
for each row execute function meta.require_national_publication_approval();

create trigger require_national_publication_approval
before insert or update or delete on meta.publication_set_member
for each row execute function meta.require_national_publication_approval();

create trigger require_national_publication_approval
before insert or update or delete on meta.publication_set_pointer
for each row execute function meta.require_national_publication_approval();

select pg_catalog.set_config(
  'quoin.national_publication_approval',
  'NATIONAL_PUBLICATION_APPROVED:' || pg_catalog.txid_current()::text,
  true
);

insert into geo.area (area_uid, area_kind, official_name, country_code)
values ('area_us', 'country', 'United States', 'US');

insert into geo.area (
  area_uid, area_kind, official_name, country_code, state_code
)
values (
  'area_us_dc', 'district', 'District of Columbia', 'US', 'DC'
);

insert into geo.area_relation (
  child_area_uid, parent_area_uid, relationship_kind, valid_from
)
values ('area_us_dc', 'area_us', 'contained_by', date '1790-07-16');

insert into geo.area_identifier (
  area_uid, identifier_authority, identifier_namespace, raw_identifier,
  normalization_version, valid_from
)
values
  ('area_us', 'ISO', 'ISO_3166_1_ALPHA_2', 'US', 'raw-v1', null),
  ('area_us_dc', 'USPS', 'STATE_ABBREVIATION', 'DC', 'upper-v1', null),
  ('area_us_dc', 'US_CENSUS', 'STATE_FIPS', '11', 'digits-v1', null);

insert into meta.issuing_authority (
  authority_uid, authority_kind, official_name
)
values (
  'auth_us_dc_otr', 'district_agency',
  'District of Columbia Office of Tax and Revenue'
);

insert into meta.authority_scope (
  authority_uid, area_uid, scope_kind
)
values ('auth_us_dc_otr', 'area_us_dc', 'issues_for');

with pointer_binding as (
  select extensions.digest(
    pg_catalog.string_agg(
      p.source_id || '|' || p.pointer_name || '|' || p.release_id::text,
      E'\n' order by p.source_id, p.pointer_name
    ),
    'sha256'
  ) as digest
  from meta.source_release_pointer p
), inserted_generation as (
  insert into meta.release_generation (
    scope_area_uid, generation_key, generation_status, contract_version,
    manifest_sha256, data_effective_at, validated_at, published_at
  )
  select
    'area_us_dc',
    'dc-legacy-gate2',
    'published',
    'national-v1',
    pg_catalog.encode(digest, 'hex'),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  from pointer_binding
  returning generation_id, manifest_sha256
)
insert into meta.legacy_dc_binding (
  generation_id, property_account_count, active_property_count,
  pointer_binding_sha256, gate2_report_sha256
)
select
  g.generation_id,
  (select pg_catalog.count(*) from core.property_account_current),
  (select pg_catalog.count(*) from core.property_account_current where not is_deleted),
  g.manifest_sha256,
  'f2d7f888014939c66d87bfc77ea89d4687bcd56a8c881d5fcf624919c8705d40'
from inserted_generation g;

insert into meta.generation_source (
  generation_id, release_id, source_purpose
)
select b.generation_id, p.release_id, 'legacy_dc_current_pointer'
from meta.legacy_dc_binding b
cross join meta.source_release_pointer p;

insert into meta.generation_jurisdiction (
  generation_id, area_uid, roster_position
)
select generation_id, 'area_us_dc', 1
from meta.legacy_dc_binding;

insert into meta.property_identity (
  property_uid, first_seen_generation_id
)
select
  'qprop_' || pg_catalog.encode(
    extensions.digest(
      'US|DC|OTR|SSL|' || p.ssl_normalized,
      'sha256'
    ),
    'hex'
  ),
  b.generation_id
from core.property_account_current p
cross join meta.legacy_dc_binding b
where not p.is_deleted;

insert into meta.property_identifier (
  property_uid, authority_uid, identifier_namespace, raw_identifier,
  normalized_identifier, normalization_version
)
select
  'qprop_' || pg_catalog.encode(
    extensions.digest(
      'US|DC|OTR|SSL|' || p.ssl_normalized,
      'sha256'
    ),
    'hex'
  ),
  'auth_us_dc_otr',
  'ssl',
  p.ssl_display,
  p.ssl_normalized,
  'dc-ssl-v1'
from core.property_account_current p
where not p.is_deleted;

insert into meta.generation_property (
  generation_id, property_uid, jurisdiction_area_uid, source_account_id
)
select
  b.generation_id,
  'qprop_' || pg_catalog.encode(
    extensions.digest(
      'US|DC|OTR|SSL|' || p.ssl_normalized,
      'sha256'
    ),
    'hex'
  ),
  'area_us_dc',
  p.account_id
from core.property_account_current p
cross join meta.legacy_dc_binding b
where not p.is_deleted;

insert into meta.generation_coverage (
  generation_id, area_uid, domain_key, property_class,
  availability_status, observed_record_count
)
select
  generation_id, 'area_us_dc', 'property_record', 'all',
  'available', active_property_count
from meta.legacy_dc_binding;

with member as (
  select
    b.generation_id,
    pg_catalog.encode(
      extensions.digest(
        'national-v1|area_us_dc|' || g.manifest_sha256,
        'sha256'
      ),
      'hex'
    ) as publication_sha256
  from meta.legacy_dc_binding b
  join meta.release_generation g using (generation_id)
), publication as (
  insert into meta.publication_set (
    contract_version, publication_sha256, publication_status, activated_at
  )
  select
    'national-v1', publication_sha256, 'active', pg_catalog.clock_timestamp()
  from member
  returning publication_set_id
), publication_member as (
  insert into meta.publication_set_member (
    publication_set_id, area_uid, generation_id, availability_status
  )
  select p.publication_set_id, 'area_us_dc', m.generation_id, 'available'
  from publication p cross join member m
  returning publication_set_id
)
insert into meta.publication_set_pointer (
  pointer_name, publication_set_id
)
select 'national-v1', publication_set_id
from publication_member;

do $security$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'geo.area'::regclass,
    'geo.area_identifier'::regclass,
    'geo.area_relation'::regclass,
    'meta.issuing_authority'::regclass,
    'meta.authority_scope'::regclass,
    'meta.release_generation'::regclass,
    'meta.generation_source'::regclass,
    'meta.generation_jurisdiction'::regclass,
    'meta.property_identity'::regclass,
    'meta.property_identifier'::regclass,
    'meta.generation_property'::regclass,
    'meta.generation_coverage'::regclass,
    'meta.publication_set'::regclass,
    'meta.publication_set_member'::regclass,
    'meta.publication_set_pointer'::regclass,
    'meta.legacy_dc_binding'::regclass
  ] loop
    execute pg_catalog.format('alter table %s enable row level security', v_table);
    execute pg_catalog.format(
      'create policy api_owner_read on %s for select to api_owner using (true)',
      v_table
    );
    execute pg_catalog.format(
      'create policy dc_property_admin_all on %s for all to dc_property_admin using (true) with check (true)',
      v_table
    );
    execute pg_catalog.format(
      'revoke all on %s from public, mcp_runtime',
      v_table
    );
    execute pg_catalog.format('grant select on %s to api_owner', v_table);
    execute pg_catalog.format(
      'grant select, insert, update, delete on %s to dc_property_admin',
      v_table
    );
  end loop;
end;
$security$;

alter table meta.production_migration enable row level security;
revoke all on meta.production_migration from public, mcp_runtime, api_owner;
create policy dc_property_admin_read on meta.production_migration
  for select to dc_property_admin using (true);
grant select on meta.production_migration to dc_property_admin;

revoke all on all sequences in schema geo from public, mcp_runtime, api_owner;
revoke all on sequence meta.property_identifier_property_identifier_id_seq
  from public, mcp_runtime, api_owner;
revoke all on sequence meta.release_generation_generation_id_seq
  from public, mcp_runtime, api_owner;
revoke all on sequence meta.publication_set_publication_set_id_seq
  from public, mcp_runtime, api_owner;
grant usage, select on all sequences in schema geo to dc_property_admin;
grant usage, select on sequence meta.authority_scope_authority_scope_id_seq
  to dc_property_admin;
grant usage, select on sequence meta.property_identifier_property_identifier_id_seq
  to dc_property_admin;
grant usage, select on sequence meta.release_generation_generation_id_seq
  to dc_property_admin;
grant usage, select on sequence meta.publication_set_publication_set_id_seq
  to dc_property_admin;

insert into meta.production_migration (
  migration_key, migration_sha256, target_class
)
values (
  'national-foundation-v1',
  pg_catalog.current_setting('quoin.migration_sha256'),
  pg_catalog.current_setting('quoin.migration_target_class')
);

grant create on schema meta, geo to data_owner;

do $ownership$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'meta.production_migration'::regclass,
    'geo.area'::regclass,
    'geo.area_identifier'::regclass,
    'geo.area_relation'::regclass,
    'meta.issuing_authority'::regclass,
    'meta.authority_scope'::regclass,
    'meta.release_generation'::regclass,
    'meta.generation_source'::regclass,
    'meta.generation_jurisdiction'::regclass,
    'meta.property_identity'::regclass,
    'meta.property_identifier'::regclass,
    'meta.generation_property'::regclass,
    'meta.generation_coverage'::regclass,
    'meta.publication_set'::regclass,
    'meta.publication_set_member'::regclass,
    'meta.publication_set_pointer'::regclass,
    'meta.legacy_dc_binding'::regclass
  ] loop
    execute pg_catalog.format('alter table %s owner to data_owner', v_table);
  end loop;
end;
$ownership$;

alter function meta.require_national_publication_approval() owner to data_owner;
alter schema geo owner to data_owner;
grant usage on schema meta to data_owner;
set local role data_owner;

grant usage on schema geo to dc_property_admin;

do $admin_grants$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'geo.area'::regclass,
    'geo.area_identifier'::regclass,
    'geo.area_relation'::regclass,
    'meta.issuing_authority'::regclass,
    'meta.authority_scope'::regclass,
    'meta.release_generation'::regclass,
    'meta.generation_source'::regclass,
    'meta.generation_jurisdiction'::regclass,
    'meta.property_identity'::regclass,
    'meta.property_identifier'::regclass,
    'meta.generation_property'::regclass,
    'meta.generation_coverage'::regclass,
    'meta.publication_set'::regclass,
    'meta.publication_set_member'::regclass,
    'meta.publication_set_pointer'::regclass,
    'meta.legacy_dc_binding'::regclass
  ] loop
    execute pg_catalog.format(
      'grant select, insert, update, delete on %s to dc_property_admin',
      v_table
    );
  end loop;
end;
$admin_grants$;

grant select on meta.production_migration to dc_property_admin;
grant usage, select on all sequences in schema geo to dc_property_admin;
grant usage, select on sequence meta.authority_scope_authority_scope_id_seq
  to dc_property_admin;
grant usage, select on sequence meta.property_identifier_property_identifier_id_seq
  to dc_property_admin;
grant usage, select on sequence meta.release_generation_generation_id_seq
  to dc_property_admin;
grant usage, select on sequence meta.publication_set_publication_set_id_seq
  to dc_property_admin;

reset role;
set local role dc_property_admin;
revoke create, usage on schema meta from data_owner;

reset role;
set local role api_owner;

create or replace function api_v1.list_national_jurisdictions(
  p_state_code text default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, geo, meta
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'area_uid', a.area_uid,
        'name', a.official_name,
        'area_kind', a.area_kind,
        'country_code', a.country_code,
        'state_code', a.state_code,
        'availability', m.availability_status,
        'reason', m.availability_reason,
        'contract_version', p.contract_version
      ) order by a.state_code nulls first, a.official_name, a.area_uid
    ),
    '[]'::jsonb
  )
  from meta.publication_set_pointer pp
  join meta.publication_set p
    on p.publication_set_id = pp.publication_set_id
   and p.publication_status = 'active'
  join meta.publication_set_member m
    on m.publication_set_id = p.publication_set_id
  join geo.area a on a.area_uid = m.area_uid
  where pp.pointer_name = 'national-v1'
    and (p_state_code is null or a.state_code = upper(btrim(p_state_code)));
$function$;

create or replace function api_v1.get_national_jurisdiction_availability(
  p_state_code text,
  p_area_uid text default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, geo, meta
as $function$
  select coalesce(
    (
      select jsonb_build_object(
        'area_uid', a.area_uid,
        'name', a.official_name,
        'area_kind', a.area_kind,
        'state_code', a.state_code,
        'availability', m.availability_status,
        'reason', m.availability_reason,
        'contract_version', p.contract_version
      )
      from meta.publication_set_pointer pp
      join meta.publication_set p
        on p.publication_set_id = pp.publication_set_id
       and p.publication_status = 'active'
      join meta.publication_set_member m
        on m.publication_set_id = p.publication_set_id
      join geo.area a on a.area_uid = m.area_uid
      where pp.pointer_name = 'national-v1'
        and a.state_code = upper(btrim(p_state_code))
        and (p_area_uid is null or a.area_uid = p_area_uid)
      order by a.area_uid
      limit 1
    ),
    jsonb_build_object(
      'area_uid', p_area_uid,
      'state_code', upper(btrim(p_state_code)),
      'availability', 'unavailable',
      'reason', 'No public property records are available for this jurisdiction yet.',
      'contract_version', 'national-v1'
    )
  );
$function$;

revoke all on function api_v1.list_national_jurisdictions(text) from public;
revoke all on function api_v1.get_national_jurisdiction_availability(text, text) from public;
grant execute on function api_v1.list_national_jurisdictions(text) to mcp_runtime;
grant execute on function api_v1.get_national_jurisdiction_availability(text, text) to mcp_runtime;

reset role;

commit;
