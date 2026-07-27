begin;

insert into meta.source_asset (
  source_id, publisher, dataset_name, source_class,
  official_landing_url, official_download_url, bytes, sha256, row_count,
  archive_capture_at, dataset_retrieved_at, extract_date_min, extract_date_max, limitations
) values
(
  'itspe_2017_archive', 'District of Columbia', 'Integrated Tax System Public Extract',
  'archived_official_snapshot',
  'https://opendata.dc.gov/',
  'https://web.archive.org/web/20170216211948id_/http://opendata.dc.gov/datasets/496533836db640bcade61dd9078b0d63_53.csv',
  225281177, 'ee9915a77d8bab591b8bb12c99bf148142a1c19a7e74eb21df02aeec8a4bb845',
  218027, '2017-02-16T21:19:48Z', null, '2017-02-04', '2017-02-04',
  'Archived copy of a D.C. official publication; not a live record.'
),
(
  'itspe_2021_archive', 'District of Columbia', 'Integrated Tax System Public Extract',
  'archived_official_snapshot',
  'https://opendata.dc.gov/',
  'https://web.archive.org/web/20211126114211id_/https://opendata.dc.gov/datasets/496533836db640bcade61dd9078b0d63_53.csv',
  195185233, '244868a74ca3f82ba8abcca24c987d8e0c5c4635b94d3c4a171a4f920355d1f6',
  212841, '2021-11-26T11:42:11Z', null, '2021-10-08', '2021-11-23',
  'Contains 15 blank SSL rows and one duplicated SSL key; conflicts are preserved.'
),
(
  'itspe_current', 'District of Columbia', 'Integrated Tax System Public Extract',
  'live_official',
  'https://opendata.dc.gov/datasets/DCGIS::integrated-tax-system-public-extract/about',
  'https://opendata.dc.gov/api/download/v1/items/1476813cbc2d458394ce586ce06d3edd/csv?layers=53',
  215078178, '7c9c083bdabf28b2b1c161c1b80d02841f7862f1ff0b90b28d8576b663351719',
  221263, null, '2026-07-26T17:50:23-04:00', '2024-03-01', '2026-06-22',
  'Record dates vary by row. Retrieval date is not the fact effective date.'
)
on conflict (source_id) do update set
  bytes = excluded.bytes,
  sha256 = excluded.sha256,
  row_count = excluded.row_count,
  dataset_retrieved_at = excluded.dataset_retrieved_at,
  limitations = excluded.limitations;

insert into semantic.field_definition (
  field_key, json_path, title, definition, entity_name, data_type, unit, time_grain,
  source_fields, lender_synonyms, commonly_confused_with, null_semantics,
  aggregation_rule, caveat, definition_status, exposure_allowed, search_filter_allowed
) values
('property.ssl', '$.identity.ssl', 'Square, suffix, lot identifier',
 'The source-reported D.C. real-property tax account identifier.', 'property_account', 'text', null, 'record date',
 array['SSL'], array['SSL','parcel number','tax account'], array['physical parcel','collateral'],
 'Null is not expected for current accounts.', null,
 'A tax account is not guaranteed to equal one physical parcel.', 'official', true, false),
('property.premise_address', '$.identity.premise_address', 'Premise address',
 'The situs address reported for the tax account.', 'property_account', 'text', null, 'record date',
 array['PREMISEADD'], array['property address','situs'], array['mailing address'],
 'Null means the source did not report a premise address.', null, null, 'official', true, false),
('property.ward', '$.identity.ward', 'Ward',
 'The D.C. ward code reported by the source.', 'property_account', 'text', null, 'record date',
 array['WARD'], array['ward'], array[]::text[],
 'Null means the source did not report a ward.', null, null, 'official', true, true),
('classification.property_type', '$.classification.property_type', 'Property type',
 'The source property-type label; no remapping is inferred.', 'property_account', 'text', null, 'record date',
 array['PROPERTYTYP'], array['property type','asset type'], array['use code'],
 'Null means the source did not report a label.', null,
 'Treat as a source label, not an independent underwriting classification.', 'source_label_only', true, true),
('classification.use_code', '$.classification.use_code', 'Use code',
 'The use code carried by ITSPE.', 'property_account', 'text', null, 'record date',
 array['USECODE'], array['use code'], array['zoning'],
 'Null means the source did not report a use code.', null,
 'A use code is not proof of zoning compliance.', 'official', true, true),
('classification.tax_class', '$.classification.tax_class', 'Tax class',
 'The real-property tax class reported by ITSPE.', 'property_account', 'text', null, 'record date',
 array['TAXCLASS'], array['tax class'], array['use code'],
 'Null means the source did not report a tax class.', null, null, 'official', true, false),
('property.land_area', '$.classification.land_area_sqft', 'Land area',
 'The land-area figure reported by ITSPE.', 'property_account', 'integer', 'square feet', 'record date',
 array['LANDAREA'], array['lot area','land area'], array['building area','gross square feet'],
 'Null means the source did not report an area.', 'Do not sum across accounts without resolving parcel relationships.',
 'This is not building area.', 'official', true, false),
('ownership.owner_name', '$.ownership.owner_name', 'Owner name of record',
 'The owner name carried by the assessor extract.', 'property_account', 'text', null, 'record date',
 array['OWNERNAME'], array['owner','borrower'], array['legal owner','borrowing entity'],
 'Null means the source did not report an owner name.', null,
 'Not proof of title, authority, or borrower identity.', 'official', true, false),
('ownership.owner_occupancy_flag', '$.ownership.owner_occupancy_flag', 'Owner occupancy flag',
 'The source-reported owner-occupancy indicator.', 'property_account', 'text', null, 'record date',
 array['OWNEROCC'], array['owner occupied'], array['commercial occupancy','tenant occupancy'],
 'Null means the source did not report the indicator.', null,
 'Not a measure of tenant occupancy or leased percentage.', 'official', true, false),
('assessment.current_total_value', '$.valuation.current_total_value_dollars', 'Current total assessed value',
 'The current-stage total assessed value in the selected ITSPE record.', 'assessment', 'integer', 'USD', 'tax-year stage and record date',
 array['ASSESSMENTTOT'], array['assessment','assessed value'], array['market value','appraised value','proposed assessment'],
 'Null means the source did not report a value; it is not zero.', 'Do not add repeated snapshot values.',
 'An assessment is not an appraisal or lending value.', 'official', true, true),
('assessment.proposed_total_value', '$.valuation.proposed_total_value_dollars', 'Proposed total assessed value',
 'The proposed-stage total assessed value in the selected ITSPE record.', 'assessment', 'integer', 'USD', 'tax-year stage and record date',
 array['ASSESSMENTTOTPROPOSED'], array['proposed assessment'], array['current assessment'],
 'Null means the source did not report a proposed value.', 'Do not combine with current or prior stages.',
 'Proposed values may not become final.', 'official', true, false),
('tax.annual_tax', '$.tax_and_balance.annual_tax_cents', 'Annual tax',
 'The annual-tax amount reported by the current ITSPE record.', 'tax_account', 'integer', 'cents', 'record date',
 array['ANNUALTAX'], array['property tax','annual tax'], array['total due','tax bill'],
 'Null means the source did not report an amount; it is not zero.', 'Do not sum with slot taxes without understanding source overlap.',
 'This is not a reproduced tax bill.', 'official', true, false),
('tax.total_due', '$.tax_and_balance.total_due_cents', 'Total due',
 'The total-due amount reported by the current ITSPE record.', 'tax_account', 'integer', 'cents', 'record date',
 array['TOTALDUE'], array['amount due'], array['annual tax','balance'],
 'Null means the source did not report an amount; it is not zero.', null, null, 'official', true, false),
('tax.total_balance', '$.tax_and_balance.total_balance_cents', 'Total balance',
 'The total balance reported by the current ITSPE record.', 'tax_account', 'integer', 'cents', 'record date',
 array['TOTALBAL'], array['tax balance','arrears'], array['total due'],
 'Null means the source did not report an amount; it is not zero.', null,
 'Does not establish lien priority or payoff amount.', 'official', true, false),
('sale.latest_price', '$.latest_transfer.sale_price_dollars', 'Latest reported sale price',
 'The latest sale price carried by the current ITSPE record.', 'transfer', 'integer', 'USD', 'record date and reported sale date',
 array['SALEPRICE'], array['sale price','consideration'], array['appraised value'],
 'Null means the source did not report a price.', null,
 'ITSPE does not provide a complete transfer or title history.', 'official', true, false),
('sale.latest_date', '$.latest_transfer.sale_date', 'Latest reported sale date',
 'The latest sale date carried by the current ITSPE record.', 'transfer', 'date', null, 'reported sale date',
 array['SALEDATE'], array['sale date','transfer date'], array['deed date'],
 'Null means the source did not report a date.', null,
 'ITSPE does not provide a complete transfer or title history.', 'official', true, false),
('deed.latest_instrument_number', '$.latest_transfer.instrument_number', 'Latest instrument number',
 'The latest instrument identifier carried by ITSPE.', 'transfer', 'text', null, 'record date',
 array['INSTRUMENTNO'], array['instrument number','deed number'], array['title report'],
 'Null means the source did not report an identifier.', null,
 'This is not proof of title or a complete recorder search.', 'official', true, false)
on conflict (field_key) do update set
  definition = excluded.definition,
  lender_synonyms = excluded.lender_synonyms,
  caveat = excluded.caveat;

insert into semantic.field_definition (
  field_key, json_path, title, definition, entity_name, data_type, unit,
  time_grain, source_fields, null_semantics, aggregation_rule, caveat,
  definition_status, exposure_allowed, search_filter_allowed
)
select
  v.field_key, '$', v.title, v.definition, v.entity_name, v.data_type, v.unit,
  v.time_grain, v.source_fields,
  'Null means the source did not report a value; it does not mean zero or none.',
  v.aggregation_rule, v.caveat, 'official', true, false
from (values
  ('assessment.land_value','Land assessed value','Source-reported assessed value allocated to land.','assessment','integer','USD','tax-year stage and record date',array['OLDLAND','PHASELAND','NEWLAND']::text[],'Do not add repeated snapshot values.','Not an appraisal or lending value.'),
  ('assessment.improvement_value','Improvement assessed value','Source-reported assessed value allocated to improvements.','assessment','integer','USD','tax-year stage and record date',array['OLDIMPR','PHASEBUILD','NEWIMPR']::text[],'Do not add repeated snapshot values.','Not an appraisal or verified building value.'),
  ('assessment.total_value','Total assessed value','Source-reported total assessed value for the named stage and year.','assessment','integer','USD','tax-year stage and record date',array['OLDTOTAL','ASSESSMENT','NEWTOTAL']::text[],'Do not combine prior, current, proposed, or repeated snapshots.','Not an appraisal or lending value.'),
  ('tax.total_collected','Total collected','Current ITSPE total-collected amount.','tax_account','integer','cents','record date',array['TOTCOLAMT']::text[],null,'Not a payment ledger.'),
  ('tax.last_payment_date','Last payment date','Latest payment date reported by current ITSPE.','tax_account','date',null,'record date',array['LASTPAYDT']::text[],null,'Not a complete payment history.'),
  ('tax.slot.tax_sale_flag','Tax-slot tax-sale flag','Tax-sale indicator preserved for the named ITSPE slot.','tax_slot','text',null,'source slot and record date',array['CY1TXSALE','CY2TXSALE','PY1TXSALE..PY10TXSALE']::text[],'Do not aggregate across slots.','A flag is not a title or lien-priority conclusion.'),
  ('tax.slot.tax','Tax-slot tax amount','Tax amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1TAX','CY2TAX','PY1TAX..PY10TAX']::text[],'Do not aggregate across slots without a documented rule.',null),
  ('tax.slot.penalty','Tax-slot penalty','Penalty amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1PEN','CY2PEN','PY1PEN..PY10PEN']::text[],'Do not aggregate across slots without a documented rule.',null),
  ('tax.slot.interest','Tax-slot interest','Interest amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1INT','CY2INT','PY1INT..PY10INT']::text[],'Do not aggregate across slots without a documented rule.',null),
  ('tax.slot.fee','Tax-slot fee','Fee amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1FEE','CY2FEE','PY1FEE..PY10FEE']::text[],'Do not aggregate across slots without a documented rule.',null),
  ('tax.slot.total_due','Tax-slot total due','Total-due amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1TOTDUE','CY2TOTDUE','PY1TOTDUE..PY10TOTDUE']::text[],'Do not aggregate across slots without a documented rule.',null),
  ('tax.slot.collected','Tax-slot collected','Collected amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1COLL','CY2COLL','PY1COLL..PY10COLL']::text[],'Do not aggregate across slots without a documented rule.','Not a payment ledger.'),
  ('tax.slot.balance','Tax-slot balance','Balance amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1BAL','CY2BAL','PY1BAL..PY10BAL']::text[],'Do not aggregate across slots without a documented rule.','Not a payoff or lien-priority conclusion.'),
  ('tax.slot.credit','Tax-slot credit','Credit amount preserved for the named ITSPE slot.','tax_slot','integer','cents','source slot and record date',array['CY1CR','CY2CR','PY1CR..PY10CR']::text[],'Do not aggregate across slots without a documented rule.',null),
  ('special.bid_balance','BID balance','BID balance carried by current ITSPE.','special_balance','integer','cents','record date',array['BIDBALANCE']::text[],null,'Source acronym is preserved without expanding its meaning.'),
  ('special.sews_balance','SEWS balance','SEWS balance carried by current ITSPE.','special_balance','integer','cents','record date',array['SEWSBALANCE']::text[],null,'Source acronym is preserved without expanding its meaning.'),
  ('special.pace_balance','PACE balance','PACE balance carried by current ITSPE.','special_balance','integer','cents','record date',array['PACEBALANCE']::text[],null,'Does not establish assessment or lien priority.'),
  ('special.swwsad_balance','SWWSAD balance','SWWSAD balance carried by current ITSPE.','special_balance','integer','cents','record date',array['SWWSADBALANCE']::text[],null,'Source acronym is preserved without expanding its meaning.'),
  ('ownership.owner_name_2','Second owner-name line','Second owner-name field carried by ITSPE.','property_account','text',null,'record date',array['OWNNAME2']::text[],null,'Not proof of title or borrower identity.'),
  ('ownership.care_of_name','Care-of name','Care-of name carried by the assessor mailing record.','property_account','text',null,'record date',array['CAREOFNAME']::text[],null,'A mailing field is not proof of ownership.'),
  ('ownership.mailing_address_1','Mailing address line 1','First mailing-address line carried by ITSPE.','property_account','text',null,'record date',array['ADDRESS1']::text[],null,'May contain personal information from a public record.'),
  ('ownership.mailing_address_2','Mailing address line 2','Second mailing-address line carried by ITSPE.','property_account','text',null,'record date',array['ADDRESS2']::text[],null,'May contain personal information from a public record.'),
  ('ownership.mailing_city_state_zip','Mailing city, state, ZIP','Mailing locality and postal field carried by ITSPE.','property_account','text',null,'record date',array['CITYSTZIP']::text[],null,'May contain personal information from a public record.'),
  ('sale.latest_type','Latest sale type','Sale-type label for the latest transfer carried by ITSPE.','transfer','text',null,'reported sale date and record date',array['SALETYPE']::text[],null,'Not a complete transfer or title history.'),
  ('sale.latest_acceptance_code','Latest sale acceptance code','Acceptance-code label for the latest transfer carried by ITSPE.','transfer','text',null,'reported sale date and record date',array['ACCEPTCODE']::text[],null,'Meaning is preserved as a source code unless separately documented.'),
  ('deed.latest_date','Latest deed date','Deed date for the latest transfer carried by ITSPE.','transfer','date',null,'reported deed date',array['DEEDDATE']::text[],null,'Not a complete recorder or title history.')
) as v(
  field_key, title, definition, entity_name, data_type, unit, time_grain,
  source_fields, aggregation_rule, caveat
)
on conflict (field_key) do nothing;

insert into semantic.coverage (
  coverage_key, entity_name, tax_year, stage, availability_status, source_id, caveat
) values
('assessment-2016-prior','assessment',2016,'prior','available','itspe_2017_archive',null),
('assessment-2017-current','assessment',2017,'current','available','itspe_2017_archive',null),
('assessment-2018-proposed','assessment',2018,'proposed','available','itspe_2017_archive','Proposed stage.'),
('assessment-2019-gap','assessment',2019,null,'not_available',null,'No complete year found in collected snapshots.'),
('assessment-2020-prior','assessment',2020,'prior','available','itspe_2021_archive',null),
('assessment-2021-current','assessment',2021,'current','available','itspe_2021_archive',null),
('assessment-2022-proposed','assessment',2022,'proposed','available','itspe_2021_archive','Proposed stage.'),
('assessment-2023-gap','assessment',2023,null,'not_available',null,'No complete year found in collected snapshots.'),
('assessment-2024-gap','assessment',2024,null,'not_available',null,'No complete year found in collected snapshots.'),
('assessment-2025-prior','assessment',2025,'prior','available','itspe_current',null),
('assessment-2026-current','assessment',2026,'current','available','itspe_current',null),
('assessment-2027-proposed','assessment',2027,'proposed','available','itspe_current','Proposed stage.')
on conflict (coverage_key) do update set
  availability_status = excluded.availability_status,
  source_id = excluded.source_id,
  caveat = excluded.caveat;

commit;
