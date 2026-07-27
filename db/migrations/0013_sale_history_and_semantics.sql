begin;

create table if not exists history.sale_series (
  account_id bigint primary key
    references core.property_account_current on delete cascade,
  source_objectids integer[] not null,
  sale_dates date[] not null,
  sale_prices bigint[] not null,
  qualified_codes text[] not null,
  sale_codes text[] not null,
  current_owner_flags smallint[] not null,
  check (
    cardinality(source_objectids) = cardinality(sale_dates)
    and cardinality(source_objectids) = cardinality(sale_prices)
    and cardinality(source_objectids) = cardinality(qualified_codes)
    and cardinality(source_objectids) = cardinality(sale_codes)
    and cardinality(source_objectids) = cardinality(current_owner_flags)
    and cardinality(source_objectids) > 0
  )
);

comment on table history.sale_series is
  'Compact, per-account arrays preserving every linked record from the official Tax System Property Sales (CAMA) export. This is assessor sale history, not a Recorder chain of title.';

revoke all on history.sale_series from public;
grant select on history.sale_series to api_owner;

insert into meta.source_asset (
  source_id,
  publisher,
  dataset_name,
  source_class,
  official_landing_url,
  official_download_url,
  r2_object_key,
  bytes,
  sha256,
  row_count,
  archive_capture_at,
  dataset_retrieved_at,
  extract_date_min,
  extract_date_max,
  limitations
) values (
  'cama_sales_current',
  'D.C. Office of the Chief Financial Officer / DCGIS',
  'Tax System Property Sales (CAMA)',
  'live_official',
  'https://opendata.dc.gov/datasets/DCGIS::tax-system-property-sales-cama',
  'https://opendata.dc.gov/api/download/v1/items/ee35b5aa5ca643679fb37c141c532a92/csv?layers=57',
  null,
  37396484,
  '102dd0c19d7d1f99ea7650b2209a6e2f35a56145c1cc88c30a8f4dedd57a224a',
  421445,
  null,
  '2026-07-27T17:27:25-04:00'::timestamptz,
  '1900-01-01',
  '2026-07-14',
  'Sale history for active properties on the D.C. assessment roll. Nine source rows did not link to the current ITSPE account extract. It is not a Recorder of Deeds chain of title; qualified codes and zero or sentinel values are preserved as reported.'
) on conflict (source_id) do update set
  publisher = excluded.publisher,
  dataset_name = excluded.dataset_name,
  source_class = excluded.source_class,
  official_landing_url = excluded.official_landing_url,
  official_download_url = excluded.official_download_url,
  bytes = excluded.bytes,
  sha256 = excluded.sha256,
  row_count = excluded.row_count,
  dataset_retrieved_at = excluded.dataset_retrieved_at,
  extract_date_min = excluded.extract_date_min,
  extract_date_max = excluded.extract_date_max,
  limitations = excluded.limitations;

insert into meta.verification_route (
  source_id,
  priority,
  route_kind,
  url_template,
  allowed_fields,
  required_lookup_keys,
  instructions,
  stable,
  requires_session,
  last_tested_at,
  last_test_status
)
select
  'cama_sales_current',
  1,
  'official_dataset',
  'https://opendata.dc.gov/datasets/DCGIS::tax-system-property-sales-cama',
  array[
    'sale.history.date',
    'sale.history.price',
    'sale.history.qualified_code',
    'sale.history.sale_code',
    'sale.history.current_owner_flag'
  ],
  array['ssl', 'source_record_id'],
  array[
    'Open the human-facing Tax System Property Sales (CAMA) dataset.',
    'Use the supplied SSL or source record ID to locate the sale.',
    'Compare the sale date, price, qualification, and sale code.'
  ],
  true,
  false,
  '2026-07-27T17:27:25-04:00'::timestamptz,
  'ok'
where not exists (
  select 1
  from meta.verification_route
  where source_id = 'cama_sales_current'
    and route_kind = 'official_dataset'
);

set local role api_owner;

create or replace function api_v1._canonical_property_type(
  p_source_label text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select case trim(coalesce(p_source_label, ''))
    when '' then null
    when 'Vacant-True' then 'Vacant'
    when 'Residential-Condominium (Garag' then
      'Residential Condominium — Garage'
    when 'Commercial-Office (Condominium' then
      'Commercial Office — Condominium'
    when 'Commercial-Office (Miscellaneo' then
      'Commercial Office — Miscellaneous'
    when 'Office-Condominium (Horizontal' then
      'Office Condominium — Horizontal'
    else regexp_replace(
      replace(trim(p_source_label), '-', ' '),
      '\s+\(([^)]+)\)$',
      ' — \1'
    )
  end;
$$;

reset role;

create table if not exists semantic.code_decode (
  code_system text not null,
  code text not null,
  label text not null,
  description text,
  source_labels text[] not null default '{}',
  current_account_count integer,
  official_reference_url text not null,
  decode_status text not null check (
    decode_status in ('official_definition', 'source_label_with_official_reference')
  ),
  primary key (code_system, code)
);

revoke all on semantic.code_decode from public;
grant select on semantic.code_decode to api_owner;

insert into semantic.code_decode (
  code_system,
  code,
  label,
  description,
  source_labels,
  current_account_count,
  official_reference_url,
  decode_status
)
select
  'use_code',
  a.use_code,
  api_v1._canonical_property_type(min(a.property_type)),
  'Current ITSPE source label for this D.C. real-property use code. The linked OTR appendix is the authoritative decode reference.',
  array_agg(distinct a.property_type order by a.property_type)
    filter (where a.property_type is not null),
  count(*)::integer,
  'https://otr.cfo.dc.gov/publication/real-property-use-code-listing',
  'source_label_with_official_reference'
from core.property_account_current a
where nullif(trim(a.use_code), '') is not null
group by a.use_code
on conflict (code_system, code) do update set
  label = excluded.label,
  description = excluded.description,
  source_labels = excluded.source_labels,
  current_account_count = excluded.current_account_count,
  official_reference_url = excluded.official_reference_url,
  decode_status = excluded.decode_status;

insert into semantic.code_decode (
  code_system,
  code,
  label,
  description,
  official_reference_url,
  decode_status
) values
  (
    'tax_class', '1A', 'Residential — three or more units',
    'Residential real property with three or more units, including apartments and triplexes.',
    'https://otr.cfo.dc.gov/node/1794811',
    'official_definition'
  ),
  (
    'tax_class', '1B', 'Residential — two or fewer units',
    'Residential real property with two or fewer units, including single-family, row house, townhouse, and a house with a second living unit.',
    'https://otr.cfo.dc.gov/node/1794811',
    'official_definition'
  ),
  (
    'tax_class', '2', 'Commercial and industrial',
    'Commercial and industrial real property, including hotels and motels.',
    'https://otr.cfo.dc.gov/node/1794811',
    'official_definition'
  ),
  (
    'tax_class', '3', 'Vacant',
    'Vacant real property.',
    'https://otr.cfo.dc.gov/node/1794811',
    'official_definition'
  ),
  (
    'tax_class', '4', 'Vacant and blighted',
    'Vacant, blighted real property.',
    'https://otr.cfo.dc.gov/node/1794811',
    'official_definition'
  ),
  (
    'special_assessment', 'BID', 'Business Improvement District',
    'Business Improvement District tax or balance carried by ITSPE.',
    'https://otr.cfo.dc.gov/page/real-property-tax-certificate',
    'official_definition'
  ),
  (
    'special_assessment', 'SEWS', 'Southeast Water and Sewer',
    'Southeast Water and Sewer amount carried by ITSPE.',
    'https://opendata.dc.gov/datasets/DCGIS::computer-assisted-mass-appraisal-cama-database',
    'official_definition'
  ),
  (
    'special_assessment', 'PACE', 'Property Assessed Clean Energy',
    'Voluntary clean-energy financing repaid through a special property-tax assessment.',
    'https://doee.dc.gov/service/dcpace',
    'official_definition'
  ),
  (
    'special_assessment', 'SWWSAD',
    'Southwest Waterfront Special Assessment District',
    'Special assessment for the Southwest Waterfront Improvement Benefit District.',
    'https://opendata.dc.gov/datasets/DCGIS::computer-assisted-mass-appraisal-cama-database',
    'official_definition'
  )
on conflict (code_system, code) do update set
  label = excluded.label,
  description = excluded.description,
  official_reference_url = excluded.official_reference_url,
  decode_status = excluded.decode_status;

update semantic.field_definition
set
  exposure_allowed = false,
  caveat = 'Deprecated semantic label: ITSPE defines OWNOCCT as the number of occupied co-op units, not a boolean owner-occupancy flag.'
where field_key = 'ownership.owner_occupancy_flag';

update semantic.field_definition
set
  exposure_allowed = false,
  caveat = 'Deprecated semantic label: the official TOTDUEAMT alias is Total of all liabilities, not the current balance owed.'
where field_key = 'tax.total_due';

insert into semantic.field_definition (
  field_key,
  json_path,
  title,
  definition,
  entity_name,
  data_type,
  unit,
  time_grain,
  source_fields,
  lender_synonyms,
  commonly_confused_with,
  null_semantics,
  aggregation_rule,
  caveat,
  definition_status,
  formula_version,
  exposure_allowed,
  search_filter_allowed
) values
  (
    'ownership.owner_occupied_cooperative_units',
    '$.ownership.owner_occupied_cooperative_units',
    'Occupied cooperative units',
    'Number of occupied cooperative units reported in ITSPE OWNOCCT.',
    'property_account',
    'integer',
    'units',
    'record date',
    array['OWNOCCT'],
    array['occupied co-op units'],
    array['owner occupancy flag', 'tenant occupancy rate'],
    'Null means the source did not report a count; zero is a reported count.',
    null,
    'This is a unit count, not a boolean owner-occupancy indicator or an occupancy rate.',
    'official',
    null,
    true,
    false
  ),
  (
    'classification.property_type_canonical',
    '$.classification.property_type_canonical',
    'Canonical property-type label',
    'A display label derived from the raw ITSPE property-type source label. The raw label is retained.',
    'property_account',
    'text',
    null,
    'record date',
    array['PROPTYPE'],
    array['property category'],
    array['raw property type'],
    'Null means the source property type was blank.',
    null,
    'Derived for usability; consult property_type_source for the exact official source value.',
    'derived',
    'canonical-property-type-v1',
    true,
    true
  ),
  (
    'tax.total_liabilities_reported',
    '$.tax_and_balance.total_liabilities_reported_cents',
    'Total liabilities reported',
    'The ITSPE TOTDUEAMT field, whose official alias is Total of all liabilities.',
    'tax_account',
    'integer',
    'cents',
    'record date',
    array['TOTDUEAMT'],
    array['total liabilities'],
    array['current balance', 'payoff amount', 'annual tax'],
    'Null means the source did not report an amount; zero is a reported amount.',
    null,
    'This is not the amount currently owed. Use total_balance for the source-reported current balance.',
    'official',
    null,
    true,
    false
  ),
  (
    'sale.history.date',
    '$.sale_history[].sale_date',
    'CAMA sale date',
    'Sale date reported in the official Tax System Property Sales (CAMA) record.',
    'transfer',
    'date',
    null,
    'reported sale',
    array['SALE_DATE'],
    array['sale date', 'transfer date'],
    array['deed date'],
    'Null means the source did not report a date.',
    null,
    'A 1900-01-01 value is preserved but flagged as a likely source sentinel.',
    'official',
    null,
    true,
    true
  ),
  (
    'sale.history.price',
    '$.sale_history[].sale_price_dollars',
    'CAMA sale price',
    'Sale price reported in the official Tax System Property Sales (CAMA) record.',
    'transfer',
    'integer',
    'USD',
    'reported sale',
    array['SALE_PRICE'],
    array['sale price', 'consideration'],
    array['assessed value', 'appraised value'],
    'Null means the source did not report a price; zero is preserved as a reported value.',
    null,
    'A zero price may represent a nominal or non-market transfer.',
    'official',
    null,
    true,
    true
  ),
  (
    'sale.history.qualified_code',
    '$.sale_history[].qualified_code',
    'CAMA qualification code',
    'Qualified/unqualified indicator reported by CAMA.',
    'transfer',
    'text',
    null,
    'reported sale',
    array['QUALIFIED'],
    array['qualified sale'],
    array['title status'],
    'Null means the source did not report the code.',
    null,
    'Qualification is an assessor sale classification, not a title conclusion.',
    'official',
    null,
    true,
    false
  ),
  (
    'sale.history.sale_code',
    '$.sale_history[].sale_code',
    'CAMA sale code',
    'Sale code reported by CAMA.',
    'transfer',
    'text',
    null,
    'reported sale',
    array['SALE_CODE'],
    array['sale code'],
    array['deed type'],
    'Null means the source did not report the code.',
    null,
    'The raw code is preserved without inferring a Recorder document type.',
    'official',
    null,
    true,
    false
  ),
  (
    'sale.history.current_owner_flag',
    '$.sale_history[].current_owner_flag',
    'Sale relates to current owner',
    'CAMA indicator that the sale is associated with the current owner.',
    'transfer',
    'boolean',
    null,
    'current CAMA extract',
    array['SALE_CURR_OWNER'],
    array['current owner sale'],
    array['proof of ownership'],
    'Null means the source did not report the flag.',
    null,
    'This is an assessor indicator, not proof of legal title.',
    'official',
    null,
    true,
    false
  )
on conflict (field_key) do update set
  json_path = excluded.json_path,
  title = excluded.title,
  definition = excluded.definition,
  entity_name = excluded.entity_name,
  data_type = excluded.data_type,
  unit = excluded.unit,
  time_grain = excluded.time_grain,
  source_fields = excluded.source_fields,
  lender_synonyms = excluded.lender_synonyms,
  commonly_confused_with = excluded.commonly_confused_with,
  null_semantics = excluded.null_semantics,
  aggregation_rule = excluded.aggregation_rule,
  caveat = excluded.caveat,
  definition_status = excluded.definition_status,
  formula_version = excluded.formula_version,
  exposure_allowed = excluded.exposure_allowed,
  search_filter_allowed = excluded.search_filter_allowed;

update semantic.field_definition
set caveat = case field_key
  when 'special.bid_balance' then
    'BID means Business Improvement District. This balance is not a payoff or lien-priority conclusion.'
  when 'special.sews_balance' then
    'SEWS means Southeast Water and Sewer. This balance is not a payoff or lien-priority conclusion.'
  when 'special.pace_balance' then
    'PACE means Property Assessed Clean Energy. A reported balance does not establish assessment or lien priority.'
  when 'special.swwsad_balance' then
    'SWWSAD means Southwest Waterfront Special Assessment District. This balance is not a payoff or lien-priority conclusion.'
end
where field_key in (
  'special.bid_balance',
  'special.sews_balance',
  'special.pace_balance',
  'special.swwsad_balance'
);

insert into semantic.coverage (
  coverage_key,
  entity_name,
  tax_year,
  stage,
  availability_status,
  source_id,
  caveat
) values (
  'cama-sale-history-current',
  'transfer',
  null,
  'sale_history',
  'available',
  'cama_sales_current',
  'Complete downloaded CAMA sale history for active assessment-roll properties as retrieved 2026-07-27; not a Recorder chain of title.'
) on conflict (coverage_key) do update set
  availability_status = excluded.availability_status,
  source_id = excluded.source_id,
  caveat = excluded.caveat;

commit;
