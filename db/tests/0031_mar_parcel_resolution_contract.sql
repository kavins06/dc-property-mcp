begin;

do $contract$
declare
  v_accounts bigint[];
  v_ssls text[];
  v_sorted_ssls text[];
  v_address_release bigint;
  v_xref_release bigint;
  v_unit_release bigint;
  v_payload jsonb;
  v_evidence jsonb;
  v_ref text;
  v_mar_id bigint := 990000000001;
begin
  select array_agg(account_id order by account_id),
         array_agg(ssl_normalized order by account_id)
  into v_accounts, v_ssls
  from (
    select account_id, ssl_normalized
    from core.property_account_current
    where not is_deleted and ssl_normalized ~ '^[0-9]{8}$'
    order by account_id
    limit 2
  ) accounts;

  if cardinality(v_accounts) <> 2 then
    raise exception 'MAR contract requires two current numeric SSL fixtures';
  end if;
  select array_agg(value order by value)
  into v_sorted_ssls
  from unnest(v_ssls || array['99999999']) value;

  insert into meta.source_release (
    source_id, release_key, release_status, quality_status,
    snapshot_retrieved_at, archive_object_key, content_type,
    bytes, row_count, sha256, schema_sha256, published_at
  ) values
    ('mar_address_current', 'contract-address', 'published', 'passed',
     now(), 'contract/address', 'application/gzip', 1, 1,
     repeat('a', 64), repeat('1', 64), now())
  returning release_id into v_address_release;

  insert into meta.source_release (
    source_id, release_key, release_status, quality_status,
    snapshot_retrieved_at, archive_object_key, content_type,
    bytes, row_count, sha256, schema_sha256, published_at
  ) values
    ('mar_address_ssl_current', 'contract-xref', 'published', 'passed',
     now(), 'contract/xref', 'application/gzip', 1, 3,
     repeat('b', 64), repeat('2', 64), now())
  returning release_id into v_xref_release;

  insert into meta.source_release (
    source_id, release_key, release_status, quality_status,
    snapshot_retrieved_at, archive_object_key, content_type,
    bytes, row_count, sha256, schema_sha256, published_at
  ) values
    ('mar_residential_unit_current', 'contract-unit', 'published', 'passed',
     now(), 'contract/unit', 'application/gzip', 1, 1,
     repeat('c', 64), repeat('3', 64), now())
  returning release_id into v_unit_release;

  insert into meta.source_release_pointer (
    source_id, pointer_name, release_id
  ) values
    ('mar_address_current', 'current', v_address_release),
    ('mar_address_ssl_current', 'current', v_xref_release),
    ('mar_residential_unit_current', 'current', v_unit_release);

  insert into core.mar_address_current (
    mar_id, address_source_value, address_normalized, status,
    base_ssl_normalized, source_id, source_release_id,
    source_record_id, source_row_sha256
  ) values (
    v_mar_id, '99999 TEST STREET NW', '99999 TEST ST NW', 'ACTIVE',
    v_ssls[1], 'mar_address_current', v_address_release,
    990000000011, repeat('d', 64)
  );

  insert into core.mar_address_ssl_current (
    mar_id, ssl_normalized, square, lot, lot_type,
    source_id, source_release_id, source_record_id, source_row_sha256
  ) values
    (v_mar_id, v_ssls[1], substring(v_ssls[1], 1, 4),
     substring(v_ssls[1], 5, 4), 'TAX LOT',
     'mar_address_ssl_current', v_xref_release, 990000000021, repeat('e', 64)),
    (v_mar_id, v_ssls[2], substring(v_ssls[2], 1, 4),
     substring(v_ssls[2], 5, 4), 'CONDO',
     'mar_address_ssl_current', v_xref_release, 990000000022, repeat('f', 64)),
    (v_mar_id, '99999999', '9999', '9999', 'PARCEL',
     'mar_address_ssl_current', v_xref_release, 990000000023, repeat('0', 64));

  insert into core.mar_residential_unit_current (
    unit_id, mar_id, full_address, full_address_normalized,
    primary_address, unit_number, unit_type, condo_ssl_normalized,
    status, source_id, source_release_id, source_record_id,
    source_row_sha256
  ) values (
    990000000031, v_mar_id, '99999 TEST STREET NW UNIT 4',
    '99999 TEST ST NW 4', '99999 TEST STREET NW', '4', 'CONDO',
    v_ssls[2], 'ACTIVE', 'mar_residential_unit_current',
    v_unit_release, 990000000031, repeat('4', 64)
  );

  select api_v1.resolve_property(
    null, '99999 TEST STREET NW', false, 10, 0, 2
  ) into v_payload;
  if v_payload->>'status' <> 'ambiguous'
     or v_payload->>'ambiguity_reason' <> 'multiple_official_parcels'
     or (v_payload#>>'{parcel_resolution,total_count}')::integer <> 3
     or jsonb_array_length(v_payload#>'{parcel_resolution,parcels}') <> 2
     or (v_payload#>>'{parcel_resolution,has_more}')::boolean is not true then
    raise exception 'multi-parcel address contract failed: %', v_payload;
  end if;

  select api_v1.resolve_property(
    null, '99999 TEST STREET NW', false, 10, 1, 2
  ) into v_payload;
  if v_payload#>>'{parcel_resolution,parcels,0,ssl_normalized}' <> v_sorted_ssls[2]
     or v_payload#>>'{parcel_resolution,parcels,1,ssl_normalized}' <> v_sorted_ssls[3]
     or (v_payload#>>'{parcel_resolution,has_more}')::boolean is not false then
    raise exception 'stable parcel pagination contract failed: %', v_payload;
  end if;

  select api_v1.resolve_property(
    null, '99999 TEST STREET NW UNIT 4', false, 10, 0, 25
  ) into v_payload;
  if v_payload->>'status' <> 'resolved'
     or v_payload#>>'{candidates,0,ssl}' is null
     or api_v1._normalize_ssl(v_payload#>>'{candidates,0,ssl}') <> v_ssls[2]
     or v_payload#>>'{parcel_resolution,relationship}' <>
       'official_mar_unit_condo_ssl' then
    raise exception 'condominium unit narrowing contract failed: %', v_payload;
  end if;

  select api_v1.resolve_property(
    v_ssls[1], null, false, 10, 0, 25
  ) into v_payload;
  if v_payload->>'status' <> 'resolved'
     or (v_payload#>>'{parcel_resolution,total_count}')::integer <> 1
     or v_payload#>>'{parcel_resolution,parcels,0,ssl_normalized}' <> v_ssls[1] then
    raise exception 'exact SSL parcel contract failed: %', v_payload;
  end if;

  select item#>>'{source_refs,0}'
  into v_ref
  from jsonb_array_elements(v_payload#>'{parcel_resolution,parcels}') item
  limit 1;
  v_evidence := api_v1.get_source_evidence(array[v_ref]);
  if v_evidence->>'status' <> 'ok'
     or v_evidence#>>'{sources,0,link}' not like 'https://%'
     or lower(v_evidence#>>'{sources,0,link}') ~
       '(featureserver|mapserver|/rest/|/api/)' then
    raise exception 'MAR human-source evidence contract failed: %', v_evidence;
  end if;
end;
$contract$;

rollback;
