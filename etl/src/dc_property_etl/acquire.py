from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from .arcgis import acquire_source
from .source_registry import SOURCE_BY_ID, SOURCES, sources_for_family


PROJECT = Path(__file__).resolve().parents[3]


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Acquire registered official DC ArcGIS sources into immutable "
            "gzip JSONL files with integrity manifests."
        )
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--source", action="append")
    selection.add_argument("--family")
    parser.add_argument("--run-id", default=_run_id())
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=PROJECT / "data" / "regulatory" / "raw",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    if (
        not arguments.run_id
        or any(
            character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            "abcdefghijklmnopqrstuvwxyz0123456789_-"
            for character in arguments.run_id
        )
    ):
        raise SystemExit(
            "--run-id may contain only letters, digits, underscore, and hyphen."
        )
    if not 1 <= arguments.workers <= 8:
        raise SystemExit("--workers must be between 1 and 8.")

    if arguments.source:
        unknown = sorted(set(arguments.source).difference(SOURCE_BY_ID))
        if unknown:
            raise SystemExit(f"Unknown source IDs: {unknown}")
        selected = tuple(
            SOURCE_BY_ID[source_id]
            for source_id in arguments.source
        )
    elif arguments.family:
        selected = sources_for_family(arguments.family)
        if not selected:
            raise SystemExit(
                f"No registered sources for family {arguments.family!r}."
            )
    else:
        selected = SOURCES

    run_directory = (
        arguments.output_root.resolve() / arguments.run_id
    )
    if run_directory.exists():
        raise SystemExit(
            f"Refusing to reuse acquisition run directory: {run_directory}"
        )
    run_directory.mkdir(parents=True)

    manifests: list[dict[str, object]] = []
    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=arguments.workers) as executor:
        future_by_source = {
            executor.submit(
                acquire_source, source, run_directory
            ): source
            for source in selected
        }
        for future in as_completed(future_by_source):
            source = future_by_source[future]
            try:
                manifest = future.result()
                manifests.append(manifest)
                print(
                    json.dumps(
                        {
                            "source_id": source.source_id,
                            "rows": manifest["artifact"]["rows"],
                            "status": "complete",
                        },
                        sort_keys=True,
                    ),
                    flush=True,
                )
            except Exception as error:
                failures.append(
                    {
                        "source_id": source.source_id,
                        "error": str(error),
                    }
                )

    run_manifest = {
        "manifest_kind": "dc-property-arcgis-run",
        "manifest_version": 1,
        "run_id": arguments.run_id,
        "completed_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "status": "complete" if not failures else "failed",
        "source_count": len(selected),
        "completed_source_count": len(manifests),
        "failed_source_count": len(failures),
        "total_rows": sum(
            int(manifest["artifact"]["rows"])
            for manifest in manifests
        ),
        "sources": sorted(
            (
                {
                    "source_id": manifest["source"]["source_id"],
                    "family": manifest["source"]["family"],
                    "rows": manifest["artifact"]["rows"],
                    "gzip_sha256": manifest["artifact"]["gzip_sha256"],
                    "schema_fingerprint": (
                        manifest["arcgis"]["schema_fingerprint"]
                    ),
                }
                for manifest in manifests
            ),
            key=lambda item: item["source_id"],
        ),
        "failures": sorted(
            failures, key=lambda item: item["source_id"]
        ),
    }
    manifest_path = run_directory / "run.manifest.json"
    with manifest_path.open("x", encoding="utf-8") as handle:
        json.dump(
            run_manifest,
            handle,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        handle.write("\n")
    if failures:
        raise SystemExit(
            f"{len(failures)} source acquisitions failed; see "
            f"{manifest_path}."
        )


if __name__ == "__main__":
    main()
