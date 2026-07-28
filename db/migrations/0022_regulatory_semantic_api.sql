begin;

-- Security-definer functions below use a fixed system-only search path and
-- schema-qualified objects, following the PostgreSQL and Supabase guidance:
-- https://www.postgresql.org/docs/current/sql-createfunction.html
-- https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker

create table semantic.source_family_definition (
  source_family_key text primary key,
  title text not null,
  definition text not null,
  source_id_pattern text not null,
  record_types text[] not null,
  api_category text not null check (
    api_category in (
      'permit',
      'license',
      'inspection_and_enforcement',
      'building_and_land'
    )
  ),
  recommended_tool text not null check (
    recommended_tool in (
      'get_permit_history',
      'get_license_history',
      'get_inspection_and_enforcement_history',
      'get_building_and_land_profile'
    )
  ),
  portal_family text not null check (
    portal_family in (
      'scout',
      'tops',
      'propertyquest',
      'beam',
      'doee_well',
      'dob_vacant',
      'abca'
    )
  ),
  attribution_scope text not null,
  caveat text not null,
  exposure_allowed boolean not null default true,
  check (cardinality(record_types) > 0)
);

create table semantic.regulatory_field_binding (
  field_key text primary key
    references semantic.field_definition(field_key) on delete cascade,
  record_types text[] not null,
  source_column text not null,
  check (cardinality(record_types) > 0),
  check (nullif(btrim(source_column), '') is not null)
);

alter table semantic.source_family_definition enable row level security;
alter table semantic.regulatory_field_binding enable row level security;

create policy api_owner_read
  on semantic.source_family_definition
  for select to api_owner using (true);
create policy api_owner_read
  on semantic.regulatory_field_binding
  for select to api_owner using (true);

revoke all on table semantic.source_family_definition
  from public, mcp_runtime;
revoke all on table semantic.regulatory_field_binding
  from public, mcp_runtime;
grant select on table semantic.source_family_definition to api_owner;
grant select on table semantic.regulatory_field_binding to api_owner;

insert into semantic.source_family_definition (
  source_family_key,
  title,
  definition,
  source_id_pattern,
  record_types,
  api_category,
  recommended_tool,
  portal_family,
  attribution_scope,
  caveat
) values
  (
    'dob_building_permits',
    'DOB building permits',
    'Official Department of Buildings permit applications and issued permit records.',
    '^dob_building_permits_[0-9]{4}($|_)',
    array['building_permit'],
    'permit',
    'get_permit_history',
    'scout',
    'A record is exact only when the source SSL resolves to one tax account; otherwise it is labeled contextual.',
    'A permit is not proof that work was completed, code-compliant, or finally inspected.'
  ),
  (
    'dob_certificates_of_occupancy',
    'DOB certificates of occupancy',
    'Official Department of Buildings certificates authorizing reported occupancy and use.',
    '^dob_certificate_of_occupancy($|_)',
    array['certificate_of_occupancy'],
    'permit',
    'get_permit_history',
    'scout',
    'Certificate records are associated to the returned property through the explicit property-link label.',
    'A certificate can be superseded, amended, limited to floors or uses, or absent from an open-data extract.'
  ),
  (
    'dlcp_basic_business_licenses',
    'DLCP basic business licenses',
    'Official business-license locations published by the Department of Licensing and Consumer Protection.',
    '^dlcp_basic_business_licenses($|_)',
    array['business_license'],
    'license',
    'get_license_history',
    'scout',
    'The result describes a licensed business at the reported premise; it does not establish ownership of the real estate.',
    'A premise association is not a title, tenant-estoppel, or lease-status conclusion.'
  ),
  (
    'ddot_public_space',
    'DDOT public-space permits and inspections',
    'Official TOPS public-space construction, occupancy, tree, rental, emergency-work, and inspection records.',
    '^ddot_',
    array[
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'inspection'
    ],
    'permit',
    'get_permit_history',
    'tops',
    'These records concern public-space work or occupancy associated with the premise and retain exact/contextual link labels.',
    'A DDOT public-space inspection is not a DOB building or housing inspection.'
  ),
  (
    'dob_home_occupancy',
    'DOB home-occupancy permits',
    'Official home-occupancy permit records associated with reported premises.',
    '^dob_home_occupancy_permits($|_)',
    array['home_occupancy_permit'],
    'permit',
    'get_permit_history',
    'scout',
    'The record is linked through the published SSL, MAR identifier, or address according to the returned link label.',
    'A home-occupancy permit does not establish current operation, zoning compliance outside its terms, or property ownership.'
  ),
  (
    'doee_well_permits',
    'DOEE well permits',
    'Official Department of Energy and Environment well-permit records.',
    '^doee_well_permits($|_)',
    array['well_permit'],
    'permit',
    'get_permit_history',
    'doee_well',
    'Well records may be parcel-linked or contextual depending on the official location identifiers available.',
    'A permit record is not confirmation of current well condition, abandonment, or environmental clearance.'
  ),
  (
    'abca_licenses',
    'ABCA alcohol and medical-cannabis licenses',
    'Official Alcoholic Beverage and Cannabis Administration licensed-location records.',
    '^abca_',
    array['alcohol_license', 'cannabis_license'],
    'license',
    'get_license_history',
    'abca',
    'The result describes a licensed activity at the reported premise, not ownership of the collateral.',
    'License status and operating authority should be confirmed in the official ABCA interface.'
  ),
  (
    'dob_and_ddot_inspections',
    'Official inspections and enforcement',
    'Official inspection and enforcement records retained with their publishing agency identity.',
    '(inspection|enforcement|violation)',
    array['inspection', 'enforcement_action'],
    'inspection_and_enforcement',
    'get_inspection_and_enforcement_history',
    'scout',
    'Agency and property-link context are preserved; DDOT public-space activity is never represented as DOB building activity.',
    'An empty history means no linked record was loaded, not proof that no inspection or violation exists.'
  ),
  (
    'cama_building_profiles',
    'CAMA building profiles',
    'Official CAMA commercial, condominium, and residential building-characteristic records.',
    '^cama_(commercial|condominium|residential)_current($|_)',
    array['cama_building_profile'],
    'building_and_land',
    'get_building_and_land_profile',
    'propertyquest',
    'CAMA profiles are returned only for exact SSL-to-tax-account links.',
    'Assessor characteristics are not a survey, property-condition assessment, zoning determination, or appraisal.'
  ),
  (
    'doee_energy_benchmarking',
    'DOEE energy benchmarking',
    'Official building-level energy and water benchmarking disclosures.',
    '^doee_energy_benchmarking($|_)',
    array['energy_benchmark'],
    'building_and_land',
    'get_building_and_land_profile',
    'beam',
    'Benchmark records are building context and are never labeled as exact tax-account facts.',
    'Reported metrics can cover a whole building containing multiple condominiums or tax accounts.'
  ),
  (
    'doee_beps',
    'DOEE Building Energy Performance Standards',
    'Official BEPS cycle, pathway, target, and compliance fields.',
    '^doee_beps_current($|_)',
    array['beps'],
    'building_and_land',
    'get_building_and_land_profile',
    'beam',
    'BEPS records are building context and retain the published building-to-property attribution quality.',
    'A row does not independently establish final compliance, penalty liability, or satisfaction after its source date.'
  ),
  (
    'dob_vacant_blighted',
    'DOB vacant and blighted classifications',
    'Official vacant, blighted, exemption, and negative classification records.',
    '^dob_vacant_blighted_addresses($|_)',
    array['vacant_blighted'],
    'building_and_land',
    'get_building_and_land_profile',
    'dob_vacant',
    'The returned exact/contextual link label determines whether the classification is parcel-specific or premise context.',
    'Classification and exemption status can change; confirm the current official status before underwriting reliance.'
  ),
  (
    'official_land_designations',
    'Official land designations',
    'Extensible official zoning, historic, environmental, and other land-designation records.',
    '(zoning|historic|flood|land|designation)',
    array['land_designation'],
    'building_and_land',
    'get_building_and_land_profile',
    'propertyquest',
    'Spatial and multi-parcel matches are labeled contextual unless an exact official parcel identifier was available.',
    'Map overlays can be approximate and do not replace agency determinations, surveys, or legal opinions.'
  )
on conflict (source_family_key) do update set
  title = excluded.title,
  definition = excluded.definition,
  source_id_pattern = excluded.source_id_pattern,
  record_types = excluded.record_types,
  api_category = excluded.api_category,
  recommended_tool = excluded.recommended_tool,
  portal_family = excluded.portal_family,
  attribution_scope = excluded.attribution_scope,
  caveat = excluded.caveat,
  exposure_allowed = excluded.exposure_allowed;

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
  exposure_allowed,
  search_filter_allowed
) values
  ('regulatory.record_number', '$.records[*].facts.record_number', 'Official record number', 'Record or permit identifier reported by the publishing agency.', 'regulatory_record', 'text', null, 'record', array['record_number'], array['permit number','license number','case number'], '{}', 'not_reported means the source row did not expose a record number.', null, 'Use source_record_id for immutable provenance even when this display number is absent.', 'official', true, false),
  ('regulatory.status', '$.records[*].facts.status', 'Source-reported status', 'Status label reported by the publishing agency.', 'regulatory_record', 'text', null, 'record', array['record_status'], array['permit status','license status','case status'], '{}', 'not_reported means no status was supplied in the normalized source fields.', null, 'Status vocabularies differ by agency and should not be compared without interpretation.', 'official', true, false),
  ('regulatory.status_date', '$.records[*].facts.status_date', 'Status date', 'Date associated with the source-reported status.', 'regulatory_record', 'date', null, 'record', array['record_status_date'], array['last status date'], '{}', 'not_reported means no status date was supplied.', null, 'The date can represent an update, disposition, or source-specific milestone.', 'official', true, false),
  ('regulatory.premise_address', '$.records[*].facts.premise_address', 'Reported premise address', 'Premise address shown on the official record.', 'regulatory_record', 'text', null, 'record', array['premise_address'], array['job address','license location'], array['property.mailing_address_1'], 'not_reported means no premise address was supplied.', null, 'The premise address is not the owner mailing address.', 'official', true, false),
  ('permit.type', '$.records[*].facts.permit_type', 'Permit type', 'Permit type reported by the issuing agency.', 'permit', 'text', null, 'record', array['permit_type','record_kind'], array['permit class'], '{}', 'not_reported means the source did not supply a permit type.', null, 'Agency permit vocabularies differ.', 'official', true, false),
  ('permit.subtype', '$.records[*].facts.permit_subtype', 'Permit subtype', 'Permit subtype reported by the issuing agency.', 'permit', 'text', null, 'record', array['permit_subtype'], '{}', '{}', 'not_reported means the source did not supply a subtype.', null, 'Interpret with permit type and issuing agency.', 'official', true, false),
  ('permit.work_type', '$.records[*].facts.work_type', 'Work type', 'Source-reported category of permitted work.', 'permit', 'text', null, 'record', array['work_type'], array['scope category'], '{}', 'not_reported means no normalized work type was supplied.', null, 'Work type is not the complete permitted scope.', 'official', true, false),
  ('permit.work_description', '$.records[*].facts.work_description', 'Work description', 'Source-reported narrative description of proposed or permitted work.', 'permit', 'text', null, 'record', array['work_description'], array['scope of work'], '{}', 'not_reported means no description was supplied.', null, 'Descriptions can be abbreviated and do not replace approved plans.', 'official', true, false),
  ('permit.application_date', '$.records[*].facts.application_date', 'Application date', 'Date the permit application was recorded by the source.', 'permit', 'date', null, 'record', array['application_date','source_created_at'], '{}', '{}', 'not_reported means no application date was supplied.', null, 'Application is not issuance.', 'official', true, false),
  ('permit.issue_date', '$.records[*].facts.issue_date', 'Issue date', 'Date the permit or certificate was issued.', 'permit', 'date', null, 'record', array['issue_date'], array['issued date'], '{}', 'not_reported means no issue date was supplied.', null, 'Issue does not prove completion.', 'official', true, false),
  ('permit.expiration_date', '$.records[*].facts.expiration_date', 'Expiration date', 'Source-reported permit or certificate expiration date.', 'permit', 'date', null, 'record', array['expiration_date'], '{}', '{}', 'not_reported means no expiration date was supplied.', null, 'Extensions or later amendments may exist.', 'official', true, false),
  ('permit.finaled_date', '$.records[*].facts.finaled_date', 'Finaled date', 'Date the source reports the permit as finaled.', 'permit', 'date', null, 'record', array['finaled_date'], array['completion date'], '{}', 'not_reported means no finaled date was supplied.', null, 'A source finaled date should be confirmed with the official permit record.', 'official', true, false),
  ('permit.estimated_cost_dollars', '$.records[*].facts.estimated_cost_dollars', 'Estimated construction cost', 'Applicant or source-reported estimated construction cost.', 'permit', 'number', 'USD', 'record', array['estimated_cost_dollars'], array['job cost'], '{}', 'not_reported means no cost was supplied; zero is a reported value.', 'Do not sum without checking amendments and duplicates.', 'Estimated permit cost is not a valuation, budget, or verified expenditure.', 'official', true, false),
  ('permit.fee_cents', '$.records[*].facts.permit_fee_cents', 'Permit fee', 'Source-reported permit fee in cents.', 'permit', 'integer', 'cents', 'record', array['permit_fee_cents'], '{}', '{}', 'not_reported means no fee was supplied; zero is a reported value.', 'Sum only within a defined permit scope.', 'Fees do not measure construction cost.', 'official', true, false),
  ('permit.contractor_name', '$.records[*].facts.contractor_name', 'Contractor name', 'Contractor name reported on the permit.', 'permit', 'text', null, 'record', array['contractor_name'], '{}', array['ownership.owner_name'], 'not_reported means no contractor name was supplied.', null, 'A listed contractor is not proof of current engagement or license standing.', 'official', true, false),
  ('permit.contractor_license_number', '$.records[*].facts.contractor_license_number', 'Contractor license number', 'Contractor license identifier reported on the permit.', 'permit', 'text', null, 'record', array['contractor_license_number'], '{}', '{}', 'not_reported means no license number was supplied.', null, 'Verify current license standing separately.', 'official', true, false),
  ('permit.proposed_use', '$.records[*].facts.proposed_use', 'Proposed use', 'Proposed use reported on a permit or certificate.', 'permit', 'text', null, 'record', array['proposed_use'], '{}', array['classification.use_code'], 'not_reported means no proposed use was supplied.', null, 'Proposed use is not a zoning determination or proof of current occupancy.', 'official', true, false),
  ('permit.existing_use', '$.records[*].facts.existing_use', 'Existing use', 'Existing use reported on a permit or certificate.', 'permit', 'text', null, 'record', array['existing_use'], '{}', array['classification.use_code'], 'not_reported means no existing use was supplied.', null, 'This is a source-reported permit field, not a current-use determination.', 'official', true, false),
  ('permit.number_of_stories', '$.records[*].facts.number_of_stories', 'Reported stories', 'Number of stories reported on the permit.', 'permit', 'number', 'stories', 'record', array['number_of_stories'], '{}', array['building.stories'], 'not_reported means no story count was supplied.', null, 'Permit scope can cover only part of a building.', 'official', true, false),
  ('permit.number_of_units', '$.records[*].facts.number_of_units', 'Reported units', 'Number of units reported on the permit.', 'permit', 'integer', 'units', 'record', array['number_of_units'], '{}', array['building.dwelling_units'], 'not_reported means no unit count was supplied.', null, 'Permit units are not a certified current rent roll.', 'official', true, false),
  ('permit.floor_area_square_feet', '$.records[*].facts.floor_area_square_feet', 'Reported floor area', 'Floor area reported on the permit.', 'permit', 'number', 'square_feet', 'record', array['floor_area_square_feet'], '{}', array['building.gross_building_area_square_feet'], 'not_reported means no floor area was supplied.', null, 'Permit floor area is scope-specific and not a survey.', 'official', true, false),
  ('occupancy.certificate_number', '$.records[*].facts.certificate_number', 'Certificate number', 'Certificate-of-occupancy identifier.', 'certificate_of_occupancy', 'text', null, 'record', array['certificate_number'], array['C of O number'], '{}', 'not_reported means no certificate number was normalized.', null, 'Use the immutable source record ID when the display number is absent.', 'official', true, false),
  ('occupancy.related_permit_number', '$.records[*].facts.related_building_permit_number', 'Related building permit', 'Building-permit number referenced by the certificate.', 'certificate_of_occupancy', 'text', null, 'record', array['related_building_permit_number'], '{}', '{}', 'not_reported means no related permit was supplied.', null, 'The relationship is source-reported.', 'official', true, false),
  ('occupancy.use', '$.records[*].facts.occupancy_use', 'Authorized occupancy use', 'Occupancy use reported by the certificate.', 'certificate_of_occupancy', 'text', null, 'record', array['occupancy_use'], '{}', array['classification.use_code'], 'not_reported means no occupancy use was supplied.', null, 'Read with floors, load, expiration, and later certificates.', 'official', true, false),
  ('occupancy.load', '$.records[*].facts.occupancy_load', 'Occupancy load', 'Occupancy load reported by the certificate.', 'certificate_of_occupancy', 'integer', 'persons', 'record', array['occupancy_load'], '{}', '{}', 'not_reported means no load was supplied.', null, 'This is not a current headcount.', 'official', true, false),
  ('occupancy.floors', '$.records[*].facts.floors_occupied', 'Floors occupied', 'Floors or areas covered by the certificate.', 'certificate_of_occupancy', 'text', null, 'record', array['floors_occupied'], '{}', '{}', 'not_reported means no floors were supplied.', null, 'A certificate can apply to only part of a building.', 'official', true, false),
  ('occupancy.dwelling_units', '$.records[*].facts.dwelling_units', 'Dwelling units', 'Dwelling-unit count reported by the certificate.', 'certificate_of_occupancy', 'integer', 'units', 'record', array['dwelling_units'], '{}', array['building.dwelling_units'], 'not_reported means no dwelling-unit count was supplied.', null, 'This is not a current rent roll or legal-unit opinion.', 'official', true, false),
  ('license.category', '$.records[*].facts.license_category', 'License category', 'Official license category.', 'license', 'text', null, 'record', array['license_category'], '{}', '{}', 'not_reported means no category was supplied.', null, 'Categories differ across licensing agencies.', 'official', true, false),
  ('license.type', '$.records[*].facts.license_type', 'License type', 'Official license type.', 'license', 'text', null, 'record', array['license_type','record_kind'], '{}', '{}', 'not_reported means no type was supplied.', null, 'Interpret within the publishing agency.', 'official', true, false),
  ('license.entity_name', '$.records[*].facts.entity_name', 'Licensed entity', 'Entity name reported on the license.', 'license', 'text', null, 'record', array['entity_name'], array['business name'], array['ownership.owner_name'], 'not_reported means no entity name was supplied.', null, 'A licensed entity at a premise is not necessarily the property owner or borrower.', 'official', true, false),
  ('license.trade_name', '$.records[*].facts.trade_name', 'Trade name', 'Trade name reported on the license.', 'license', 'text', null, 'record', array['trade_name'], array['DBA'], '{}', 'not_reported means no trade name was supplied.', null, 'Trade names can change independently of entity or property ownership.', 'official', true, false),
  ('license.activity_description', '$.records[*].facts.activity_description', 'Licensed activity', 'Activity description reported by the licensing source.', 'license', 'text', null, 'record', array['activity_description'], '{}', '{}', 'not_reported means no activity description was supplied.', null, 'Licensed activity does not prove current operation.', 'official', true, false),
  ('license.issue_date', '$.records[*].facts.issue_date', 'License issue date', 'Source-reported license issue date.', 'license', 'date', null, 'record', array['issue_date'], '{}', '{}', 'not_reported means no issue date was supplied.', null, 'Check later renewals and status.', 'official', true, false),
  ('license.start_date', '$.records[*].facts.start_date', 'License start date', 'Source-reported license start date.', 'license', 'date', null, 'record', array['start_date'], '{}', '{}', 'not_reported means no start date was supplied.', null, 'Start date is not proof of current operation.', 'official', true, false),
  ('license.expiration_date', '$.records[*].facts.expiration_date', 'License expiration date', 'Source-reported expiration date.', 'license', 'date', null, 'record', array['expiration_date'], '{}', '{}', 'not_reported means no expiration date was supplied.', null, 'Renewal or administrative changes may post after the extract.', 'official', true, false),
  ('license.is_active', '$.records[*].facts.is_active', 'Source active flag', 'Boolean active flag normalized from the official source.', 'license', 'boolean', null, 'record', array['is_active'], '{}', '{}', 'not_reported means no reliable active flag was supplied; false is a reported value.', null, 'Confirm current status in the licensing portal.', 'official', true, false),
  ('inspection.type', '$.records[*].facts.inspection_type', 'Inspection type', 'Inspection type reported by the publishing agency.', 'inspection', 'text', null, 'record', array['inspection_type'], '{}', '{}', 'not_reported means no type was supplied.', null, 'DDOT public-space inspections are distinct from DOB building inspections.', 'official', true, false),
  ('inspection.result', '$.records[*].facts.inspection_result', 'Inspection result', 'Result reported by the publishing agency.', 'inspection', 'text', null, 'record', array['inspection_result'], '{}', '{}', 'not_reported means no result was supplied.', null, 'Result vocabularies differ by agency and program.', 'official', true, false),
  ('inspection.completed_at', '$.records[*].facts.completed_at', 'Inspection completion time', 'Source-reported inspection completion timestamp.', 'inspection', 'timestamp', null, 'record', array['completed_at'], '{}', '{}', 'not_reported means no completion timestamp was supplied.', null, 'The timestamp can be source-updated after initial publication.', 'official', true, false),
  ('inspection.agency_context', '$.records[*].facts.agency_context', 'Inspection agency context', 'Plain-language label identifying the kind of official inspection represented.', 'inspection', 'text', null, 'record', array['source_id','inspector_unit'], '{}', '{}', 'not_reported means agency context could not be normalized.', null, 'This field prevents public-space inspection records from being misread as building inspections.', 'derived', true, false),
  ('inspection.violation_count', '$.records[*].facts.violation_count', 'Violation count', 'Source-reported count of violations associated with the inspection.', 'inspection', 'integer', 'violations', 'record', array['violation_count'], '{}', '{}', 'not_reported means no count was supplied; zero is a reported value.', 'Do not sum across duplicate or follow-up inspections without review.', 'A count does not describe severity or current cure status.', 'official', true, false),
  ('enforcement.case_number', '$.records[*].facts.case_number', 'Enforcement case number', 'Official enforcement case identifier.', 'enforcement', 'text', null, 'record', array['case_number'], '{}', '{}', 'not_reported means no case number was supplied.', null, 'Use source_record_id for immutable provenance.', 'official', true, false),
  ('enforcement.action_type', '$.records[*].facts.action_type', 'Enforcement action type', 'Source-reported action type.', 'enforcement', 'text', null, 'record', array['action_type'], '{}', '{}', 'not_reported means no type was supplied.', null, 'Action vocabularies differ by agency.', 'official', true, false),
  ('enforcement.description', '$.records[*].facts.description', 'Enforcement description', 'Source-reported description of the action or condition.', 'enforcement', 'text', null, 'record', array['description'], '{}', '{}', 'not_reported means no description was supplied.', null, 'Descriptions may be abbreviated.', 'official', true, false),
  ('enforcement.opened_date', '$.records[*].facts.opened_date', 'Case opened date', 'Source-reported date the enforcement matter opened.', 'enforcement', 'date', null, 'record', array['opened_date'], '{}', '{}', 'not_reported means no opened date was supplied.', null, 'Opening does not establish current unresolved status.', 'official', true, false),
  ('enforcement.issued_date', '$.records[*].facts.issued_date', 'Action issued date', 'Source-reported action issue date.', 'enforcement', 'date', null, 'record', array['issued_date'], '{}', '{}', 'not_reported means no issue date was supplied.', null, 'Check disposition and later actions.', 'official', true, false),
  ('enforcement.compliance_due_date', '$.records[*].facts.compliance_due_date', 'Compliance due date', 'Source-reported compliance deadline.', 'enforcement', 'date', null, 'record', array['compliance_due_date'], '{}', '{}', 'not_reported means no deadline was supplied.', null, 'Extensions or later orders may change the deadline.', 'official', true, false),
  ('enforcement.closed_date', '$.records[*].facts.closed_date', 'Case closed date', 'Source-reported closure date.', 'enforcement', 'date', null, 'record', array['closed_date'], '{}', '{}', 'not_reported means no closure date was supplied.', null, 'Absence of a closure date is not independently proof the matter remains open.', 'official', true, false),
  ('enforcement.fine_cents', '$.records[*].facts.fine_cents', 'Reported fine', 'Source-reported fine in cents.', 'enforcement', 'integer', 'cents', 'record', array['fine_cents'], '{}', '{}', 'not_reported means no fine was supplied; zero is a reported value.', 'Do not sum without reviewing amendments and duplicate actions.', 'This is not a payoff, lien, or collectible-balance determination.', 'official', true, false),
  ('enforcement.resolution', '$.records[*].facts.resolution', 'Resolution', 'Source-reported enforcement resolution.', 'enforcement', 'text', null, 'record', array['resolution'], '{}', '{}', 'not_reported means no resolution was supplied.', null, 'Confirm current disposition with the issuing agency.', 'official', true, false),
  ('building.type', '$.records[*].facts.building_type', 'CAMA building type', 'Building type reported in the CAMA profile.', 'building_profile', 'text', null, 'record', array['building_type'], '{}', '{}', 'not_reported means the CAMA row did not supply a type.', null, 'Assessor classification is not a property-condition assessment.', 'official', true, false),
  ('building.use_description', '$.records[*].facts.use_description', 'CAMA use description', 'Building use description reported by CAMA.', 'building_profile', 'text', null, 'record', array['use_description'], '{}', array['classification.use_code'], 'not_reported means no use description was supplied.', null, 'This is not a zoning determination.', 'official', true, false),
  ('building.year_built', '$.records[*].facts.year_built', 'Year built', 'Year built reported by CAMA.', 'building_profile', 'integer', 'year', 'record', array['year_built'], array['construction year'], '{}', 'not_reported means no year was supplied.', null, 'Assessor year built can be approximate.', 'official', true, false),
  ('building.year_renovated', '$.records[*].facts.year_renovated', 'Year renovated', 'Renovation year reported by CAMA.', 'building_profile', 'integer', 'year', 'record', array['year_renovated'], '{}', '{}', 'not_reported means no renovation year was supplied.', null, 'This does not establish renovation scope, cost, permits, or condition.', 'official', true, false),
  ('building.stories', '$.records[*].facts.stories', 'CAMA stories', 'Number of stories reported by CAMA.', 'building_profile', 'number', 'stories', 'record', array['stories'], '{}', array['permit.number_of_stories'], 'not_reported means no story count was supplied.', null, 'Confirm physical configuration independently.', 'official', true, false),
  ('building.bedrooms', '$.records[*].facts.bedrooms', 'Bedrooms', 'Bedroom count reported by CAMA.', 'building_profile', 'integer', 'rooms', 'record', array['bedrooms'], '{}', '{}', 'not_reported means no bedroom count was supplied.', null, 'Not a certified legal bedroom count.', 'official', true, false),
  ('building.full_bathrooms', '$.records[*].facts.full_bathrooms', 'Full bathrooms', 'Full-bathroom count reported by CAMA.', 'building_profile', 'integer', 'rooms', 'record', array['full_bathrooms'], '{}', '{}', 'not_reported means no count was supplied.', null, 'Assessor characteristics can lag physical changes.', 'official', true, false),
  ('building.half_bathrooms', '$.records[*].facts.half_bathrooms', 'Half bathrooms', 'Half-bathroom count reported by CAMA.', 'building_profile', 'integer', 'rooms', 'record', array['half_bathrooms'], '{}', '{}', 'not_reported means no count was supplied.', null, 'Assessor characteristics can lag physical changes.', 'official', true, false),
  ('building.gross_area_square_feet', '$.records[*].facts.gross_building_area_square_feet', 'Gross building area', 'Gross building area reported by CAMA.', 'building_profile', 'number', 'square_feet', 'record', array['gross_building_area_square_feet'], array['GBA'], array['permit.floor_area_square_feet'], 'not_reported means no area was supplied.', null, 'Not a survey or rentable-area measurement.', 'official', true, false),
  ('building.living_area_square_feet', '$.records[*].facts.living_area_square_feet', 'Living area', 'Living area reported by CAMA.', 'building_profile', 'number', 'square_feet', 'record', array['living_area_square_feet'], '{}', array['building.gross_area_square_feet'], 'not_reported means no area was supplied.', null, 'Not a survey or rent-roll measurement.', 'official', true, false),
  ('building.grade', '$.records[*].facts.grade', 'CAMA grade', 'Building grade reported by CAMA.', 'building_profile', 'text', null, 'record', array['grade'], '{}', '{}', 'not_reported means no grade was supplied.', null, 'Grade is an assessor label, not an engineering conclusion.', 'official', true, false),
  ('building.condition', '$.records[*].facts.condition', 'CAMA condition', 'Building condition label reported by CAMA.', 'building_profile', 'text', null, 'record', array['condition'], '{}', '{}', 'not_reported means no condition was supplied.', null, 'Not a current property-condition assessment.', 'official', true, false),
  ('energy.reporting_year', '$.records[*].facts.reporting_year', 'Benchmark reporting year', 'Calendar year covered by the energy benchmark disclosure.', 'energy_benchmark', 'integer', 'year', 'annual', array['reporting_year'], '{}', '{}', 'Always reported for a normalized benchmark row.', null, 'Reporting year differs from publication date.', 'official', true, false),
  ('energy.reporting_status', '$.records[*].facts.reporting_status', 'Benchmark reporting status', 'Source-reported benchmark status.', 'energy_benchmark', 'text', null, 'annual', array['reporting_status'], '{}', '{}', 'not_reported means no status was supplied.', null, 'Status vocabularies can change by reporting cycle.', 'official', true, false),
  ('energy.property_name', '$.records[*].facts.property_name', 'Benchmark property name', 'Building name reported in the benchmark disclosure.', 'energy_benchmark', 'text', null, 'annual', array['property_name'], '{}', array['ownership.owner_name'], 'not_reported means no name was supplied.', null, 'The property name is not an ownership assertion.', 'official', true, false),
  ('energy.primary_property_type', '$.records[*].facts.primary_property_type', 'Benchmark property type', 'Primary property type reported for benchmarking.', 'energy_benchmark', 'text', null, 'annual', array['primary_property_type'], '{}', array['property.property_type'], 'not_reported means no type was supplied.', null, 'Benchmarking taxonomy differs from assessor classifications.', 'official', true, false),
  ('energy.gross_floor_area_square_feet', '$.records[*].facts.gross_floor_area_square_feet', 'Benchmark gross floor area', 'Gross floor area used for benchmarking.', 'energy_benchmark', 'number', 'square_feet', 'annual', array['gross_floor_area_square_feet'], array['benchmark GFA'], array['building.gross_area_square_feet'], 'not_reported means no area was supplied.', null, 'Building-level area can cover multiple tax accounts.', 'official', true, false),
  ('energy.energy_star_score', '$.records[*].facts.energy_star_score', 'ENERGY STAR score', 'Source-reported ENERGY STAR score from 0 to 100.', 'energy_benchmark', 'integer', 'score', 'annual', array['energy_star_score'], '{}', '{}', 'not_reported means no score was supplied; zero is a reported score.', null, 'Eligibility and methodology vary by property type and year.', 'official', true, false),
  ('energy.site_eui', '$.records[*].facts.site_eui_kbtu_per_square_foot', 'Site EUI', 'Site energy use intensity reported in kBtu per square foot.', 'energy_benchmark', 'number', 'kBtu_per_square_foot', 'annual', array['site_eui_kbtu_per_square_foot'], array['site energy intensity'], '{}', 'not_reported means no metric was supplied; zero is a reported value.', 'Compare only compatible years and building scopes.', 'Building-level metric can span multiple tax accounts.', 'official', true, false),
  ('energy.source_eui', '$.records[*].facts.source_eui_kbtu_per_square_foot', 'Source EUI', 'Source energy use intensity reported in kBtu per square foot.', 'energy_benchmark', 'number', 'kBtu_per_square_foot', 'annual', array['source_eui_kbtu_per_square_foot'], '{}', array['energy.site_eui'], 'not_reported means no metric was supplied; zero is a reported value.', 'Compare only compatible years and building scopes.', 'Building-level metric can span multiple tax accounts.', 'official', true, false),
  ('energy.ghg_metric_tons', '$.records[*].facts.total_ghg_emissions_metric_tons', 'Total GHG emissions', 'Total greenhouse-gas emissions reported in metric tons.', 'energy_benchmark', 'number', 'metric_tons', 'annual', array['total_ghg_emissions_metric_tons'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', 'Compare only compatible reporting scopes and years.', 'Source methodology and verification status should be reviewed.', 'official', true, false),
  ('energy.electricity_kwh', '$.records[*].facts.electricity_kwh', 'Electricity use', 'Annual electricity use reported in kWh.', 'energy_benchmark', 'number', 'kWh', 'annual', array['electricity_kwh'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', 'Do not combine across overlapping building records.', 'Building-level usage can span multiple tax accounts.', 'official', true, false),
  ('energy.natural_gas_therms', '$.records[*].facts.natural_gas_therms', 'Natural gas use', 'Annual natural-gas use reported in therms.', 'energy_benchmark', 'number', 'therms', 'annual', array['natural_gas_therms'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', 'Do not combine across overlapping building records.', 'Building-level usage can span multiple tax accounts.', 'official', true, false),
  ('energy.water_gallons', '$.records[*].facts.water_gallons', 'Water use', 'Annual water use reported in gallons.', 'energy_benchmark', 'number', 'gallons', 'annual', array['water_gallons'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', 'Do not combine across overlapping building records.', 'Building-level usage can span multiple tax accounts.', 'official', true, false),
  ('beps.compliance_cycle', '$.records[*].facts.compliance_cycle', 'BEPS compliance cycle', 'Official BEPS compliance cycle identifier.', 'beps', 'text', null, 'cycle', array['compliance_cycle'], '{}', '{}', 'Always reported for a normalized BEPS row.', null, 'Interpret with current DOEE rules and source date.', 'official', true, false),
  ('beps.compliance_status', '$.records[*].facts.compliance_status', 'BEPS compliance status', 'Source-reported BEPS compliance status.', 'beps', 'text', null, 'cycle', array['compliance_status'], '{}', '{}', 'not_reported means no status was supplied.', null, 'Confirm final status and later determinations with DOEE.', 'official', true, false),
  ('beps.compliance_pathway', '$.records[*].facts.compliance_pathway', 'BEPS pathway', 'Source-reported BEPS compliance pathway.', 'beps', 'text', null, 'cycle', array['compliance_pathway'], '{}', '{}', 'not_reported means no pathway was supplied.', null, 'A pathway can be amended or subject to agency determination.', 'official', true, false),
  ('beps.baseline_year', '$.records[*].facts.baseline_year', 'BEPS baseline year', 'Baseline year reported for the BEPS record.', 'beps', 'integer', 'year', 'cycle', array['baseline_year'], '{}', '{}', 'not_reported means no baseline year was supplied.', null, 'Review the applicable cycle methodology.', 'official', true, false),
  ('beps.target_year', '$.records[*].facts.target_year', 'BEPS target year', 'Target year reported for the BEPS record.', 'beps', 'integer', 'year', 'cycle', array['target_year'], '{}', '{}', 'not_reported means no target year was supplied.', null, 'Deadlines and extensions can change.', 'official', true, false),
  ('beps.baseline_metric', '$.records[*].facts.baseline_metric', 'BEPS baseline metric', 'Source-reported baseline metric.', 'beps', 'number', null, 'cycle', array['baseline_metric'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', null, 'Metric meaning depends on the pathway and cycle.', 'official', true, false),
  ('beps.target_metric', '$.records[*].facts.target_metric', 'BEPS target metric', 'Source-reported target metric.', 'beps', 'number', null, 'cycle', array['target_metric'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', null, 'Metric meaning depends on the pathway and cycle.', 'official', true, false),
  ('beps.reported_metric', '$.records[*].facts.reported_metric', 'BEPS reported metric', 'Source-reported performance metric.', 'beps', 'number', null, 'cycle', array['reported_metric'], '{}', '{}', 'not_reported means no metric was supplied; zero is a reported value.', null, 'A reported metric does not independently establish final compliance.', 'official', true, false),
  ('beps.determination_date', '$.records[*].facts.determination_date', 'BEPS determination date', 'Source-reported determination date.', 'beps', 'date', null, 'cycle', array['determination_date'], '{}', '{}', 'not_reported means no date was supplied.', null, 'Later determinations may supersede it.', 'official', true, false),
  ('beps.compliance_deadline', '$.records[*].facts.compliance_deadline', 'BEPS compliance deadline', 'Source-reported compliance deadline.', 'beps', 'date', null, 'cycle', array['compliance_deadline'], '{}', '{}', 'not_reported means no deadline was supplied.', null, 'Extensions or rule changes may apply.', 'official', true, false),
  ('beps.penalty_cents', '$.records[*].facts.penalty_cents', 'BEPS penalty', 'Source-reported penalty in cents.', 'beps', 'integer', 'cents', 'cycle', array['penalty_cents'], '{}', '{}', 'not_reported means no penalty was supplied; zero is a reported value.', 'Do not sum across superseded cycle rows.', 'This is not a payoff or lien determination.', 'official', true, false),
  ('vacancy.classification', '$.records[*].facts.classification', 'Vacant/blighted classification', 'Normalized official vacant, blighted, exemption, negative, or unknown classification.', 'vacant_blighted', 'text', null, 'record', array['classification'], '{}', '{}', 'Always reported for a normalized classification row.', null, 'Confirm current classification and exemption status with DOB and OTR.', 'official', true, false),
  ('vacancy.source_classification', '$.records[*].facts.source_classification', 'Source classification label', 'Original classification label reported by the source.', 'vacant_blighted', 'text', null, 'record', array['source_classification'], '{}', '{}', 'not_reported means no original label was preserved.', null, 'Use the normalized classification for comparisons and retain this label for verification.', 'official', true, false),
  ('vacancy.status', '$.records[*].facts.status', 'Vacancy status', 'Source-reported status associated with the classification.', 'vacant_blighted', 'text', null, 'record', array['status'], '{}', '{}', 'not_reported means no status was supplied.', null, 'Status can change after the source date.', 'official', true, false),
  ('vacancy.effective_date', '$.records[*].facts.effective_date', 'Vacancy effective date', 'Source-reported effective date.', 'vacant_blighted', 'date', null, 'record', array['effective_date'], '{}', '{}', 'not_reported means no effective date was supplied.', null, 'Confirm current status before reliance.', 'official', true, false),
  ('vacancy.expiration_date', '$.records[*].facts.expiration_date', 'Vacancy expiration date', 'Source-reported expiration date for a status or exemption.', 'vacant_blighted', 'date', null, 'record', array['expiration_date'], '{}', '{}', 'not_reported means no expiration date was supplied.', null, 'Later agency action may supersede it.', 'official', true, false),
  ('vacancy.exemption_reason', '$.records[*].facts.exemption_reason', 'Vacancy exemption reason', 'Source-reported exemption reason.', 'vacant_blighted', 'text', null, 'record', array['exemption_reason'], '{}', '{}', 'not_reported means no exemption reason was supplied.', null, 'An exemption can be conditional, time-limited, or revoked.', 'official', true, false),
  ('land.designation_system', '$.records[*].facts.designation_system', 'Designation system', 'Official system or program defining the land designation.', 'land_designation', 'text', null, 'record', array['designation_system'], '{}', '{}', 'Always reported for a normalized designation row.', null, 'Interpret within the issuing authority.', 'official', true, false),
  ('land.designation_type', '$.records[*].facts.designation_type', 'Designation type', 'Official type of land designation.', 'land_designation', 'text', null, 'record', array['designation_type'], '{}', '{}', 'Always reported for a normalized designation row.', null, 'Map overlays and legal designations can differ in precision.', 'official', true, false),
  ('land.designation_code', '$.records[*].facts.designation_code', 'Designation code', 'Official designation code when supplied.', 'land_designation', 'text', null, 'record', array['designation_code'], '{}', '{}', 'not_reported means no code was supplied.', null, 'Use with system, type, and name.', 'official', true, false),
  ('land.designation_name', '$.records[*].facts.designation_name', 'Designation name', 'Official designation name when supplied.', 'land_designation', 'text', null, 'record', array['designation_name'], '{}', '{}', 'not_reported means no name was supplied.', null, 'A name alone does not define the controlling boundary.', 'official', true, false),
  ('land.designation_status', '$.records[*].facts.designation_status', 'Designation status', 'Source-reported designation status.', 'land_designation', 'text', null, 'record', array['designation_status'], '{}', '{}', 'not_reported means no status was supplied.', null, 'Confirm final legal status with the issuing authority.', 'official', true, false),
  ('land.issuing_authority', '$.records[*].facts.issuing_authority', 'Issuing authority', 'Agency or authority reported for the designation.', 'land_designation', 'text', null, 'record', array['issuing_authority'], '{}', '{}', 'not_reported means no authority was supplied.', null, 'The responsible verification portal depends on the designation system.', 'official', true, false),
  ('land.effective_date', '$.records[*].facts.effective_date', 'Designation effective date', 'Source-reported effective date.', 'land_designation', 'date', null, 'record', array['effective_date'], '{}', '{}', 'not_reported means no effective date was supplied.', null, 'Later amendments may apply.', 'official', true, false),
  ('land.expiration_date', '$.records[*].facts.expiration_date', 'Designation expiration date', 'Source-reported expiration date.', 'land_designation', 'date', null, 'record', array['expiration_date'], '{}', '{}', 'not_reported means no expiration date was supplied.', null, 'Absence of an expiration date does not prove permanence.', 'official', true, false)
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
  exposure_allowed = excluded.exposure_allowed,
  search_filter_allowed = excluded.search_filter_allowed;

insert into semantic.regulatory_field_binding (
  field_key,
  record_types,
  source_column
)
select
  f.field_key,
  case
    when f.field_key like 'regulatory.%' then array[
      'building_permit',
      'certificate_of_occupancy',
      'business_license',
      'inspection',
      'enforcement_action',
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'home_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'well_permit',
      'alcohol_license',
      'cannabis_license'
    ]
    when f.field_key like 'permit.%' then array[
      'building_permit',
      'certificate_of_occupancy',
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'home_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'well_permit'
    ]
    when f.field_key like 'occupancy.%'
      then array['certificate_of_occupancy']
    when f.field_key like 'license.%' then array[
      'business_license',
      'alcohol_license',
      'cannabis_license'
    ]
    when f.field_key like 'inspection.%' then array['inspection']
    when f.field_key like 'enforcement.%' then array['enforcement_action']
    when f.field_key like 'building.%' then array['cama_building_profile']
    when f.field_key like 'energy.%' then array['energy_benchmark']
    when f.field_key like 'beps.%' then array['beps']
    when f.field_key like 'vacancy.%' then array['vacant_blighted']
    when f.field_key like 'land.%' then array['land_designation']
  end,
  f.source_fields[1]
from semantic.field_definition f
where f.field_key ~
  '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
on conflict (field_key) do update set
  record_types = excluded.record_types,
  source_column = excluded.source_column;

insert into semantic.coverage (
  coverage_key,
  entity_name,
  tax_year,
  stage,
  availability_status,
  source_id,
  caveat
) values
  ('regulatory_permits_current', 'permit', null, 'current_snapshot', 'available_when_linked', null, 'Curated official permit records are returned only when an explicit source-record property link exists.'),
  ('regulatory_licenses_current', 'license', null, 'current_snapshot', 'available_when_linked', null, 'Curated official license-location records are premise associations, not property ownership.'),
  ('regulatory_inspections_current', 'inspection_and_enforcement', null, 'current_snapshot', 'available_when_linked', null, 'Publishing agency identity is preserved; no record is relabeled as a different agency inspection.'),
  ('regulatory_building_land_current', 'building_and_land', null, 'current_snapshot', 'available_when_linked', null, 'Building-level and multi-parcel sources are explicitly contextual rather than exact.')
on conflict (coverage_key) do update set
  entity_name = excluded.entity_name,
  tax_year = excluded.tax_year,
  stage = excluded.stage,
  availability_status = excluded.availability_status,
  source_id = excluded.source_id,
  caveat = excluded.caveat;

set local role api_owner;

create or replace function api_v1._regulatory_property_link(
  p_scope text,
  p_method text,
  p_quality text,
  p_confidence numeric
) returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select jsonb_build_object(
    'scope', p_scope,
    'method', p_method,
    'quality', p_quality,
    'confidence', p_confidence,
    'is_exact_property', p_scope = 'exact_property',
    'interpretation', case p_scope
      when 'exact_property' then
        'The source record is linked to this exact D.C. tax account.'
      when 'shared_building' then
        'Building-level or shared-premise context; it can apply to multiple tax accounts and is not an exact parcel assertion.'
      when 'multi_parcel' then
        'The official record spans or references multiple parcels; it is contextual for this tax account.'
      when 'proximity_context' then
        'Nearby or spatial context only; it is not asserted as a fact about this exact parcel.'
      else
        'Link scope was not recognized; do not treat the record as exact.'
    end
  );
$function$;

create or replace function api_v1._regulatory_binding_sha256(
  p_source_id text,
  p_source_release_id bigint,
  p_source_record_id bigint,
  p_source_row_sha256 text,
  p_field_key text,
  p_ssl text
) returns text
language sql
immutable
parallel safe
returns null on null input
set search_path = pg_catalog, pg_temp
as $function$
  select encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'field_key', p_field_key,
          'source_id', p_source_id,
          'source_record_id', p_source_record_id,
          'source_release_id', p_source_release_id,
          'source_row_sha256', p_source_row_sha256,
          'ssl', api_v1._normalize_ssl(p_ssl)
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
  where p_source_release_id > 0
    and p_source_record_id > 0
    and p_source_row_sha256 ~ '^[0-9a-f]{64}$'
    and nullif(p_source_id, '') is not null
    and p_source_id !~ '[|]'
    and nullif(p_field_key, '') is not null
    and p_field_key !~ '[|]'
    and api_v1._normalize_ssl(p_ssl) is not null;
$function$;

create or replace function api_v1._regulatory_source_ref(
  p_source_id text,
  p_source_release_id bigint,
  p_source_record_id bigint,
  p_source_row_sha256 text,
  p_field_key text,
  p_ssl text
) returns text
language sql
immutable
parallel safe
returns null on null input
set search_path = pg_catalog, pg_temp
as $function$
  with binding as (
    select
      api_v1._normalize_ssl(p_ssl) ssl,
      api_v1._regulatory_binding_sha256(
        p_source_id,
        p_source_release_id,
        p_source_record_id,
        p_source_row_sha256,
        p_field_key,
        p_ssl
      ) binding_sha256
  )
  select
    p_source_id || '|' ||
    p_source_release_id::text || '|' ||
    p_source_record_id::text || '|' ||
    p_field_key || '|' ||
    b.binding_sha256 || '|' ||
    b.ssl
  from binding b
  where b.binding_sha256 is not null
    and b.ssl is not null;
$function$;

create or replace function api_v1._fact(
  p_value anyelement,
  p_field_key text,
  p_record_date date,
  p_source_ref text
) returns jsonb
language sql
stable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  with ref as (
    select string_to_array(p_source_ref, '|') parts
  ),
  flags as (
    select case
      when p_field_key = 'ownership.mailing_city_state_zip'
        and upper(coalesce(p_value::text, '')) like '%SEOUL%'
        and upper(coalesce(p_value::text, '')) like '%NORTH KOREA%'
        then jsonb_build_array('mailing_jurisdiction_conflict')
      when p_field_key = 'classification.property_type'
        and length(coalesce(p_value::text, '')) >= 30
        then jsonb_build_array('property_type_source_length_limit')
      when p_field_key = 'property.premise_address'
        and length(coalesce(p_value::text, '')) >= 50
        then jsonb_build_array('premise_address_source_length_limit')
      when p_field_key = 'classification.property_type_canonical'
        then jsonb_build_array('derived_display_label')
      else '[]'::jsonb
    end value
  )
  select jsonb_build_object(
    'value', to_jsonb(p_value),
    'field_key', p_field_key,
    'title', f.title,
    'unit', f.unit,
    'record_date', p_record_date,
    'status', case
      when p_value is null then 'not_reported'
      else 'reported'
    end,
    'source_refs', jsonb_build_array(
      case
        when cardinality(ref.parts) = 6
          and ref.parts[4] = p_field_key then p_source_ref
        when cardinality(ref.parts) >= 4 then concat_ws(
          '|',
          ref.parts[1],
          ref.parts[2],
          replace(coalesce(p_field_key, ''), '|', ''),
          ref.parts[4]
        )
        else p_source_ref
      end
    ),
    'quality_flags', flags.value,
    'caveat', f.caveat
  )
  from ref
  cross join flags
  left join semantic.field_definition f
    on f.field_key = p_field_key;
$function$;

create or replace function api_v1._regulatory_resolution_error(
  p_status text
) returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select jsonb_build_object(
    'status', p_status,
    'next_tool', 'resolve_property',
    'hint', case p_status
      when 'ambiguous' then
        'Resolve the unit or SSL before requesting public-record facts.'
      when 'no_exact_match' then
        'Confirm one exact property identity before requesting public-record facts.'
      when 'invalid_input' then
        'Provide an SSL or street address.'
      when 'conflicting_input' then
        'Correct the conflicting SSL and address.'
      else
        'Verify the property identity with resolve_property.'
    end
  );
$function$;

revoke all on function api_v1._regulatory_property_link(
  text, text, text, numeric
) from public, mcp_runtime;
revoke all on function api_v1._regulatory_binding_sha256(
  text, bigint, bigint, text, text, text
) from public, mcp_runtime;
revoke all on function api_v1._regulatory_source_ref(
  text, bigint, bigint, text, text, text
) from public, mcp_runtime;
revoke all on function api_v1._regulatory_resolution_error(text)
  from public, mcp_runtime;
grant execute on function api_v1._regulatory_property_link(
  text, text, text, numeric
) to api_owner;
grant execute on function api_v1._regulatory_binding_sha256(
  text, bigint, bigint, text, text, text
) to api_owner;
grant execute on function api_v1._regulatory_source_ref(
  text, bigint, bigint, text, text, text
) to api_owner;
grant execute on function api_v1._regulatory_resolution_error(text)
  to api_owner;

comment on function api_v1._regulatory_binding_sha256(
  text, bigint, bigint, text, text, text
) is
  'Computes the immutable SHA-256 binding over canonical JSON containing source, release, record, persisted row hash, field, and normalized SSL.';
comment on function api_v1._regulatory_source_ref(
  text, bigint, bigint, text, text, text
) is
  'Emits source_id|source_release_id|source_record_id|field_key|binding_sha256|ssl for regulatory and property-context facts.';

create or replace function api_v1._regulatory_feed(
  p_account_id bigint,
  p_ssl text,
  p_category text
) returns table (
  source_record_link_id bigint,
  sort_date date,
  source_id text,
  source_release_id bigint,
  source_record_id bigint,
  source_row_sha256 text,
  record_type text,
  record_status text,
  record_payload jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
  with regulatory_base as (
    select
      l.source_record_link_id,
      l.source_id,
      l.source_release_id,
      l.source_record_id,
      l.link_scope,
      l.link_method,
      l.match_quality,
      l.link_confidence,
      r.source_row_sha256,
      r.record_kind record_type,
      r.record_number,
      r.record_status,
      r.record_status_date,
      r.premise_address,
      r.source_created_at,
      r.source_updated_at,
      bp.permit_type,
      bp.permit_subtype,
      bp.work_type,
      bp.work_description,
      bp.application_date,
      bp.issue_date permit_issue_date,
      bp.expiration_date permit_expiration_date,
      bp.finaled_date,
      bp.estimated_cost_dollars,
      bp.permit_fee_cents,
      bp.contractor_name,
      bp.contractor_license_number,
      bp.proposed_use permit_proposed_use,
      bp.existing_use permit_existing_use,
      bp.number_of_stories,
      bp.number_of_units,
      bp.floor_area_square_feet,
      co.certificate_number,
      co.related_building_permit_number,
      co.occupancy_use,
      co.proposed_use occupancy_proposed_use,
      co.existing_use occupancy_existing_use,
      co.occupancy_load,
      co.floors_occupied,
      co.dwelling_units,
      co.issue_date occupancy_issue_date,
      co.expiration_date occupancy_expiration_date,
      bl.license_category,
      bl.license_type,
      bl.entity_name,
      bl.trade_name,
      bl.activity_description,
      bl.issue_date license_issue_date,
      bl.start_date license_start_date,
      bl.expiration_date license_expiration_date,
      bl.is_active,
      i.inspection_type,
      i.inspection_result,
      i.completed_at inspection_completed_at,
      i.inspector_unit,
      i.violation_count,
      e.case_number,
      e.action_type,
      e.description enforcement_description,
      e.opened_date,
      e.issued_date enforcement_issued_date,
      e.compliance_due_date,
      e.closed_date,
      e.fine_cents,
      e.resolution,
      coalesce(
        bp.issue_date,
        co.issue_date,
        bl.issue_date,
        i.completed_at::date,
        e.issued_date,
        e.opened_date,
        r.record_status_date,
        r.source_updated_at::date,
        r.source_created_at::date
      ) sort_date
    from meta.source_record_link l
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    join regulatory.record r
      on r.source_id = l.source_id
     and r.source_record_id = l.source_record_id
     and r.source_release_id = l.source_release_id
    left join regulatory.building_permit bp
      on bp.record_id = r.record_id
    left join regulatory.certificate_of_occupancy co
      on co.record_id = r.record_id
    left join regulatory.business_license bl
      on bl.record_id = r.record_id
    left join regulatory.inspection i
      on i.record_id = r.record_id
    left join regulatory.enforcement_action e
      on e.record_id = r.record_id
    where l.account_id = p_account_id
      and l.link_status = 'linked'
      and case p_category
        when 'permit' then r.record_kind in (
          'building_permit',
          'certificate_of_occupancy',
          'public_space_construction_permit',
          'public_space_occupancy_permit',
          'home_occupancy_permit',
          'special_tree_permit',
          'public_space_rental_permit',
          'emergency_work_request',
          'well_permit'
        )
        when 'license' then r.record_kind in (
          'business_license',
          'alcohol_license',
          'cannabis_license'
        )
        when 'inspection_and_enforcement' then r.record_kind in (
          'inspection',
          'enforcement_action'
        )
        else false
      end
  ),
  regulatory_rows as (
    select
      b.source_record_link_id,
      b.sort_date,
      b.source_id,
      b.source_release_id,
      b.source_record_id,
      b.source_row_sha256,
      b.record_type,
      b.record_status,
      jsonb_build_object(
        'source_id', b.source_id,
        'source_record_id', b.source_record_id,
        'record_type', b.record_type,
        'property_link', api_v1._regulatory_property_link(
          b.link_scope,
          b.link_method,
          b.match_quality,
          b.link_confidence
        ),
        'facts',
          jsonb_strip_nulls(jsonb_build_object(
            'record_number', case when b.record_number is not null
              then api_v1._fact(
                b.record_number,
                'regulatory.record_number',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'regulatory.record_number',
                  p_ssl
                )
              )
            end,
            'status', case when b.record_status is not null
              then api_v1._fact(
                b.record_status,
                'regulatory.status',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'regulatory.status',
                  p_ssl
                )
              )
            end,
            'status_date', case when b.record_status_date is not null
              then api_v1._fact(
                b.record_status_date,
                'regulatory.status_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'regulatory.status_date',
                  p_ssl
                )
              )
            end,
            'premise_address', case when b.premise_address is not null
              then api_v1._fact(
                b.premise_address,
                'regulatory.premise_address',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'regulatory.premise_address',
                  p_ssl
                )
              )
            end,
            'permit_type', case
              when p_category = 'permit' then api_v1._fact(
                coalesce(b.permit_type, b.record_type),
                'permit.type',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.type',
                  p_ssl
                )
              )
            end,
            'permit_subtype', case when b.permit_subtype is not null
              then api_v1._fact(
                b.permit_subtype,
                'permit.subtype',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.subtype',
                  p_ssl
                )
              )
            end,
            'work_type', case when b.work_type is not null
              then api_v1._fact(
                b.work_type,
                'permit.work_type',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.work_type',
                  p_ssl
                )
              )
            end,
            'work_description', case when b.work_description is not null
              then api_v1._fact(
                b.work_description,
                'permit.work_description',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.work_description',
                  p_ssl
                )
              )
            end,
            'application_date', case when b.application_date is not null
              then api_v1._fact(
                b.application_date,
                'permit.application_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.application_date',
                  p_ssl
                )
              )
            end,
            'issue_date', case
              when p_category = 'permit'
                and coalesce(
                  b.permit_issue_date,
                  b.occupancy_issue_date
                ) is not null
              then api_v1._fact(
                coalesce(
                  b.permit_issue_date,
                  b.occupancy_issue_date
                ),
                'permit.issue_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.issue_date',
                  p_ssl
                )
              )
              when p_category = 'license'
                and b.license_issue_date is not null
              then api_v1._fact(
                b.license_issue_date,
                'license.issue_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.issue_date',
                  p_ssl
                )
              )
            end,
            'expiration_date', case
              when p_category = 'permit'
                and coalesce(
                  b.permit_expiration_date,
                  b.occupancy_expiration_date
                ) is not null
              then api_v1._fact(
                coalesce(
                  b.permit_expiration_date,
                  b.occupancy_expiration_date
                ),
                'permit.expiration_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.expiration_date',
                  p_ssl
                )
              )
              when p_category = 'license'
                and b.license_expiration_date is not null
              then api_v1._fact(
                b.license_expiration_date,
                'license.expiration_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.expiration_date',
                  p_ssl
                )
              )
            end,
            'finaled_date', case when b.finaled_date is not null
              then api_v1._fact(
                b.finaled_date,
                'permit.finaled_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.finaled_date',
                  p_ssl
                )
              )
            end,
            'estimated_cost_dollars',
              case when b.estimated_cost_dollars is not null
                then api_v1._fact(
                  b.estimated_cost_dollars,
                  'permit.estimated_cost_dollars',
                  b.sort_date,
                  api_v1._regulatory_source_ref(
                    b.source_id,
                    b.source_release_id,
                    b.source_record_id,
                    b.source_row_sha256,
                    'permit.estimated_cost_dollars',
                    p_ssl
                  )
                )
              end,
            'permit_fee_cents', case when b.permit_fee_cents is not null
              then api_v1._fact(
                b.permit_fee_cents,
                'permit.fee_cents',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.fee_cents',
                  p_ssl
                )
              )
            end,
            'contractor_name', case when b.contractor_name is not null
              then api_v1._fact(
                b.contractor_name,
                'permit.contractor_name',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.contractor_name',
                  p_ssl
                )
              )
            end,
            'contractor_license_number',
              case when b.contractor_license_number is not null
                then api_v1._fact(
                  b.contractor_license_number,
                  'permit.contractor_license_number',
                  b.sort_date,
                  api_v1._regulatory_source_ref(
                    b.source_id,
                    b.source_release_id,
                    b.source_record_id,
                    b.source_row_sha256,
                    'permit.contractor_license_number',
                    p_ssl
                  )
                )
              end,
            'proposed_use', case
              when coalesce(
                b.permit_proposed_use,
                b.occupancy_proposed_use
              ) is not null
              then api_v1._fact(
                coalesce(
                  b.permit_proposed_use,
                  b.occupancy_proposed_use
                ),
                'permit.proposed_use',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.proposed_use',
                  p_ssl
                )
              )
            end,
            'existing_use', case
              when coalesce(
                b.permit_existing_use,
                b.occupancy_existing_use
              ) is not null
              then api_v1._fact(
                coalesce(
                  b.permit_existing_use,
                  b.occupancy_existing_use
                ),
                'permit.existing_use',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.existing_use',
                  p_ssl
                )
              )
            end,
            'number_of_stories', case when b.number_of_stories is not null
              then api_v1._fact(
                b.number_of_stories,
                'permit.number_of_stories',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.number_of_stories',
                  p_ssl
                )
              )
            end,
            'number_of_units', case when b.number_of_units is not null
              then api_v1._fact(
                b.number_of_units,
                'permit.number_of_units',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'permit.number_of_units',
                  p_ssl
                )
              )
            end,
            'floor_area_square_feet',
              case when b.floor_area_square_feet is not null
                then api_v1._fact(
                  b.floor_area_square_feet,
                  'permit.floor_area_square_feet',
                  b.sort_date,
                  api_v1._regulatory_source_ref(
                    b.source_id,
                    b.source_release_id,
                    b.source_record_id,
                    b.source_row_sha256,
                    'permit.floor_area_square_feet',
                    p_ssl
                  )
                )
              end,
            'certificate_number', case when b.certificate_number is not null
              then api_v1._fact(
                b.certificate_number,
                'occupancy.certificate_number',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'occupancy.certificate_number',
                  p_ssl
                )
              )
            end,
            'related_building_permit_number',
              case when b.related_building_permit_number is not null
                then api_v1._fact(
                  b.related_building_permit_number,
                  'occupancy.related_permit_number',
                  b.sort_date,
                  api_v1._regulatory_source_ref(
                    b.source_id,
                    b.source_release_id,
                    b.source_record_id,
                    b.source_row_sha256,
                    'occupancy.related_permit_number',
                    p_ssl
                  )
                )
              end,
            'occupancy_use', case when b.occupancy_use is not null
              then api_v1._fact(
                b.occupancy_use,
                'occupancy.use',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'occupancy.use',
                  p_ssl
                )
              )
            end,
            'occupancy_load', case when b.occupancy_load is not null
              then api_v1._fact(
                b.occupancy_load,
                'occupancy.load',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'occupancy.load',
                  p_ssl
                )
              )
            end,
            'floors_occupied', case when b.floors_occupied is not null
              then api_v1._fact(
                b.floors_occupied,
                'occupancy.floors',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'occupancy.floors',
                  p_ssl
                )
              )
            end,
            'dwelling_units', case when b.dwelling_units is not null
              then api_v1._fact(
                b.dwelling_units,
                'occupancy.dwelling_units',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'occupancy.dwelling_units',
                  p_ssl
                )
              )
            end,
            'license_type', case when p_category = 'license'
              then api_v1._fact(
                coalesce(b.license_type, b.record_type),
                'license.type',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.type',
                  p_ssl
                )
              )
            end,
            'license_category', case when b.license_category is not null
              then api_v1._fact(
                b.license_category,
                'license.category',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.category',
                  p_ssl
                )
              )
            end,
            'entity_name', case when b.entity_name is not null
              then api_v1._fact(
                b.entity_name,
                'license.entity_name',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.entity_name',
                  p_ssl
                )
              )
            end,
            'trade_name', case when b.trade_name is not null
              then api_v1._fact(
                b.trade_name,
                'license.trade_name',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.trade_name',
                  p_ssl
                )
              )
            end,
            'activity_description',
              case when b.activity_description is not null
                then api_v1._fact(
                  b.activity_description,
                  'license.activity_description',
                  b.sort_date,
                  api_v1._regulatory_source_ref(
                    b.source_id,
                    b.source_release_id,
                    b.source_record_id,
                    b.source_row_sha256,
                    'license.activity_description',
                    p_ssl
                  )
                )
              end,
            'start_date', case when b.license_start_date is not null
              then api_v1._fact(
                b.license_start_date,
                'license.start_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.start_date',
                  p_ssl
                )
              )
            end,
            'is_active', case when b.is_active is not null
              then api_v1._fact(
                b.is_active,
                'license.is_active',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'license.is_active',
                  p_ssl
                )
              )
            end,
            'inspection_type', case when b.inspection_type is not null
              then api_v1._fact(
                b.inspection_type,
                'inspection.type',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'inspection.type',
                  p_ssl
                )
              )
            end,
            'inspection_result', case when b.inspection_result is not null
              then api_v1._fact(
                b.inspection_result,
                'inspection.result',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'inspection.result',
                  p_ssl
                )
              )
            end,
            'completed_at', case when b.inspection_completed_at is not null
              then api_v1._fact(
                b.inspection_completed_at,
                'inspection.completed_at',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'inspection.completed_at',
                  p_ssl
                )
              )
            end,
            'agency_context', case when b.record_type = 'inspection'
              then api_v1._fact(
                case
                  when b.source_id like 'ddot_%' then
                    'DDOT public-space permit inspection'
                  when b.source_id like 'dob_%' then
                    'Department of Buildings inspection'
                  else coalesce(
                    b.inspector_unit,
                    'Inspection published by the named source agency'
                  )
                end,
                'inspection.agency_context',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'inspection.agency_context',
                  p_ssl
                )
              )
            end,
            'violation_count', case when b.violation_count is not null
              then api_v1._fact(
                b.violation_count,
                'inspection.violation_count',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'inspection.violation_count',
                  p_ssl
                )
              )
            end,
            'case_number', case when b.case_number is not null
              then api_v1._fact(
                b.case_number,
                'enforcement.case_number',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.case_number',
                  p_ssl
                )
              )
            end,
            'action_type', case when b.action_type is not null
              then api_v1._fact(
                b.action_type,
                'enforcement.action_type',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.action_type',
                  p_ssl
                )
              )
            end,
            'description', case when b.enforcement_description is not null
              then api_v1._fact(
                b.enforcement_description,
                'enforcement.description',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.description',
                  p_ssl
                )
              )
            end,
            'opened_date', case when b.opened_date is not null
              then api_v1._fact(
                b.opened_date,
                'enforcement.opened_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.opened_date',
                  p_ssl
                )
              )
            end,
            'issued_date', case when b.enforcement_issued_date is not null
              then api_v1._fact(
                b.enforcement_issued_date,
                'enforcement.issued_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.issued_date',
                  p_ssl
                )
              )
            end,
            'compliance_due_date',
              case when b.compliance_due_date is not null
                then api_v1._fact(
                  b.compliance_due_date,
                  'enforcement.compliance_due_date',
                  b.sort_date,
                  api_v1._regulatory_source_ref(
                    b.source_id,
                    b.source_release_id,
                    b.source_record_id,
                    b.source_row_sha256,
                    'enforcement.compliance_due_date',
                    p_ssl
                  )
                )
              end,
            'closed_date', case when b.closed_date is not null
              then api_v1._fact(
                b.closed_date,
                'enforcement.closed_date',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.closed_date',
                  p_ssl
                )
              )
            end,
            'fine_cents', case when b.fine_cents is not null
              then api_v1._fact(
                b.fine_cents,
                'enforcement.fine_cents',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.fine_cents',
                  p_ssl
                )
              )
            end,
            'resolution', case when b.resolution is not null
              then api_v1._fact(
                b.resolution,
                'enforcement.resolution',
                b.sort_date,
                api_v1._regulatory_source_ref(
                  b.source_id,
                  b.source_release_id,
                  b.source_record_id,
                  b.source_row_sha256,
                  'enforcement.resolution',
                  p_ssl
                )
              )
            end
          )),
        'limitations', case
          when b.record_type = 'business_license' then jsonb_build_array(
            'This is a business-at-premise record, not a representation of property ownership, tenancy duration, lease status, or borrower identity.',
            'Confirm current license standing in the public D.C. Department of Buildings Scout interface.'
          )
          when b.record_type = 'inspection'
            and b.source_id like 'ddot_%' then jsonb_build_array(
              'This is a DDOT public-space permit inspection, not a DOB building, housing, or certificate-of-occupancy inspection.',
              'An empty or favorable result is not a property-condition conclusion.'
            )
          when b.record_type = 'building_permit' then jsonb_build_array(
            'Issuance does not prove completion, final inspection, code compliance, or current physical condition.'
          )
          else jsonb_build_array(
            'Verify the current official record before underwriting reliance.'
          )
        end
      ) record_payload
    from regulatory_base b
  ),
  cama_rows as (
    select
      l.source_record_link_id,
      null::date sort_date,
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'cama_building_profile'::text record_type,
      null::text record_status,
      jsonb_build_object(
        'source_id', p.source_id,
        'source_record_id', p.source_record_id,
        'record_type', 'cama_building_profile',
        'property_link', api_v1._regulatory_property_link(
          l.link_scope,
          l.link_method,
          l.match_quality,
          l.link_confidence
        ),
        'facts', jsonb_strip_nulls(jsonb_build_object(
          'building_type', case when p.building_type is not null
            then api_v1._fact(
              p.building_type,
              'building.type',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.type',
                p_ssl
              )
            )
          end,
          'use_description', case when p.use_description is not null
            then api_v1._fact(
              p.use_description,
              'building.use_description',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.use_description',
                p_ssl
              )
            )
          end,
          'year_built', case when p.year_built is not null
            then api_v1._fact(
              p.year_built,
              'building.year_built',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.year_built',
                p_ssl
              )
            )
          end,
          'year_renovated', case when p.year_renovated is not null
            then api_v1._fact(
              p.year_renovated,
              'building.year_renovated',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.year_renovated',
                p_ssl
              )
            )
          end,
          'stories', case when p.stories is not null
            then api_v1._fact(
              p.stories,
              'building.stories',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.stories',
                p_ssl
              )
            )
          end,
          'bedrooms', case when p.bedrooms is not null
            then api_v1._fact(
              p.bedrooms,
              'building.bedrooms',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.bedrooms',
                p_ssl
              )
            )
          end,
          'full_bathrooms', case when p.full_bathrooms is not null
            then api_v1._fact(
              p.full_bathrooms,
              'building.full_bathrooms',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.full_bathrooms',
                p_ssl
              )
            )
          end,
          'half_bathrooms', case when p.half_bathrooms is not null
            then api_v1._fact(
              p.half_bathrooms,
              'building.half_bathrooms',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.half_bathrooms',
                p_ssl
              )
            )
          end,
          'gross_building_area_square_feet',
            case when p.gross_building_area_square_feet is not null
              then api_v1._fact(
                p.gross_building_area_square_feet,
                'building.gross_area_square_feet',
                null::date,
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'building.gross_area_square_feet',
                  p_ssl
                )
              )
            end,
          'living_area_square_feet',
            case when p.living_area_square_feet is not null
              then api_v1._fact(
                p.living_area_square_feet,
                'building.living_area_square_feet',
                null::date,
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'building.living_area_square_feet',
                  p_ssl
                )
              )
            end,
          'grade', case when p.grade is not null
            then api_v1._fact(
              p.grade,
              'building.grade',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.grade',
                p_ssl
              )
            )
          end,
          'condition', case when p.condition is not null
            then api_v1._fact(
              p.condition,
              'building.condition',
              null::date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'building.condition',
                p_ssl
              )
            )
          end
        )),
        'limitations', jsonb_build_array(
          'CAMA characteristics are assessor records, not a survey, appraisal, zoning determination, or current property-condition assessment.',
          'This profile is returned only through an exact SSL-to-tax-account link.'
        )
      ) record_payload
    from property_context.cama_building_profile p
    join meta.source_record_link l
      on l.source_record_link_id = p.source_record_link_id
     and l.source_id = p.source_id
     and l.source_release_id = p.source_release_id
     and l.source_record_id = p.source_record_id
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where p.account_id = p_account_id
      and l.account_id = p_account_id
      and l.link_status = 'linked'
      and p_category = 'building_and_land'
  ),
  energy_rows as (
    select
      l.source_record_link_id,
      make_date(p.reporting_year, 12, 31) sort_date,
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'energy_benchmark'::text record_type,
      p.reporting_status record_status,
      jsonb_build_object(
        'source_id', p.source_id,
        'source_record_id', p.source_record_id,
        'record_type', 'energy_benchmark',
        'property_link', api_v1._regulatory_property_link(
          l.link_scope,
          l.link_method,
          l.match_quality,
          l.link_confidence
        ),
        'facts', jsonb_strip_nulls(jsonb_build_object(
          'reporting_year', api_v1._fact(
            p.reporting_year,
            'energy.reporting_year',
            make_date(p.reporting_year, 12, 31),
            api_v1._regulatory_source_ref(
              p.source_id,
              p.source_release_id,
              p.source_record_id,
              p.source_row_sha256,
              'energy.reporting_year',
              p_ssl
            )
          ),
          'reporting_status', case when p.reporting_status is not null
            then api_v1._fact(
              p.reporting_status,
              'energy.reporting_status',
              make_date(p.reporting_year, 12, 31),
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'energy.reporting_status',
                p_ssl
              )
            )
          end,
          'property_name', case when p.property_name is not null
            then api_v1._fact(
              p.property_name,
              'energy.property_name',
              make_date(p.reporting_year, 12, 31),
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'energy.property_name',
                p_ssl
              )
            )
          end,
          'primary_property_type',
            case when p.primary_property_type is not null
              then api_v1._fact(
                p.primary_property_type,
                'energy.primary_property_type',
                make_date(p.reporting_year, 12, 31),
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'energy.primary_property_type',
                  p_ssl
                )
              )
            end,
          'gross_floor_area_square_feet',
            case when p.gross_floor_area_square_feet is not null
              then api_v1._fact(
                p.gross_floor_area_square_feet,
                'energy.gross_floor_area_square_feet',
                make_date(p.reporting_year, 12, 31),
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'energy.gross_floor_area_square_feet',
                  p_ssl
                )
              )
            end,
          'energy_star_score', case when p.energy_star_score is not null
            then api_v1._fact(
              p.energy_star_score,
              'energy.energy_star_score',
              make_date(p.reporting_year, 12, 31),
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'energy.energy_star_score',
                p_ssl
              )
            )
          end,
          'site_eui_kbtu_per_square_foot',
            case when p.site_eui_kbtu_per_square_foot is not null
              then api_v1._fact(
                p.site_eui_kbtu_per_square_foot,
                'energy.site_eui',
                make_date(p.reporting_year, 12, 31),
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'energy.site_eui',
                  p_ssl
                )
              )
            end,
          'source_eui_kbtu_per_square_foot',
            case when p.source_eui_kbtu_per_square_foot is not null
              then api_v1._fact(
                p.source_eui_kbtu_per_square_foot,
                'energy.source_eui',
                make_date(p.reporting_year, 12, 31),
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'energy.source_eui',
                  p_ssl
                )
              )
            end,
          'total_ghg_emissions_metric_tons',
            case when p.total_ghg_emissions_metric_tons is not null
              then api_v1._fact(
                p.total_ghg_emissions_metric_tons,
                'energy.ghg_metric_tons',
                make_date(p.reporting_year, 12, 31),
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'energy.ghg_metric_tons',
                  p_ssl
                )
              )
            end,
          'electricity_kwh', case when p.electricity_kwh is not null
            then api_v1._fact(
              p.electricity_kwh,
              'energy.electricity_kwh',
              make_date(p.reporting_year, 12, 31),
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'energy.electricity_kwh',
                p_ssl
              )
            )
          end,
          'natural_gas_therms', case when p.natural_gas_therms is not null
            then api_v1._fact(
              p.natural_gas_therms,
              'energy.natural_gas_therms',
              make_date(p.reporting_year, 12, 31),
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'energy.natural_gas_therms',
                p_ssl
              )
            )
          end,
          'water_gallons', case when p.water_gallons is not null
            then api_v1._fact(
              p.water_gallons,
              'energy.water_gallons',
              make_date(p.reporting_year, 12, 31),
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'energy.water_gallons',
                p_ssl
              )
            )
          end
        )),
        'limitations', jsonb_build_array(
          'This is building-level context and can cover multiple tax accounts; it is never represented as an exact tax-account fact.',
          'Compare reporting year, building scope, and verification status before using the metrics.'
        )
      ) record_payload
    from property_context.energy_benchmark p
    join property_context.energy_benchmark_property_link pl
      on pl.energy_benchmark_id = p.energy_benchmark_id
     and pl.account_id = p_account_id
     and pl.link_status = 'linked'
    join meta.source_record_link l
      on l.source_record_link_id = pl.source_record_link_id
     and l.account_id = p_account_id
     and l.source_id = p.source_id
     and l.source_release_id = p.source_release_id
     and l.source_record_id = p.source_record_id
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where p_category = 'building_and_land'
  ),
  beps_rows as (
    select
      l.source_record_link_id,
      coalesce(
        p.determination_date,
        p.compliance_deadline,
        case when p.target_year is not null
          then make_date(p.target_year, 12, 31)
        end
      ) sort_date,
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'beps'::text record_type,
      p.compliance_status record_status,
      jsonb_build_object(
        'source_id', p.source_id,
        'source_record_id', p.source_record_id,
        'record_type', 'beps',
        'property_link', api_v1._regulatory_property_link(
          l.link_scope,
          l.link_method,
          l.match_quality,
          l.link_confidence
        ),
        'facts', jsonb_strip_nulls(jsonb_build_object(
          'compliance_cycle', api_v1._fact(
            p.compliance_cycle,
            'beps.compliance_cycle',
            p.determination_date,
            api_v1._regulatory_source_ref(
              p.source_id,
              p.source_release_id,
              p.source_record_id,
              p.source_row_sha256,
              'beps.compliance_cycle',
              p_ssl
            )
          ),
          'compliance_status', case when p.compliance_status is not null
            then api_v1._fact(
              p.compliance_status,
              'beps.compliance_status',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.compliance_status',
                p_ssl
              )
            )
          end,
          'compliance_pathway', case when p.compliance_pathway is not null
            then api_v1._fact(
              p.compliance_pathway,
              'beps.compliance_pathway',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.compliance_pathway',
                p_ssl
              )
            )
          end,
          'baseline_year', case when p.baseline_year is not null
            then api_v1._fact(
              p.baseline_year,
              'beps.baseline_year',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.baseline_year',
                p_ssl
              )
            )
          end,
          'target_year', case when p.target_year is not null
            then api_v1._fact(
              p.target_year,
              'beps.target_year',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.target_year',
                p_ssl
              )
            )
          end,
          'baseline_metric', case when p.baseline_metric is not null
            then api_v1._fact(
              p.baseline_metric,
              'beps.baseline_metric',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.baseline_metric',
                p_ssl
              )
            )
          end,
          'target_metric', case when p.target_metric is not null
            then api_v1._fact(
              p.target_metric,
              'beps.target_metric',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.target_metric',
                p_ssl
              )
            )
          end,
          'reported_metric', case when p.reported_metric is not null
            then api_v1._fact(
              p.reported_metric,
              'beps.reported_metric',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.reported_metric',
                p_ssl
              )
            )
          end,
          'determination_date', case when p.determination_date is not null
            then api_v1._fact(
              p.determination_date,
              'beps.determination_date',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.determination_date',
                p_ssl
              )
            )
          end,
          'compliance_deadline', case when p.compliance_deadline is not null
            then api_v1._fact(
              p.compliance_deadline,
              'beps.compliance_deadline',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.compliance_deadline',
                p_ssl
              )
            )
          end,
          'penalty_cents', case when p.penalty_cents is not null
            then api_v1._fact(
              p.penalty_cents,
              'beps.penalty_cents',
              p.determination_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'beps.penalty_cents',
                p_ssl
              )
            )
          end
        )),
        'limitations', jsonb_build_array(
          'This is building-level context and is not an exact tax-account compliance assertion.',
          'Confirm current pathway, deadlines, determinations, and penalties with DOEE.'
        )
      ) record_payload
    from property_context.beps_compliance p
    join property_context.beps_property_link pl
      on pl.beps_compliance_id = p.beps_compliance_id
     and pl.account_id = p_account_id
     and pl.link_status = 'linked'
    join meta.source_record_link l
      on l.source_record_link_id = pl.source_record_link_id
     and l.account_id = p_account_id
     and l.source_id = p.source_id
     and l.source_release_id = p.source_release_id
     and l.source_record_id = p.source_record_id
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where p_category = 'building_and_land'
  ),
  vacant_rows as (
    select
      l.source_record_link_id,
      coalesce(p.effective_date, p.expiration_date) sort_date,
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'vacant_blighted'::text record_type,
      p.status record_status,
      jsonb_build_object(
        'source_id', p.source_id,
        'source_record_id', p.source_record_id,
        'record_type', 'vacant_blighted',
        'property_link', api_v1._regulatory_property_link(
          l.link_scope,
          l.link_method,
          l.match_quality,
          l.link_confidence
        ),
        'facts', jsonb_strip_nulls(jsonb_build_object(
          'classification', api_v1._fact(
            p.classification,
            'vacancy.classification',
            p.effective_date,
            api_v1._regulatory_source_ref(
              p.source_id,
              p.source_release_id,
              p.source_record_id,
              p.source_row_sha256,
              'vacancy.classification',
              p_ssl
            )
          ),
          'source_classification',
            case when p.source_classification is not null
              then api_v1._fact(
                p.source_classification,
                'vacancy.source_classification',
                p.effective_date,
                api_v1._regulatory_source_ref(
                  p.source_id,
                  p.source_release_id,
                  p.source_record_id,
                  p.source_row_sha256,
                  'vacancy.source_classification',
                  p_ssl
                )
              )
            end,
          'status', case when p.status is not null
            then api_v1._fact(
              p.status,
              'vacancy.status',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'vacancy.status',
                p_ssl
              )
            )
          end,
          'effective_date', case when p.effective_date is not null
            then api_v1._fact(
              p.effective_date,
              'vacancy.effective_date',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'vacancy.effective_date',
                p_ssl
              )
            )
          end,
          'expiration_date', case when p.expiration_date is not null
            then api_v1._fact(
              p.expiration_date,
              'vacancy.expiration_date',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'vacancy.expiration_date',
                p_ssl
              )
            )
          end,
          'exemption_reason', case when p.exemption_reason is not null
            then api_v1._fact(
              p.exemption_reason,
              'vacancy.exemption_reason',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'vacancy.exemption_reason',
                p_ssl
              )
            )
          end
        )),
        'limitations', jsonb_build_array(
          'Classification and exemption status can change after the source date.',
          'Use the exact/contextual property-link label and verify current status with DOB and OTR.'
        )
      ) record_payload
    from property_context.vacant_blighted_status p
    join meta.source_record_link l
      on l.source_record_link_id = p.source_record_link_id
     and l.source_id = p.source_id
     and l.source_release_id = p.source_release_id
     and l.source_record_id = p.source_record_id
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where p.account_id = p_account_id
      and l.account_id = p_account_id
      and l.link_status = 'linked'
      and p_category = 'building_and_land'
  ),
  land_rows as (
    select
      l.source_record_link_id,
      coalesce(p.effective_date, p.expiration_date) sort_date,
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'land_designation'::text record_type,
      p.designation_status record_status,
      jsonb_build_object(
        'source_id', p.source_id,
        'source_record_id', p.source_record_id,
        'record_type', 'land_designation',
        'property_link', api_v1._regulatory_property_link(
          l.link_scope,
          l.link_method,
          l.match_quality,
          l.link_confidence
        ),
        'facts', jsonb_strip_nulls(jsonb_build_object(
          'designation_system', api_v1._fact(
            p.designation_system,
            'land.designation_system',
            p.effective_date,
            api_v1._regulatory_source_ref(
              p.source_id,
              p.source_release_id,
              p.source_record_id,
              p.source_row_sha256,
              'land.designation_system',
              p_ssl
            )
          ),
          'designation_type', api_v1._fact(
            p.designation_type,
            'land.designation_type',
            p.effective_date,
            api_v1._regulatory_source_ref(
              p.source_id,
              p.source_release_id,
              p.source_record_id,
              p.source_row_sha256,
              'land.designation_type',
              p_ssl
            )
          ),
          'designation_code', case when p.designation_code is not null
            then api_v1._fact(
              p.designation_code,
              'land.designation_code',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'land.designation_code',
                p_ssl
              )
            )
          end,
          'designation_name', case when p.designation_name is not null
            then api_v1._fact(
              p.designation_name,
              'land.designation_name',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'land.designation_name',
                p_ssl
              )
            )
          end,
          'designation_status', case when p.designation_status is not null
            then api_v1._fact(
              p.designation_status,
              'land.designation_status',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'land.designation_status',
                p_ssl
              )
            )
          end,
          'issuing_authority', case when p.issuing_authority is not null
            then api_v1._fact(
              p.issuing_authority,
              'land.issuing_authority',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'land.issuing_authority',
                p_ssl
              )
            )
          end,
          'effective_date', case when p.effective_date is not null
            then api_v1._fact(
              p.effective_date,
              'land.effective_date',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'land.effective_date',
                p_ssl
              )
            )
          end,
          'expiration_date', case when p.expiration_date is not null
            then api_v1._fact(
              p.expiration_date,
              'land.expiration_date',
              p.effective_date,
              api_v1._regulatory_source_ref(
                p.source_id,
                p.source_release_id,
                p.source_record_id,
                p.source_row_sha256,
                'land.expiration_date',
                p_ssl
              )
            )
          end
        )),
        'limitations', jsonb_build_array(
          'Map-based, multi-parcel, and proximity links remain contextual and do not replace a survey or agency determination.',
          'Confirm controlling boundaries and current legal status with the issuing authority.'
        )
      ) record_payload
    from property_context.land_designation p
    join property_context.land_designation_property_link pl
      on pl.land_designation_id = p.land_designation_id
     and pl.account_id = p_account_id
     and pl.link_status = 'linked'
    join meta.source_record_link l
      on l.source_record_link_id = pl.source_record_link_id
     and l.account_id = p_account_id
     and l.source_id = p.source_id
     and l.source_release_id = p.source_release_id
     and l.source_record_id = p.source_record_id
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where p_category = 'building_and_land'
  )
  select * from regulatory_rows
  union all
  select * from cama_rows
  union all
  select * from energy_rows
  union all
  select * from beps_rows
  union all
  select * from vacant_rows
  union all
  select * from land_rows;
$function$;

revoke all on function api_v1._regulatory_feed(bigint, text, text)
  from public, mcp_runtime;
grant execute on function api_v1._regulatory_feed(bigint, text, text)
  to api_owner;

create or replace function api_v1._regulatory_page(
  p_account_id bigint,
  p_ssl text,
  p_category text,
  p_filters jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_unknown_keys text[];
  v_record_types text[];
  v_allowed_record_types text[];
  v_invalid_record_types text[];
  v_status text;
  v_date_from date;
  v_date_to date;
  v_limit integer := 50;
  v_offset integer := 0;
  v_cursor_text text;
  v_total_count bigint;
  v_records jsonb;
  v_returned integer;
  v_has_more boolean;
  v_next_cursor text;
  v_ssl_display text;
  v_premise_address text;
  v_property_source_id text;
  v_property_source_row bigint;
  v_property_record_date date;
  v_property_ref text;
begin
  if jsonb_typeof(v_filters) <> 'object' then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'filter_object_required',
        'hint',
          'Pass a JSON object containing only record_types, status, date_from, date_to, limit, and cursor.'
      )
    );
  end if;

  select array_agg(key order by key)
  into v_unknown_keys
  from jsonb_object_keys(v_filters) key
  where key <> all(array[
    'record_types',
    'status',
    'date_from',
    'date_to',
    'limit',
    'cursor'
  ]);

  if v_unknown_keys is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_filters',
        'unknown_filters', to_jsonb(v_unknown_keys),
        'hint',
          'Use only record_types, status, date_from, date_to, limit, and cursor.'
      )
    );
  end if;

  v_allowed_record_types := case p_category
    when 'permit' then array[
      'building_permit',
      'certificate_of_occupancy',
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'home_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'well_permit'
    ]
    when 'license' then array[
      'business_license',
      'alcohol_license',
      'cannabis_license'
    ]
    when 'inspection_and_enforcement' then array[
      'inspection',
      'enforcement_action'
    ]
    when 'building_and_land' then array[
      'cama_building_profile',
      'energy_benchmark',
      'beps',
      'vacant_blighted',
      'land_designation'
    ]
    else null
  end;

  if v_allowed_record_types is null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'unknown_regulatory_category'
      )
    );
  end if;

  if v_filters ? 'record_types' then
    if jsonb_typeof(v_filters->'record_types') <> 'array'
       or jsonb_array_length(v_filters->'record_types') = 0
       or exists (
         select 1
         from jsonb_array_elements(v_filters->'record_types') item
         where jsonb_typeof(item) <> 'string'
       ) then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'record_types_array_required',
          'allowed_record_types', to_jsonb(v_allowed_record_types)
        )
      );
    end if;

    select array_agg(distinct value order by value)
    into v_record_types
    from jsonb_array_elements_text(v_filters->'record_types') item(value);

    select array_agg(value order by value)
    into v_invalid_record_types
    from unnest(v_record_types) item(value)
    where value <> all(v_allowed_record_types);

    if v_invalid_record_types is not null then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'unsupported_record_types',
          'unsupported_record_types', to_jsonb(v_invalid_record_types),
          'allowed_record_types', to_jsonb(v_allowed_record_types)
        )
      );
    end if;
  end if;

  v_status := nullif(trim(v_filters->>'status'), '');

  if v_filters ? 'limit' then
    if coalesce(v_filters->>'limit', '') !~ '^[0-9]+$'
       or (v_filters->>'limit')::numeric < 1 then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'invalid_limit',
          'hint', 'limit must be a positive integer; the database caps it at 50.'
        )
      );
    end if;
    v_limit := least((v_filters->>'limit')::numeric, 50)::integer;
  end if;

  begin
    if v_filters ? 'date_from' then
      if coalesce(v_filters->>'date_from', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise invalid_datetime_format;
      end if;
      v_date_from := (v_filters->>'date_from')::date;
    end if;
    if v_filters ? 'date_to' then
      if coalesce(v_filters->>'date_to', '') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise invalid_datetime_format;
      end if;
      v_date_to := (v_filters->>'date_to')::date;
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_date',
        'hint', 'date_from and date_to must be valid ISO dates (YYYY-MM-DD).'
      )
    );
  end;

  if v_date_from is not null
     and v_date_to is not null
     and v_date_from > v_date_to then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'invalid_date_range',
        'hint', 'date_from must be on or before date_to.'
      )
    );
  end if;

  if v_filters ? 'cursor' then
    begin
      v_cursor_text := convert_from(
        decode(v_filters->>'cursor', 'base64'),
        'UTF8'
      );
    exception when others then
      v_cursor_text := null;
    end;

    if coalesce(v_cursor_text, '') !~ '^[0-9]+$'
       or length(v_cursor_text) > 9 then
      return jsonb_build_object(
        'status', 'invalid_input',
        'error', jsonb_build_object(
          'code', 'invalid_cursor',
          'hint', 'Use next_cursor exactly as returned by the preceding page.'
        )
      );
    end if;
    v_offset := v_cursor_text::integer;
  end if;

  select
    a.ssl_display,
    a.premise_address,
    a.source_id,
    a.source_row_number::bigint,
    a.record_extract_at
  into
    v_ssl_display,
    v_premise_address,
    v_property_source_id,
    v_property_source_row,
    v_property_record_date
  from core.property_account_current a
  where a.account_id = p_account_id;

  v_property_ref := api_v1._source_ref(
    v_property_source_id,
    v_property_source_row,
    'property_account',
    p_ssl
  );

  select count(*)
  into v_total_count
  from api_v1._regulatory_feed(
    p_account_id,
    p_ssl,
    p_category
  ) f
  where (
      v_record_types is null
      or f.record_type = any(v_record_types)
    )
    and (
      v_status is null
      or lower(coalesce(f.record_status, '')) = lower(v_status)
    )
    and (
      v_date_from is null
      or f.sort_date >= v_date_from
    )
    and (
      v_date_to is null
      or f.sort_date <= v_date_to
    );

  select coalesce(
    jsonb_agg(
      page.record_payload
      order by
        page.sort_date desc nulls last,
        page.source_id,
        page.source_record_id,
        page.source_record_link_id
    ),
    '[]'::jsonb
  )
  into v_records
  from (
    select f.*
    from api_v1._regulatory_feed(
      p_account_id,
      p_ssl,
      p_category
    ) f
    where (
        v_record_types is null
        or f.record_type = any(v_record_types)
      )
      and (
        v_status is null
        or lower(coalesce(f.record_status, '')) = lower(v_status)
      )
      and (
        v_date_from is null
        or f.sort_date >= v_date_from
      )
      and (
        v_date_to is null
        or f.sort_date <= v_date_to
      )
    order by
      f.sort_date desc nulls last,
      f.source_id,
      f.source_record_id,
      f.source_record_link_id
    offset v_offset
    limit v_limit
  ) page;

  v_returned := jsonb_array_length(v_records);
  v_has_more := (v_offset::bigint + v_returned) < v_total_count;
  if v_has_more then
    v_next_cursor := encode(
      convert_to((v_offset + v_returned)::text, 'UTF8'),
      'base64'
    );
  end if;

  return jsonb_build_object(
    'status', 'resolved',
    'property', jsonb_build_object(
      'ssl', api_v1._fact(
        v_ssl_display,
        'property.ssl',
        v_property_record_date,
        v_property_ref
      ),
      'premise_address', api_v1._fact(
        v_premise_address,
        'property.premise_address',
        v_property_record_date,
        v_property_ref
      )
    ),
    'category', p_category,
    'records', v_records,
    'total_count', v_total_count,
    'limit', v_limit,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'applied_filters', jsonb_strip_nulls(jsonb_build_object(
      'record_types', to_jsonb(v_record_types),
      'status', v_status,
      'date_from', v_date_from,
      'date_to', v_date_to
    )),
    'attribution_rule',
      'Only exact_property means the cited source row is asserted for this exact tax account. shared_building, multi_parcel, and proximity_context are explicitly contextual.',
    'empty_result_semantics',
      'No linked record in the loaded official source releases matched these filters. This is not proof that no permit, license, inspection, enforcement matter, building context, or land designation exists.'
  );
end;
$function$;

revoke all on function api_v1._regulatory_page(
  bigint, text, text, jsonb
) from public, mcp_runtime;
grant execute on function api_v1._regulatory_page(
  bigint, text, text, jsonb
) to api_owner;

create or replace function api_v1.get_permit_history(
  p_ssl text default null,
  p_address text default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_status text;
  v_account_id bigint;
  v_ssl text;
begin
  select r.resolution_status, r.resolved_account_id
  into v_status, v_account_id
  from api_v1._resolve_account(p_ssl, p_address) r;

  if v_status is distinct from 'resolved' then
    return api_v1._regulatory_resolution_error(v_status);
  end if;

  select a.ssl_normalized
  into v_ssl
  from core.property_account_current a
  where a.account_id = v_account_id;

  return api_v1._regulatory_page(
    v_account_id,
    v_ssl,
    'permit',
    p_filters
  );
end;
$function$;

create or replace function api_v1.get_license_history(
  p_ssl text default null,
  p_address text default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_status text;
  v_account_id bigint;
  v_ssl text;
begin
  select r.resolution_status, r.resolved_account_id
  into v_status, v_account_id
  from api_v1._resolve_account(p_ssl, p_address) r;

  if v_status is distinct from 'resolved' then
    return api_v1._regulatory_resolution_error(v_status);
  end if;

  select a.ssl_normalized
  into v_ssl
  from core.property_account_current a
  where a.account_id = v_account_id;

  return api_v1._regulatory_page(
    v_account_id,
    v_ssl,
    'license',
    p_filters
  );
end;
$function$;

create or replace function api_v1.get_inspection_and_enforcement_history(
  p_ssl text default null,
  p_address text default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_status text;
  v_account_id bigint;
  v_ssl text;
begin
  select r.resolution_status, r.resolved_account_id
  into v_status, v_account_id
  from api_v1._resolve_account(p_ssl, p_address) r;

  if v_status is distinct from 'resolved' then
    return api_v1._regulatory_resolution_error(v_status);
  end if;

  select a.ssl_normalized
  into v_ssl
  from core.property_account_current a
  where a.account_id = v_account_id;

  return api_v1._regulatory_page(
    v_account_id,
    v_ssl,
    'inspection_and_enforcement',
    p_filters
  );
end;
$function$;

create or replace function api_v1.get_building_and_land_profile(
  p_ssl text default null,
  p_address text default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_status text;
  v_account_id bigint;
  v_ssl text;
begin
  select r.resolution_status, r.resolved_account_id
  into v_status, v_account_id
  from api_v1._resolve_account(p_ssl, p_address) r;

  if v_status is distinct from 'resolved' then
    return api_v1._regulatory_resolution_error(v_status);
  end if;

  select a.ssl_normalized
  into v_ssl
  from core.property_account_current a
  where a.account_id = v_account_id;

  return api_v1._regulatory_page(
    v_account_id,
    v_ssl,
    'building_and_land',
    p_filters
  );
end;
$function$;

revoke all on function api_v1.get_permit_history(text, text, jsonb)
  from public;
revoke all on function api_v1.get_license_history(text, text, jsonb)
  from public;
revoke all on function api_v1.get_inspection_and_enforcement_history(
  text, text, jsonb
) from public;
revoke all on function api_v1.get_building_and_land_profile(
  text, text, jsonb
) from public;

grant execute on function api_v1.get_permit_history(text, text, jsonb)
  to mcp_runtime;
grant execute on function api_v1.get_license_history(text, text, jsonb)
  to mcp_runtime;
grant execute on function api_v1.get_inspection_and_enforcement_history(
  text, text, jsonb
) to mcp_runtime;
grant execute on function api_v1.get_building_and_land_profile(
  text, text, jsonb
) to mcp_runtime;

comment on function api_v1.get_permit_history(text, text, jsonb) is
  'Returns linked DOB, DDOT, DOEE, and related official permit records with a 50-row database page cap and field-level source refs.';
comment on function api_v1.get_license_history(text, text, jsonb) is
  'Returns official licensed-business-at-premise records without representing them as property ownership or lease facts.';
comment on function api_v1.get_inspection_and_enforcement_history(
  text, text, jsonb
) is
  'Returns official inspection and enforcement records while preserving agency identity; DDOT public-space inspections are never labeled as DOB building inspections.';
comment on function api_v1.get_building_and_land_profile(
  text, text, jsonb
) is
  'Returns exact CAMA tax-account profiles and explicitly contextual energy, BEPS, vacancy, and land-designation records.';

do $block$
begin
  if to_regprocedure(
    'api_v1._get_source_evidence_v04_base(text[])'
  ) is null then
    alter function api_v1.get_source_evidence(text[])
      rename to _get_source_evidence_v04_base;
  end if;
end;
$block$;

revoke all on function api_v1._get_source_evidence_v04_base(text[])
  from public, mcp_runtime;
grant execute on function api_v1._get_source_evidence_v04_base(text[])
  to api_owner;

create or replace function api_v1.get_source_evidence(
  p_source_refs text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_ref_count integer := coalesce(cardinality(p_source_refs), 0);
  v_new_ref_count integer;
  v_invalid_refs jsonb;
  v_old_refs text[];
  v_old_result jsonb;
  v_new_evidence jsonb;
  v_old_evidence jsonb;
  v_combined jsonb;
begin
  if v_ref_count < 1 or v_ref_count > 50 then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_count',
        'hint', 'Pass between 1 and 50 source_refs exactly as returned by the connector.'
      )
    );
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      string_to_array(ref, '|') parts
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
  ),
  classified as (
    select
      p.*,
      (
        coalesce(
          case
            when cardinality(p.parts) = 6 then p.parts[4]
            else p.parts[3]
          end,
          ''
        ) ~
          '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
        or exists (
          select 1
          from meta.source_record_link l
          where l.source_id = p.parts[1]
        )
      )
        is_regulatory
    from parsed p
  )
  select
    count(*) filter (where is_regulatory),
    array_agg(ref order by ordinality)
      filter (where not is_regulatory)
  into v_new_ref_count, v_old_refs
  from classified;

  if v_new_ref_count = 0 then
    return api_v1._get_source_evidence_v04_base(p_source_refs);
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      string_to_array(ref, '|') parts
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_invalid_refs
  from parsed p
  where (
      coalesce(
        case
          when cardinality(p.parts) = 6 then p.parts[4]
          else p.parts[3]
        end,
        ''
      ) ~
        '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
      or exists (
        select 1
        from meta.source_record_link l
        where l.source_id = p.parts[1]
      )
    )
    and (
      cardinality(p.parts) <> 6
      or nullif(p.parts[1], '') is null
      or coalesce(p.parts[2], '') !~ '^[0-9]+$'
      or length(coalesce(p.parts[2], '')) > 19
      or case
        when coalesce(p.parts[2], '') ~ '^[0-9]{1,19}$'
          then p.parts[2]::numeric not between
            1 and 9223372036854775807
        else false
      end
      or coalesce(p.parts[3], '') !~ '^[0-9]+$'
      or length(coalesce(p.parts[3], '')) > 19
      or case
        when coalesce(p.parts[3], '') ~ '^[0-9]{1,19}$'
          then p.parts[3]::numeric not between
            1 and 9223372036854775807
        else false
      end
      or nullif(p.parts[4], '') is null
      or coalesce(p.parts[5], '') !~ '^[0-9a-f]{64}$'
      or nullif(p.parts[6], '') is null
      or p.parts[6] is distinct from
        api_v1._normalize_ssl(p.parts[6])
    );

  if v_invalid_refs is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'malformed_source_ref',
        'invalid_refs', v_invalid_refs,
        'hint',
          'Use the six-part regulatory source_ref exactly as returned: source_id|source_release_id|source_record_id|field_key|binding_sha256|ssl.'
      )
    );
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 5) binding_sha256,
      split_part(ref, '|', 6) ssl
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
    where split_part(ref, '|', 4) ~
        '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
      or exists (
        select 1
        from meta.source_record_link l
        where l.source_id = split_part(ref, '|', 1)
      )
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_invalid_refs
  from parsed p
  where not exists (
    select 1
    from meta.source_record_link l
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    where l.source_id = p.source_id
      and l.source_release_id = p.source_release_id
      and l.source_record_id = p.source_record_id
      and l.link_status = 'linked'
  );

  if v_invalid_refs is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_release_mismatch',
        'invalid_refs', v_invalid_refs,
        'hint',
          'The cited release must be the published current release for this linked source record. Request a fresh source_ref from the connector.'
      )
    );
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 5) binding_sha256,
      split_part(ref, '|', 6) ssl
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
    where split_part(ref, '|', 4) ~
        '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
      or exists (
        select 1
        from meta.source_record_link l
        where l.source_id = split_part(ref, '|', 1)
      )
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_invalid_refs
  from parsed p
  where not exists (
    select 1
    from meta.source_record_link l
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join core.property_account_current a
      on a.account_id = l.account_id
     and not a.is_deleted
    where l.source_id = p.source_id
      and l.source_release_id = p.source_release_id
      and l.source_record_id = p.source_record_id
      and l.link_status = 'linked'
      and a.ssl_normalized = p.ssl
  );

  if v_invalid_refs is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_property_mismatch',
        'invalid_refs', v_invalid_refs,
        'hint',
          'The source record, release, and normalized property SSL are bound. Use the source_ref without editing any segment.'
      )
    );
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 5) binding_sha256,
      split_part(ref, '|', 6) ssl
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
    where split_part(ref, '|', 4) ~
        '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
      or exists (
        select 1
        from meta.source_record_link l
        where l.source_id = split_part(ref, '|', 1)
      )
  ),
  record_identity as (
    select
      r.source_id,
      r.source_release_id,
      r.source_record_id,
      r.source_row_sha256,
      r.record_kind record_type
    from regulatory.record r
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'cama_building_profile'
    from property_context.cama_building_profile p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'energy_benchmark'
    from property_context.energy_benchmark p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'beps'
    from property_context.beps_compliance p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'vacant_blighted'
    from property_context.vacant_blighted_status p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'land_designation'
    from property_context.land_designation p
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_invalid_refs
  from parsed p
  where not exists (
    select 1
    from meta.source_record_link l
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release rel
      on rel.release_id = l.source_release_id
     and rel.release_status = 'published'
     and rel.quality_status = 'passed'
    join core.property_account_current a
      on a.account_id = l.account_id
     and a.ssl_normalized = p.ssl
     and not a.is_deleted
    join record_identity r
      on r.source_id = l.source_id
     and r.source_release_id = l.source_release_id
     and r.source_record_id = l.source_record_id
    join semantic.regulatory_field_binding f
      on f.field_key = p.field_key
     and r.record_type = any(f.record_types)
    where l.source_id = p.source_id
      and l.source_release_id = p.source_release_id
      and l.source_record_id = p.source_record_id
      and l.link_status = 'linked'
  );

  if v_invalid_refs is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_field_mismatch',
        'invalid_refs', v_invalid_refs,
        'hint',
          'The field key is bound to the cited source-record type. Use the source_ref without editing its field segment.'
      )
    );
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 5) binding_sha256,
      split_part(ref, '|', 6) ssl
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
    where split_part(ref, '|', 4) ~
        '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
      or exists (
        select 1
        from meta.source_record_link l
        where l.source_id = split_part(ref, '|', 1)
      )
  ),
  record_identity as (
    select
      r.source_id,
      r.source_release_id,
      r.source_record_id,
      r.source_row_sha256,
      r.record_kind record_type
    from regulatory.record r
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'cama_building_profile'
    from property_context.cama_building_profile p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'energy_benchmark'
    from property_context.energy_benchmark p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'beps'
    from property_context.beps_compliance p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'vacant_blighted'
    from property_context.vacant_blighted_status p
    union all
    select
      p.source_id,
      p.source_release_id,
      p.source_record_id,
      p.source_row_sha256,
      'land_designation'
    from property_context.land_designation p
  )
  select jsonb_agg(to_jsonb(p.ref) order by p.ordinality)
  into v_invalid_refs
  from parsed p
  where not exists (
    select 1
    from record_identity r
    where r.source_id = p.source_id
      and r.source_release_id = p.source_release_id
      and r.source_record_id = p.source_record_id
      and p.binding_sha256 =
        api_v1._regulatory_binding_sha256(
          r.source_id,
          r.source_release_id,
          r.source_record_id,
          r.source_row_sha256,
          p.field_key,
          p.ssl
        )
  );

  if v_invalid_refs is not null then
    return jsonb_build_object(
      'status', 'invalid_input',
      'error', jsonb_build_object(
        'code', 'source_ref_binding_mismatch',
        'invalid_refs', v_invalid_refs,
        'hint',
          'The release, record, persisted row hash, field, and normalized SSL are cryptographically bound. Request a fresh source_ref without editing it.'
      )
    );
  end if;

  if v_old_refs is not null then
    v_old_result := api_v1._get_source_evidence_v04_base(v_old_refs);
    if v_old_result->>'status' is distinct from 'ok' then
      return v_old_result;
    end if;
    v_old_evidence := coalesce(
      v_old_result->'evidence',
      '[]'::jsonb
    );
  else
    v_old_evidence := '[]'::jsonb;
  end if;

  with parsed as (
    select
      ref,
      ordinality,
      split_part(ref, '|', 1) source_id,
      split_part(ref, '|', 2)::bigint source_release_id,
      split_part(ref, '|', 3)::bigint source_record_id,
      split_part(ref, '|', 4) field_key,
      split_part(ref, '|', 5) binding_sha256,
      split_part(ref, '|', 6) ssl
    from unnest(p_source_refs)
      with ordinality requested(ref, ordinality)
    where split_part(ref, '|', 4) ~
        '^(regulatory|permit|occupancy|license|inspection|enforcement|building|energy|beps|vacancy|land)\.'
      or exists (
        select 1
        from meta.source_record_link l
        where l.source_id = split_part(ref, '|', 1)
      )
  ),
  expanded as (
    select
      p.*,
      l.link_scope,
      l.link_method,
      l.match_quality,
      l.link_confidence,
      a.ssl_display,
      a.premise_address account_address,
      case
        when p.ssl ~ '^[0-9]{8}$' then
          substring(p.ssl from 1 for 4) ||
          ',' ||
          substring(p.ssl from 5 for 4)
      end tops_square_lot,
      s.publisher,
      s.dataset_name,
      s.source_class,
      s.dataset_retrieved_at,
      s.archive_capture_at,
      s.sha256,
      sr.snapshot_retrieved_at,
      sr.data_effective_at,
      sr.sha256 release_sha256,
      r.record_kind,
      r.record_number,
      r.premise_address regulatory_address,
      bl.entity_name,
      bl.trade_name,
      coalesce(
        c.premise_address,
        en.premise_address,
        be.premise_address,
        vb.premise_address,
        ld.source_address
      ) context_address,
      en.source_building_id energy_building_id,
      en.reporting_year,
      be.source_building_id beps_building_id,
      be.compliance_cycle,
      ld.designation_name,
      case
        when ld.source_record_id is not null then 'propertyquest'
        when c.source_record_id is not null then 'propertyquest'
        when en.source_record_id is not null
          or be.source_record_id is not null then 'beam'
        when vb.source_record_id is not null then 'dob_vacant'
        when p.source_id like 'ddot_%' then 'tops'
        when p.source_id like
          'abca_alcohol_license_locations%' then 'abca_alcohol'
        when p.source_id like
          'abca_medical_cannabis_nonretailers%'
          then 'abca_cannabis_nonretailer'
        when p.source_id like
          'abca_medical_cannabis_retailers%'
          then 'abca_cannabis_retailer'
        when p.source_id like 'abca_%'
          or r.record_kind in (
            'alcohol_license',
            'cannabis_license'
          ) then 'abca'
        when p.source_id like 'doee_well_permits%'
          or r.record_kind = 'well_permit' then 'doee_well'
        when p.source_id like 'doee_energy_benchmarking%'
          or p.source_id like 'doee_beps%' then 'beam'
        when p.source_id like 'dob_vacant_blighted%' then 'dob_vacant'
        when p.source_id like 'cama_%' then 'propertyquest'
        else 'scout'
      end portal_family
    from parsed p
    join meta.source_record_link l
      on l.source_id = p.source_id
     and l.source_release_id = p.source_release_id
     and l.source_record_id = p.source_record_id
     and l.link_status = 'linked'
    join meta.source_release_pointer rp
      on rp.source_id = l.source_id
     and rp.pointer_name = 'current'
     and rp.release_id = l.source_release_id
    join meta.source_release sr
      on sr.release_id = l.source_release_id
     and sr.release_status = 'published'
     and sr.quality_status = 'passed'
    join core.property_account_current a
      on a.account_id = l.account_id
     and a.ssl_normalized = p.ssl
     and not a.is_deleted
    join meta.source_asset s
      on s.source_id = p.source_id
    left join regulatory.record r
      on r.source_id = p.source_id
     and r.source_release_id = l.source_release_id
     and r.source_record_id = p.source_record_id
    left join regulatory.business_license bl
      on bl.record_id = r.record_id
    left join property_context.cama_building_profile c
      on c.source_id = p.source_id
     and c.source_release_id = l.source_release_id
     and c.source_record_id = p.source_record_id
    left join property_context.energy_benchmark en
      on en.source_id = p.source_id
     and en.source_release_id = l.source_release_id
     and en.source_record_id = p.source_record_id
    left join property_context.beps_compliance be
      on be.source_id = p.source_id
     and be.source_release_id = l.source_release_id
     and be.source_record_id = p.source_record_id
    left join property_context.vacant_blighted_status vb
      on vb.source_id = p.source_id
     and vb.source_release_id = l.source_release_id
     and vb.source_record_id = p.source_record_id
    left join property_context.land_designation ld
      on ld.source_id = p.source_id
     and ld.source_release_id = l.source_release_id
     and ld.source_record_id = p.source_record_id
  ),
  routed as (
    select
      e.*,
      coalesce(
        e.regulatory_address,
        e.context_address,
        e.account_address
      ) search_address,
      case e.portal_family
        when 'tops' then 'DDOT Transportation Online Permitting System (TOPS)'
        when 'abca_alcohol' then 'ABCA Current Alcohol License Holders'
        when 'abca_cannabis_nonretailer'
          then 'ABCA Medical Cannabis Non-Retailer Licensees'
        when 'abca_cannabis_retailer'
          then 'ABCA Medical Cannabis Retailer Licensees'
        when 'abca' then 'ABCA Licensing Services'
        when 'doee_well' then 'DOEE Well Permitting'
        when 'beam' then 'Building Energy Performance DC'
        when 'dob_vacant' then 'DOB Vacant and Blighted Buildings'
        when 'propertyquest' then 'DC PropertyQuest'
        else 'D.C. Department of Buildings SCOUT'
      end portal_name,
      case e.portal_family
        when 'tops' then
          'https://tops.ddot.dc.gov/DDOTPermitSystem/DDOTPermitOnline/MapLookup.aspx'
        when 'abca_alcohol' then 'https://abca.dc.gov/node/612672'
        when 'abca_cannabis_nonretailer'
          then 'https://abca.dc.gov/node/1657531'
        when 'abca_cannabis_retailer'
          then 'https://abca.dc.gov/node/1751426'
        when 'abca' then 'https://abca.dc.gov/page/licensing'
        when 'doee_well' then 'https://doee.dc.gov/service/well-permitting'
        when 'beam' then 'https://buildingperformancedc.org/'
        when 'dob_vacant' then 'https://dob.dc.gov/vacantbuildings'
        when 'propertyquest' then 'https://propertyquest.dc.gov/'
        else 'https://scout.dob.dc.gov/'
      end portal_url
    from expanded e
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source_ref', e.ref,
        'field_key', e.field_key,
        'publisher', e.publisher,
        'dataset_name', e.dataset_name,
        'source_class', e.source_class,
        'property_link', api_v1._regulatory_property_link(
          e.link_scope,
          e.link_method,
          e.match_quality,
          e.link_confidence
        ),
        'human_verification', jsonb_build_object(
          'portal_name', e.portal_name,
          'portal_url', e.portal_url,
          'access', case
            when e.portal_family in (
              'scout',
              'tops',
              'propertyquest',
              'beam',
              'dob_vacant',
              'abca_alcohol',
              'abca_cannabis_nonretailer',
              'abca_cannabis_retailer'
            )
              then 'Public human interface; no sign-in should be required for the cited search workflow.'
            else
              'Open the public human interface; some record detail or account workflows may request sign-in.'
          end,
          'search_inputs', jsonb_strip_nulls(jsonb_build_object(
            'ssl', e.ssl_display,
            'tops_square_lot', case
              when e.portal_family = 'tops'
                then e.tops_square_lot
            end,
            'property_address', e.search_address,
            'record_number', e.record_number,
            'source_record_id', e.source_record_id,
            'licensed_entity', e.entity_name,
            'trade_name', e.trade_name,
            'energy_building_id', e.energy_building_id,
            'energy_reporting_year', e.reporting_year,
            'beps_building_id', e.beps_building_id,
            'beps_compliance_cycle', e.compliance_cycle,
            'designation_name', e.designation_name,
            'field_to_verify', e.field_key
          )),
          'steps', case e.portal_family
            when 'scout' then case
              when e.record_kind = 'business_license'
                or e.source_id like 'dlcp_%' then jsonb_build_array(
                  'Open the public D.C. Department of Buildings SCOUT interface.',
                  'Search by the supplied premise address and open the matching property.',
                  'Review the business-license section and compare the supplied record number, licensed entity or trade name, cited field, and status.'
                )
              else jsonb_build_array(
                'Open the public D.C. Department of Buildings SCOUT interface.',
                'Choose Permit # when a record number is supplied; otherwise choose Address and enter the supplied property address.',
                'Open the matching record and compare the cited field, status, and dates.'
              )
            end
            when 'tops' then jsonb_build_array(
              'Open the public DDOT TOPS Map/Info Lookup Tool.',
              'Enter the supplied property address, or enter the supplied tops_square_lot value in Square,Lot format with no spaces.',
              'Select the matching location, open the relevant permit or inspection, and compare the cited field, status, and dates.'
            )
            when 'propertyquest' then jsonb_build_array(
              'Open DC PropertyQuest.',
              'Enter the supplied street address or SSL in the search box and choose the matching property.',
              'Review the property/building panel for the cited CAMA or land-context field and use the source-agency links for definitive confirmation.'
            )
            when 'beam' then jsonb_build_array(
              'Open Building Energy Performance DC.',
              'Search or filter by the supplied address, building identifier, reporting year, or BEPS cycle.',
              'Open the matching building record and compare the cited metric or compliance field.'
            )
            when 'doee_well' then jsonb_build_array(
              'Open the DOEE Well Permitting page.',
              'Use the supplied permit number, source record ID, or address in the public lookup workflow linked from that page.',
              'Compare the cited permit field and current agency status.'
            )
            when 'dob_vacant' then jsonb_build_array(
              'Open the DOB Vacant and Blighted Buildings page.',
              'Open the Vacant Property Map/Public Dashboard and search with the supplied address or SSL.',
              'Compare the current classification or exemption context with the cited source date.'
            )
            when 'abca' then jsonb_build_array(
              'Open ABCA Licensing Services.',
              'Choose the applicable alcohol or medical-cannabis licensing/records search and use the supplied record number, entity, trade name, or premise address.',
              'Open the matching licensed-location record and compare the cited field and current status.'
            )
            when 'abca_alcohol' then jsonb_build_array(
              'Open the public ABCA Current Alcohol License Holders page; no sign-in is required.',
              'Open the current PDF holder list, then use browser Find (Ctrl+F or Command+F) with the supplied license or record number, licensed entity or trade name, or premise address.',
              'Compare the matching licensed-business row with the cited field and status.'
            )
            when 'abca_cannabis_nonretailer' then jsonb_build_array(
              'Open the public ABCA Medical Cannabis Non-Retailer Licensees page; no sign-in is required.',
              'Use browser Find (Ctrl+F or Command+F) with the supplied license or record number, licensed entity or trade name, or premise address.',
              'Compare the matching non-retailer licensed-location entry with the cited field and status.'
            )
            when 'abca_cannabis_retailer' then jsonb_build_array(
              'Open the public ABCA Medical Cannabis Retailer Licensees page; no sign-in is required.',
              'Use browser Find (Ctrl+F or Command+F) with the supplied license or record number, licensed entity or trade name, or premise address.',
              'Compare the matching retailer licensed-location entry with the cited field and status.'
            )
          end,
          'verification_note',
            'This result came from a dated official source release. The human portal can be newer; compare the source record, field label, property identifier, and source date.'
        ),
        'alternate_human_verification', case
          when e.portal_family = 'propertyquest' then jsonb_build_array(
            jsonb_build_object(
              'portal_name', 'MyTax.DC.gov Real Property Search',
              'portal_url',
                'https://mytax.dc.gov/_/#2',
              'search_inputs', jsonb_build_object(
                'ssl', e.ssl_display,
                'property_address', e.search_address
              ),
              'use_when',
                'Use MyTax for current tax-account, assessment, owner, billing, and payment details; PropertyQuest is a planning interface.'
            )
          )
          when e.portal_family = 'dob_vacant' then jsonb_build_array(
            jsonb_build_object(
              'portal_name', 'MyTax.DC.gov Real Property Search',
              'portal_url',
                'https://mytax.dc.gov/_/#2',
              'search_inputs', jsonb_build_object(
                'ssl', e.ssl_display,
                'property_address', e.search_address
              ),
              'use_when',
                'Use MyTax to compare the current tax classification associated with vacant or blighted treatment.'
            )
          )
          else '[]'::jsonb
        end,
        'provenance', jsonb_strip_nulls(jsonb_build_object(
          'source_id', e.source_id,
          'source_record_id', e.source_record_id,
          'source_release_id', e.source_release_id,
          'snapshot_retrieved_at', e.snapshot_retrieved_at,
          'data_effective_at', e.data_effective_at,
          'dataset_retrieved_at', e.dataset_retrieved_at,
          'archive_capture_at', e.archive_capture_at,
          'release_sha256', e.release_sha256,
          'source_asset_sha256', e.sha256
        ))
      )
      order by e.ordinality
    ),
    '[]'::jsonb
  )
  into v_new_evidence
  from routed e;

  with all_evidence as (
    select item->>'source_ref' source_ref, item
    from jsonb_array_elements(v_new_evidence) item
    union all
    select item->>'source_ref' source_ref, item
    from jsonb_array_elements(v_old_evidence) item
  ),
  requested as (
    select ref, ordinality
    from unnest(p_source_refs)
      with ordinality refs(ref, ordinality)
  )
  select coalesce(
    jsonb_agg(e.item order by r.ordinality),
    '[]'::jsonb
  )
  into v_combined
  from requested r
  join all_evidence e on e.source_ref = r.ref;

  return jsonb_build_object(
    'status', 'ok',
    'evidence', v_combined,
    'verification_policy',
      'Only official human-facing portals are returned. Machine endpoints, ArcGIS REST services, raw downloads, and session-bound document URLs are deliberately excluded.'
  );
end;
$function$;

revoke all on function api_v1.get_source_evidence(text[])
  from public;
grant execute on function api_v1.get_source_evidence(text[])
  to mcp_runtime;

comment on function api_v1.get_source_evidence(text[]) is
  'Validates the current source release, source record, persisted row hash, field, and normalized SSL binding before returning official human-facing verification portals and exact search inputs.';

do $block$
begin
  if to_regprocedure(
    'api_v1._describe_data_v04_base(text)'
  ) is null then
    alter function api_v1.describe_data(text)
      rename to _describe_data_v04_base;
  end if;
end;
$block$;

revoke all on function api_v1._describe_data_v04_base(text)
  from public, mcp_runtime;
grant execute on function api_v1._describe_data_v04_base(text)
  to api_owner;

create or replace function api_v1.describe_data(
  p_question text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  v_question text := nullif(trim(p_question), '');
  v_q text := lower(coalesce(v_question, ''));
  v_result jsonb;
  v_source_families jsonb;
  v_field_definitions jsonb;
begin
  if v_q ~
    '(permit|license|inspection|enforcement|violation|certificate of occupancy|c of o|building profile|year built|energy|benchmark|beps|vacant|blight|land designation|zoning|historic|public space|well|cannabis|alcohol)' then
    with per_source_counts as (
      select
        l.source_id,
        count(*) linked_property_records,
        count(*) filter (
          where l.link_scope = 'exact_property'
        ) exact_property_links,
        count(*) filter (
          where l.link_scope in (
            'shared_building',
            'multi_parcel',
            'proximity_context'
          )
        ) contextual_links
      from meta.source_record_link l
      join meta.source_release_pointer rp
        on rp.source_id = l.source_id
       and rp.pointer_name = 'current'
       and rp.release_id = l.source_release_id
      join meta.source_release rel
        on rel.release_id = l.source_release_id
       and rel.release_status = 'published'
       and rel.quality_status = 'passed'
      where l.link_status = 'linked'
      group by l.source_id
    ),
    link_counts as (
      select
        f.source_family_key,
        count(s.source_id) loaded_sources,
        coalesce(sum(s.linked_property_records), 0)
          linked_property_records,
        coalesce(sum(s.exact_property_links), 0)
          exact_property_links,
        coalesce(sum(s.contextual_links), 0)
          contextual_links
      from semantic.source_family_definition f
      left join per_source_counts s
        on s.source_id ~ f.source_id_pattern
      where f.exposure_allowed
      group by f.source_family_key
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_family_key', f.source_family_key,
          'title', f.title,
          'definition', f.definition,
          'record_types', to_jsonb(f.record_types),
          'recommended_tool', f.recommended_tool,
          'human_portal_family', f.portal_family,
          'attribution_scope', f.attribution_scope,
          'caveat', f.caveat,
          'loaded_sources', coalesce(c.loaded_sources, 0),
          'linked_property_records',
            coalesce(c.linked_property_records, 0),
          'exact_property_links',
            coalesce(c.exact_property_links, 0),
          'contextual_links', coalesce(c.contextual_links, 0)
        )
        order by f.source_family_key
      ),
      '[]'::jsonb
    )
    into v_source_families
    from semantic.source_family_definition f
    left join link_counts c
      on c.source_family_key = f.source_family_key
    where f.exposure_allowed;

    select coalesce(
      jsonb_object_agg(
        f.field_key,
        jsonb_build_object(
          'title', f.title,
          'definition', f.definition,
          'unit', f.unit,
          'null_semantics', f.null_semantics,
          'aggregation_rule', f.aggregation_rule,
          'caveat', f.caveat,
          'record_types', to_jsonb(b.record_types)
        )
      ),
      '{}'::jsonb
    )
    into v_field_definitions
    from semantic.field_definition f
    join semantic.regulatory_field_binding b
      on b.field_key = f.field_key
    where f.exposure_allowed
      and (
        v_q ~ '(permit|certificate|c of o|well|public space)'
          and f.field_key ~ '^(regulatory|permit|occupancy)\.'
        or v_q ~ '(license|business|alcohol|cannabis)'
          and f.field_key ~ '^(regulatory|license)\.'
        or v_q ~ '(inspection|enforcement|violation)'
          and f.field_key ~
            '^(regulatory|inspection|enforcement)\.'
        or v_q ~ '(building profile|year built|energy|benchmark|beps|vacant|blight|land designation|zoning|historic)'
          and f.field_key ~
            '^(building|energy|beps|vacancy|land)\.'
      );

    return jsonb_build_object(
      'status', 'ok',
      'question', v_question,
      'answer',
        'Use the four curated public-record tools after resolving one D.C. tax account. Every returned fact carries a source_ref that expands to an official human portal, exact search inputs, and verification steps.',
      'tools', jsonb_build_object(
        'get_permit_history',
          'DOB building permits and certificates plus DDOT public-space, DOB home-occupancy, DOEE well, tree, rental, and emergency-work records.',
        'get_license_history',
          'DLCP basic-business and ABCA alcohol/cannabis licensed-location records. These are business-at-premise records, not property ownership or lease conclusions.',
        'get_inspection_and_enforcement_history',
          'Official inspection and enforcement history with publishing-agency identity preserved. DDOT public-space inspection is never labeled as DOB building inspection.',
        'get_building_and_land_profile',
          'Exact CAMA tax-account building characteristics plus explicitly contextual energy, BEPS, vacancy/blight, and land-designation records.'
      ),
      'filters', jsonb_build_object(
        'common', jsonb_build_array(
          'record_types',
          'status',
          'date_from',
          'date_to',
          'limit',
          'cursor'
        ),
        'database_page_cap', 50,
        'cursor_rule',
          'Use next_cursor exactly as returned; cursors are deterministic and validated.'
      ),
      'source_families', v_source_families,
      'field_definitions', v_field_definitions,
      'critical_distinctions', jsonb_build_array(
        'Only exact_property is an exact tax-account assertion. shared_building, multi_parcel, and proximity_context are contextual.',
        'A business license identifies a licensed business at a premise and does not establish property ownership, borrower identity, tenancy duration, or lease status.',
        'A DDOT/TOPS inspection concerns public space and is not a DOB building, housing, or certificate-of-occupancy inspection.',
        'Energy benchmarking and BEPS are building-level context and can span multiple condominium or tax accounts.',
        'An empty result means no linked record in the loaded official releases matched; it is not proof that no public record exists.',
        'Permit issuance does not prove completion, final inspection, current condition, or code compliance.'
      ),
      'evidence_policy',
        'get_source_evidence validates the current source release, source record, persisted row hash, field, and normalized SSL binding and returns only official human-facing interfaces. Machine APIs, raw downloads, and session-bound links are excluded.'
    );
  end if;

  v_result := api_v1._describe_data_v04_base(p_question);

  if v_result ? 'tools' then
    v_result := jsonb_set(
      v_result,
      '{tools}',
      (v_result->'tools') || jsonb_build_object(
        'get_permit_history',
          'Curated official building, occupancy, public-space, home-occupancy, well, tree, rental, and emergency-work permit history.',
        'get_license_history',
          'Curated official business-at-premise and alcohol/cannabis license history.',
        'get_inspection_and_enforcement_history',
          'Curated official inspection and enforcement history with agency identity preserved.',
        'get_building_and_land_profile',
          'Exact CAMA profile plus explicitly contextual building-energy, BEPS, vacancy, and land records.'
      )
    );
  else
    v_result := v_result || jsonb_build_object(
      'tools', jsonb_build_object(
        'get_permit_history',
          'Curated official permit history.',
        'get_license_history',
          'Curated official licensed-location history.',
        'get_inspection_and_enforcement_history',
          'Curated official inspection and enforcement history.',
        'get_building_and_land_profile',
          'Curated building and land context.'
      )
    );
  end if;

  v_result := v_result || jsonb_build_object(
    'regulatory_attribution_rule',
      'Only exact_property is exact. shared_building, multi_parcel, and proximity_context are contextual and must remain labeled.',
    'regulatory_evidence_policy',
      'Regulatory source_refs expand to official human portals and are bound to source record, field, and SSL.'
  );

  if v_result ? 'human_portals' then
    v_result := jsonb_set(
      v_result,
      '{human_portals}',
      (v_result->'human_portals') || jsonb_build_array(
        'D.C. Department of Buildings SCOUT',
        'DDOT TOPS',
        'DC PropertyQuest',
        'Building Energy Performance DC',
        'DOEE Well Permitting',
        'DOB Vacant and Blighted Buildings',
        'ABCA Licensing Services'
      )
    );
  end if;

  return v_result;
end;
$function$;

revoke all on function api_v1.describe_data(text)
  from public;
grant execute on function api_v1.describe_data(text)
  to mcp_runtime;

comment on function api_v1.describe_data(text) is
  'Semantic router and data dictionary for property, assessment, tax, sale, regulatory, building, and land questions.';

reset role;

comment on table semantic.source_family_definition is
  'AI-facing definitions, attribution rules, recommended tools, and human portal families for official regulatory and property-context sources.';
comment on table semantic.regulatory_field_binding is
  'Allowlist binding each exposed regulatory field key to compatible normalized record types; source evidence rejects edited or cross-type refs.';

commit;
