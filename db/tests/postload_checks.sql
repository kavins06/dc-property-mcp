begin;

do $$
declare
  v_payload jsonb;
  v_table_read_failed boolean := false;
  v_database_size_bytes bigint;
begin
  assert (select count(*) from core.property_account_current) = 221263,
    'current account row-count gate failed';
  assert (select count(*) from history.tax_series) = 221263,
    'tax-series row-count gate failed';
  assert (select count(*) from history.sale_series) = 215408,
    'sale-series account row-count gate failed';
  assert (
    select sum(cardinality(source_objectids))
    from history.sale_series
  ) = 421436, 'sale-series source row-count gate failed';
  select pg_database_size(current_database()) into v_database_size_bytes;
  if v_database_size_bytes >= 5000000000 then
    raise warning
      'database has reached the 5 GB warning threshold: % bytes',
      v_database_size_bytes;
  end if;
  assert v_database_size_bytes < 6000000000,
    'database has reached the 6 GB release limit';

  assert not exists (
    select 1 from core.property_account_current
    where ssl_normalized is null or ssl_normalized = ''
  ), 'current SSL null gate failed';
  assert not exists (
    select ssl_normalized from core.property_account_current
    group by ssl_normalized having count(*) > 1
  ), 'current SSL uniqueness gate failed';
  assert not exists (
    select 1 from history.tax_series
    where cardinality(values_cents) <> 96
  ), 'tax value-vector cardinality gate failed';
  assert (select count(*) from history.tax_value_overflow) = 131,
    'tax overflow preservation gate failed';
  assert not exists (
    select 1 from history.tax_sale_flag
    where slot_ordinal not between 1 and 12
  ), 'tax-sale flag slot gate failed';
  assert not exists (
    select 1 from history.sale_series
    where cardinality(source_objectids) <> cardinality(sale_dates)
       or cardinality(source_objectids) <> cardinality(sale_prices)
       or cardinality(source_objectids) <> cardinality(qualified_codes)
       or cardinality(source_objectids) <> cardinality(sale_codes)
       or cardinality(source_objectids) <> cardinality(current_owner_flags)
  ), 'sale-series vector cardinality gate failed';
  assert to_regclass('history.assessment_snapshot_record') is null,
    'standalone assessment history table still exists';
  assert to_regclass('meta.snapshot_record_link') is null,
    'legacy assessment link table still exists';
  assert not exists (
    select 1
    from core.property_account_current
    where prior_land_value is null
       or prior_improvement_value is null
       or prior_total_value is null
       or current_land_value is null
       or current_improvement_value is null
       or current_total_value is null
       or proposed_land_value is null
       or proposed_improvement_value is null
       or proposed_total_value is null
  ), 'current account assessment-stage completeness gate failed';

  assert (select count(*) from semantic.field_definition) >= 40,
    'semantic field catalog is unexpectedly incomplete';
  assert (
    select count(*)
    from semantic.coverage
    where entity_name = 'assessment'
      and availability_status = 'available'
      and (tax_year, stage) in (
        (2025, 'prior'),
        (2026, 'current'),
        (2027, 'proposed')
      )
  ) = 3,
    'assessment coverage catalog gate failed';
  assert (
    select count(*)
    from semantic.coverage
    where entity_name = 'assessment'
  ) = 3, 'assessment coverage contains obsolete entries';
  assert not exists (
    select 1
    from meta.source_asset
    where source_id in ('itspe_2017_archive', 'itspe_2021_archive')
  ), 'legacy assessment source metadata remains active';
  assert (select count(*) from semantic.property_type_vocabulary) >= 10,
    'property-type screening vocabulary is unexpectedly incomplete';
  assert to_regclass('core.property_account_screen_type_tax_idx') is not null,
    'property-type/tax-class screening index is missing';
  assert to_regclass('core.property_account_screen_ward_tax_idx') is not null,
    'ward/tax-class screening index is missing';

  assert not has_table_privilege('mcp_runtime', 'core.property_account_current', 'select'),
    'runtime role unexpectedly has current-table SELECT';
  assert has_function_privilege(
    'mcp_runtime', 'api_v1.get_property_snapshot(text,text)', 'execute'
  ), 'runtime role lacks expected API function EXECUTE';
  assert has_function_privilege(
    'mcp_runtime', 'api_v1.get_latest_sale_and_deed(text,text)', 'execute'
  ), 'runtime role lacks latest sale/deed API function EXECUTE';
  assert has_function_privilege(
    'mcp_runtime', 'api_v1.resolve_properties_batch(jsonb)', 'execute'
  ), 'runtime role lacks batch resolver API function EXECUTE';
  assert not has_function_privilege(
    'public', 'api_v1.get_property_snapshot(text,text)', 'execute'
  ), 'PUBLIC unexpectedly has API function EXECUTE';
  assert not has_table_privilege(
    'mcp_runtime', 'history.sale_series', 'select'
  ), 'runtime role unexpectedly has sale-history table SELECT';
  assert not has_table_privilege(
    'mcp_runtime', 'semantic.property_type_vocabulary', 'select'
  ), 'runtime role unexpectedly has semantic vocabulary SELECT';

  execute 'set local role mcp_runtime';
  select api_v1.resolve_property('5576    0001', null, false, 10) into v_payload;
  assert v_payload->>'status' = 'resolved', 'sample SSL did not resolve';

  select api_v1.get_property_snapshot('5576    0001', null) into v_payload;
  assert v_payload->>'status' = 'resolved', 'sample snapshot call failed';
  assert v_payload#>>'{valuation,current_total_value_dollars,source_refs,0}' is not null,
    'sample fact lacks source reference';
  assert v_payload#>>'{valuation,current_total_value_dollars,record_date}' is not null,
    'sample fact lacks record date';

  select api_v1.get_source_evidence(array[
    v_payload#>>'{valuation,current_total_value_dollars,source_refs,0}'
  ]) into v_payload;
  assert v_payload#>>'{evidence,0,field_key}' = 'assessment.current_total_value',
    'sample evidence reference is not fact-specific';
  assert v_payload#>>'{evidence,0,human_verification,portal_url}' =
    'https://mytax.dc.gov/?Link=PropertySearch&Check=1',
    'sample evidence lacks the MyTax human search portal';
  assert v_payload#>>'{evidence,0,human_verification,search_inputs,ssl}' is not null,
    'sample evidence lacks the exact SSL lookup input';
  assert v_payload#>>'{evidence,0,human_verification,search_inputs,property_address}' is not null,
    'sample evidence lacks the exact address lookup input';
  assert v_payload::text not like '%services.arcgis.com%',
    'machine-readable ArcGIS URL leaked into evidence';
  assert v_payload::text not like '%f=html%',
    'ArcGIS REST query leaked into evidence';
  assert v_payload::text not like '%/_/Retrieve/%',
    'session-bound MyTax Retrieve URL was persisted';

  select api_v1.get_ownership_and_sale('5576    0001', null) into v_payload;
  assert not (v_payload ? 'latest_reported_transfer'),
    'ownership response still duplicates transfer facts';
  select api_v1.get_latest_sale_and_deed('5576    0001', null) into v_payload;
  select api_v1.get_source_evidence(array[
    v_payload#>>'{latest_assessor_deed,instrument_number,source_refs,0}'
  ]) into v_payload;
  assert v_payload#>>'{evidence,0,field_key}' = 'deed.latest_instrument_number',
    'deed evidence reference is not fact-specific';
  assert v_payload#>>'{evidence,0,human_verification,portal_url}' =
    'https://washington.dc.publicsearch.us/',
    'deed evidence lacks the Recorder human search portal';
  assert v_payload#>>'{evidence,0,human_verification,search_inputs,ssl}' is not null,
    'deed evidence lacks the parcel SSL';
  assert v_payload::text not like '%services.arcgis.com%',
    'machine-readable ArcGIS URL leaked into deed evidence';

  select api_v1.get_latest_sale_and_deed('3562    0059', null) into v_payload;
  assert v_payload->>'status' = 'resolved',
    'dedicated sale/deed sample did not resolve';
  assert v_payload#>>'{sale_history,0,sale_price_dollars,value}' = '745000',
    'sale history sample lacks expected sale price';
  assert v_payload#>>'{sale_history,0,sale_date,value}' = '2026-06-15',
    'sale history sample lacks expected sale date';
  assert v_payload#>>'{latest_assessor_deed,instrument_number,value}' = '2026058413',
    'dedicated sale/deed sample lacks expected instrument number';
  execute 'reset role';

  begin
    execute 'set local role mcp_runtime';
    perform * from core.property_account_current limit 1;
  exception when insufficient_privilege then
    v_table_read_failed := true;
  end;
  execute 'reset role';
  assert v_table_read_failed, 'runtime direct-table read did not fail';
end
$$;

rollback;
