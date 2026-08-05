const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_IDS = new Set([
  "mar_address_current",
  "mar_address_ssl_current",
  "mar_residential_unit_current",
]);
export const MAR_ARTIFACTS = Object.freeze([
  "mar_addresses.csv.gz",
  "mar_address_ssls.csv.gz",
  "mar_residential_units.csv.gz",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} has an invalid SHA-256.`);
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
}

export function validateMarManifest(manifest) {
  object(manifest, "MAR manifest");
  if (
    manifest.manifest_kind !== "dc-property-mar-normalized" ||
    manifest.manifest_version !== 1 ||
    manifest.source_count !== 3 ||
    !Array.isArray(manifest.sources)
  ) {
    throw new Error("Unsupported MAR manifest or source set.");
  }
  const observed = new Set();
  for (const source of manifest.sources) {
    object(source, "MAR source");
    if (!SOURCE_IDS.has(source.source_id) || observed.has(source.source_id)) {
      throw new Error("MAR manifest source set is not exact.");
    }
    observed.add(source.source_id);
    if (source.release_key !== `arcgis-${source.gzip_sha256}`) {
      throw new Error(`${source.source_id} release key is not content-bound.`);
    }
    hash(source.gzip_sha256, `${source.source_id}.gzip_sha256`);
    hash(source.canonical_rows_sha256, `${source.source_id}.canonical_rows_sha256`);
    hash(source.schema_sha256, `${source.source_id}.schema_sha256`);
    nonNegativeInteger(source.rows, `${source.source_id}.rows`);
    nonNegativeInteger(source.bytes, `${source.source_id}.bytes`);
    object(source.source, `${source.source_id}.source`);
  }
  if (observed.size !== SOURCE_IDS.size) {
    throw new Error("MAR manifest source set is not exact.");
  }
  object(manifest.artifacts, "MAR artifacts");
  for (const name of MAR_ARTIFACTS) {
    const artifact = object(manifest.artifacts[name], name);
    nonNegativeInteger(artifact.rows, `${name}.rows`);
    nonNegativeInteger(artifact.bytes, `${name}.bytes`);
    hash(artifact.sha256, `${name}.sha256`);
    hash(artifact.canonical_rows_sha256, `${name}.canonical_rows_sha256`);
  }
  if (Object.keys(manifest.artifacts).length !== MAR_ARTIFACTS.length) {
    throw new Error("MAR artifact set is not exact.");
  }
  return manifest;
}

export function buildMarReleaseRows(manifest, receipt) {
  validateMarManifest(manifest);
  object(receipt, "archive receipt");
  if (
    receipt.status !== "verified" ||
    typeof receipt.receipt_object_key !== "string" ||
    !receipt.receipt_object_key.trim() ||
    !SHA256.test(receipt.receipt_sha256)
  ) {
    throw new Error("A verified archive receipt is required for MAR publication.");
  }
  return manifest.sources.map((source) => ({
    source_id: source.source_id,
    release_key: source.release_key,
    release_status: "published",
    quality_status: "passed",
    snapshot_retrieved_at: source.retrieved_at,
    archive_object_key: receipt.receipt_object_key,
    content_type: "application/gzip",
    bytes: source.bytes,
    row_count: source.rows,
    sha256: source.gzip_sha256,
    schema_sha256: source.schema_sha256,
    release_metadata: {
      canonical_rows_sha256: source.canonical_rows_sha256,
      archive_receipt_sha256: receipt.receipt_sha256,
    },
  }));
}
