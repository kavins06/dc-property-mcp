from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import shutil
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from .source_registry import ArcGisSource, SOURCE_BY_ID


PROJECT = Path(__file__).resolve().parents[3]
DEFAULT_SAFE_MAX_ACCOUNTS_PER_ADDRESS = 64

SOURCE_ID_ALIASES = {
    "dob_certificates_of_occupancy": "dob_certificate_of_occupancy",
}

SOURCE_ASSET_HEADER = (
    "source_id",
    "family",
    "publisher",
    "dataset_name",
    "item_id",
    "source_system",
    "source_dataset_identifier",
    "source_layer_identifier",
    "source_record_id_field",
    "landing_url",
    "human_portal_url",
    "human_portal_name",
    "machine_layer_url",
    "snapshot_policy",
    "source_limitations",
    "source_metadata_json",
)

SOURCE_RELEASE_HEADER = (
    "source_id",
    "release_key",
    "snapshot_retrieved_at",
    "source_updated_at",
    "archive_object_key",
    "content_type",
    "bytes",
    "row_count",
    "sha256",
    "schema_sha256",
    "canonical_rows_sha256",
    "release_metadata_json",
)

RECORD_HEADER = (
    "source_id",
    "release_key",
    "source_record_id",
    "source_row_number",
    "source_row_sha256",
    "record_type",
    "record_number",
    "record_status",
    "record_status_date",
    "premise_address",
    "address_normalized",
    "ssl_raw",
    "ssl_normalized",
    "mar_id",
    "ubid",
    "event_date",
    "expiration_date",
    "latitude",
    "longitude",
    "facts_json",
)

SOURCE_RECORD_LINK_HEADER = (
    "source_id",
    "release_key",
    "source_record_id",
    "account_id",
    "link_status",
    "link_scope",
    "link_method",
    "match_quality",
    "link_confidence",
    "match_basis_json",
)

ARTIFACT_HEADERS: dict[str, tuple[str, ...]] = {
    "source_assets.csv.gz": SOURCE_ASSET_HEADER,
    "source_releases.csv.gz": SOURCE_RELEASE_HEADER,
    "regulatory_records.csv.gz": RECORD_HEADER,
    "property_context_records.csv.gz": RECORD_HEADER,
    "source_record_links.csv.gz": SOURCE_RECORD_LINK_HEADER,
}

CONTEXT_RECORD_TYPES = {
    "building_profile_commercial": "cama_building_profile",
    "building_profile_condominium": "cama_building_profile",
    "building_profile_residential": "cama_building_profile",
    "energy_benchmark": "energy_benchmark",
    "energy_beps": "beps",
    "vacant_blighted": "vacant_blighted",
}

REGULATORY_RECORD_TYPES = {
    "building_permit": "building_permit",
    "business_license": "business_license",
    "occupancy_permit": "certificate_of_occupancy",
    "public_space_construction_permit": (
        "public_space_construction_permit"
    ),
    "public_space_occupancy_permit": "public_space_occupancy_permit",
    "public_space_permit_inspection": "inspection",
    "public_space_nonpermit_inspection": "inspection",
    "home_occupancy_permit": "home_occupancy_permit",
    "special_tree_permit": "special_tree_permit",
    "public_space_rental_permit": "public_space_rental_permit",
    "emergency_work_request": "emergency_work_request",
    "well_permit": "well_permit",
    "alcohol_license": "alcohol_license",
    "cannabis_license": "cannabis_license",
}

EXACT_SSL_ONLY_FAMILIES = {
    "building_profile_commercial",
    "building_profile_condominium",
    "building_profile_residential",
}

PARCEL_FAMILIES = {
    "building_permit",
    "occupancy_permit",
    "vacant_blighted",
}

SHARED_BUILDING_FAMILIES = {
    "business_license",
    "home_occupancy_permit",
    "alcohol_license",
    "cannabis_license",
    "energy_benchmark",
    "energy_beps",
}

PROXIMITY_FAMILIES = {
    "public_space_construction_permit",
    "public_space_occupancy_permit",
    "public_space_permit_inspection",
    "public_space_nonpermit_inspection",
    "special_tree_permit",
    "public_space_rental_permit",
    "emergency_work_request",
    "well_permit",
}

NUMBER_FIELDS = (
    "PERMIT_ID",
    "PERMIT_NUMBER",
    "PermitNumber",
    "CUSTOMERNUMBER",
    "INSPECTIONID",
    "INCIDENTCASENUMBER",
    "HOP_PERMIT_NUMBER",
    "CONSTRUCTIONTRACKINGNUMBER",
    "OCCUPANCYTRACKINGNUMBER",
    "TrackingNumber",
    "DCRAPERMITNUMBER",
    "LICENSE",
    "ABCA_NUMBER",
    "PID",
)

STATUS_FIELDS = (
    "APPLICATION_STATUS_NAME",
    "LICENSESTATUS",
    "STATUS",
    "Status",
    "INSPECTIONSTATUSDESC",
    "INCIDENTSTATUSDESC",
    "REPORTSTATUS",
    "MEETS_BEPS",
)

STATUS_DATE_FIELDS = (
    "LICENSESTATUSDATE",
    "LASTMODIFIEDDATE",
    "LastUpdateDate",
    "LASTUPDATEDATE",
    "LAST_EDITED_DATE",
    "EDITED",
    "GIS_LAST_MOD_DTTM",
    "DCS_LAST_MOD_DTTM",
    "LASTUPDATE",
)

ADDRESS_FIELDS = (
    "FULL_ADDRESS",
    "PREMISEADDRESS",
    "ADDRESS",
    "INSPECTIONLOCATION",
    "WorkLocationFullAddress",
    "TreeLocation",
    "LOCATIONDESCRIPTION",
    "ADDRESSOFRECORD",
    "REPORTEDADDRESS",
)

SSL_FIELDS = ("SSL", "MULTIPLE_LAND_SSL")
MAR_FIELDS = ("MAR_ID", "MARADDRESSREPOSITORYID")
UBID_FIELDS = ("UBID",)

EVENT_DATE_FIELDS = (
    "ISSUE_DATE",
    "IssueDate",
    "ISSUEDDATE",
    "INSPECTIONDATE",
    "APPLICATIONDATE",
    "ApplicationDate",
    "CREATIONDATE",
    "BEGIN_DATE",
    "REPORTINGYEAR",
    "PROPERTY_BEPS_METRIC_YEAR",
    "SALEDATE",
)

EXPIRATION_DATE_FIELDS = (
    "EXPIRATION_DATE",
    "ExpirationDate",
    "LICENSEENDDATE",
)

LATITUDE_FIELDS = ("LATITUDE", "Latitude")
LONGITUDE_FIELDS = ("LONGITUDE", "Longitude", "LONGITDUE")

_SSL_PATTERN = re.compile(
    r"(?<![A-Z0-9])(?:PI\s*)?\d{4}[A-Z]?\s*-?\s*\d{4,8}"
    r"(?![A-Z0-9])",
    re.IGNORECASE,
)
_COMPACT_SSL_PATTERN = re.compile(
    r"(?:\d{4}[A-Z]?\d{4}|PI\d{8,12})"
)
_NON_ALPHANUMERIC = re.compile(r"[^A-Z0-9]+")
_WHITESPACE = re.compile(r"\s+")
_UNIT_SUFFIX = re.compile(
    r"(?:\s|,)(?:#\s*[A-Z0-9-]+|"
    r"(?:APT|APARTMENT|UNIT|STE|SUITE|ROOM|RM|FLOOR|FL)"
    r"\s*[A-Z0-9-]+)(?:\s|,|$).*$",
    re.IGNORECASE,
)
_DC_TAIL = re.compile(
    r"\s+(?:(?:WASHINGTON\s+)?DC|"
    r"WASHINGTON\s+DISTRICT\s+OF\s+COLUMBIA|"
    r"DISTRICT\s+OF\s+COLUMBIA)"
    r"(?:\s+\d{5}(?:\s+\d{4})?)?\s*$"
)
_STREET_SUFFIXES = {
    "ALY",
    "AVE",
    "BLVD",
    "CIR",
    "CT",
    "DR",
    "HWY",
    "LN",
    "MEWS",
    "PL",
    "PKWY",
    "RD",
    "SQ",
    "ST",
    "TER",
    "TRL",
    "WAY",
}
_TOKEN_REPLACEMENTS = {
    "ALLEY": "ALY",
    "AVENUE": "AVE",
    "BOULEVARD": "BLVD",
    "CIRCLE": "CIR",
    "COURT": "CT",
    "DRIVE": "DR",
    "HIGHWAY": "HWY",
    "LANE": "LN",
    "PLACE": "PL",
    "PARKWAY": "PKWY",
    "ROAD": "RD",
    "SQUARE": "SQ",
    "STREET": "ST",
    "TERRACE": "TER",
    "TRAIL": "TRL",
    "NORTHWEST": "NW",
    "NORTHEAST": "NE",
    "SOUTHWEST": "SW",
    "SOUTHEAST": "SE",
}


class RegulatoryNormalizationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class AccountIndex:
    ssl_accounts: Mapping[str, tuple[int, ...]]
    address_accounts: Mapping[str, tuple[int, ...]]
    row_count: int
    sha256: str


@dataclass(frozen=True, slots=True)
class SourceInput:
    source_id: str
    source: ArcGisSource
    run_id: str
    run_status: str
    manifest_path: Path
    data_path: Path
    manifest: Mapping[str, Any]
    release_key: str


@dataclass(frozen=True, slots=True)
class Link:
    account_id: int
    scope: str
    method: str
    quality: str
    confidence: str
    basis: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class LinkDecision:
    links: tuple[Link, ...]
    outcome: str


class DeterministicCsvGzipWriter:
    def __init__(self, path: Path, header: Sequence[str]) -> None:
        self.path = path
        self.header = tuple(header)
        self.rows = 0
        self._row_digest = hashlib.sha256()
        self._raw = path.open("xb")
        self._gzip = gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=self._raw,
            compresslevel=6,
            mtime=0,
        )
        self._gzip.write(_csv_line(self.header))

    def write(self, row: Mapping[str, Any]) -> None:
        unknown = set(row).difference(self.header)
        if unknown:
            raise RegulatoryNormalizationError(
                f"{self.path.name} row has unknown columns: "
                f"{sorted(unknown)}"
            )
        payload = _csv_line(
            tuple(_csv_value(row.get(column)) for column in self.header)
        )
        self._row_digest.update(payload)
        self._gzip.write(payload)
        self.rows += 1

    def close(self) -> dict[str, Any]:
        self._gzip.close()
        self._raw.close()
        return {
            "rows": self.rows,
            "bytes": self.path.stat().st_size,
            "sha256": _sha256(self.path),
            "canonical_rows_sha256": self._row_digest.hexdigest(),
        }


def _csv_line(values: Sequence[Any]) -> bytes:
    output = io.StringIO(newline="")
    csv.writer(output, lineterminator="\n").writerow(values)
    return output.getvalue().encode("utf-8")


def _csv_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_single_ssl(value: str | None) -> str | None:
    compact = re.sub(r"[\s-]+", "", (value or "").strip().upper())
    return compact if _COMPACT_SSL_PATTERN.fullmatch(compact) else None


def normalize_ssl_values(value: Any) -> tuple[str, ...]:
    """Extract conservative, canonical D.C. square-and-lot identifiers."""
    if value is None:
        return ()
    raw = str(value).strip().upper()
    if not raw:
        return ()
    matches = _SSL_PATTERN.findall(raw)
    if not matches:
        compact = _normalize_single_ssl(raw)
        return (compact,) if compact else ()
    normalized = {
        compact
        for match in matches
        if (compact := _normalize_single_ssl(match)) is not None
    }
    return tuple(sorted(normalized))


def normalize_street_key(value: Any) -> str | None:
    """Return a conservative building-premise key, never a fuzzy match key."""
    if value is None:
        return None
    raw = str(value).strip().upper()
    if not raw:
        return None
    raw = _UNIT_SUFFIX.sub("", raw)
    normalized = _NON_ALPHANUMERIC.sub(" ", raw)
    normalized = _WHITESPACE.sub(" ", normalized).strip()
    normalized = _DC_TAIL.sub("", normalized).strip()
    tokens = [
        _TOKEN_REPLACEMENTS.get(token, token)
        for token in normalized.split()
    ]
    if not tokens or not tokens[0].isdigit():
        return None
    house_number = int(tokens[0])
    if house_number <= 0:
        return None
    tokens[0] = str(house_number)
    if len(tokens) < 3 or not any(
        token in _STREET_SUFFIXES for token in tokens[1:]
    ):
        return None
    return " ".join(tokens)


def _positive_integer(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not numeric.is_integer() or numeric <= 0:
        return None
    return int(numeric)


def _decimal_text(value: Any, minimum: float, maximum: float) -> str:
    if value is None or value == "":
        return ""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return ""
    if not minimum <= numeric <= maximum:
        return ""
    return format(numeric, ".8f").rstrip("0").rstrip(".")


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _first_value(
    row: Mapping[str, Any],
    field_names: Iterable[str],
) -> Any:
    for field_name in field_names:
        value = row.get(field_name)
        if value is not None and _text(value):
            return value
    return None


def _iso_date(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric.is_integer() and 1800 <= numeric <= 2200:
            return f"{int(numeric):04d}-01-01"
        try:
            timestamp = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(
                milliseconds=numeric
            )
        except (OverflowError, ValueError):
            return ""
        return timestamp.date().isoformat()
    raw = str(value).strip()
    if re.fullmatch(r"\d{4}", raw):
        return f"{raw}-01-01"
    match = re.match(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", raw)
    if not match:
        return ""
    try:
        return datetime(
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
            tzinfo=timezone.utc,
        ).date().isoformat()
    except ValueError:
        return ""


def _iso_datetime_from_millis(value: Any) -> str:
    if value is None or value == "":
        return ""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return ""
    try:
        timestamp = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(
            milliseconds=numeric
        )
    except (OverflowError, ValueError):
        return ""
    return timestamp.isoformat().replace("+00:00", "Z")


def _strip_nulls(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_nulls(child)
            for key, child in sorted(value.items())
            if child is not None
        }
    if isinstance(value, list):
        return [_strip_nulls(child) for child in value if child is not None]
    return value


def _record_type(family: str) -> tuple[str, str]:
    if family in CONTEXT_RECORD_TYPES:
        return "property_context_records.csv.gz", CONTEXT_RECORD_TYPES[family]
    if family in REGULATORY_RECORD_TYPES:
        return "regulatory_records.csv.gz", REGULATORY_RECORD_TYPES[family]
    raise RegulatoryNormalizationError(
        f"No record mapping is registered for family {family!r}."
    )


def _source_family_mode(family: str) -> str:
    if family in EXACT_SSL_ONLY_FAMILIES:
        return "exact_ssl_only"
    if family in PARCEL_FAMILIES:
        return "parcel"
    if family in SHARED_BUILDING_FAMILIES:
        return "shared_building"
    if family in PROXIMITY_FAMILIES:
        return "proximity"
    raise RegulatoryNormalizationError(
        f"No link policy is registered for family {family!r}."
    )


def _load_account_index(
    account_path: Path,
) -> AccountIndex:
    if not account_path.is_file():
        raise RegulatoryNormalizationError(
            f"Account input does not exist: {account_path}"
        )
    ssl_accounts: dict[str, set[int]] = defaultdict(set)
    address_accounts: dict[str, set[int]] = defaultdict(set)
    account_ids: set[int] = set()
    row_count = 0
    with gzip.open(
        account_path,
        "rt",
        encoding="utf-8-sig",
        newline="",
    ) as handle:
        reader = csv.DictReader(handle)
        required = {"account_id", "ssl_normalized", "premise_address"}
        missing = required.difference(reader.fieldnames or ())
        if missing:
            raise RegulatoryNormalizationError(
                f"Account input is missing columns: {sorted(missing)}"
            )
        for row in reader:
            row_count += 1
            account_id = _positive_integer(row.get("account_id"))
            if account_id is None:
                raise RegulatoryNormalizationError(
                    f"Account row {row_count} has an invalid account_id."
                )
            if account_id in account_ids:
                raise RegulatoryNormalizationError(
                    f"Duplicate account_id {account_id}."
                )
            account_ids.add(account_id)
            ssl = _normalize_single_ssl(row.get("ssl_normalized"))
            if ssl:
                ssl_accounts[ssl].add(account_id)
            address = normalize_street_key(row.get("premise_address"))
            if address:
                address_accounts[address].add(account_id)
    return AccountIndex(
        ssl_accounts={
            key: tuple(sorted(values))
            for key, values in sorted(ssl_accounts.items())
        },
        address_accounts={
            key: tuple(sorted(values))
            for key, values in sorted(address_accounts.items())
        },
        row_count=row_count,
        sha256=_sha256(account_path),
    )


def _load_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RegulatoryNormalizationError(
            f"Could not read valid JSON object from {path}."
        ) from error
    if not isinstance(value, dict):
        raise RegulatoryNormalizationError(
            f"Expected a JSON object in {path}."
        )
    return value


def _canonical_source_id(source_id: str) -> str:
    return SOURCE_ID_ALIASES.get(source_id, source_id)


def _validate_source_manifest(
    manifest_path: Path,
    run_id: str,
    run_status: str,
) -> SourceInput:
    manifest = _load_json_object(manifest_path)
    if (
        manifest.get("manifest_kind") != "dc-property-arcgis-source"
        or manifest.get("manifest_version") != 1
        or manifest.get("status") != "complete"
    ):
        raise RegulatoryNormalizationError(
            f"Invalid or incomplete source manifest: {manifest_path}"
        )
    source_metadata = manifest.get("source")
    artifact = manifest.get("artifact")
    arcgis = manifest.get("arcgis")
    if not all(
        isinstance(value, dict)
        for value in (source_metadata, artifact, arcgis)
    ):
        raise RegulatoryNormalizationError(
            f"Source manifest is missing object sections: {manifest_path}"
        )
    raw_source_id = source_metadata.get("source_id")
    if not isinstance(raw_source_id, str):
        raise RegulatoryNormalizationError(
            f"Source manifest has no source ID: {manifest_path}"
        )
    source_id = _canonical_source_id(raw_source_id)
    source = SOURCE_BY_ID.get(source_id)
    if source is None:
        raise RegulatoryNormalizationError(
            f"Source {raw_source_id!r} is not in the registry."
        )
    if source_metadata.get("family") != source.family:
        raise RegulatoryNormalizationError(
            f"Source family mismatch for {source_id}."
        )
    artifact_file = artifact.get("file")
    if not isinstance(artifact_file, str) or Path(artifact_file).name != artifact_file:
        raise RegulatoryNormalizationError(
            f"Unsafe artifact filename for {source_id}."
        )
    data_path = manifest_path.parent / artifact_file
    if not data_path.is_file():
        raise RegulatoryNormalizationError(
            f"Source artifact is missing for {source_id}: {data_path}"
        )
    gzip_sha = artifact.get("gzip_sha256")
    if (
        not isinstance(gzip_sha, str)
        or not re.fullmatch(r"[0-9a-f]{64}", gzip_sha)
        or _sha256(data_path) != gzip_sha
    ):
        raise RegulatoryNormalizationError(
            f"Source artifact hash mismatch for {source_id}."
        )
    return SourceInput(
        source_id=source_id,
        source=source,
        run_id=run_id,
        run_status=run_status,
        manifest_path=manifest_path,
        data_path=data_path,
        manifest=manifest,
        release_key=f"arcgis-{gzip_sha}",
    )


def _discover_sources(
    acquisition_run_directories: Sequence[Path],
) -> tuple[list[SourceInput], list[dict[str, Any]]]:
    if not acquisition_run_directories:
        raise RegulatoryNormalizationError(
            "At least one acquisition run directory is required."
        )
    candidates: dict[str, list[SourceInput]] = defaultdict(list)
    run_rows: list[dict[str, Any]] = []
    seen_run_ids: set[str] = set()
    for directory in acquisition_run_directories:
        resolved = directory.resolve()
        run_manifest_path = resolved / "run.manifest.json"
        run_manifest = _load_json_object(run_manifest_path)
        if (
            run_manifest.get("manifest_kind") != "dc-property-arcgis-run"
            or run_manifest.get("manifest_version") != 1
        ):
            raise RegulatoryNormalizationError(
                f"Invalid acquisition run manifest: {run_manifest_path}"
            )
        run_id = run_manifest.get("run_id")
        run_status = run_manifest.get("status")
        if (
            not isinstance(run_id, str)
            or not run_id
            or run_id in seen_run_ids
            or run_status not in {"complete", "failed"}
        ):
            raise RegulatoryNormalizationError(
                f"Invalid or duplicate acquisition run ID in "
                f"{run_manifest_path}."
            )
        seen_run_ids.add(run_id)
        declared_sources_raw = run_manifest.get("sources")
        if not isinstance(declared_sources_raw, list):
            raise RegulatoryNormalizationError(
                f"Acquisition run has no source inventory: "
                f"{run_manifest_path}"
            )
        declared_sources: dict[str, Mapping[str, Any]] = {}
        for declared in declared_sources_raw:
            if not isinstance(declared, dict):
                raise RegulatoryNormalizationError(
                    f"Acquisition source inventory is invalid: "
                    f"{run_manifest_path}"
                )
            declared_source_id = declared.get("source_id")
            if not isinstance(declared_source_id, str):
                raise RegulatoryNormalizationError(
                    f"Acquisition source inventory has no source ID: "
                    f"{run_manifest_path}"
                )
            canonical_declared_id = _canonical_source_id(
                declared_source_id
            )
            if canonical_declared_id in declared_sources:
                raise RegulatoryNormalizationError(
                    f"Duplicate source {canonical_declared_id} in "
                    f"{run_manifest_path}."
                )
            declared_sources[canonical_declared_id] = declared
        if run_manifest.get("completed_source_count") != len(
            declared_sources
        ):
            raise RegulatoryNormalizationError(
                f"Acquisition completed-source count does not match its "
                f"inventory: {run_manifest_path}"
            )
        declared_source_count = run_manifest.get("source_count")
        failed_source_count = run_manifest.get("failed_source_count")
        if (
            not isinstance(declared_source_count, int)
            or not isinstance(failed_source_count, int)
            or failed_source_count < 0
            or declared_source_count
            != len(declared_sources) + failed_source_count
        ):
            raise RegulatoryNormalizationError(
                f"Acquisition total-source count does not match completed "
                f"and failed sources: {run_manifest_path}"
            )
        run_rows.append(
            {
                "run_id": run_id,
                "status": run_status,
                "manifest_file": f"{run_id}/run.manifest.json",
                "manifest_sha256": _sha256(run_manifest_path),
                "declared_source_count": run_manifest.get("source_count"),
                "completed_source_count": run_manifest.get(
                    "completed_source_count"
                ),
                "failed_source_count": run_manifest.get(
                    "failed_source_count"
                ),
            }
        )
        for manifest_path in sorted(
            resolved.glob("*.manifest.json"),
            key=lambda path: path.name,
        ):
            if manifest_path.name == "run.manifest.json":
                continue
            source_input = _validate_source_manifest(
                manifest_path,
                run_id,
                run_status,
            )
            declared = declared_sources.get(source_input.source_id)
            if declared is None:
                raise RegulatoryNormalizationError(
                    f"Source {source_input.source_id} is not bound by "
                    f"acquisition run manifest {run_manifest_path}."
                )
            if (
                declared.get("gzip_sha256")
                != source_input.manifest["artifact"].get("gzip_sha256")
                or declared.get("rows")
                != source_input.manifest["artifact"].get("rows")
                or declared.get("family") != source_input.source.family
            ):
                raise RegulatoryNormalizationError(
                    f"Source {source_input.source_id} does not match its "
                    f"acquisition run inventory."
                )
            candidates[source_input.source_id].append(source_input)

    selected: list[SourceInput] = []
    for source_id, options in sorted(candidates.items()):
        newest = max(
            str(option.manifest.get("retrieved_at") or "")
            for option in options
        )
        latest = [
            option
            for option in options
            if str(option.manifest.get("retrieved_at") or "") == newest
        ]
        hashes = {
            str(option.manifest["artifact"]["gzip_sha256"])
            for option in latest
        }
        if len(hashes) > 1:
            raise RegulatoryNormalizationError(
                f"Source {source_id} has divergent snapshots with the same "
                f"retrieval timestamp."
            )
        latest.sort(
            key=lambda option: (
                option.manifest["source"].get("source_id")
                != source_id,
                option.run_id,
                option.data_path.name,
            )
        )
        selected.append(latest[0])
    if not selected:
        raise RegulatoryNormalizationError(
            "No completed source artifacts were found."
        )
    return selected, sorted(run_rows, key=lambda row: row["run_id"])


def _source_ssl_values(row: Mapping[str, Any]) -> tuple[str, ...]:
    values: set[str] = set()
    for field in SSL_FIELDS:
        values.update(normalize_ssl_values(row.get(field)))
    return tuple(sorted(values))


def _address_value(row: Mapping[str, Any]) -> Any:
    return _first_value(row, ADDRESS_FIELDS)


def _make_links(
    *,
    family: str,
    ssl_values: tuple[str, ...],
    address_key: str | None,
    account_index: AccountIndex,
    safe_max_accounts_per_address: int,
) -> LinkDecision:
    mode = _source_family_mode(family)
    matched_by_ssl: dict[int, list[str]] = defaultdict(list)
    ssl_index_ambiguous = False
    for ssl in ssl_values:
        accounts = account_index.ssl_accounts.get(ssl, ())
        if len(accounts) > 1:
            ssl_index_ambiguous = True
        for account_id in accounts:
            matched_by_ssl[account_id].append(ssl)

    if matched_by_ssl:
        account_ids = tuple(sorted(matched_by_ssl))
        if (
            len(account_ids) > safe_max_accounts_per_address
            or (
                mode == "exact_ssl_only"
                and (len(account_ids) != 1 or ssl_index_ambiguous)
            )
        ):
            return LinkDecision((), "ambiguous")
        source_is_multi = len(ssl_values) > 1 or len(account_ids) > 1
        if mode == "exact_ssl_only":
            scope, quality, confidence = (
                "exact_property",
                "exact",
                "1.0000",
            )
        elif mode == "parcel" and not source_is_multi:
            scope, quality, confidence = (
                "exact_property",
                "exact",
                "1.0000",
            )
        elif mode == "proximity":
            scope, quality, confidence = (
                "proximity_context",
                "contextual",
                "0.7000",
            )
        elif source_is_multi:
            scope, quality, confidence = (
                "multi_parcel",
                "contextual",
                "0.8500",
            )
        else:
            scope, quality, confidence = (
                "shared_building",
                "contextual",
                "0.9000",
            )
        return LinkDecision(
            tuple(
                Link(
                    account_id=account_id,
                    scope=scope,
                    method="ssl",
                    quality=quality,
                    confidence=confidence,
                    basis={
                        "matched_ssl_values": sorted(
                            matched_by_ssl[account_id]
                        ),
                        "source_ssl_values": list(ssl_values),
                        "policy": mode,
                    },
                )
                for account_id in account_ids
            ),
            "exact" if quality == "exact" else "contextual",
        )

    if mode == "exact_ssl_only":
        return LinkDecision((), "unlinked")
    if not address_key:
        return LinkDecision((), "unlinked")
    address_accounts = account_index.address_accounts.get(address_key, ())
    if not address_accounts:
        return LinkDecision((), "unlinked")
    if len(address_accounts) > safe_max_accounts_per_address:
        return LinkDecision((), "ambiguous")

    if mode == "proximity":
        scope, quality, confidence = (
            "proximity_context",
            "contextual",
            "0.6500",
        )
    elif len(ssl_values) > 1:
        scope, quality, confidence = (
            "multi_parcel",
            "contextual",
            "0.7500",
        )
    else:
        scope, quality, confidence = (
            "shared_building",
            "contextual",
            "0.8000",
        )
    return LinkDecision(
        tuple(
            Link(
                account_id=account_id,
                scope=scope,
                method="normalized_address",
                quality=quality,
                confidence=confidence,
                basis={
                    "address_key": address_key,
                    "candidate_account_count": len(address_accounts),
                    "source_ssl_values": list(ssl_values),
                    "policy": mode,
                },
            )
            for account_id in address_accounts
        ),
        "exact" if quality == "exact" else "contextual",
    )


def _record_row(
    source_input: SourceInput,
    row: Mapping[str, Any],
    row_number: int,
    row_hash: str,
    record_type: str,
) -> dict[str, Any]:
    ssl_raw_value = _first_value(row, SSL_FIELDS)
    ssl_values = _source_ssl_values(row)
    premise_address = _text(_address_value(row))
    latitude = _decimal_text(
        _first_value(row, LATITUDE_FIELDS), -90, 90
    )
    longitude = _decimal_text(
        _first_value(row, LONGITUDE_FIELDS), -180, 180
    )
    if not latitude or not longitude:
        latitude = ""
        longitude = ""
    return {
        "source_id": source_input.source_id,
        "release_key": source_input.release_key,
        "source_record_id": _positive_integer(
            row.get(
                str(
                    source_input.manifest["arcgis"].get(
                        "object_id_field", "OBJECTID"
                    )
                )
            )
        ),
        "source_row_number": row_number,
        "source_row_sha256": row_hash,
        "record_type": record_type,
        "record_number": _text(_first_value(row, NUMBER_FIELDS)),
        "record_status": _text(_first_value(row, STATUS_FIELDS)),
        "record_status_date": _iso_date(
            _first_value(row, STATUS_DATE_FIELDS)
        ),
        "premise_address": premise_address,
        "address_normalized": normalize_street_key(premise_address) or "",
        "ssl_raw": _text(ssl_raw_value),
        "ssl_normalized": ssl_values[0] if len(ssl_values) == 1 else "",
        "mar_id": _positive_integer(_first_value(row, MAR_FIELDS)) or "",
        "ubid": _text(_first_value(row, UBID_FIELDS)),
        "event_date": _iso_date(_first_value(row, EVENT_DATE_FIELDS)),
        "expiration_date": _iso_date(
            _first_value(row, EXPIRATION_DATE_FIELDS)
        ),
        "latitude": latitude,
        "longitude": longitude,
        "facts_json": _canonical_json(_strip_nulls(dict(row))),
    }


def _iter_source_rows(
    source_input: SourceInput,
) -> Iterator[tuple[int, dict[str, Any], str]]:
    expected_rows = source_input.manifest["artifact"].get("rows")
    expected_canonical_hash = source_input.manifest["artifact"].get(
        "canonical_rows_sha256"
    )
    if not isinstance(expected_rows, int) or expected_rows < 0:
        raise RegulatoryNormalizationError(
            f"Invalid declared row count for {source_input.source_id}."
        )
    object_id_field = str(
        source_input.manifest["arcgis"].get(
            "object_id_field", "OBJECTID"
        )
    )
    aggregate = hashlib.sha256()
    prior_object_id = 0
    row_count = 0
    try:
        handle = gzip.open(
            source_input.data_path,
            "rt",
            encoding="utf-8",
            newline="",
        )
        with handle:
            for row_number, line in enumerate(handle, start=1):
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RegulatoryNormalizationError(
                        f"Invalid JSONL in {source_input.data_path} at "
                        f"row {row_number}."
                    ) from error
                if not isinstance(row, dict):
                    raise RegulatoryNormalizationError(
                        f"Non-object source row in {source_input.data_path}."
                    )
                object_id = _positive_integer(row.get(object_id_field))
                if object_id is None or object_id <= prior_object_id:
                    raise RegulatoryNormalizationError(
                        f"Source object IDs are missing, duplicated, or "
                        f"unordered in {source_input.data_path}."
                    )
                prior_object_id = object_id
                canonical = (
                    _canonical_json(row).encode("utf-8") + b"\n"
                )
                aggregate.update(canonical)
                row_count += 1
                yield row_number, row, hashlib.sha256(
                    canonical[:-1]
                ).hexdigest()
    except (OSError, UnicodeDecodeError) as error:
        raise RegulatoryNormalizationError(
            f"Could not read source artifact {source_input.data_path}."
        ) from error
    if row_count != expected_rows:
        raise RegulatoryNormalizationError(
            f"{source_input.source_id} has {row_count} rows; "
            f"manifest declares {expected_rows}."
        )
    if (
        not isinstance(expected_canonical_hash, str)
        or aggregate.hexdigest() != expected_canonical_hash
    ):
        raise RegulatoryNormalizationError(
            f"Canonical row hash mismatch for {source_input.source_id}."
        )


def _source_asset_row(source_input: SourceInput) -> dict[str, Any]:
    source = source_input.source
    layer_identifier = source.layer_url.rstrip("/").split("/")[-1]
    return {
        "source_id": source.source_id,
        "family": source.family,
        "publisher": source.publisher,
        "dataset_name": source.dataset_name,
        "item_id": source.item_id or "",
        "source_system": "dc_arcgis",
        "source_dataset_identifier": source.item_id or source.source_id,
        "source_layer_identifier": (
            layer_identifier if layer_identifier.isdigit() else ""
        ),
        "source_record_id_field": source_input.manifest["arcgis"].get(
            "object_id_field", "OBJECTID"
        ),
        "landing_url": source.landing_url,
        "human_portal_url": source.human_portal_url,
        "human_portal_name": source.human_portal_name,
        "machine_layer_url": source.layer_url,
        "snapshot_policy": "periodic_snapshot",
        "source_limitations": source.source_limitations,
        "source_metadata_json": _canonical_json(
            {
                "family": source.family,
                "item_id": source.item_id,
                "registered_fields": list(source.fields),
            }
        ),
    }


def _load_s3_archive_receipt(
    path: Path,
) -> tuple[dict[str, str], dict[str, Any]]:
    resolved = path.resolve()
    receipt = _load_json_object(resolved)
    if (
        receipt.get("receipt_kind") != "dc-property-s3-archive"
        or receipt.get("receipt_version") != 1
        or receipt.get("status") != "verified"
        or not isinstance(receipt.get("provider"), str)
        or not receipt.get("provider")
        or not isinstance(receipt.get("endpoint"), str)
        or not receipt.get("endpoint", "").startswith("https://")
        or not isinstance(receipt.get("region"), str)
        or not receipt.get("region")
        or not re.fullmatch(
            r"[0-9a-f]{64}", str(receipt.get("archive_id") or "")
        )
        or not isinstance(receipt.get("bucket"), str)
        or not receipt.get("bucket")
        or not isinstance(receipt.get("receipt_object_key"), str)
        or not receipt.get("receipt_object_key")
        or not isinstance(receipt.get("files"), list)
    ):
        raise RegulatoryNormalizationError(
            f"Invalid verified S3 archive receipt: {resolved}"
        )
    object_by_sha: dict[str, str] = {}
    for file in receipt["files"]:
        if (
            not isinstance(file, dict)
            or not re.fullmatch(
                r"[0-9a-f]{64}", str(file.get("sha256") or "")
            )
            or not isinstance(file.get("bytes"), int)
            or not isinstance(file.get("parts"), list)
            or len(file["parts"]) != 1
        ):
            continue
        part = file["parts"][0]
        if (
            not isinstance(part, dict)
            or part.get("sha256") != file["sha256"]
            or part.get("bytes") != file["bytes"]
            or not isinstance(part.get("object_key"), str)
            or not part["object_key"]
        ):
            continue
        uri = f"s3://{receipt['bucket']}/{part['object_key']}"
        existing = object_by_sha.get(file["sha256"])
        object_by_sha[file["sha256"]] = (
            min(existing, uri) if existing is not None else uri
        )
    return object_by_sha, {
        "archive_id": receipt["archive_id"],
        "provider": receipt["provider"],
        "endpoint": receipt["endpoint"],
        "region": receipt["region"],
        "bucket": receipt["bucket"],
        "receipt_object_key": receipt["receipt_object_key"],
        "receipt_sha256": _sha256(resolved),
    }


def _source_release_row(
    source_input: SourceInput,
    archive_object_by_sha: Mapping[str, str] | None = None,
    archive_metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = source_input.manifest
    artifact = manifest["artifact"]
    arcgis = manifest["arcgis"]
    artifact_sha = str(artifact["gzip_sha256"])
    if archive_object_by_sha is None:
        archive_object_key = (
            f"data/regulatory/raw/{source_input.run_id}/"
            f"{source_input.data_path.name}"
        )
    else:
        archive_object_key = archive_object_by_sha.get(artifact_sha)
        if archive_object_key is None:
            raise RegulatoryNormalizationError(
                f"Verified S3 receipt does not bind raw artifact "
                f"{source_input.source_id} ({artifact_sha})."
            )
    return {
        "source_id": source_input.source_id,
        "release_key": source_input.release_key,
        "snapshot_retrieved_at": manifest["retrieved_at"],
        "source_updated_at": _iso_datetime_from_millis(
            arcgis.get("service_last_edit_ms")
        ),
        "archive_object_key": archive_object_key,
        "content_type": "application/x-ndjson+gzip",
        "bytes": artifact["bytes"],
        "row_count": artifact["rows"],
        "sha256": artifact["gzip_sha256"],
        "schema_sha256": arcgis["schema_fingerprint"],
        "canonical_rows_sha256": artifact["canonical_rows_sha256"],
        "release_metadata_json": _canonical_json(
            _strip_nulls(
                {
                    "acquisition_run_id": source_input.run_id,
                    "object_id_field": arcgis.get("object_id_field"),
                    "object_id_inventory_sha256": arcgis.get(
                        "object_id_inventory_sha256"
                    ),
                    "pagination_strategy": arcgis.get(
                        "pagination_strategy"
                    ),
                    "service_name": arcgis.get("service_name"),
                    "etag": arcgis.get("etag"),
                    "last_modified": arcgis.get("last_modified"),
                    "s3_archive_id": (
                        archive_metadata.get("archive_id")
                        if archive_metadata
                        else None
                    ),
                    "s3_archive_receipt_sha256": (
                        archive_metadata.get("receipt_sha256")
                        if archive_metadata
                        else None
                    ),
                }
            )
        ),
    }


def _empty_source_stats(source_input: SourceInput) -> dict[str, Any]:
    return {
        "source_id": source_input.source_id,
        "family": source_input.source.family,
        "release_key": source_input.release_key,
        "input_rows": 0,
        "served_records": 0,
        "exact_records": 0,
        "contextual_records": 0,
        "ambiguous_records": 0,
        "unlinked_records": 0,
        "account_links": 0,
    }


def normalize_regulatory_data(
    *,
    account_path: Path,
    acquisition_run_directories: Sequence[Path],
    output_directory: Path,
    run_id: str,
    s3_archive_receipt: Path | None = None,
    safe_max_accounts_per_address: int = (
        DEFAULT_SAFE_MAX_ACCOUNTS_PER_ADDRESS
    ),
) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id or ""):
        raise RegulatoryNormalizationError(
            "run_id may contain only letters, digits, underscores, and hyphens."
        )
    if not 1 <= safe_max_accounts_per_address <= 256:
        raise RegulatoryNormalizationError(
            "safe_max_accounts_per_address must be between 1 and 256."
        )
    output_directory = output_directory.resolve()
    if output_directory.exists():
        raise RegulatoryNormalizationError(
            f"Refusing to overwrite normalized run: {output_directory}"
        )
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    partial_directory = (
        output_directory.parent / f".{output_directory.name}.partial"
    )
    if partial_directory.exists():
        raise RegulatoryNormalizationError(
            f"Refusing to reuse partial run directory: {partial_directory}"
        )

    account_index = _load_account_index(account_path.resolve())
    sources, acquisition_runs = _discover_sources(
        tuple(Path(path) for path in acquisition_run_directories)
    )
    archive_object_by_sha = None
    archive_metadata = None
    if s3_archive_receipt is not None:
        archive_object_by_sha, archive_metadata = _load_s3_archive_receipt(
            s3_archive_receipt
        )
    partial_directory.mkdir()
    writers: dict[str, DeterministicCsvGzipWriter] = {}
    try:
        writers = {
            filename: DeterministicCsvGzipWriter(
                partial_directory / filename,
                header,
            )
            for filename, header in ARTIFACT_HEADERS.items()
        }
        source_stats: list[dict[str, Any]] = []
        snapshot_times: list[str] = []
        for source_input in sources:
            writers["source_assets.csv.gz"].write(
                _source_asset_row(source_input)
            )
            writers["source_releases.csv.gz"].write(
                _source_release_row(
                    source_input,
                    archive_object_by_sha,
                    archive_metadata,
                )
            )
            snapshot_times.append(str(source_input.manifest["retrieved_at"]))
            stats = _empty_source_stats(source_input)
            destination, record_type = _record_type(
                source_input.source.family
            )
            for row_number, row, row_hash in _iter_source_rows(
                source_input
            ):
                stats["input_rows"] += 1
                source_record_id = _positive_integer(
                    row.get(
                        str(
                            source_input.manifest["arcgis"].get(
                                "object_id_field", "OBJECTID"
                            )
                        )
                    )
                )
                if source_record_id is None:
                    raise RegulatoryNormalizationError(
                        f"Invalid source record ID for "
                        f"{source_input.source_id} row {row_number}."
                    )
                ssl_values = _source_ssl_values(row)
                address_key = normalize_street_key(_address_value(row))
                decision = _make_links(
                    family=source_input.source.family,
                    ssl_values=ssl_values,
                    address_key=address_key,
                    account_index=account_index,
                    safe_max_accounts_per_address=(
                        safe_max_accounts_per_address
                    ),
                )
                if not decision.links:
                    stats[f"{decision.outcome}_records"] += 1
                    continue
                stats["served_records"] += 1
                stats[f"{decision.outcome}_records"] += 1
                stats["account_links"] += len(decision.links)
                writers[destination].write(
                    _record_row(
                        source_input,
                        row,
                        row_number,
                        row_hash,
                        record_type,
                    )
                )
                for link in decision.links:
                    writers["source_record_links.csv.gz"].write(
                        {
                            "source_id": source_input.source_id,
                            "release_key": source_input.release_key,
                            "source_record_id": source_record_id,
                            "account_id": link.account_id,
                            "link_status": "linked",
                            "link_scope": link.scope,
                            "link_method": link.method,
                            "match_quality": link.quality,
                            "link_confidence": link.confidence,
                            "match_basis_json": _canonical_json(link.basis),
                        }
                    )
            source_stats.append(stats)

        artifact_stats = {
            filename: writer.close()
            for filename, writer in writers.items()
        }
        writers = {}
        total_keys = (
            "input_rows",
            "served_records",
            "exact_records",
            "contextual_records",
            "ambiguous_records",
            "unlinked_records",
            "account_links",
        )
        manifest = {
            "manifest_kind": "dc-property-regulatory-normalized",
            "manifest_version": 1,
            "run_id": run_id,
            "generated_from_snapshot_at": max(snapshot_times),
            "account_input": {
                "file": account_path.name,
                "rows": account_index.row_count,
                "sha256": account_index.sha256,
            },
            "archive_policy": (
                {
                    "status": "verified",
                    "scheme": "s3_content_addressed_sha256",
                    **archive_metadata,
                }
                if archive_metadata is not None
                else {
                    "status": "local_test_fixture",
                    "scheme": "local_path",
                }
            ),
            "acquisition_runs": acquisition_runs,
            "safe_max_accounts_per_address": (
                safe_max_accounts_per_address
            ),
            "linking_policy": {
                "precedence": [
                    "exact SSL",
                    "conservative normalized street address",
                ],
                "fuzzy_matching": False,
                "exact_property": (
                    "SSL-derived only, confidence 1.0000; address-derived "
                    "links are always contextual"
                ),
                "cama": "exact SSL only",
                "energy_and_beps": (
                    "building context only; never exact tax-account evidence"
                ),
                "business_and_premise": (
                    "shared-building or multi-parcel context"
                ),
                "ddot_tree_and_well": "proximity context only",
                "address_key": (
                    "DC city and ZIP tails, known unit suffixes, punctuation, "
                    "and leading house-number zeroes removed; a numeric house "
                    "number and recognized street suffix are required"
                ),
                "address_account_cap": safe_max_accounts_per_address,
                "source_row_hash": (
                    "SHA-256 of canonical UTF-8 JSON without the trailing "
                    "JSONL newline"
                ),
            },
            "source_count": len(source_stats),
            "sources": source_stats,
            "totals": {
                key: sum(int(source[key]) for source in source_stats)
                for key in total_keys
            },
            "artifacts": artifact_stats,
        }
        manifest_path = partial_directory / "manifest.json"
        manifest_path.write_text(
            json.dumps(
                manifest,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        partial_directory.replace(output_directory)
        return manifest
    except BaseException:
        for writer in writers.values():
            try:
                writer.close()
            except BaseException:
                pass
        if partial_directory.exists():
            shutil.rmtree(partial_directory)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Normalize and conservatively link immutable official D.C. "
            "regulatory acquisitions to current property accounts."
        )
    )
    parser.add_argument(
        "--account-file",
        type=Path,
        default=PROJECT / "data" / "generated" / (
            "property_account_current.csv.gz"
        ),
    )
    parser.add_argument(
        "--acquisition-run",
        type=Path,
        action="append",
        required=True,
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--s3-archive-receipt",
        type=Path,
        required=True,
        help=(
            "Verified content-addressed S3 receipt covering every selected "
            "raw source artifact."
        ),
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=PROJECT / "data" / "regulatory" / "generated",
    )
    parser.add_argument(
        "--safe-max-accounts-per-address",
        type=int,
        default=DEFAULT_SAFE_MAX_ACCOUNTS_PER_ADDRESS,
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    output_directory = (
        arguments.output_root.resolve() / arguments.run_id
    )
    manifest = normalize_regulatory_data(
        account_path=arguments.account_file,
        acquisition_run_directories=arguments.acquisition_run,
        output_directory=output_directory,
        run_id=arguments.run_id,
        s3_archive_receipt=arguments.s3_archive_receipt,
        safe_max_accounts_per_address=(
            arguments.safe_max_accounts_per_address
        ),
    )
    print(
        json.dumps(
            {
                "run_id": manifest["run_id"],
                "source_count": manifest["source_count"],
                "totals": manifest["totals"],
                "output_directory": str(output_directory),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
