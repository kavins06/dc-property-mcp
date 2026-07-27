#!/usr/bin/env python3
from __future__ import annotations

import csv
import gzip
import json
from collections import Counter
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
GENERATED = PROJECT / "data" / "generated"
REPORT = PROJECT / "db" / "reports" / "generated" / "artifact_validation.json"

EXPECTED = {
    "property_account_current.csv.gz": 221_263,
    "assessment_snapshot_record.csv.gz": 652_131,
    "tax_series.csv.gz": 221_263,
}


def validate_current(path: Path) -> dict[str, object]:
    rows = 0
    blank_ssl = 0
    duplicate_ssl = 0
    seen: set[str] = set()
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for rows, row in enumerate(csv.DictReader(handle), start=1):
            if int(row["account_id"]) != rows:
                raise ValueError(f"Non-sequential current account_id at data row {rows}")
            ssl = row["ssl_normalized"]
            blank_ssl += not bool(ssl)
            if ssl in seen:
                duplicate_ssl += 1
            seen.add(ssl)
    return {
        "rows": rows,
        "blank_ssl_rows": blank_ssl,
        "duplicate_ssl_rows": duplicate_ssl,
        "sequential_account_ids": True,
    }


def validate_assessments(path: Path) -> dict[str, object]:
    rows = 0
    linked = 0
    unlinked_by_source: Counter[str] = Counter()
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for rows, row in enumerate(csv.DictReader(handle), start=1):
            if int(row["assessment_record_id"]) != rows:
                raise ValueError(f"Non-sequential assessment_record_id at data row {rows}")
            account_id = row["account_id"]
            if account_id:
                numeric_id = int(account_id)
                if not 1 <= numeric_id <= EXPECTED["property_account_current.csv.gz"]:
                    raise ValueError(f"Out-of-range assessment account_id {numeric_id}")
                linked += 1
            else:
                unlinked_by_source[row["source_id"]] += 1
    return {
        "rows": rows,
        "linked_to_current_account": linked,
        "unlinked_by_source": dict(sorted(unlinked_by_source.items())),
        "sequential_assessment_record_ids": True,
    }


def validate_tax(path: Path) -> dict[str, object]:
    rows = 0
    array_columns = [
        "slot_codes", "tax_years", "tax_sale_flags", "tax_cents", "penalty_cents",
        "interest_cents", "fee_cents", "total_due_cents", "collected_cents",
        "balance_cents", "credit_cents",
    ]
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for rows, row in enumerate(csv.DictReader(handle), start=1):
            if int(row["account_id"]) != rows:
                raise ValueError(f"Non-sequential tax account_id at data row {rows}")
            for column in array_columns:
                value = row[column]
                # Source values contain no commas, so a twelve-slot PG array has 11 separators.
                if not (value.startswith("{") and value.endswith("}") and value.count(",") == 11):
                    raise ValueError(f"Malformed twelve-slot array in {column}, row {rows}")
    return {
        "rows": rows,
        "sequential_account_ids": True,
        "all_array_cardinalities": 12,
    }


def main() -> None:
    validators = {
        "property_account_current.csv.gz": validate_current,
        "assessment_snapshot_record.csv.gz": validate_assessments,
        "tax_series.csv.gz": validate_tax,
    }
    results: dict[str, object] = {}
    for filename, expected_rows in EXPECTED.items():
        path = GENERATED / filename
        if not path.is_file() or path.stat().st_size == 0:
            raise FileNotFoundError(f"Missing or empty artifact: {path}")
        result = validators[filename](path)
        if result["rows"] != expected_rows:
            raise ValueError(
                f"{filename}: expected {expected_rows:,} rows, got {result['rows']:,}"
            )
        result["gzip_crc_read_succeeded"] = True
        results[filename] = result

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
