from __future__ import annotations

import gzip
import hashlib
import http.client
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .source_registry import ArcGisSource


USER_AGENT = "Quoin-DC-Property-ETL/0.4 (+public-data-ingestion)"


class ArcGisAcquisitionError(RuntimeError):
    pass


class _ArcGisServiceError(ArcGisAcquisitionError):
    def __init__(self, message: str, code: int | None) -> None:
        super().__init__(message)
        self.code = code


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def schema_fingerprint(fields: list[dict[str, Any]]) -> str:
    schema = [
        {
            "name": field.get("name"),
            "alias": field.get("alias"),
            "type": field.get("type"),
            "length": field.get("length"),
            "nullable": field.get("nullable"),
        }
        for field in fields
    ]
    canonical = json.dumps(
        schema,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _request_json(
    url: str,
    parameters: dict[str, str] | None = None,
    *,
    attempts: int = 6,
    timeout: int = 90,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> tuple[dict[str, Any], dict[str, str]]:
    body = None
    request_url = url
    if parameters is not None:
        body = urllib.parse.urlencode(parameters).encode("ascii")
    request = urllib.request.Request(
        request_url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
        method="POST" if body is not None else "GET",
    )
    for attempt in range(1, attempts + 1):
        try:
            with opener(request, timeout=timeout) as response:
                raw = response.read()
                headers = {
                    key.lower(): value
                    for key, value in response.headers.items()
                }
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ArcGisAcquisitionError(
                    f"ArcGIS returned a non-object response for {url}."
                )
            if payload.get("error"):
                service_error = payload["error"]
                code = (
                    service_error.get("code")
                    if isinstance(service_error, dict)
                    else None
                )
                raise _ArcGisServiceError(
                    f"ArcGIS error for {url}: "
                    f"{json.dumps(service_error, sort_keys=True)}",
                    code if isinstance(code, int) else None,
                )
            return payload, headers
        except (
            ArcGisAcquisitionError,
            ConnectionError,
            http.client.HTTPException,
            json.JSONDecodeError,
            TimeoutError,
            urllib.error.HTTPError,
            urllib.error.URLError,
        ) as error:
            if isinstance(error, _ArcGisServiceError):
                retryable = error.code in {
                    None,
                    408,
                    429,
                    500,
                    502,
                    503,
                    504,
                }
            elif isinstance(error, urllib.error.HTTPError):
                retryable = error.code in {
                    408,
                    429,
                    500,
                    502,
                    503,
                    504,
                }
            else:
                retryable = True
            if attempt == attempts or not retryable:
                raise ArcGisAcquisitionError(
                    f"Failed to retrieve {url} after {attempt} attempts: "
                    f"{error}"
                ) from error
            delay = min(30.0, (2 ** (attempt - 1)) + random.random())
            time.sleep(delay)
    raise AssertionError("unreachable")


def _validate_metadata(
    source: ArcGisSource,
    metadata: dict[str, Any],
) -> tuple[str, int, list[dict[str, Any]]]:
    object_id_field = (
        metadata.get("objectIdField")
        or metadata.get("objectIdFieldName")
    )
    if not object_id_field:
        object_id_field = next(
            (
                field.get("name")
                for field in metadata.get("fields", [])
                if field.get("type") == "esriFieldTypeOID"
            ),
            None,
        )
    if not isinstance(object_id_field, str) or not object_id_field:
        raise ArcGisAcquisitionError(
            f"{source.source_id} has no object-ID field."
        )
    max_record_count = metadata.get("maxRecordCount", 2000)
    if not isinstance(max_record_count, int) or max_record_count < 1:
        raise ArcGisAcquisitionError(
            f"{source.source_id} has an invalid maxRecordCount."
        )
    fields = metadata.get("fields")
    if not isinstance(fields, list) or not fields:
        raise ArcGisAcquisitionError(
            f"{source.source_id} has no field schema."
        )
    available = {
        field.get("name")
        for field in fields
        if isinstance(field, dict)
    }
    missing = sorted(set(source.fields).difference(available))
    if missing:
        raise ArcGisAcquisitionError(
            f"{source.source_id} is missing registered fields: {missing}"
        )
    if object_id_field not in source.fields:
        raise ArcGisAcquisitionError(
            f"{source.source_id} must request {object_id_field}."
        )
    return object_id_field, min(max_record_count, 2000), fields


def _validate_page(
    source_id: str,
    features: Any,
    object_id_field: str,
    seen_object_ids: set[int],
) -> list[dict[str, Any]]:
    if not isinstance(features, list):
        raise ArcGisAcquisitionError(
            f"{source_id} returned a non-array feature page."
        )
    rows: list[dict[str, Any]] = []
    page_ids: list[int] = []
    for feature in features:
        attributes = (
            feature.get("attributes")
            if isinstance(feature, dict)
            else None
        )
        if not isinstance(attributes, dict):
            raise ArcGisAcquisitionError(
                f"{source_id} returned a feature without attributes."
            )
        object_id = attributes.get(object_id_field)
        if not isinstance(object_id, int):
            raise ArcGisAcquisitionError(
                f"{source_id} returned a non-integer object ID."
            )
        if object_id in seen_object_ids or object_id in page_ids:
            raise ArcGisAcquisitionError(
                f"{source_id} returned duplicate object ID {object_id}."
            )
        page_ids.append(object_id)
        rows.append(attributes)
    if page_ids != sorted(page_ids):
        raise ArcGisAcquisitionError(
            f"{source_id} page is not ordered by object ID."
        )
    seen_object_ids.update(page_ids)
    return rows


def _validate_object_id_inventory(
    source_id: str,
    payload: dict[str, Any],
    object_id_field: str,
    expected_count: int,
) -> list[int]:
    inventory_field = payload.get("objectIdFieldName")
    if (
        isinstance(inventory_field, str)
        and inventory_field.lower() != object_id_field.lower()
    ):
        raise ArcGisAcquisitionError(
            f"{source_id} object-ID field changed from "
            f"{object_id_field} to {inventory_field}."
        )
    object_ids = payload.get("objectIds")
    if not isinstance(object_ids, list):
        raise ArcGisAcquisitionError(
            f"{source_id} returned no object-ID inventory."
        )
    if any(not isinstance(object_id, int) for object_id in object_ids):
        raise ArcGisAcquisitionError(
            f"{source_id} returned a non-integer object ID."
        )
    if len(set(object_ids)) != len(object_ids):
        raise ArcGisAcquisitionError(
            f"{source_id} returned duplicate object IDs."
        )
    if len(object_ids) != expected_count:
        raise ArcGisAcquisitionError(
            f"{source_id} object-ID inventory has {len(object_ids)} IDs; "
            f"expected {expected_count}."
        )
    return sorted(object_ids)


def _object_id_inventory_sha256(object_ids: list[int]) -> str:
    return hashlib.sha256(
        ",".join(str(object_id) for object_id in object_ids).encode("ascii")
    ).hexdigest()


def _snapshot_guard(
    *,
    metadata: dict[str, Any],
    headers: dict[str, str],
    object_id_field: str,
    fields: list[dict[str, Any]],
    row_count: int,
    object_ids: list[int],
) -> dict[str, Any]:
    return {
        "object_id_field": object_id_field,
        "row_count": row_count,
        "object_id_inventory_sha256": _object_id_inventory_sha256(
            object_ids
        ),
        "schema_fingerprint": schema_fingerprint(fields),
        "service_last_edit_ms": (
            metadata.get("editingInfo") or {}
        ).get("lastEditDate"),
        "etag": headers.get("etag"),
        "last_modified": headers.get("last-modified"),
    }


def _assert_snapshot_unchanged(
    source_id: str,
    before: dict[str, Any],
    after: dict[str, Any],
) -> None:
    volatile_headers = {"etag", "last_modified"}
    changed = sorted(
        key
        for key in before
        if key not in volatile_headers and before.get(key) != after.get(key)
    )
    if changed:
        detail = ", ".join(changed)
        raise ArcGisAcquisitionError(
            f"{source_id} changed during paged acquisition ({detail}); "
            "the partial snapshot was discarded."
        )


def _fetch_exact_object_id_batch(
    source_id: str,
    query_url: str,
    fields: tuple[str, ...],
    object_id_field: str,
    requested_ids: list[int],
    *,
    request_json: Callable[
        [str, dict[str, str]],
        tuple[dict[str, Any], dict[str, str]],
    ] = _request_json,
) -> list[dict[str, Any]]:
    if not requested_ids:
        return []
    try:
        page, _ = request_json(
            query_url,
            {
                "f": "json",
                "objectIds": ",".join(
                    str(object_id) for object_id in requested_ids
                ),
                "outFields": ",".join(fields),
                "returnGeometry": "false",
                "orderByFields": f"{object_id_field} ASC",
            },
        )
        rows = _validate_page(
            source_id,
            page.get("features"),
            object_id_field,
            set(),
        )
        returned_ids = [row[object_id_field] for row in rows]
        if returned_ids == requested_ids:
            return rows
    except ArcGisAcquisitionError as error:
        if len(requested_ids) == 1:
            raise ArcGisAcquisitionError(
                f"{source_id} could not retrieve object ID "
                f"{requested_ids[0]}: {error}"
            ) from error

    if len(requested_ids) == 1:
        raise ArcGisAcquisitionError(
            f"{source_id} could not retrieve object ID "
            f"{requested_ids[0]}."
        )
    midpoint = len(requested_ids) // 2
    return [
        *_fetch_exact_object_id_batch(
            source_id,
            query_url,
            fields,
            object_id_field,
            requested_ids[:midpoint],
            request_json=request_json,
        ),
        *_fetch_exact_object_id_batch(
            source_id,
            query_url,
            fields,
            object_id_field,
            requested_ids[midpoint:],
            request_json=request_json,
        ),
    ]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def acquire_source(
    source: ArcGisSource,
    output_directory: Path,
) -> dict[str, Any]:
    output_directory.mkdir(parents=True, exist_ok=True)
    data_path = output_directory / f"{source.source_id}.jsonl.gz"
    manifest_path = output_directory / f"{source.source_id}.manifest.json"
    partial_data = data_path.with_suffix(data_path.suffix + ".partial")
    partial_manifest = manifest_path.with_suffix(
        manifest_path.suffix + ".partial"
    )
    if data_path.exists() or manifest_path.exists():
        raise ArcGisAcquisitionError(
            f"Refusing to overwrite existing acquisition for "
            f"{source.source_id}."
        )

    metadata, metadata_headers = _request_json(
        f"{source.layer_url}?f=json"
    )
    object_id_field, page_size, fields = _validate_metadata(
        source, metadata
    )
    count_payload, _ = _request_json(
        f"{source.layer_url}/query",
        {
            "f": "json",
            "where": "1=1",
            "returnCountOnly": "true",
        },
    )
    expected_count = count_payload.get("count")
    if not isinstance(expected_count, int) or expected_count < 0:
        raise ArcGisAcquisitionError(
            f"{source.source_id} returned an invalid record count."
        )
    if expected_count < source.expected_min_rows:
        raise ArcGisAcquisitionError(
            f"{source.source_id} count {expected_count} is below the "
            f"registered minimum {source.expected_min_rows}."
        )
    inventory_payload, _ = _request_json(
        f"{source.layer_url}/query",
        {
            "f": "json",
            "where": "1=1",
            "returnIdsOnly": "true",
        },
    )
    object_ids = _validate_object_id_inventory(
        source.source_id,
        inventory_payload,
        object_id_field,
        expected_count,
    )
    inventory_digest = _object_id_inventory_sha256(object_ids)

    retrieval_started_at = utc_timestamp()
    initial_guard = _snapshot_guard(
        metadata=metadata,
        headers=metadata_headers,
        object_id_field=object_id_field,
        fields=fields,
        row_count=expected_count,
        object_ids=object_ids,
    )
    seen_object_ids: set[int] = set()
    row_digest = hashlib.sha256()
    row_count = 0
    try:
        with partial_data.open("xb") as raw_handle:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=raw_handle,
                compresslevel=6,
                mtime=0,
            ) as gzip_handle:
                for start in range(0, expected_count, page_size):
                    requested_ids = object_ids[start : start + page_size]
                    rows = _fetch_exact_object_id_batch(
                        source.source_id,
                        f"{source.layer_url}/query",
                        source.fields,
                        object_id_field,
                        requested_ids,
                    )
                    duplicates = seen_object_ids.intersection(
                        row[object_id_field] for row in rows
                    )
                    if duplicates:
                        raise ArcGisAcquisitionError(
                            f"{source.source_id} returned duplicate object "
                            f"IDs across batches: {sorted(duplicates)[:5]}."
                        )
                    seen_object_ids.update(
                        row[object_id_field] for row in rows
                    )
                    for row in rows:
                        line = (
                            json.dumps(
                                row,
                                ensure_ascii=False,
                                sort_keys=True,
                                separators=(",", ":"),
                            ).encode("utf-8")
                            + b"\n"
                        )
                        row_digest.update(line)
                        gzip_handle.write(line)
                    row_count += len(rows)

        if row_count != expected_count:
            raise ArcGisAcquisitionError(
                f"{source.source_id} acquired {row_count} rows; "
                f"expected {expected_count}."
            )
        final_metadata, final_metadata_headers = _request_json(
            f"{source.layer_url}?f=json"
        )
        (
            final_object_id_field,
            _final_page_size,
            final_fields,
        ) = _validate_metadata(source, final_metadata)
        final_count_payload, _ = _request_json(
            f"{source.layer_url}/query",
            {
                "f": "json",
                "where": "1=1",
                "returnCountOnly": "true",
            },
        )
        final_count = final_count_payload.get("count")
        if not isinstance(final_count, int) or final_count < 0:
            raise ArcGisAcquisitionError(
                f"{source.source_id} returned an invalid final record count."
            )
        final_inventory_payload, _ = _request_json(
            f"{source.layer_url}/query",
            {
                "f": "json",
                "where": "1=1",
                "returnIdsOnly": "true",
            },
        )
        final_object_ids = _validate_object_id_inventory(
            source.source_id,
            final_inventory_payload,
            final_object_id_field,
            final_count,
        )
        final_guard = _snapshot_guard(
            metadata=final_metadata,
            headers=final_metadata_headers,
            object_id_field=final_object_id_field,
            fields=final_fields,
            row_count=final_count,
            object_ids=final_object_ids,
        )
        _assert_snapshot_unchanged(
            source.source_id,
            initial_guard,
            final_guard,
        )
        retrieval_completed_at = utc_timestamp()
        manifest = {
            "manifest_kind": "dc-property-arcgis-source",
            "manifest_version": 1,
            "status": "complete",
            "retrieved_at": retrieval_completed_at,
            "retrieval_started_at": retrieval_started_at,
            "retrieval_completed_at": retrieval_completed_at,
            "source": asdict(source),
            "arcgis": {
                "service_name": metadata.get("name"),
                "object_id_field": object_id_field,
                "max_record_count": metadata.get("maxRecordCount"),
                "service_last_edit_ms": (
                    metadata.get("editingInfo") or {}
                ).get("lastEditDate"),
                "etag": metadata_headers.get("etag"),
                "last_modified": metadata_headers.get("last-modified"),
                "schema_fingerprint": schema_fingerprint(fields),
                "pagination_strategy": "object_id_inventory",
                "object_id_inventory_sha256": inventory_digest,
                "fields": fields,
                "consistency_validation": {
                    "strategy": (
                        "metadata_schema_count_and_object_id_inventory_"
                        "revalidated_after_paged_download"
                    ),
                    "before": initial_guard,
                    "after": final_guard,
                    "passed": True,
                },
            },
            "artifact": {
                "file": data_path.name,
                "rows": row_count,
                "bytes": partial_data.stat().st_size,
                "gzip_sha256": _sha256(partial_data),
                "canonical_rows_sha256": row_digest.hexdigest(),
            },
        }
        with partial_manifest.open("x", encoding="utf-8") as handle:
            json.dump(
                manifest,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
        partial_data.replace(data_path)
        partial_manifest.replace(manifest_path)
        return manifest
    except BaseException:
        partial_data.unlink(missing_ok=True)
        partial_manifest.unlink(missing_ok=True)
        raise
