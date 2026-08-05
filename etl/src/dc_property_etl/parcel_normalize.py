from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
from pathlib import Path
from typing import Any, Mapping

from .regulatory_normalize import normalize_ssl_values
from .source_registry import PARCEL_SOURCES


PROJECT = Path(__file__).resolve().parents[3]
SOURCE_IDS = tuple(source.source_id for source in PARCEL_SOURCES)
ARTIFACT_HEADERS = {
    "mar_addresses.csv.gz": (
        "source_id", "release_key", "source_record_id", "source_row_sha256",
        "mar_id", "address_source_value", "status", "base_ssl_normalized",
    ),
    "mar_address_ssls.csv.gz": (
        "source_id", "release_key", "source_record_id", "source_row_sha256",
        "mar_id", "ssl_normalized", "square", "suffix", "lot", "lot_type",
        "common_ownership_lot", "parcel", "reservation",
    ),
    "mar_residential_units.csv.gz": (
        "source_id", "release_key", "source_record_id", "source_row_sha256",
        "unit_id", "mar_id", "full_address", "primary_address", "unit_number",
        "unit_type", "condo_ssl_normalized", "status",
    ),
}


def _positive_integer(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a positive integer")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a positive integer") from error
    if not number.is_integer() or number <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return int(number)


def _ssl(value: Any, *, required: bool) -> str | None:
    values = normalize_ssl_values(value)
    if not values:
        if required:
            raise ValueError("SSL must be one valid D.C. identifier")
        return None
    if len(values) != 1:
        raise ValueError("SSL must be one valid D.C. identifier")
    return values[0]


def _official_parcel_id(value: Any) -> str:
    compact = re.sub(r"[\s-]+", "", str(value or "").strip().upper())
    if not re.fullmatch(
        r"(?=.{5,32}$)(?:\d{3,4}|RES|PAR|PI)[A-Z0-9./]+",
        compact,
    ):
        raise ValueError("SSL must be one valid official D.C. parcel identifier")
    return compact


def normalize_address_row(row: Mapping[str, Any]) -> dict[str, Any] | None:
    source_record_id = _positive_integer(row.get("OBJECTID"), "OBJECTID")
    mar_id = _positive_integer(row.get("MAR_ID"), "MAR_ID")
    address = str(row.get("ADDRESS") or "").strip()
    if not address:
        return None
    return {
        "source_record_id": source_record_id,
        "mar_id": mar_id,
        "address_source_value": address,
        "status": str(row.get("STATUS") or "").strip() or None,
        "base_ssl_normalized": _ssl(row.get("SSL"), required=False),
    }


def normalize_address_ssl_row(row: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "source_record_id": _positive_integer(row.get("OBJECTID"), "OBJECTID"),
        "mar_id": _positive_integer(row.get("MARID"), "MARID"),
        "ssl_normalized": _official_parcel_id(row.get("SSL")),
        "square": str(row.get("SQUARE") or "").strip() or None,
        "suffix": str(row.get("SUFFIX") or "").strip() or None,
        "lot": str(row.get("LOT") or "").strip() or None,
        "common_ownership_lot": str(row.get("COL") or "").strip() or None,
        "parcel": str(row.get("PARCEL") or "").strip() or None,
        "reservation": str(row.get("RESERVATION") or "").strip() or None,
        "lot_type": str(row.get("LOT_TYPE") or "").strip() or None,
    }


def normalize_residential_unit_row(row: Mapping[str, Any]) -> dict[str, Any] | None:
    source_record_id = _positive_integer(row.get("OBJECTID"), "OBJECTID")
    mar_id = _positive_integer(row.get("MAR_ID"), "MAR_ID")
    full_address = str(row.get("FULL_ADDRESS") or "").strip()
    primary_address = str(row.get("PRIMARY_ADDRESS") or "").strip()
    unit_number = str(row.get("UNIT_NUMBER") or "").strip()
    if not full_address or not primary_address or not unit_number:
        return None
    return {
        "source_record_id": source_record_id,
        "unit_id": _positive_integer(row.get("UNIT_ID"), "UNIT_ID"),
        "mar_id": mar_id,
        "full_address": full_address,
        "primary_address": primary_address,
        "unit_number": unit_number,
        "unit_type": str(row.get("UNIT_TYPE") or "").strip() or None,
        "condo_ssl_normalized": _ssl(row.get("CONDO_SSL"), required=False),
        "status": str(row.get("STATUS") or "").strip() or None,
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _csv_line(values: list[Any]) -> bytes:
    output = io.StringIO(newline="")
    csv.writer(output, lineterminator="\n").writerow(
        "" if value is None else value for value in values
    )
    return output.getvalue().encode("utf-8")


def _write_artifact(
    path: Path, header: tuple[str, ...], rows: list[dict[str, Any]]
) -> dict[str, Any]:
    row_digest = hashlib.sha256()
    with path.open("xb") as raw:
        with gzip.GzipFile(
            filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0
        ) as output:
            header_line = _csv_line(list(header))
            output.write(header_line)
            for row in rows:
                line = _csv_line([row.get(column) for column in header])
                row_digest.update(line)
                output.write(line)
    return {
        "rows": len(rows),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "canonical_rows_sha256": row_digest.hexdigest(),
    }


def _load_source(
    acquisition: Path,
    source_id: str,
    normalizer: Any,
    key_fields: tuple[str, ...],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    manifest_path = acquisition / f"{source_id}.manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("manifest_kind") != "dc-property-arcgis-source"
        or manifest.get("status") != "complete"
        or manifest.get("source", {}).get("source_id") != source_id
    ):
        raise ValueError(f"Invalid acquisition manifest for {source_id}")
    data_path = acquisition / manifest["artifact"]["file"]
    if _sha256(data_path) != manifest["artifact"]["gzip_sha256"]:
        raise ValueError(f"Acquisition hash mismatch for {source_id}")

    release_key = f"arcgis-{manifest['artifact']['gzip_sha256']}"
    by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
    excluded_rows = 0
    with gzip.open(data_path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            raw = json.loads(line)
            normalized = normalizer(raw)
            if normalized is None:
                excluded_rows += 1
                continue
            normalized.update({
                "source_id": source_id,
                "release_key": release_key,
                "source_row_sha256": hashlib.sha256(_canonical(raw)).hexdigest(),
            })
            key = tuple(normalized[field] for field in key_fields)
            prior = by_key.get(key)
            if prior is None:
                by_key[key] = normalized
            elif {
                field: value for field, value in prior.items()
                if field not in {
                    "source_record_id", "source_row_sha256", "square", "suffix",
                    "lot", "common_ownership_lot", "parcel", "reservation",
                }
            } != {
                field: value for field, value in normalized.items()
                if field not in {
                    "source_record_id", "source_row_sha256", "square", "suffix",
                    "lot", "common_ownership_lot", "parcel", "reservation",
                }
            }:
                raise ValueError(
                    f"Conflicting duplicate {source_id} key {key} at row {line_number}"
                )

    if len(by_key) > int(manifest["artifact"]["rows"]):
        raise ValueError(f"Normalized row count exceeds source count for {source_id}")
    rows = sorted(by_key.values(), key=lambda row: tuple(row[field] for field in key_fields))
    release = {
        "source_id": source_id,
        "release_key": release_key,
        "retrieved_at": manifest["retrieved_at"],
        "rows": manifest["artifact"]["rows"],
        "bytes": manifest["artifact"]["bytes"],
        "gzip_sha256": manifest["artifact"]["gzip_sha256"],
        "canonical_rows_sha256": manifest["artifact"]["canonical_rows_sha256"],
        "schema_sha256": manifest["arcgis"]["schema_fingerprint"],
        "excluded_rows": excluded_rows,
        "source": manifest["source"],
    }
    return rows, release


def normalize_parcel_data(
    acquisition_directory: Path, output_directory: Path
) -> dict[str, Any]:
    acquisition = acquisition_directory.resolve()
    output = output_directory.resolve()
    if output.exists():
        raise ValueError(f"Refusing to overwrite output directory: {output}")
    output.mkdir(parents=True)

    addresses, address_release = _load_source(
        acquisition, "mar_address_current", normalize_address_row, ("mar_id",)
    )
    address_ssls, xref_release = _load_source(
        acquisition,
        "mar_address_ssl_current",
        normalize_address_ssl_row,
        ("mar_id", "ssl_normalized"),
    )
    units, unit_release = _load_source(
        acquisition,
        "mar_residential_unit_current",
        normalize_residential_unit_row,
        ("unit_id",),
    )
    address_mar_ids = {row["mar_id"] for row in addresses}
    linked_address_ssls = [
        row for row in address_ssls if row["mar_id"] in address_mar_ids
    ]
    xref_release["excluded_rows"] += len(address_ssls) - len(linked_address_ssls)
    address_ssls = linked_address_ssls
    linked_units = [row for row in units if row["mar_id"] in address_mar_ids]
    unit_release["excluded_rows"] += len(units) - len(linked_units)
    units = linked_units

    artifacts = {
        "mar_addresses.csv.gz": _write_artifact(
            output / "mar_addresses.csv.gz",
            ARTIFACT_HEADERS["mar_addresses.csv.gz"],
            addresses,
        ),
        "mar_address_ssls.csv.gz": _write_artifact(
            output / "mar_address_ssls.csv.gz",
            ARTIFACT_HEADERS["mar_address_ssls.csv.gz"],
            address_ssls,
        ),
        "mar_residential_units.csv.gz": _write_artifact(
            output / "mar_residential_units.csv.gz",
            ARTIFACT_HEADERS["mar_residential_units.csv.gz"],
            units,
        ),
    }
    manifest = {
        "manifest_kind": "dc-property-mar-normalized",
        "manifest_version": 1,
        "source_count": 3,
        "sources": sorted(
            [address_release, xref_release, unit_release],
            key=lambda source: source["source_id"],
        ),
        "artifacts": artifacts,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize official MAR parcel sources.")
    parser.add_argument("acquisition_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(normalize_parcel_data(
        arguments.acquisition_directory, arguments.output_directory
    ), sort_keys=True))


if __name__ == "__main__":
    main()
