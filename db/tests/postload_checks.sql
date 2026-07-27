begin;

do $$
declare
  v_payload jsonb;
  v_table_read_failed boolean := false;
begin
  assert (select count(*) from core.property_account_current) = 221263,
    'current account row-count gate failed';
  assert (select count(*) from history.assessment_snapshot_record) = 652131,
    'assessment row-count gate failed';
  assert (select count(*) from history.tax_series) = 221263,
    'tax-series row-count gate failed';
  assert pg_database_size(current_database()) <= 450000000,
    'database exceeds 450 MB no-go gate';

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

  assert (select count(*) from semantic.field_definition) >= 40,
    'semantic field catalog is unexpectedly incomplete';
  assert (select count(*) from semantic.coverage where availability_status = 'available') = 9,
    'assessment coverage catalog gate failed';
  assert (select count(*) from semantic.coverage where availability_status = 'not_available') = 3,
    'assessment gap catalog gate failed';

  assert not has_table_privilege('mcp_runtime', 'core.property_account_current', 'select'),
    'runtime role unexpectedly has current-table SELECT';
  assert not has_table_privilege('mcp_runtime', 'history.assessment_snapshot_record', 'select'),
    'runtime role unexpectedly has history-table SELECT';
  assert has_function_privilege(
    'mcp_runtime', 'api_v1.get_property_snapshot(text,text)', 'execute'
  ), 'runtime role lacks expected API function EXECUTE';
  assert has_function_privilege(
    'mcp_runtime', 'api_v1.get_latest_sale_and_deed(text,text)', 'execute'
  ), 'runtime role lacks latest sale/deed API function EXECUTE';
  assert not has_function_privilege(
    'public', 'api_v1.get_property_snapshot(text,text)', 'execute'
  ), 'PUBLIC unexpectedly has API function EXECUTE';

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
  select api_v1.get_source_evidence(array[
    v_payload#>>'{latest_reported_transfer,instrument_number,source_refs,0}'
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
  assert v_payload#>>'{latest_sale_and_deed,sale_price_dollars,value}' = '745000',
    'dedicated sale/deed sample lacks expected sale price';
  assert v_payload#>>'{latest_sale_and_deed,sale_date,value}' = '2026-06-15',
    'dedicated sale/deed sample lacks expected sale date';
  assert v_payload#>>'{latest_sale_and_deed,instrument_number,value}' = '2026058413',
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
