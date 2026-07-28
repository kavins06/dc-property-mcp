begin;

do $contract$
declare
  v_failures text[] := array[]::text[];
  v_source_id text;
  v_account_id bigint;
  v_release_a bigint;
  v_release_b bigint;
begin
  if to_regclass('regulatory.property_link') is not null then
    v_failures := array_append(
      v_failures,
      'redundant regulatory.property_link still exists'
    );
  end if;

  if to_regclass('meta.ingest_phase_checkpoint') is null
     or to_regclass('meta.loaded_artifact_binding') is null then
    v_failures := array_append(
      v_failures,
      'release lifecycle administrative tables are missing'
    );
  end if;

  if has_table_privilege(
       'api_owner',
       'meta.ingest_phase_checkpoint',
       'insert'
     )
     or has_table_privilege(
       'api_owner',
       'meta.loaded_artifact_binding',
       'select'
     )
     or has_table_privilege(
       'mcp_runtime',
       'meta.loaded_artifact_binding',
       'select'
     ) then
    v_failures := array_append(
      v_failures,
      'administrative lifecycle proof is exposed to an API role'
    );
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'regulatory.record'::regclass
      and conname = 'record_source_id_source_record_id_key'
  ) then
    v_failures := array_append(
      v_failures,
      'cross-release regulatory identity constraint still exists'
    );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'regulatory.record'::regclass
      and conname = 'regulatory_record_release_identity_key'
      and contype = 'u'
  ) then
    v_failures := array_append(
      v_failures,
      'release-aware regulatory identity constraint is missing'
    );
  end if;

  select source_id into v_source_id
  from meta.source_asset
  order by source_id
  limit 1;
  select account_id into v_account_id
  from core.property_account_current
  order by account_id
  limit 1;

  if v_source_id is null or v_account_id is null then
    v_failures := array_append(
      v_failures,
      'production fixtures are unavailable'
    );
  else
    insert into meta.source_release (
      source_id,
      release_key,
      release_status,
      quality_status,
      snapshot_retrieved_at,
      archive_object_key,
      bytes,
      row_count,
      sha256,
      schema_sha256
    ) values (
      v_source_id,
      '__lifecycle_a__',
      'validated',
      'passed',
      clock_timestamp(),
      '__lifecycle_a__',
      0,
      1,
      repeat('a', 64),
      repeat('b', 64)
    )
    returning release_id into v_release_a;

    insert into meta.source_release (
      source_id,
      release_key,
      release_status,
      quality_status,
      snapshot_retrieved_at,
      archive_object_key,
      bytes,
      row_count,
      sha256,
      schema_sha256
    ) values (
      v_source_id,
      '__lifecycle_b__',
      'validated',
      'passed',
      clock_timestamp(),
      '__lifecycle_b__',
      0,
      1,
      repeat('c', 64),
      repeat('d', 64)
    )
    returning release_id into v_release_b;

    insert into regulatory.record (
      source_id,
      source_release_id,
      source_record_id,
      source_row_sha256,
      record_kind
    ) values
      (
        v_source_id,
        v_release_a,
        4200000001,
        repeat('e', 64),
        'building_permit'
      ),
      (
        v_source_id,
        v_release_b,
        4200000001,
        repeat('f', 64),
        'building_permit'
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
    ) values
      (
        v_source_id,
        v_release_a,
        4200000001,
        v_account_id,
        'linked',
        'exact_property',
        'ssl',
        'exact',
        1
      ),
      (
        v_source_id,
        v_release_b,
        4200000001,
        v_account_id,
        'linked',
        'exact_property',
        'ssl',
        'exact',
        1
      );
  end if;

  insert into meta.loaded_artifact_binding (
    artifact_key,
    file_name,
    relation_name,
    artifact_sha256,
    artifact_row_count,
    mapping_sha256,
    build_manifest_sha256,
    verification_method
  ) values (
    'property_account_current',
    'fixture.csv.gz',
    'core.property_account_current',
    repeat('1', 64),
    1,
    repeat('2', 64),
    repeat('3', 64),
    'contract_fixture'
  );

  update core.property_account_current
  set premise_address = premise_address
  where account_id = v_account_id;

  if exists (
    select 1
    from meta.loaded_artifact_binding
    where artifact_key = 'property_account_current'
  ) then
    v_failures := array_append(
      v_failures,
      'core write did not invalidate the account artifact binding'
    );
  end if;

  if cardinality(v_failures) > 0 then
    raise exception '0024 lifecycle contract failures: %',
      array_to_string(v_failures, '; ');
  end if;
end
$contract$;

rollback;
