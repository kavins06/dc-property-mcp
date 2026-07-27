begin;

set local role api_owner;
drop function if exists api_v1.resolve_property(text, text, boolean, integer);
drop function if exists api_v1.get_property_snapshot(text, text);
drop function if exists api_v1.get_assessment_history(text, text);
drop function if exists api_v1.get_tax_and_balance_history(text, text);
drop function if exists api_v1.get_ownership_and_sale(text, text);
drop function if exists api_v1.search_properties(jsonb);
reset role;

alter table core.property_account_current
  drop column if exists raw_objectid,
  drop column if exists raw_internalid,
  drop column if exists ssl_raw,
  drop column if exists square,
  drop column if exists suffix,
  drop column if exists lot,
  alter column land_area type integer using land_area::integer,
  alter column prior_land_value type integer using prior_land_value::integer,
  alter column prior_improvement_value type integer using prior_improvement_value::integer,
  alter column prior_total_value type integer using prior_total_value::integer,
  alter column current_land_value type integer using current_land_value::integer,
  alter column current_improvement_value type integer using current_improvement_value::integer,
  alter column current_total_value type integer using current_total_value::integer,
  alter column proposed_improvement_value type integer using proposed_improvement_value::integer,
  alter column cap_current_value type integer using cap_current_value::integer;

alter table meta.snapshot_record_link
  drop constraint if exists snapshot_record_link_assessment_record_id_fkey;

alter table history.assessment_snapshot_record
  drop column if exists ssl_raw,
  drop column if exists source_internalid,
  drop column if exists source_objectid,
  drop column if exists source_globalid,
  alter column assessment_record_id type integer using assessment_record_id::integer,
  alter column prior_land_value type integer using prior_land_value::integer,
  alter column prior_improvement_value type integer using prior_improvement_value::integer,
  alter column prior_total_value type integer using prior_total_value::integer,
  alter column current_land_value type integer using current_land_value::integer,
  alter column current_improvement_value type integer using current_improvement_value::integer,
  alter column current_total_value type integer using current_total_value::integer,
  alter column proposed_improvement_value type integer using proposed_improvement_value::integer;

alter table meta.snapshot_record_link
  alter column assessment_record_id type integer using assessment_record_id::integer,
  add constraint snapshot_record_link_assessment_record_id_fkey
    foreign key (assessment_record_id)
    references history.assessment_snapshot_record
    on delete cascade;

analyze core.property_account_current;
analyze history.assessment_snapshot_record;
analyze meta.snapshot_record_link;

commit;
