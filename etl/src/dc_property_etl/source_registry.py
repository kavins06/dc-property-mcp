from __future__ import annotations

from dataclasses import dataclass


DCGIS_FEATURE_SERVER = (
    "https://maps2.dcgis.dc.gov/dcgis/rest/services"
)


@dataclass(frozen=True, slots=True)
class ArcGisSource:
    source_id: str
    family: str
    publisher: str
    dataset_name: str
    item_id: str | None
    layer_url: str
    landing_url: str
    human_portal_url: str
    human_portal_name: str
    fields: tuple[str, ...]
    expected_min_rows: int
    source_limitations: str


PERMIT_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "DCRAINTERNALNUMBER",
    "PERMIT_ID",
    "ISSUE_DATE",
    "PERMIT_TYPE_NAME",
    "PERMIT_SUBTYPE_NAME",
    "PERMIT_CATEGORY_NAME",
    "APPLICATION_STATUS_NAME",
    "FULL_ADDRESS",
    "DESC_OF_WORK",
    "SSL",
    "ZONING",
    "FEE_TYPE",
    "FEES_PAID",
    "MARADDRESSREPOSITORYID",
    "LATITUDE",
    "LONGITUDE",
    "LASTMODIFIEDDATE",
)

BBL_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "CUSTOMERNUMBER",
    "LICENSESTATUS",
    "LICENSETYPE",
    "LICENSESUBTYPE",
    "LICENSESTATUSDATE",
    "LICENSESTARTDATE",
    "LICENSEENDDATE",
    "INITIALISSUEDATE",
    "PRIMARYACTIVITY",
    "BUSINESSACTIVITY",
    "PREMISEADDRESS",
    "PREMISEINDC",
    "ENTITYNAME",
    "ENTITYTRADENAME",
    "ENTITYTYPE",
    "DATAREFRESHEDON",
    "MAR_ID",
    "SSL",
    "LATITUDE",
    "LONGITUDE",
)

OCCUPANCY_FIELDS = (
    "OBJECTID",
    "PERMIT_NUMBER",
    "ISSUE_DATE",
    "EXPIRATION_DATE",
    "ADDRESS",
    "SSL",
    "MAR_ID",
    "DESCRIPTION_OF_OCCUPANCY",
    "PERMISSION_GRANTED_TO",
    "TRADING_AS",
    "OCCUPANCY_LOAD",
    "B_Z_A_NUMBER",
    "APPROVED_BUILDING_CODE_USE",
    "APPROVED_ZONING_USE",
    "APPROVED_ZONING_GENERAL_USE",
    "APPLICATION_COMMENTS",
    "FLOORS_OCCUPIED",
    "OCCUPIED_SQ_FOOTAGE",
    "OCCPNT_TOT_NUM_OF_DWELL_UNITS",
    "CONDITIONAL_RESTRICTION",
    "DCS_LAST_MOD_DTTM",
    "LATITUDE",
    "LONGITUDE",
)

CAMA_COMMON_FIELDS = (
    "OBJECTID",
    "SSL",
    "BLDG_NUM",
    "SALEDATE",
    "PRICE",
    "QUALIFIED",
    "AYB",
    "YR_RMDL",
    "EYB",
    "SALE_NUM",
    "USECODE",
    "LANDAREA",
    "GIS_LAST_MOD_DTTM",
)

ENERGY_FIELDS = (
    "OBJECTID",
    "PID",
    "SSL",
    "PMPROPERTYID",
    "PROPERTYNAME",
    "REPORTINGYEAR",
    "REPORTSTATUS",
    "ADDRESSOFRECORD",
    "REPORTEDADDRESS",
    "YEARBUILT",
    "PRIMARYPROPERTYTYPE_SELFSELECT",
    "PRIMARYPROPERTYTYPE_EPACALC",
    "TAXRECORDFLOORAREA",
    "REPORTEDBUILDINGGROSSFLOORAREA",
    "ENERGYSTARSCORE",
    "SITEEUI_KBTU_FT",
    "WEATHERNORMALZEDSITEEUI_KBTUFT",
    "SOURCEEUI_KBTU_FT",
    "TOTGHGEMISSIONS_METRICTONSCO2E",
    "TOTGHGEMISSINTENSITY_KGCO2EFT",
    "WATERSCORE_MFPROPERTIES",
    "WATERUSE_ALLWATERSOURCES_KGAL",
    "NATURALGASUSE_THERMS",
    "ELECTRICITYUSE_RENEWABLE_KWH",
    "ELECTRICITYUSE_GRID_KWH",
    "ADDRESSID",
    "UBID",
    "ENFORCEMENT_ACTION",
    "LASTUPDATE",
    "LATITUDE",
    "LONGITUDE",
)

BEPS_FIELDS = (
    "OBJECTID",
    "PID",
    "SSL",
    "PMPROPERTYID",
    "UBID",
    "PROPERTYNAME",
    "ADDRESSOFRECORD",
    "REPORTEDADDRESS",
    "YEARBUILT",
    "PRIMARYPROPERTYTYPE_EPACALC",
    "TAXRECORDFLOORAREA",
    "REPORTEDBUILDINGGROSSFLOORAREA",
    "BEPS",
    "BEPS_METRIC_TYPE",
    "PROPERTY_BEPS_METRIC_YEAR",
    "BEPS_PROPERTY_GROUP",
    "PROPERTY_BEPS_METRIC",
    "DISTANCE_FROM_BEPS_ESTIMATED",
    "PERFORMANCE_REQUIREMENT_EST",
    "MEETS_BEPS",
    "APPROVED_COMPLIANCE_PATHWAY",
    "LASTUPDATE",
    "MAR_ID",
    "LATITUDE",
    "LONGITUDE",
)

VACANT_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "ADDRESS",
    "STATUS",
    "SSL",
    "MAR_ID",
    "BUILDING",
    "MULTIPLE_LAND_SSL",
    "HOUSING_UNIT_COUNT",
    "RESIDENTIAL_UNIT_COUNT",
    "BEFORE_DATE",
    "BEGIN_DATE",
    "FIRST_KNOWN_DATE",
    "CREATED_DATE",
    "LAST_EDITED_DATE",
    "LATITUDE",
    "LONGITUDE",
)

TOPS_CONSTRUCTION_FIELDS = (
    "OBJECTID",
    "GlobalID",
    "TrackingNumber",
    "PermitNumber",
    "Status",
    "StatusDescription",
    "ApplicationDate",
    "IssueDate",
    "EffectiveDate",
    "ExpirationDate",
    "LastUpdateDate",
    "PermitType",
    "TypeDetailNames",
    "WorkLocationFullAddress",
    "WorkLocationAddressID",
    "WorkDetail",
    "TotalFee",
    "PermitFee",
    "InspectionNumber",
    "IsExcavation",
    "IsFixture",
    "IsPaving",
    "IsOccupancy",
    "IsLandscaping",
    "IsProjections",
    "IsPSRental",
    "IsOverHeadWork",
    "IsAnnualPermit",
    "Latitude",
    "Longitude",
)

TOPS_OCCUPANCY_FIELDS = (
    "OBJECTID",
    "GlobalID",
    "TrackingNumber",
    "PermitNumber",
    "ConstructionPermitNumber",
    "ConstructionTrackingNumber",
    "Status",
    "StatusDescription",
    "EventTypeDescription",
    "OtherEventType",
    "ApplicationDate",
    "IssueDate",
    "EffectiveDate",
    "ExpirationDate",
    "LastUpdateDate",
    "WorkLocationFullAddress",
    "LocationID",
    "TotalPermitFee",
    "IsRoadClosed",
    "IsCoveredWalkway",
    "CoveredWalkwayType",
    "Latitude",
    "Longitude",
)

TOPS_INSPECTION_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "INSPECTIONID",
    "PERMITNUMBER",
    "TRACKINGNUMBER",
    "INSPECTIONLOCATION",
    "APPLICATIONTYPE",
    "CREATIONDATE",
    "LASTUPDATEDATE",
    "INSPECTIONDATE",
    "INSPECTIONSTATUSCODE",
    "INSPECTIONSTATUSDESC",
    "NOTESFORPERMITTEE",
    "LATITUDE",
    "LONGITUDE",
)

TOPS_NONPERMIT_INSPECTION_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "INSPECTIONID",
    "INCIDENTCASENUMBER",
    "INCIDENTNAME",
    "INCIDENTSTATUSCODE",
    "INCIDENTSTATUSDESC",
    "INSPECTIONLOCATION",
    "PROBLEMCODE",
    "PROBELMDESCRIPTION",
    "CREATIONDATE",
    "LASTUPDATEDATE",
    "INSPECTIONDATE",
    "NOTESFORPERMITTEE",
    "LATITUDE",
    "LONGITUDE",
)

HOME_OCCUPANCY_FIELDS = (
    "OBJECTID",
    "HOP_PERMIT_NUMBER",
    "ISSUE_DATE",
    "EXPIRATION_DATE",
    "ADDRESS",
    "MAR_ID",
    "BUSINESS_ENTITY_TYPE",
    "BUSINESS_ENTITY",
    "DESCRIPTION",
    "BUSINESS_OWNER_TENANT",
    "BZA_NUMBER",
    "TOTAL_SQUARE_FOOTAGE",
    "PERCENT_OF_USE",
    "NUMBER_OF_EMPLOYEES",
    "DAYS_OF_OPERATION",
    "HOURS_OF_OPERATION",
    "CONDITION_RESTRICTION",
    "DCS_LAST_MOD_DTTM",
    "LATITUDE",
    "LONGITUDE",
)

TREE_PERMIT_FIELDS = (
    "OBJECTID",
    "TrackingNumber",
    "PermitNumber",
    "Status",
    "ApplicationDate",
    "IssueDate",
    "EffectiveDate",
    "ExpirationDate",
    "LastUpdateDate",
    "TreeLocation",
    "TotalTreeCount",
    "HazardousTreeCount",
    "NonHazardousTreeCount",
    "HeritageHazardousTreeCount",
    "HeritageNonHazardousTreeCount",
    "ExemptedTreeCount",
    "Under55TreeCount",
    "SpecialTreesPreservationCount",
    "SpecialTreesRelocationCount",
    "HeritageTreesPreservationCount",
    "HeritageTreesRelocationCount",
    "TreeFundAmount",
    "Latitude",
    "Longitude",
)

ANNUAL_PUBLIC_SPACE_FIELDS = (
    "OBJECTID",
    "TrackingNumber",
    "PermitNumber",
    "ConstructionPermitNumber",
    "ConstructionTrackingNumber",
    "Status",
    "StatusDescription",
    "EventTypeDescription",
    "ApplicationDate",
    "IssueDate",
    "EffectiveDate",
    "ExpirationDate",
    "LastUpdateDate",
    "WorkLocationFullAddress",
    "TotalPermitFee",
    "TotalCarSpace",
    "Latitude",
    "Longitude",
)

EMERGENCY_WORK_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "CONSTRUCTIONTRACKINGNUMBER",
    "OCCUPANCYTRACKINGNUMBER",
    "EMERGENCYCAUSE",
    "EMERGENCYTYPEDESC",
    "LOCATIONDESCRIPTION",
    "STATUS",
    "STATUSDESC",
    "APPLICATIONDATE",
    "EFFECTIVEDATE",
    "EXPIRATIONDATE",
    "ISSUEDDATE",
    "LASTUPDATEDATE",
    "LATITUDE",
    "LONGITUDE",
)

WELL_PERMIT_FIELDS = (
    "OBJECTID",
    "DCRAPERMITNUMBER",
    "ADDRESS",
    "NUMBEROFWELLS",
    "TYPEOFWELLS",
    "XCOORD",
    "YCOORD",
)

ALCOHOL_LICENSE_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "LICENSE",
    "APPLICANT",
    "TRADE_NAME",
    "CLASS",
    "TYPE",
    "STATUS",
    "ADDRESS",
    "EXPIRATION_DATE",
    "TOTAL_CAPACITY",
    "CO_CAPACITY",
    "MAR_ID",
    "LATITUDE",
    "LONGITUDE",
    "BREW_PUB",
    "ENTERTAINMENT",
    "SALES_CONSUMPTION",
    "SIDEWALK_CAFE",
    "SUMMER_GARDEN",
    "TASTING",
    "WINE_PUB",
    "COVERCHARGE",
    "DANCING",
    "OFFPREMISESTORAGE",
    "STORAGEFACILITY",
    "DISTILLERY_PUB",
    "GAMES_OF_SKILL",
    "SPORTS_WAGGERING",
    "CARRYOUT_DELIVERY",
    "STREATERY",
    "EDITED",
)

CANNABIS_NONRETAIL_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "ABCA_NUMBER",
    "NAME",
    "FACILITY_TYPE",
    "ADDRESS",
    "STATUS",
    "ISSUE_DATE",
    "EXPIRATION_DATE",
    "TRADE_NAME",
    "ENTITY_NAME",
    "LICENSE_TYPE",
    "ENDORSEMENTS",
    "MAR_ID",
    "LATITUDE",
    "LONGITUDE",
    "LAST_EDITED_DATE",
)

CANNABIS_RETAIL_FIELDS = (
    "OBJECTID",
    "GLOBALID",
    "ABCA_NUMBER",
    "FACILITY_NAME",
    "FACILITY_TYPE",
    "ADDRESS",
    "STATUS",
    "ISSUE_DATE",
    "EXPIRATION_DATE",
    "TRADE_NAME",
    "ENTITY_NAME",
    "LICENSE_TYPE",
    "ENDORSEMENTS",
    "MAR_ID",
    "LATITUDE",
    "LONGITDUE",
    "EDITED",
)


def _building_permit_sources() -> tuple[ArcGisSource, ...]:
    layer_by_year = {
        2009: 12,
        2010: 11,
        2011: 10,
        2012: 7,
        2013: 6,
        2014: 5,
        2015: 25,
        2016: 24,
        2017: 37,
        2018: 9,
        2019: 8,
        2020: 2,
        2021: 3,
        2022: 14,
        2023: 15,
        2024: 16,
        2025: 17,
        2026: 18,
    }
    return tuple(
        ArcGisSource(
            source_id=f"dob_building_permits_{year}",
            family="building_permit",
            publisher="D.C. Department of Buildings",
            dataset_name=f"Building Permits in {year}",
            item_id=(
                "4aeaaa42c5e04b58b87f07e4511766c1"
                if year == 2025
                else None
            ),
            layer_url=(
                f"{DCGIS_FEATURE_SERVER}/FEEDS/DCRA/FeatureServer/{layer}"
            ),
            landing_url=(
                "https://opendata.dc.gov/datasets/DCGIS::"
                f"building-permits-in-{year}"
            ),
            human_portal_url="https://scout.dob.dc.gov/",
            human_portal_name="D.C. Department of Buildings SCOUT",
            fields=(
                tuple(
                    field
                    for field in PERMIT_FIELDS
                    if field != "FEES_PAID"
                )
                if year in {2018, 2019}
                else PERMIT_FIELDS
            ),
            expected_min_rows=20_000,
            source_limitations=(
                "Issued building construction and alteration permit records. "
                "Geocoding and source SSL values can be absent or imperfect; "
                "a permit does not establish completion or code compliance."
                + (
                    " The official service cannot reliably serialize "
                    "FEES_PAID for this annual layer, so that field is "
                    "excluded while all source records are retained."
                    if year in {2018, 2019}
                    else ""
                )
            ),
        )
        for year, layer in layer_by_year.items()
    )


SOURCES: tuple[ArcGisSource, ...] = (
    *_building_permit_sources(),
    ArcGisSource(
        source_id="dlcp_basic_business_licenses",
        family="business_license",
        publisher=(
            "D.C. Department of Licensing and Consumer Protection"
        ),
        dataset_name="Basic Business Licenses",
        item_id="85bf98d3915f412c8a4de706f2d13513",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/FEEDS/DCRA/FeatureServer/0"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "basic-business-licenses"
        ),
        human_portal_url="https://scout.dob.dc.gov/",
        human_portal_name="D.C. Department of Buildings SCOUT",
        fields=BBL_FIELDS,
        expected_min_rows=200_000,
        source_limitations=(
            "Premise business-license records, not evidence of ownership, "
            "tenant occupancy, or current legal compliance. A premise can "
            "serve multiple property accounts."
        ),
    ),
    ArcGisSource(
        source_id="dob_certificate_of_occupancy",
        family="occupancy_permit",
        publisher="D.C. Department of Buildings",
        dataset_name="Certificate of Occupancy",
        item_id="fbc9363a728d4c008eeb98f9ac62a35a",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Business_Licensing_and_Grants_WebMercator/FeatureServer/46"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "certificate-of-occupancy"
        ),
        human_portal_url="https://scout.dob.dc.gov/",
        human_portal_name="D.C. Department of Buildings SCOUT",
        fields=OCCUPANCY_FIELDS,
        expected_min_rows=70_000,
        source_limitations=(
            "Published certificates and occupancy permits. Absence is not "
            "proof that a use is unlawful or that no official document "
            "exists; some single-family uses can be exempt."
        ),
    ),
    ArcGisSource(
        source_id="cama_commercial_current",
        family="building_profile_commercial",
        publisher="D.C. Office of Tax and Revenue / DCGIS",
        dataset_name="Computer Assisted Mass Appraisal - Commercial",
        item_id="7d1f1b1b1e2d47c4a672cce5c918b9ff",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Property_and_Land_WebMercator/FeatureServer/23"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "computer-assisted-mass-appraisal-commercial"
        ),
        human_portal_url="https://propertyquest.dc.gov/",
        human_portal_name="DC PropertyQuest",
        fields=CAMA_COMMON_FIELDS
        + (
            "SECT_NUM",
            "STRUCT_CL",
            "STRUCT_CL_D",
            "GRADE",
            "GRADE_D",
            "EXTWALL",
            "EXTWALL_D",
            "WALL_HGT",
            "NUM_UNITS",
            "LIVING_GBA",
        ),
        expected_min_rows=15_000,
        source_limitations=(
            "Assessor mass-appraisal characteristics are reported attributes, "
            "not a survey, engineering report, appraisal, or verified rentable area."
        ),
    ),
    ArcGisSource(
        source_id="cama_condominium_current",
        family="building_profile_condominium",
        publisher="D.C. Office of Tax and Revenue / DCGIS",
        dataset_name="Computer Assisted Mass Appraisal - Condominium",
        item_id="7c675d683a3d4e6d90584af6e25c800d",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Property_and_Land_WebMercator/FeatureServer/24"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "computer-assisted-mass-appraisal-condominium"
        ),
        human_portal_url="https://propertyquest.dc.gov/",
        human_portal_name="DC PropertyQuest",
        fields=CAMA_COMMON_FIELDS
        + (
            "CMPLX_NUM",
            "ROOMS",
            "BEDRM",
            "BATHRM",
            "HF_BATHRM",
            "HEAT",
            "HEAT_D",
            "AC",
            "FIREPLACES",
            "LIVING_GBA",
        ),
        expected_min_rows=50_000,
        source_limitations=(
            "Assessor condominium characteristics are reported attributes, "
            "not a unit inspection, appraisal, or legal unit description."
        ),
    ),
    ArcGisSource(
        source_id="cama_residential_current",
        family="building_profile_residential",
        publisher="D.C. Office of Tax and Revenue / DCGIS",
        dataset_name="Computer Assisted Mass Appraisal - Residential",
        item_id="dbc439534a164a479a88140fbdd6bdc2",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Property_and_Land_WebMercator/FeatureServer/25"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "computer-assisted-mass-appraisal-residential"
        ),
        human_portal_url="https://propertyquest.dc.gov/",
        human_portal_name="DC PropertyQuest",
        fields=CAMA_COMMON_FIELDS
        + (
            "BATHRM",
            "HF_BATHRM",
            "HEAT",
            "HEAT_D",
            "AC",
            "NUM_UNITS",
            "ROOMS",
            "BEDRM",
            "STORIES",
            "GBA",
            "STYLE",
            "STYLE_D",
            "STRUCT",
            "STRUCT_D",
            "GRADE",
            "GRADE_D",
            "CNDTN",
            "CNDTN_D",
            "EXTWALL",
            "EXTWALL_D",
            "ROOF",
            "ROOF_D",
            "INTWALL",
            "INTWALL_D",
            "KITCHENS",
            "FIREPLACES",
        ),
        expected_min_rows=90_000,
        source_limitations=(
            "Assessor residential characteristics are reported attributes, "
            "not an inspection, appraisal, or verified building measurement."
        ),
    ),
    ArcGisSource(
        source_id="doee_energy_benchmarking",
        family="energy_benchmark",
        publisher="D.C. Department of Energy and Environment",
        dataset_name="Building Energy Benchmarking",
        item_id="961d83512e8b44c893d866081840b2bf",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Environment_Energy_WebMercator/FeatureServer/45"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "building-energy-benchmarking"
        ),
        human_portal_url="https://buildingperformancedc.org/",
        human_portal_name="Building Energy Performance DC",
        fields=ENERGY_FIELDS,
        expected_min_rows=20_000,
        source_limitations=(
            "Owner-reported benchmarking disclosures can be corrected after "
            "publication and can represent a building, campus, or parent "
            "property spanning multiple tax accounts."
        ),
    ),
    ArcGisSource(
        source_id="doee_beps_current",
        family="energy_beps",
        publisher="D.C. Department of Energy and Environment",
        dataset_name="Building Energy Performance",
        item_id="10f4f09fc5684d9988ae83ae4cca8b70",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Environment_Energy_WebMercator/FeatureServer/75"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "building-energy-performance"
        ),
        human_portal_url="https://buildingperformancedc.org/",
        human_portal_name="Building Energy Performance DC",
        fields=BEPS_FIELDS,
        expected_min_rows=1_000,
        source_limitations=(
            "Published BEPS disclosure and estimated performance requirement; "
            "not a lending conclusion or assurance of compliance."
        ),
    ),
    ArcGisSource(
        source_id="dob_vacant_blighted_addresses",
        family="vacant_blighted",
        publisher="D.C. Department of Buildings / DCGIS",
        dataset_name="Vacant and Blighted Building Addresses",
        item_id="da48e51ca21e450f9bcd1a39f098f2ca",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Property_and_Land_WebMercator/FeatureServer/82"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "vacant-and-blighted-building-addresses"
        ),
        human_portal_url="https://dob.dc.gov/vacantbuildings",
        human_portal_name="DOB Vacant and Blighted Buildings",
        fields=VACANT_FIELDS,
        expected_min_rows=1_000,
        source_limitations=(
            "Complaint- and inspection-driven address classifications. "
            "Absence does not establish that a property is occupied, and "
            "classifications can change after retrieval."
        ),
    ),
    ArcGisSource(
        source_id="ddot_tops_construction_permits",
        family="public_space_construction_permit",
        publisher="D.C. Department of Transportation",
        dataset_name="Construction Permits (via DDOT TOPS)",
        item_id="fc7da7bd29d4493481b17d032e117d09",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DDOT/TOPS/MapServer/0"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "construction-permits-via-ddot-tops"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=TOPS_CONSTRUCTION_FIELDS,
        expected_min_rows=400_000,
        source_limitations=(
            "Public-space construction permits, not DOB building permits. "
            "Address linkage is contextual and does not prove work occurred "
            "on or benefited a particular tax account."
        ),
    ),
    ArcGisSource(
        source_id="ddot_tops_occupancy_permits",
        family="public_space_occupancy_permit",
        publisher="D.C. Department of Transportation",
        dataset_name="Occupancy Permits (via DDOT TOPS)",
        item_id="80216437707b4135963eeb95047caeac",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DDOT/TOPS/MapServer/1"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "occupancy-permits-via-ddot-tops"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=TOPS_OCCUPANCY_FIELDS,
        expected_min_rows=800_000,
        source_limitations=(
            "Occupancy of public space such as curb lanes or sidewalks; "
            "not a DOB Certificate of Occupancy or evidence of lawful "
            "building use."
        ),
    ),
    ArcGisSource(
        source_id="ddot_tops_permit_inspections",
        family="public_space_permit_inspection",
        publisher="D.C. Department of Transportation",
        dataset_name="Permit Inspections",
        item_id="cb5a598122814116b56806a61bac3559",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/FEEDS/DDOT/FeatureServer/5"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "permit-inspections"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=TOPS_INSPECTION_FIELDS,
        expected_min_rows=500_000,
        source_limitations=(
            "DDOT public-space permit inspections, not DOB building-code "
            "inspections. Inspection status does not establish completion "
            "or overall regulatory compliance."
        ),
    ),
    ArcGisSource(
        source_id="ddot_tops_nonpermit_inspections",
        family="public_space_nonpermit_inspection",
        publisher="D.C. Department of Transportation",
        dataset_name="Non-Permit Inspections",
        item_id="e8991dbdc15b40a8b1218670c865567f",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/FEEDS/DDOT/FeatureServer/4"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "non-permit-inspections"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=TOPS_NONPERMIT_INSPECTION_FIELDS,
        expected_min_rows=25_000,
        source_limitations=(
            "DDOT public-space inspections of possible unpermitted work. "
            "They are not DOB code inspections or adjudicated violations."
        ),
    ),
    ArcGisSource(
        source_id="dob_home_occupancy_permits",
        family="home_occupancy_permit",
        publisher="D.C. Department of Buildings",
        dataset_name="Home Occupancy Permit",
        item_id="3a0425a60b7c4e28bd045900cec699b4",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Business_Licensing_and_Grants_WebMercator/FeatureServer/45"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "home-occupancy-permit"
        ),
        human_portal_url="https://scout.dob.dc.gov/",
        human_portal_name="D.C. Department of Buildings SCOUT",
        fields=HOME_OCCUPANCY_FIELDS,
        expected_min_rows=5_000,
        source_limitations=(
            "Home-occupation permit records. A permit is not a general "
            "business license, Certificate of Occupancy, or zoning opinion."
        ),
    ),
    ArcGisSource(
        source_id="ddot_special_tree_permits",
        family="special_tree_permit",
        publisher="D.C. Department of Transportation",
        dataset_name="Special Tree Permit",
        item_id="6a44f007e34e48408c354a6f30ed472e",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DDOT/TOPS/MapServer/4"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "special-tree-permit"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=TREE_PERMIT_FIELDS,
        expected_min_rows=15_000,
        source_limitations=(
            "Special and heritage tree permit records linked by exact "
            "location context, not tax-account ownership."
        ),
    ),
    ArcGisSource(
        source_id="ddot_annual_public_space_rental_permits",
        family="public_space_rental_permit",
        publisher="D.C. Department of Transportation",
        dataset_name="Annual Public Space Rental Permits",
        item_id="0a19cd4d215e405a94d95cf5088ab4eb",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DDOT/TOPS/MapServer/3"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "annual-public-space-rental-permits"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=ANNUAL_PUBLIC_SPACE_FIELDS,
        expected_min_rows=2_000,
        source_limitations=(
            "Annual rental of public space; not a building occupancy right "
            "or evidence of private parcel boundaries."
        ),
    ),
    ArcGisSource(
        source_id="ddot_emergency_work_requests",
        family="emergency_work_request",
        publisher="D.C. Department of Transportation",
        dataset_name="Emergency Work Requests (via DDOT TOPS)",
        item_id="d0c39bcc92cf4c128d373cde385ca812",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/FEEDS/DDOT/FeatureServer/2"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "emergency-work-requests-via-ddot-tops"
        ),
        human_portal_url=(
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        ),
        human_portal_name=(
            "DDOT Transportation Online Permitting System"
        ),
        fields=EMERGENCY_WORK_FIELDS,
        expected_min_rows=70_000,
        source_limitations=(
            "Emergency public-space work requests. A request or status is "
            "not proof of completed work or building-system condition."
        ),
    ),
    ArcGisSource(
        source_id="doee_well_permits",
        family="well_permit",
        publisher="D.C. Department of Energy and Environment",
        dataset_name="DC Well Permits",
        item_id="84fdf39aaa3a4e75ba9e7a167577daa8",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Environment_Water_WebMercator/MapServer/41"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::dc-well-permits"
        ),
        human_portal_url="https://doee.dc.gov/service/well-permitting",
        human_portal_name="DOEE Well Permitting",
        fields=WELL_PERMIT_FIELDS,
        expected_min_rows=4_000,
        source_limitations=(
            "Location-based well permit records. They do not establish "
            "current well condition, environmental clearance, or ownership."
        ),
    ),
    ArcGisSource(
        source_id="abca_alcohol_license_locations",
        family="alcohol_license",
        publisher=(
            "D.C. Alcoholic Beverage and Cannabis Administration"
        ),
        dataset_name="Alcohol License Business Locations",
        item_id="cabe9dcef0b344518c7fae1a3def7de1",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Business_Licensing_and_Grants_WebMercator/FeatureServer/5"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "alcohol-license-business-locations"
        ),
        human_portal_url="https://abca.dc.gov/node/612672",
        human_portal_name="ABCA Current License Holders",
        fields=ALCOHOL_LICENSE_FIELDS,
        expected_min_rows=1_500,
        source_limitations=(
            "Premise license-location data. A license does not establish "
            "tenant occupancy, ownership, or future renewal."
        ),
    ),
    ArcGisSource(
        source_id="abca_medical_cannabis_nonretailers",
        family="cannabis_license",
        publisher=(
            "D.C. Alcoholic Beverage and Cannabis Administration"
        ),
        dataset_name=(
            "Licensed Medical Cannabis Facilities Non-Retailer"
        ),
        item_id="10940055fe994d8baf860ba514ab5a20",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Health_WebMercator/MapServer/33"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "licensed-medical-cannabis-facilities-non-retailer"
        ),
        human_portal_url="https://abca.dc.gov/node/1657531",
        human_portal_name=(
            "ABCA Medical Cannabis Non-Retailer Licensees"
        ),
        fields=CANNABIS_NONRETAIL_FIELDS,
        expected_min_rows=10,
        source_limitations=(
            "Licensed facility locations; not evidence of property "
            "ownership, lawful building occupancy, or future renewal."
        ),
    ),
    ArcGisSource(
        source_id="abca_medical_cannabis_retailers",
        family="cannabis_license",
        publisher=(
            "D.C. Alcoholic Beverage and Cannabis Administration"
        ),
        dataset_name="Licensed Medical Cannabis Retailers",
        item_id="5ba8ab8a14d8481192df0edad0ca59a9",
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Health_WebMercator/MapServer/31"
        ),
        landing_url=(
            "https://opendata.dc.gov/datasets/DCGIS::"
            "licensed-medical-cannabis-retailers"
        ),
        human_portal_url="https://abca.dc.gov/node/1751426",
        human_portal_name="ABCA Medical Cannabis Retailer Licensees",
        fields=CANNABIS_RETAIL_FIELDS,
        expected_min_rows=40,
        source_limitations=(
            "Licensed retailer locations; not evidence of property "
            "ownership, lawful building occupancy, or future renewal."
        ),
    ),
)


PARCEL_SOURCES: tuple[ArcGisSource, ...] = (
    ArcGisSource(
        source_id="mar_address_current",
        family="mar_address",
        publisher="D.C. Office of the Chief Technology Officer / DC GIS",
        dataset_name="Master Address Repository - Address Table",
        item_id=None,
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Location_WebMercator/MapServer/6"
        ),
        landing_url="https://opendata.dc.gov/",
        human_portal_url="https://mar2.data.dc.gov/",
        human_portal_name="D.C. Master Address Repository (MAR 2)",
        fields=("OBJECTID", "MAR_ID", "ADDRESS", "STATUS", "SSL"),
        expected_min_rows=100_000,
        source_limitations=(
            "Official address identities. An address can relate to zero, one, "
            "or many SSLs; the base SSL on an address row is not the complete "
            "address-to-property relationship."
        ),
    ),
    ArcGisSource(
        source_id="mar_address_ssl_current",
        family="mar_address_ssl",
        publisher="D.C. Office of the Chief Technology Officer / DC GIS",
        dataset_name="Master Address Repository - Address SSL XREF",
        item_id=None,
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Location_WebMercator/MapServer/7"
        ),
        landing_url="https://opendata.dc.gov/",
        human_portal_url="https://mar2.data.dc.gov/",
        human_portal_name="D.C. Master Address Repository (MAR 2)",
        fields=(
            "OBJECTID", "MARID", "SSL", "SQUARE", "SUFFIX", "LOT",
            "COL", "PARCEL", "RESERVATION", "LOT_TYPE",
        ),
        expected_min_rows=200_000,
        source_limitations=(
            "Official many-to-many address-to-SSL cross-reference. It does "
            "not establish common ownership, one building, or one collateral asset."
        ),
    ),
    ArcGisSource(
        source_id="mar_residential_unit_current",
        family="mar_residential_unit",
        publisher="D.C. Office of the Chief Technology Officer / DC GIS",
        dataset_name="Master Address Repository - Residential Units",
        item_id=None,
        layer_url=(
            f"{DCGIS_FEATURE_SERVER}/DCGIS_DATA/"
            "Property_and_Land_WebMercator/MapServer/68"
        ),
        landing_url="https://opendata.dc.gov/",
        human_portal_url="https://mar2.data.dc.gov/",
        human_portal_name="D.C. Master Address Repository (MAR 2)",
        fields=(
            "OBJECTID", "UNIT_ID", "MAR_ID", "FULL_ADDRESS",
            "PRIMARY_ADDRESS", "UNIT_NUMBER", "UNIT_TYPE", "CONDO_SSL",
            "STATUS",
        ),
        expected_min_rows=150_000,
        source_limitations=(
            "Official residential-unit identities. Only a populated CONDO_SSL "
            "is used to narrow a unit to a condominium property identifier."
        ),
    ),
)


SOURCE_BY_ID = {
    source.source_id: source for source in (*SOURCES, *PARCEL_SOURCES)
}


def sources_for_family(family: str | None) -> tuple[ArcGisSource, ...]:
    if family is None:
        return SOURCES
    return tuple(
        source
        for source in (*SOURCES, *PARCEL_SOURCES)
        if source.family == family
    )
