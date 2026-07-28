begin;

do $contract$
declare
  v_failures text[] := array[]::text[];
  v_token text := substr(
    md5(clock_timestamp()::text || random()::text),
    1,
    12
  );
  v_account_id bigint;
  v_ssl text;
  v_address text;
  v_source text;
  v_release bigint;
  v_current_release bigint;
  v_historical_release bigint;
  v_record bigint;
  v_link bigint;
  v_context_record bigint;
  v_context_link bigint;
  v_payload jsonb;
  v_page_two jsonb;
  v_record_payload jsonb;
  v_ref text;
  v_tampered_ref text;
  v_expected_binding text;
  v_evidence jsonb;
  v_describe jsonb;
  v_sources text[];
  v_refs text[];
  v_patterns text[];
  v_url text;
  v_i integer;
begin
  select
    a.account_id,
    a.ssl_normalized,
    a.premise_address
  into v_account_id, v_ssl, v_address
  from core.property_account_current a
  where not a.is_deleted
    and a.ssl_normalized is not null
  order by a.account_id
  limit 1;

  if v_account_id is null then
    raise exception
      '0022 contract requires one current property account fixture';
  end if;

  v_sources := array[
    'dob_building_permits_2026_' || v_token,
    'dob_certificate_of_occupancy_' || v_token,
    'dlcp_basic_business_licenses_' || v_token,
    'ddot_tops_permit_inspections_' || v_token,
    'cama_commercial_current_' || v_token,
    'doee_energy_benchmarking_' || v_token,
    'doee_beps_current_' || v_token,
    'dob_vacant_blighted_addresses_' || v_token,
    'doee_well_permits_' || v_token,
    'abca_alcohol_license_locations_contract_' || v_token,
    'abca_medical_cannabis_nonretailers_contract_' || v_token,
    'abca_medical_cannabis_retailers_contract_' || v_token
  ];

  foreach v_source in array v_sources loop
    insert into meta.source_asset (
      source_id,
      publisher,
      dataset_name,
      source_class,
      official_landing_url,
      bytes,
      sha256,
      row_count,
      dataset_retrieved_at,
      source_system,
      snapshot_policy
    ) values (
      v_source,
      'District of Columbia',
      'Synthetic regulatory API contract fixture',
      'official_snapshot',
      case
        when v_source like 'ddot_%'
          then 'https://tops.ddot.dc.gov/'
        when v_source like 'dlcp_%'
          then 'https://scout.dob.dc.gov/'
        when v_source like 'cama_%'
          then 'https://propertyquest.dc.gov/'
        when v_source like 'doee_%'
          then 'https://doee.dc.gov/'
        when v_source like
          'abca_alcohol_license_locations_contract_%'
          then 'https://abca.dc.gov/node/612672'
        when v_source like
          'abca_medical_cannabis_nonretailers_contract_%'
          then 'https://abca.dc.gov/node/1657531'
        when v_source like
          'abca_medical_cannabis_retailers_contract_%'
          then 'https://abca.dc.gov/node/1751426'
        else 'https://scout.dob.dc.gov/'
      end,
      0,
      repeat('a', 64),
      0,
      clock_timestamp(),
      'contract_fixture',
      'replace_current'
    );

    insert into meta.source_release (
      source_id,
      release_key,
      release_status,
      quality_status,
      snapshot_retrieved_at,
      data_effective_at,
      official_download_url,
      archive_object_key,
      content_type,
      bytes,
      row_count,
      sha256,
      schema_sha256,
      published_at
    ) values (
      v_source,
      'contract_' || v_token,
      'published',
      'passed',
      clock_timestamp(),
      clock_timestamp(),
      null,
      'contract/' || v_source,
      'application/x-ndjson',
      0,
      1,
      repeat('b', 64),
      repeat('c', 64),
      clock_timestamp()
    )
    returning release_id into v_release;

    insert into meta.source_release_pointer (
      source_id,
      pointer_name,
      release_id
    ) values (
      v_source,
      'current',
      v_release
    );
  end loop;

  -- Exact DOB building permit.
  v_source := v_sources[1];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into regulatory.record (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    record_kind,
    record_number,
    record_status,
    record_status_date,
    premise_address,
    ssl_normalized
  ) values (
    v_source,
    v_release,
    9000000001,
    1,
    repeat('1', 64),
    'building_permit',
    'B26-CONTRACT',
    'Issued',
    date '2026-06-15',
    v_address,
    v_ssl
  )
  returning record_id into v_record;

  insert into regulatory.building_permit (
    record_id,
    permit_type,
    work_type,
    work_description,
    application_date,
    issue_date,
    estimated_cost_dollars,
    contractor_name
  ) values (
    v_record,
    'Alteration and Repair',
    'Interior renovation',
    'Synthetic contract scope',
    date '2026-05-01',
    date '2026-06-15',
    125000,
    'Contract Test Builder'
  );

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence,
    match_basis
  ) values (
    v_source,
    v_release,
    9000000001,
    v_account_id,
    'linked',
    'exact_property',
    'ssl',
    'exact',
    1,
    jsonb_build_object('ssl', v_ssl)
  )
  returning source_record_link_id into v_link;

  v_current_release := v_release;

  -- A source may retain an older published snapshot with the same upstream
  -- record identifier. Only the release behind the current pointer may
  -- establish the record type and populate evidence.
  insert into meta.source_release (
    source_id,
    release_key,
    release_status,
    quality_status,
    snapshot_retrieved_at,
    data_effective_at,
    official_download_url,
    archive_object_key,
    content_type,
    bytes,
    row_count,
    sha256,
    schema_sha256,
    published_at
  ) values (
    v_source,
    'historical_contract_' || v_token,
    'published',
    'passed',
    clock_timestamp() - interval '1 year',
    clock_timestamp() - interval '1 year',
    null,
    'contract/historical/' || v_source,
    'application/x-ndjson',
    0,
    1,
    repeat('d', 64),
    repeat('e', 64),
    clock_timestamp() - interval '1 year'
  )
  returning release_id into v_historical_release;

  insert into regulatory.record (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    record_kind,
    record_number,
    record_status,
    record_status_date,
    premise_address,
    ssl_normalized
  ) values (
    v_source,
    v_historical_release,
    9000000001,
    1,
    repeat('f', 64),
    'alcohol_license',
    'OLD-LICENSE-CONTRACT',
    'Expired',
    date '2025-06-15',
    v_address,
    v_ssl
  );

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence,
    match_basis
  ) values (
    v_source,
    v_historical_release,
    9000000001,
    v_account_id,
    'linked',
    'exact_property',
    'ssl',
    'exact',
    1,
    jsonb_build_object('ssl', v_ssl)
  );

  -- Exact certificate of occupancy supplies a second permit page row.
  v_source := v_sources[2];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into regulatory.record (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    record_kind,
    record_number,
    record_status,
    record_status_date,
    premise_address,
    ssl_normalized
  ) values (
    v_source,
    v_release,
    9000000002,
    1,
    repeat('2', 64),
    'certificate_of_occupancy',
    'CO-CONTRACT',
    'Issued',
    date '2025-04-10',
    v_address,
    v_ssl
  )
  returning record_id into v_record;

  insert into regulatory.certificate_of_occupancy (
    record_id,
    certificate_number,
    occupancy_use,
    occupancy_load,
    floors_occupied,
    dwelling_units,
    issue_date
  ) values (
    v_record,
    'CO-CONTRACT',
    'Office',
    25,
    '1-2',
    0,
    date '2025-04-10'
  );

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000002,
    v_account_id,
    'linked',
    'exact_property',
    'ssl',
    'exact',
    1
  )
  returning source_record_link_id into v_link;

  -- Business-at-premise license; never an ownership fact.
  v_source := v_sources[3];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into regulatory.record (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    record_kind,
    record_number,
    record_status,
    record_status_date,
    premise_address,
    ssl_normalized
  ) values (
    v_source,
    v_release,
    9000000003,
    1,
    repeat('3', 64),
    'business_license',
    'BBL-CONTRACT',
    'Active',
    date '2026-01-01',
    v_address,
    v_ssl
  )
  returning record_id into v_record;

  insert into regulatory.business_license (
    record_id,
    license_category,
    license_type,
    entity_name,
    trade_name,
    activity_description,
    issue_date,
    expiration_date,
    is_active
  ) values (
    v_record,
    'General Business',
    'Basic Business License',
    'Contract Fixture LLC',
    'Contract Fixture',
    'Office',
    date '2025-01-01',
    date '2027-01-01',
    true
  );

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000003,
    v_account_id,
    'linked',
    'exact_property',
    'ssl',
    'exact',
    1
  )
  returning source_record_link_id into v_link;

  -- Contextual DDOT public-space inspection.
  v_source := v_sources[4];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into regulatory.record (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    record_kind,
    record_number,
    record_status,
    record_status_date,
    premise_address,
    address_normalized
  ) values (
    v_source,
    v_release,
    9000000004,
    1,
    repeat('4', 64),
    'inspection',
    'DDOT-INSP-CONTRACT',
    'Passed',
    date '2026-03-20',
    v_address,
    upper(v_address)
  )
  returning record_id into v_record;

  insert into regulatory.inspection (
    record_id,
    inspection_type,
    inspection_result,
    completed_at,
    inspector_unit,
    violation_count
  ) values (
    v_record,
    'Public Space Permit',
    'Passed',
    timestamptz '2026-03-20 12:00:00+00',
    'DDOT TOPS',
    0
  );

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000004,
    v_account_id,
    'linked',
    'shared_building',
    'normalized_address',
    'contextual',
    0.85
  )
  returning source_record_link_id into v_link;

  -- Exact CAMA profile.
  v_source := v_sources[5];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000005,
    v_account_id,
    'linked',
    'exact_property',
    'ssl',
    'exact',
    1
  )
  returning source_record_link_id into v_link;

  insert into property_context.cama_building_profile (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_record_link_id,
    account_id,
    ssl_raw,
    ssl_normalized,
    premise_address,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence,
    building_ordinal,
    building_type,
    use_description,
    year_built,
    stories,
    gross_building_area_square_feet,
    grade,
    condition
  ) values (
    v_source,
    v_release,
    9000000005,
    1,
    repeat('5', 64),
    v_link,
    v_account_id,
    v_ssl,
    v_ssl,
    v_address,
    'linked',
    'tax_account',
    'exact_ssl',
    'exact',
    1,
    1,
    'Commercial',
    'Office',
    1985,
    4,
    40000,
    'A',
    'Good'
  );

  -- Contextual energy benchmark.
  v_source := v_sources[6];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000006,
    v_account_id,
    'linked',
    'shared_building',
    'normalized_address',
    'contextual',
    0.8
  )
  returning source_record_link_id into v_context_link;

  insert into property_context.energy_benchmark (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_building_id,
    premise_address,
    address_normalized,
    reporting_year,
    reporting_status,
    property_name,
    primary_property_type,
    gross_floor_area_square_feet,
    energy_star_score,
    site_eui_kbtu_per_square_foot
  ) values (
    v_source,
    v_release,
    9000000006,
    1,
    repeat('6', 64),
    'ENERGY-CONTRACT',
    v_address,
    upper(v_address),
    2025,
    'Reported',
    'Contract Building',
    'Office',
    40000,
    88,
    42.5
  )
  returning energy_benchmark_id into v_context_record;

  insert into property_context.energy_benchmark_property_link (
    source_record_link_id,
    energy_benchmark_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence
  ) values (
    v_context_link,
    v_context_record,
    v_account_id,
    'linked',
    'building',
    'unique_exact_address',
    'contextual',
    0.8
  );

  -- Contextual BEPS.
  v_source := v_sources[7];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000007,
    v_account_id,
    'linked',
    'shared_building',
    'normalized_address',
    'contextual',
    0.8
  )
  returning source_record_link_id into v_context_link;

  insert into property_context.beps_compliance (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_building_id,
    premise_address,
    address_normalized,
    compliance_cycle,
    compliance_status,
    compliance_pathway,
    baseline_year,
    target_year,
    determination_date,
    compliance_deadline
  ) values (
    v_source,
    v_release,
    9000000007,
    1,
    repeat('7', 64),
    'BEPS-CONTRACT',
    v_address,
    upper(v_address),
    'Cycle 1',
    'In progress',
    'Performance',
    2019,
    2026,
    date '2026-02-01',
    date '2026-12-31'
  )
  returning beps_compliance_id into v_context_record;

  insert into property_context.beps_property_link (
    source_record_link_id,
    beps_compliance_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence
  ) values (
    v_context_link,
    v_context_record,
    v_account_id,
    'linked',
    'building',
    'unique_exact_address',
    'contextual',
    0.8
  );

  -- Exact vacant/blighted record.
  v_source := v_sources[8];
  select release_id into v_release
  from meta.source_release
  where source_id = v_source;

  insert into meta.source_record_link (
    source_id,
    source_release_id,
    source_record_id,
    account_id,
    link_status,
    link_scope,
    link_method,
    match_quality,
    link_confidence
  ) values (
    v_source,
    v_release,
    9000000008,
    v_account_id,
    'linked',
    'exact_property',
    'ssl',
    'exact',
    1
  )
  returning source_record_link_id into v_link;

  insert into property_context.vacant_blighted_status (
    source_id,
    source_release_id,
    source_record_id,
    source_row_number,
    source_row_sha256,
    source_record_link_id,
    account_id,
    ssl_raw,
    ssl_normalized,
    premise_address,
    address_normalized,
    link_status,
    link_scope,
    link_method,
    match_quality,
    match_confidence,
    classification,
    source_classification,
    status,
    effective_date
  ) values (
    v_source,
    v_release,
    9000000008,
    1,
    repeat('8', 64),
    v_link,
    v_account_id,
    v_ssl,
    v_ssl,
    v_address,
    upper(v_address),
    'linked',
    'tax_account',
    'exact_ssl',
    'exact',
    1,
    'not_vacant',
    'Occupied',
    'Current',
    date '2026-01-01'
  );

  -- Generic DOEE well permit plus all three ABCA licensed-location families
  -- exercise their distinct public human portals.
  for v_i in 9..12 loop
    v_source := v_sources[v_i];
    select release_id into v_release
    from meta.source_release
    where source_id = v_source;

    insert into regulatory.record (
      source_id,
      source_release_id,
      source_record_id,
      source_row_number,
      source_row_sha256,
      record_kind,
      record_number,
      record_status,
      record_status_date,
      premise_address,
      ssl_normalized
    ) values (
      v_source,
      v_release,
      9000000000 + v_i,
      1,
      repeat(
        case v_i
          when 9 then '9'
          when 10 then 'a'
          when 11 then 'b'
          else 'c'
        end,
        64
      ),
      case
        when v_i = 9 then 'well_permit'
        when v_i = 10 then 'alcohol_license'
        else 'cannabis_license'
      end,
      case v_i
        when 9 then 'WELL-CONTRACT'
        when 10 then 'ABCA-ALCOHOL-CONTRACT'
        when 11 then 'ABCA-NONRETAIL-CONTRACT'
        else 'ABCA-RETAIL-CONTRACT'
      end,
      'Active',
      date '2026-01-15',
      v_address,
      v_ssl
    )
    returning record_id into v_record;

    if v_i >= 10 then
      insert into regulatory.business_license (
        record_id,
        record_kind,
        license_category,
        license_type,
        entity_name,
        trade_name,
        issue_date,
        expiration_date,
        is_active
      ) values (
        v_record,
        case
          when v_i = 10 then 'alcohol_license'
          else 'cannabis_license'
        end,
        case
          when v_i = 10 then 'Alcoholic Beverage'
          else 'Medical Cannabis'
        end,
        case v_i
          when 10 then 'Alcohol License'
          when 11 then 'Non-Retailer License'
          else 'Retailer License'
        end,
        'ABCA Contract Entity ' || v_i,
        'ABCA Contract Trade ' || v_i,
        date '2025-01-01',
        date '2027-01-01',
        true
      );
    end if;

    insert into meta.source_record_link (
      source_id,
      source_release_id,
      source_record_id,
      account_id,
      link_status,
      link_scope,
      link_method,
      match_quality,
      link_confidence
    ) values (
      v_source,
      v_release,
      9000000000 + v_i,
      v_account_id,
      'linked',
      'exact_property',
      'ssl',
      'exact',
      1
    )
    returning source_record_link_id into v_link;
  end loop;

  execute 'set local role api_owner';
  v_expected_binding := encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'field_key', 'permit.type',
          'source_id', 'contract_binding_source',
          'source_record_id', 2::bigint,
          'source_release_id', 1::bigint,
          'source_row_sha256', repeat('a', 64),
          'ssl', '00010001'
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  v_ref := api_v1._regulatory_source_ref(
    'contract_binding_source',
    1,
    2,
    repeat('a', 64),
    'permit.type',
    '00010001'
  );
  if cardinality(string_to_array(v_ref, '|')) <> 6
     or split_part(v_ref, '|', 1) <> 'contract_binding_source'
     or split_part(v_ref, '|', 2) <> '1'
     or split_part(v_ref, '|', 3) <> '2'
     or split_part(v_ref, '|', 4) <> 'permit.type'
     or split_part(v_ref, '|', 5) is distinct from v_expected_binding
     or split_part(v_ref, '|', 6) <> '00010001' then
    v_failures := array_append(
      v_failures,
      'regulatory source-ref helper emitted an invalid binding: ' ||
        coalesce(v_ref, '<null>')
    );
  end if;

  v_refs := array[]::text[];
  for v_i in 1..cardinality(v_sources) loop
    select rp.release_id
    into v_release
    from meta.source_release_pointer rp
    where rp.source_id = v_sources[v_i]
      and rp.pointer_name = 'current';

    v_refs := array_append(
      v_refs,
      api_v1._regulatory_source_ref(
        v_sources[v_i],
        v_release,
        9000000000 + v_i,
        repeat(substr('123456789abc', v_i, 1), 64),
        case v_i
          when 1 then 'permit.type'
          when 2 then 'occupancy.use'
          when 3 then 'license.type'
          when 4 then 'inspection.type'
          when 5 then 'building.year_built'
          when 6 then 'energy.reporting_year'
          when 7 then 'beps.compliance_cycle'
          when 8 then 'vacancy.classification'
          when 9 then 'permit.type'
          else 'license.type'
        end,
        v_ssl
      )
    );
  end loop;
  execute 'reset role';

  if has_function_privilege(
       'mcp_runtime',
       'api_v1._regulatory_binding_sha256(text,bigint,bigint,text,text,text)',
       'execute'
     )
     or has_function_privilege(
       'mcp_runtime',
       'api_v1._regulatory_source_ref(text,bigint,bigint,text,text,text)',
       'execute'
     ) then
    v_failures := array_append(
      v_failures,
      'runtime can execute a private regulatory evidence helper'
    );
  end if;

  -- Four curated APIs are present, definer-secured, and runtime-only.
  foreach v_source in array array[
    'get_permit_history',
    'get_license_history',
    'get_inspection_and_enforcement_history',
    'get_building_and_land_profile'
  ] loop
    if to_regprocedure(
      'api_v1.' || v_source || '(text,text,jsonb)'
    ) is null then
      v_failures := array_append(
        v_failures,
        'missing API ' || v_source
      );
    elsif not (
      select p.prosecdef
      from pg_proc p
      where p.oid = (
        'api_v1.' || v_source || '(text,text,jsonb)'
      )::regprocedure
    ) then
      v_failures := array_append(
        v_failures,
        v_source || ' is not SECURITY DEFINER'
      );
    elsif not has_function_privilege(
      'mcp_runtime',
      'api_v1.' || v_source || '(text,text,jsonb)',
      'execute'
    ) then
      v_failures := array_append(
        v_failures,
        'runtime cannot execute ' || v_source
      );
    elsif has_function_privilege(
      'public',
      'api_v1.' || v_source || '(text,text,jsonb)',
      'execute'
    ) then
      v_failures := array_append(
        v_failures,
        'public can execute ' || v_source
      );
    end if;
  end loop;

  execute 'set local role mcp_runtime';

  select api_v1.get_permit_history(
    v_ssl,
    null,
    '{"record_types":["building_permit"],"limit":50}'::jsonb
  ) into v_payload;

  select item#>>'{facts,permit_type,source_refs,0}'
  into v_ref
  from jsonb_array_elements(
    coalesce(v_payload->'records', '[]'::jsonb)
  ) item
  where item->>'source_id' = v_sources[1]
    and item->>'source_record_id' = '9000000001'
  limit 1;

  v_expected_binding := encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'field_key', 'permit.type',
          'source_id', v_sources[1],
          'source_record_id', 9000000001::bigint,
          'source_release_id', v_current_release,
          'source_row_sha256', repeat('1', 64),
          'ssl', v_ssl
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  if v_ref is null
     or cardinality(string_to_array(v_ref, '|')) <> 6
     or split_part(v_ref, '|', 1) <> v_sources[1]
     or split_part(v_ref, '|', 2) <> v_current_release::text
     or split_part(v_ref, '|', 3) <> '9000000001'
     or split_part(v_ref, '|', 4) <> 'permit.type'
     or split_part(v_ref, '|', 5) is distinct from v_expected_binding
     or split_part(v_ref, '|', 6) <> v_ssl
     or v_ref is distinct from v_refs[1] then
    v_failures := array_append(
      v_failures,
      'permit API did not emit the expected immutable six-part source_ref'
    );
  end if;

  select api_v1.get_source_evidence(array[v_ref])
  into v_evidence;

  if v_evidence->>'status' is distinct from 'ok'
     or coalesce(jsonb_array_length(v_evidence->'evidence'), 0) <> 1
     or v_evidence#>>'{evidence,0,source_ref}' is distinct from v_ref
     or (v_evidence#>>
       '{evidence,0,provenance,source_release_id}'
     )::bigint is distinct from v_current_release
     then
    v_failures := array_append(
      v_failures,
      'valid evidence was duplicated or misrouted across source releases'
    );
  end if;

  v_expected_binding := encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'field_key', 'license.type',
          'source_id', v_sources[1],
          'source_record_id', 9000000001::bigint,
          'source_release_id', v_historical_release,
          'source_row_sha256', repeat('f', 64),
          'ssl', v_ssl
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  v_tampered_ref :=
    v_sources[1] || '|' ||
    v_historical_release::text || '|9000000001|license.type|' ||
    v_expected_binding || '|' || v_ssl;

  select api_v1.get_source_evidence(array[v_tampered_ref])
  into v_evidence;

  if v_evidence#>>'{error,code}' is distinct from
    'source_ref_release_mismatch' then
    v_failures := array_append(
      v_failures,
      'a validly bound historical release was not rejected'
    );
  end if;

  v_tampered_ref :=
    split_part(v_ref, '|', 1) || '|' ||
    v_historical_release::text || '|' ||
    split_part(v_ref, '|', 3) || '|' ||
    split_part(v_ref, '|', 4) || '|' ||
    split_part(v_ref, '|', 5) || '|' ||
    split_part(v_ref, '|', 6);

  select api_v1.get_source_evidence(array[v_tampered_ref])
  into v_evidence;

  if v_evidence#>>'{error,code}' is distinct from
    'source_ref_release_mismatch' then
    v_failures := array_append(
      v_failures,
      'an altered release segment was not rejected'
    );
  end if;

  v_tampered_ref :=
    split_part(v_ref, '|', 1) || '|' ||
    split_part(v_ref, '|', 2) || '|' ||
    split_part(v_ref, '|', 3) || '|license.type|' ||
    split_part(v_ref, '|', 5) || '|' ||
    split_part(v_ref, '|', 6);

  select api_v1.get_source_evidence(array[v_tampered_ref])
  into v_evidence;

  if v_evidence#>>'{error,code}' is distinct from
    'source_ref_field_mismatch' then
    v_failures := array_append(
      v_failures,
      'an altered cross-type field segment was not rejected'
    );
  end if;

  v_tampered_ref :=
    split_part(v_ref, '|', 1) || '|' ||
    split_part(v_ref, '|', 2) || '|' ||
    split_part(v_ref, '|', 3) || '|permit.subtype|' ||
    split_part(v_ref, '|', 5) || '|' ||
    split_part(v_ref, '|', 6);

  select api_v1.get_source_evidence(array[v_tampered_ref])
  into v_evidence;

  if v_evidence#>>'{error,code}' is distinct from
    'source_ref_binding_mismatch' then
    v_failures := array_append(
      v_failures,
      'an altered allowed field with a stale binding was not rejected'
    );
  end if;

  v_tampered_ref :=
    split_part(v_ref, '|', 1) || '|' ||
    split_part(v_ref, '|', 2) || '|' ||
    split_part(v_ref, '|', 3) || '|' ||
    split_part(v_ref, '|', 4) || '|' ||
    repeat('0', 64) || '|' ||
    split_part(v_ref, '|', 6);

  select api_v1.get_source_evidence(array[v_tampered_ref])
  into v_evidence;

  if v_evidence#>>'{error,code}' is distinct from
    'source_ref_binding_mismatch' then
    v_failures := array_append(
      v_failures,
      'an altered binding hash was not rejected'
    );
  end if;

  select api_v1.get_source_evidence(array[
    v_sources[1] || '|9000000001|permit.type|' || v_ssl
  ]) into v_evidence;

  if v_evidence#>>'{error,code}' is distinct from
    'malformed_source_ref' then
    v_failures := array_append(
      v_failures,
      'a legacy four-part regulatory source_ref was not rejected'
    );
  end if;

  select api_v1.get_permit_history(
    v_ssl,
    null,
    jsonb_build_object('limit', 500)
  ) into v_payload;

  if v_payload->>'status' <> 'resolved'
     or (v_payload->>'limit')::integer <> 50
     or (v_payload->>'total_count')::integer < 2 then
    v_failures := array_append(
      v_failures,
      'permit API did not resolve or enforce the 50-row limit'
    );
  end if;

  select api_v1.get_permit_history(
    v_ssl,
    null,
    jsonb_build_object('limit', 1)
  ) into v_payload;

  if not coalesce((v_payload->>'has_more')::boolean, false)
     or nullif(v_payload->>'next_cursor', '') is null
     or jsonb_array_length(v_payload->'records') <> 1 then
    v_failures := array_append(
      v_failures,
      'permit API did not produce a deterministic next page'
    );
  else
    select api_v1.get_permit_history(
      v_ssl,
      null,
      jsonb_build_object(
        'limit', 1,
        'cursor', v_payload->>'next_cursor'
      )
    ) into v_page_two;

    if jsonb_array_length(v_page_two->'records') <> 1
       or v_page_two#>>'{records,0,source_record_id}' =
          v_payload#>>'{records,0,source_record_id}' then
      v_failures := array_append(
        v_failures,
        'permit page two repeated or omitted the next record'
      );
    end if;
  end if;

  select api_v1.get_license_history(
    v_ssl,
    null,
    '{"record_types":["business_license"]}'::jsonb
  ) into v_payload;

  if v_payload#>>'{records,0,record_type}' <> 'business_license'
     or v_payload#>>'{records,0,limitations,0}' !~*
       '(not a representation of property ownership|not.*property ownership)' then
    v_failures := array_append(
      v_failures,
      'business license was omitted or lacks the ownership disclaimer'
    );
  end if;

  select api_v1.get_inspection_and_enforcement_history(
    v_ssl,
    null,
    '{"record_types":["inspection"]}'::jsonb
  ) into v_payload;

  if v_payload#>>'{records,0,facts,agency_context,value}' <>
      'DDOT public-space permit inspection'
     or v_payload#>>'{records,0,limitations,0}' !~*
       'not a DOB building' then
    v_failures := array_append(
      v_failures,
      'DDOT inspection was not explicitly distinguished from DOB'
    );
  end if;

  select api_v1.get_building_and_land_profile(
    v_ssl,
    null,
    '{"limit":50}'::jsonb
  ) into v_payload;

  if not (
    select array_agg(distinct item->>'record_type')
      @> array[
        'cama_building_profile',
        'energy_benchmark',
        'beps',
        'vacant_blighted'
      ]
    from jsonb_array_elements(v_payload->'records') item
  ) then
    v_failures := array_append(
      v_failures,
      'building profile API omitted a normalized context family'
    );
  end if;

  select item
  into v_record_payload
  from jsonb_array_elements(v_payload->'records') item
  where item->>'record_type' = 'energy_benchmark'
  limit 1;

  if v_record_payload#>>'{property_link,scope}' <>
      'shared_building'
     or coalesce(
       (v_record_payload#>>'{property_link,is_exact_property}')::boolean,
       true
     ) then
    v_failures := array_append(
      v_failures,
      'building energy context was mislabeled as exact'
    );
  end if;

  select value
  into v_ref
  from jsonb_array_elements_text(
    jsonb_path_query_array(
      v_record_payload,
      '$.**.source_refs[*]'
    )
  ) refs(value)
  limit 1;

  if v_ref is null
     or cardinality(string_to_array(v_ref, '|')) <> 6
     or split_part(v_ref, '|', 1) <>
        v_record_payload->>'source_id'
     or split_part(v_ref, '|', 2) !~ '^[0-9]+$'
     or split_part(v_ref, '|', 3) <>
        v_record_payload->>'source_record_id'
     or split_part(v_ref, '|', 4) !~
        '^(building|energy|beps|vacancy|land)\.'
     or split_part(v_ref, '|', 5) !~ '^[0-9a-f]{64}$'
     or split_part(v_ref, '|', 6) <> v_ssl then
    v_failures := array_append(
      v_failures,
      'a context fact lacks an immutable six-part evidence binding: ' ||
        coalesce(v_ref, '<null>')
    );
  else
    select api_v1.get_source_evidence(array[v_ref])
    into v_evidence;

    if v_evidence->>'status' <> 'ok'
       or v_evidence#>>'{evidence,0,human_verification,portal_url}'
         !~ '^https://buildingperformancedc\.org/'
       or v_evidence::text ~*
         '(featureserver|mapserver|/rest/|/api/|\.csv|\.json|/_/retrieve/)' then
      v_failures := array_append(
        v_failures,
        'energy evidence did not return the approved human portal'
      );
    end if;

    select api_v1.get_source_evidence(array[
      split_part(v_ref, '|', 1) || '|' ||
      split_part(v_ref, '|', 2) || '|' ||
      split_part(v_ref, '|', 3) || '|permit.type|' ||
      split_part(v_ref, '|', 5) || '|' ||
      split_part(v_ref, '|', 6)
    ]) into v_evidence;

    if v_evidence#>>'{error,code}' is distinct from
      'source_ref_field_mismatch' then
      v_failures := array_append(
        v_failures,
        'cross-type source-ref field tampering was not rejected'
      );
    end if;

    select api_v1.get_source_evidence(array[
      split_part(v_ref, '|', 1) || '|' ||
      split_part(v_ref, '|', 2) || '|' ||
      split_part(v_ref, '|', 3) || '|' ||
      split_part(v_ref, '|', 4) || '|' ||
      split_part(v_ref, '|', 5) || '|9999999999999999'
    ]) into v_evidence;

    if v_evidence#>>'{error,code}' is distinct from
      'source_ref_property_mismatch' then
      v_failures := array_append(
        v_failures,
        'cross-property source-ref tampering was not rejected'
      );
    end if;
  end if;

  v_patterns := array[
    '^https://scout\.dob\.dc\.gov/',
    '^https://scout\.dob\.dc\.gov/',
    '^https://scout\.dob\.dc\.gov/',
    '^https://tops\.ddot\.dc\.gov/DDOTPermitSystem/DDOTPermitOnline/MapLookup\.aspx$',
    '^https://propertyquest\.dc\.gov/',
    '^https://buildingperformancedc\.org/',
    '^https://buildingperformancedc\.org/',
    '^https://dob\.dc\.gov/vacantbuildings',
    '^https://doee\.dc\.gov/service/well-permitting',
    '^https://abca\.dc\.gov/node/612672$',
    '^https://abca\.dc\.gov/node/1657531$',
    '^https://abca\.dc\.gov/node/1751426$'
  ];

  for v_i in 1..cardinality(v_refs) loop
    select api_v1.get_source_evidence(array[v_refs[v_i]])
    into v_evidence;
    v_url := v_evidence#>>
      '{evidence,0,human_verification,portal_url}';

    if v_evidence->>'status' <> 'ok'
       or coalesce(v_url, '') !~ v_patterns[v_i]
       or (
         v_i = 4
         and (
           coalesce(
             v_evidence#>>
               '{evidence,0,human_verification,search_inputs,tops_square_lot}',
             ''
           ) !~ '^[^ ,]+,[^ ,]+$'
           or v_evidence#>>
             '{evidence,0,human_verification,steps,1}'
             !~ 'Square,Lot format with no spaces'
         )
       )
       or (
         v_i between 10 and 12
         and (
           coalesce(
             v_evidence#>>
               '{evidence,0,human_verification,access}',
             ''
           ) !~* 'public.*no sign-in'
           or coalesce(
             v_evidence#>>
               '{evidence,0,human_verification,steps,1}',
             ''
           ) !~* 'browser Find.*(license|entity|address)'
         )
       )
       or v_evidence::text ~*
         '(services\.arcgis\.com|featureserver|mapserver|/rest/|/api/|\.csv([?#]|")|\.json([?#]|")|/_/retrieve/|file__=|params__=)' then
      v_failures := array_append(
        v_failures,
        'source family evidence route ' || v_i ||
          ' is not an approved official human portal'
      );
    end if;
  end loop;

  select api_v1.get_permit_history(
    v_ssl,
    null,
    '{"cursor":"not-a-cursor"}'::jsonb
  ) into v_payload;
  if v_payload#>>'{error,code}' is distinct from
    'invalid_cursor' then
    v_failures := array_append(
      v_failures,
      'invalid cursor was not rejected'
    );
  end if;

  select api_v1.describe_data(
    'What permits, licenses, inspections, energy, and building data are available?'
  ) into v_describe;
  if v_describe->>'status' <> 'ok'
     or not (v_describe->'tools' ? 'get_permit_history')
     or not (
       v_describe->'tools' ?
       'get_inspection_and_enforcement_history'
     )
     or jsonb_array_length(v_describe->'source_families') < 8 then
    v_failures := array_append(
      v_failures,
      'describe_data omitted the regulatory semantic layer'
    );
  end if;

  execute 'reset role';

  if has_table_privilege(
    'mcp_runtime',
    'meta.source_record_link',
    'select'
  ) or has_table_privilege(
    'mcp_runtime',
    'regulatory.record',
    'select'
  ) or has_table_privilege(
    'mcp_runtime',
    'property_context.energy_benchmark',
    'select'
  ) or has_table_privilege(
    'mcp_runtime',
    'semantic.regulatory_field_binding',
    'select'
  ) then
    v_failures := array_append(
      v_failures,
      'runtime can bypass a curated API with direct table SELECT'
    );
  end if;

  if cardinality(v_failures) > 0 then
    raise exception '0022 regulatory API contract failures: %',
      array_to_string(v_failures, '; ');
  end if;
end;
$contract$;

rollback;
