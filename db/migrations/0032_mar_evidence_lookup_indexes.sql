begin;

create index if not exists mar_address_ssl_source_record_idx
  on core.mar_address_ssl_current (
    source_id, source_release_id, source_record_id
  );

create index if not exists mar_unit_source_record_idx
  on core.mar_residential_unit_current (
    source_id, source_release_id, source_record_id
  );

commit;
