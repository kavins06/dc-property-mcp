from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from .regulatory_normalize import ARTIFACT_HEADERS


class RegulatoryVerificationError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _csv_line(values: Sequence[str]) -> bytes:
    output = io.StringIO(newline="")
    csv.writer(output, lineterminator="\n").writerow(values)
    return output.getvalue().encode("utf-8")


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RegulatoryVerificationError(
            f"Invalid normalized manifest: {path}"
        ) from error
    if not isinstance(value, dict):
        raise RegulatoryVerificationError(
            f"Normalized manifest is not an object: {path}"
        )
    return value


def _integer(value: Any, label: str) -> int:
    if not isinstance(value, int) or value < 0:
        raise RegulatoryVerificationError(
            f"{label} must be a nonnegative integer."
        )
    return value


def _verify_artifact(
    release_directory: Path,
    filename: str,
    header: tuple[str, ...],
    declared: Mapping[str, Any],
    *,
    require_durable_archive: bool = False,
) -> dict[str, Any]:
    path = release_directory / filename
    if not path.is_file():
        raise RegulatoryVerificationError(
            f"Normalized artifact is missing: {filename}"
        )
    expected_sha = declared.get("sha256")
    observed_sha = _sha256(path)
    if expected_sha != observed_sha:
        raise RegulatoryVerificationError(
            f"{filename} artifact SHA-256 mismatch."
        )
    expected_bytes = _integer(
        declared.get("bytes"), f"{filename} bytes"
    )
    if path.stat().st_size != expected_bytes:
        raise RegulatoryVerificationError(
            f"{filename} artifact byte count mismatch."
        )
    row_digest = hashlib.sha256()
    row_count = 0
    try:
        with gzip.open(
            path,
            "rt",
            encoding="utf-8",
            newline="",
        ) as handle:
            reader = csv.reader(handle)
            try:
                observed_header = tuple(next(reader))
            except StopIteration as error:
                raise RegulatoryVerificationError(
                    f"{filename} is empty."
                ) from error
            if observed_header != header:
                raise RegulatoryVerificationError(
                    f"{filename} header does not match its contract."
                )
            for row in reader:
                if len(row) != len(header):
                    raise RegulatoryVerificationError(
                        f"{filename} row {row_count + 1} has "
                        f"{len(row)} columns; expected {len(header)}."
                    )
                if (
                    require_durable_archive
                    and filename == "source_releases.csv.gz"
                    and not row[header.index("archive_object_key")].startswith(
                        "s3://"
                    )
                ):
                    raise RegulatoryVerificationError(
                        "source_releases.csv.gz contains a local or "
                        "non-S3 archive_object_key."
                    )
                row_digest.update(_csv_line(row))
                row_count += 1
    except (OSError, UnicodeDecodeError, csv.Error) as error:
        raise RegulatoryVerificationError(
            f"{filename} is not a valid UTF-8 gzip CSV artifact."
        ) from error
    expected_rows = _integer(
        declared.get("rows"), f"{filename} rows"
    )
    if row_count != expected_rows:
        raise RegulatoryVerificationError(
            f"{filename} artifact row count mismatch."
        )
    if row_digest.hexdigest() != declared.get(
        "canonical_rows_sha256"
    ):
        raise RegulatoryVerificationError(
            f"{filename} canonical row SHA-256 mismatch."
        )
    return {
        "rows": row_count,
        "bytes": expected_bytes,
        "sha256": observed_sha,
        "canonical_rows_sha256": row_digest.hexdigest(),
    }


def verify_normalized_release(
    release_directory: Path,
    *,
    require_durable_archive: bool = False,
) -> dict[str, Any]:
    release_directory = release_directory.resolve()
    manifest = _load_manifest(release_directory / "manifest.json")
    if (
        manifest.get("manifest_kind")
        != "dc-property-regulatory-normalized"
        or manifest.get("manifest_version") != 1
    ):
        raise RegulatoryVerificationError(
            "Normalized manifest kind or version is unsupported."
        )
    if require_durable_archive:
        archive_policy = manifest.get("archive_policy")
        if (
            not isinstance(archive_policy, dict)
            or archive_policy.get("status") != "verified"
            or archive_policy.get("scheme")
            != "s3_content_addressed_sha256"
            or not isinstance(archive_policy.get("provider"), str)
            or not archive_policy.get("provider")
            or not isinstance(archive_policy.get("endpoint"), str)
            or not archive_policy.get("endpoint", "").startswith("https://")
            or not isinstance(archive_policy.get("region"), str)
            or not archive_policy.get("region")
            or not isinstance(archive_policy.get("bucket"), str)
            or not archive_policy.get("bucket")
            or not isinstance(
                archive_policy.get("receipt_object_key"), str
            )
            or not archive_policy.get("receipt_object_key")
            or not isinstance(archive_policy.get("archive_id"), str)
            or not isinstance(archive_policy.get("receipt_sha256"), str)
        ):
            raise RegulatoryVerificationError(
                "Normalized release is not bound to a verified S3 archive."
            )
    declared_artifacts = manifest.get("artifacts")
    if not isinstance(declared_artifacts, dict) or set(
        declared_artifacts
    ) != set(ARTIFACT_HEADERS):
        raise RegulatoryVerificationError(
            "Normalized artifact inventory does not match the contract."
        )
    verified_artifacts = {}
    for filename, header in ARTIFACT_HEADERS.items():
        declared = declared_artifacts[filename]
        if not isinstance(declared, dict):
            raise RegulatoryVerificationError(
                f"{filename} manifest entry is invalid."
            )
        verified_artifacts[filename] = _verify_artifact(
            release_directory,
            filename,
            header,
            declared,
            require_durable_archive=require_durable_archive,
        )

    sources = manifest.get("sources")
    totals = manifest.get("totals")
    if not isinstance(sources, list) or not isinstance(totals, dict):
        raise RegulatoryVerificationError(
            "Normalized manifest has no source accounting."
        )
    source_count = _integer(
        manifest.get("source_count"), "source_count"
    )
    if len(sources) != source_count:
        raise RegulatoryVerificationError(
            "Normalized source_count does not match its inventory."
        )
    accounting_keys = (
        "input_rows",
        "served_records",
        "exact_records",
        "contextual_records",
        "ambiguous_records",
        "unlinked_records",
        "account_links",
    )
    recomputed_totals = {key: 0 for key in accounting_keys}
    source_ids: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            raise RegulatoryVerificationError(
                "Normalized source accounting row is invalid."
            )
        source_id = source.get("source_id")
        if (
            not isinstance(source_id, str)
            or not source_id
            or source_id in source_ids
        ):
            raise RegulatoryVerificationError(
                "Normalized source accounting has a duplicate source ID."
            )
        source_ids.add(source_id)
        values = {
            key: _integer(
                source.get(key), f"{source_id}.{key}"
            )
            for key in accounting_keys
        }
        if values["input_rows"] != (
            values["served_records"]
            + values["ambiguous_records"]
            + values["unlinked_records"]
        ):
            raise RegulatoryVerificationError(
                f"{source_id} input accounting does not balance."
            )
        if values["served_records"] != (
            values["exact_records"] + values["contextual_records"]
        ):
            raise RegulatoryVerificationError(
                f"{source_id} served-record accounting does not balance."
            )
        if values["account_links"] < values["served_records"]:
            raise RegulatoryVerificationError(
                f"{source_id} has fewer links than served records."
            )
        for key, value in values.items():
            recomputed_totals[key] += value
    for key, observed in recomputed_totals.items():
        if _integer(totals.get(key), f"totals.{key}") != observed:
            raise RegulatoryVerificationError(
                f"Normalized total {key} does not balance."
            )

    if (
        verified_artifacts["source_assets.csv.gz"]["rows"]
        != source_count
        or verified_artifacts["source_releases.csv.gz"]["rows"]
        != source_count
    ):
        raise RegulatoryVerificationError(
            "Source metadata artifact rows do not match source_count."
        )
    served_artifact_rows = (
        verified_artifacts["regulatory_records.csv.gz"]["rows"]
        + verified_artifacts["property_context_records.csv.gz"]["rows"]
    )
    if served_artifact_rows != recomputed_totals["served_records"]:
        raise RegulatoryVerificationError(
            "Serving artifact rows do not match served_records."
        )
    if (
        verified_artifacts["source_record_links.csv.gz"]["rows"]
        != recomputed_totals["account_links"]
    ):
        raise RegulatoryVerificationError(
            "Link artifact rows do not match account_links."
        )
    account_input = manifest.get("account_input")
    if (
        not isinstance(account_input, dict)
        or _integer(account_input.get("rows"), "account_input.rows") < 1
    ):
        raise RegulatoryVerificationError(
            "Normalized manifest has no valid account input."
        )
    return {
        "run_id": manifest.get("run_id"),
        "source_count": source_count,
        "input_rows": recomputed_totals["input_rows"],
        "served_records": recomputed_totals["served_records"],
        "account_links": recomputed_totals["account_links"],
        "artifacts": verified_artifacts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Independently verify a normalized D.C. regulatory release."
        )
    )
    parser.add_argument("release_directory", type=Path)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    result = verify_normalized_release(
        arguments.release_directory,
        require_durable_archive=True,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
