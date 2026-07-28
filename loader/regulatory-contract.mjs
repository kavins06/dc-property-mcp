const SHA256 = /^[0-9a-f]{64}$/;

const permitYears = Array.from(
  { length: 2026 - 2009 + 1 },
  (_, index) => `dob_building_permits_${2009 + index}`,
);

export const REQUIRED_REGULATORY_SOURCE_FAMILIES = Object.freeze({
  ...Object.fromEntries(permitYears.map((sourceId) => [
    sourceId,
    "building_permit",
  ])),
  dlcp_basic_business_licenses: "business_license",
  dob_certificate_of_occupancy: "occupancy_permit",
  cama_commercial_current: "building_profile_commercial",
  cama_condominium_current: "building_profile_condominium",
  cama_residential_current: "building_profile_residential",
  doee_energy_benchmarking: "energy_benchmark",
  doee_beps_current: "energy_beps",
  dob_vacant_blighted_addresses: "vacant_blighted",
  ddot_tops_construction_permits:
    "public_space_construction_permit",
  ddot_tops_occupancy_permits: "public_space_occupancy_permit",
  ddot_tops_permit_inspections: "public_space_permit_inspection",
  ddot_tops_nonpermit_inspections:
    "public_space_nonpermit_inspection",
  dob_home_occupancy_permits: "home_occupancy_permit",
  ddot_special_tree_permits: "special_tree_permit",
  ddot_annual_public_space_rental_permits:
    "public_space_rental_permit",
  ddot_emergency_work_requests: "emergency_work_request",
  doee_well_permits: "well_permit",
  abca_alcohol_license_locations: "alcohol_license",
  abca_medical_cannabis_nonretailers: "cannabis_license",
  abca_medical_cannabis_retailers: "cannabis_license",
});

export const REQUIRED_REGULATORY_SOURCE_IDS = new Set(
  Object.keys(REQUIRED_REGULATORY_SOURCE_FAMILIES),
);

export const REGULATORY_ARTIFACTS = Object.freeze([
  Object.freeze({
    fileName: "source_assets.csv.gz",
    stagingTable: "stage_regulatory.source_asset",
  }),
  Object.freeze({
    fileName: "source_releases.csv.gz",
    stagingTable: "stage_regulatory.source_release",
  }),
  Object.freeze({
    fileName: "regulatory_records.csv.gz",
    stagingTable: "stage_regulatory.regulatory_record",
  }),
  Object.freeze({
    fileName: "property_context_records.csv.gz",
    stagingTable: "stage_regulatory.property_context_record",
  }),
  Object.freeze({
    fileName: "source_record_links.csv.gz",
    stagingTable: "stage_regulatory.source_record_link",
  }),
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} has an invalid sha256.`);
  }
}

const countKeys = Object.freeze([
  "input_rows",
  "served_records",
  "exact_records",
  "contextual_records",
  "ambiguous_records",
  "unlinked_records",
  "account_links",
]);

export function validateRegulatoryManifest(manifest) {
  requireObject(manifest, "manifest");
  if (
    manifest.manifest_kind !== "dc-property-regulatory-normalized" ||
    manifest.manifest_version !== 1
  ) {
    throw new Error("Unsupported regulatory manifest kind or version.");
  }
  if (
    typeof manifest.run_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(manifest.run_id)
  ) {
    throw new Error("Regulatory manifest has an invalid run_id.");
  }
  requireObject(manifest.account_input, "account_input");
  if (manifest.account_input.rows !== 221_263) {
    throw new Error("Regulatory manifest was not linked to all current accounts.");
  }
  requireSha256(manifest.account_input.sha256, "account_input");
  requireObject(manifest.archive_policy, "archive_policy");
  if (
    manifest.archive_policy.status !== "verified" ||
    manifest.archive_policy.scheme !== "s3_content_addressed_sha256"
  ) {
    throw new Error(
      "Regulatory manifest is not bound to a verified content-addressed S3 archive.",
    );
  }
  for (const key of ["archive_id", "receipt_sha256"]) {
    requireSha256(manifest.archive_policy[key], `archive_policy.${key}`);
  }
  if (
    typeof manifest.archive_policy.provider !== "string" ||
    !manifest.archive_policy.provider ||
    typeof manifest.archive_policy.endpoint !== "string" ||
    !manifest.archive_policy.endpoint.startsWith("https://") ||
    typeof manifest.archive_policy.region !== "string" ||
    !manifest.archive_policy.region ||
    typeof manifest.archive_policy.bucket !== "string" ||
    !manifest.archive_policy.bucket ||
    typeof manifest.archive_policy.receipt_object_key !== "string" ||
    !manifest.archive_policy.receipt_object_key
  ) {
    throw new Error("Regulatory S3 archive metadata is incomplete.");
  }

  if (
    !Number.isSafeInteger(manifest.safe_max_accounts_per_address) ||
    manifest.safe_max_accounts_per_address < 1 ||
    manifest.safe_max_accounts_per_address > 64
  ) {
    throw new Error("Address-link safety cap must be between 1 and 64 accounts.");
  }
  requireObject(manifest.linking_policy, "linking_policy");
  if (manifest.linking_policy.fuzzy_matching !== false) {
    throw new Error("Regulatory fuzzy matching must be disabled.");
  }

  if (!Array.isArray(manifest.sources)) {
    throw new TypeError("Regulatory manifest sources must be an array.");
  }
  if (manifest.source_count !== manifest.sources.length) {
    throw new Error("Regulatory source_count does not match sources.");
  }
  const sourceIds = new Set();
  const calculatedTotals = Object.fromEntries(
    countKeys.map((key) => [key, 0]),
  );
  for (const source of manifest.sources) {
    requireObject(source, "source");
    if (
      typeof source.source_id !== "string" ||
      !/^[a-z0-9_]+$/.test(source.source_id)
    ) {
      throw new Error("Regulatory source has an invalid source_id.");
    }
    if (sourceIds.has(source.source_id)) {
      throw new Error(`Duplicate regulatory source ${source.source_id}.`);
    }
    sourceIds.add(source.source_id);
    const expectedFamily =
      REQUIRED_REGULATORY_SOURCE_FAMILIES[source.source_id];
    if (expectedFamily === undefined) {
      throw new Error(
        `Regulatory manifest contains unexpected source ` +
          `${source.source_id}.`,
      );
    }
    if (source.family !== expectedFamily) {
      throw new Error(
        `Regulatory source ${source.source_id} has family ` +
          `${source.family}; expected ${expectedFamily}.`,
      );
    }
    if (
      typeof source.release_key !== "string" ||
      !/^arcgis-[0-9a-f]{64}$/.test(source.release_key)
    ) {
      throw new Error(
        `Regulatory source ${source.source_id} has an invalid release_key.`,
      );
    }
    for (const key of countKeys) {
      requireNonNegativeInteger(
        source[key],
        `${source.source_id}.${key}`,
      );
      calculatedTotals[key] += source[key];
    }
    if (
      source.exact_records + source.contextual_records !==
      source.served_records
    ) {
      throw new Error(
        `${source.source_id} served-record attribution counts drifted.`,
      );
    }
    if (
      source.served_records +
        source.ambiguous_records +
        source.unlinked_records !==
      source.input_rows
    ) {
      throw new Error(
        `${source.source_id} input disposition counts drifted.`,
      );
    }
    if (source.account_links < source.served_records) {
      throw new Error(
        `${source.source_id} has fewer links than served records.`,
      );
    }
  }
  for (const required of REQUIRED_REGULATORY_SOURCE_IDS) {
    if (!sourceIds.has(required)) {
      throw new Error(`Regulatory manifest is missing required source ${required}.`);
    }
  }
  if (sourceIds.size !== REQUIRED_REGULATORY_SOURCE_IDS.size) {
    throw new Error("Regulatory manifest source set is not exact.");
  }

  requireObject(manifest.totals, "totals");
  for (const key of countKeys) {
    requireNonNegativeInteger(manifest.totals[key], `totals.${key}`);
    if (manifest.totals[key] !== calculatedTotals[key]) {
      throw new Error(`Regulatory manifest total ${key} drifted.`);
    }
  }

  requireObject(manifest.artifacts, "artifacts");
  for (const { fileName } of REGULATORY_ARTIFACTS) {
    const artifact = manifest.artifacts[fileName];
    requireObject(artifact, `artifact ${fileName}`);
    requireNonNegativeInteger(artifact.rows, `${fileName}.rows`);
    requireNonNegativeInteger(artifact.bytes, `${fileName}.bytes`);
    if (artifact.rows > 0 && artifact.bytes === 0) {
      throw new Error(`${fileName} is empty despite reporting rows.`);
    }
    requireSha256(artifact.sha256, fileName);
    requireSha256(artifact.canonical_rows_sha256, `${fileName} canonical rows`);
  }

  if (
    manifest.artifacts["source_assets.csv.gz"].rows !==
      manifest.source_count ||
    manifest.artifacts["source_releases.csv.gz"].rows !==
      manifest.source_count
  ) {
    throw new Error("Source asset/release artifact counts do not match sources.");
  }
  if (
    manifest.artifacts["regulatory_records.csv.gz"].rows +
      manifest.artifacts["property_context_records.csv.gz"].rows !==
    manifest.totals.served_records
  ) {
    throw new Error("Serving-record artifact counts do not match the manifest.");
  }
  if (
    manifest.artifacts["source_record_links.csv.gz"].rows !==
    manifest.totals.account_links
  ) {
    throw new Error("The source-record link row count does not match the manifest.");
  }
  return manifest;
}
