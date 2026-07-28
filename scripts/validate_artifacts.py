#!/usr/bin/env python3
from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
GENERATED = PROJECT / "data" / "generated"
REPORT = PROJECT / "db" / "reports" / "generated" / "artifact_validation.json"

EXPECTED = {
    "property_account_current.csv.gz": 221_263,
    "tax_series.csv.gz": 221_263,
    "sale_series.csv.gz": 215_408,
}
EXPECTED_LINKED_SALE_ROWS = 421_436
EXPECTED_UNLINKED_SALE_ROWS = 9
ACTIVE_ASSESSMENT_YEARS = {
    "prior": 2025,
    "current": 2026,
    "proposed": 2027,
}
CURRENT_ASSESSMENT_COLUMNS = [
    f"{stage}_{value_part}_value"
    for stage in ACTIVE_ASSESSMENT_YEARS
    for value_part in ("land", "improvement", "total")
]


def validate_current(path: Path) -> dict[str, object]:
    rows = 0
    blank_ssl = 0
    duplicate_ssl = 0
    seen: set[str] = set()
    incomplete_assessment_rows = 0
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {
            "account_id",
            "source_id",
            "ssl_normalized",
            *CURRENT_ASSESSMENT_COLUMNS,
        }
        missing = sorted(required.difference(reader.fieldnames or []))
        if missing:
            raise ValueError(f"Current artifact is missing columns: {missing}")
        for rows, row in enumerate(reader, start=1):
            if int(row["account_id"]) != rows:
                raise ValueError(f"Non-sequential current account_id at data row {rows}")
            if row["source_id"] != "itspe_current":
                raise ValueError(
                    f"Unexpected current source_id at data row {rows}: "
                    f"{row['source_id']!r}"
                )
            ssl = row["ssl_normalized"]
            blank_ssl += not bool(ssl)
            if ssl in seen:
                duplicate_ssl += 1
            seen.add(ssl)
            incomplete_assessment_rows += any(
                not row[column] for column in CURRENT_ASSESSMENT_COLUMNS
            )
    if incomplete_assessment_rows:
        raise ValueError(
            f"Current artifact has {incomplete_assessment_rows:,} row(s) missing "
            "prior/current/proposed assessment values."
        )
    return {
        "rows": rows,
        "blank_ssl_rows": blank_ssl,
        "duplicate_ssl_rows": duplicate_ssl,
        "assessment_years": ACTIVE_ASSESSMENT_YEARS,
        "assessment_stage_complete_rows": rows,
        "sequential_account_ids": True,
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


def validate_sales(path: Path) -> dict[str, object]:
    rows = 0
    previous_account_id = 0
    source_rows = 0
    array_columns = [
        "source_objectids", "sale_dates", "sale_prices", "qualified_codes",
        "sale_codes", "current_owner_flags",
    ]
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for rows, row in enumerate(csv.DictReader(handle), start=1):
            account_id = int(row["account_id"])
            if not (
                previous_account_id
                < account_id
                <= EXPECTED["property_account_current.csv.gz"]
            ):
                raise ValueError(
                    f"Sale account IDs are not strictly ordered at data row {rows}"
                )
            previous_account_id = account_id
            cardinalities = []
            for column in array_columns:
                value = row[column]
                if not (value.startswith("{") and value.endswith("}")):
                    raise ValueError(f"Malformed sale array in {column}, row {rows}")
                cardinalities.append(0 if value == "{}" else value.count(",") + 1)
            if len(set(cardinalities)) != 1 or cardinalities[0] == 0:
                raise ValueError(f"Unequal sale vector cardinalities at row {rows}")
            source_rows += cardinalities[0]
    if source_rows != EXPECTED_LINKED_SALE_ROWS:
        raise ValueError(
            f"Expected {EXPECTED_LINKED_SALE_ROWS:,} linked CAMA rows, "
            f"found {source_rows:,}"
        )
    return {
        "rows": rows,
        "strictly_ordered_unique_account_ids": True,
        "linked_source_rows": source_rows,
        "all_vector_cardinalities_equal": True,
        "unlinked_source_rows": EXPECTED_UNLINKED_SALE_ROWS,
    }


def main() -> None:
    validators = {
        "property_account_current.csv.gz": validate_current,
        "tax_series.csv.gz": validate_tax,
        "sale_series.csv.gz": validate_sales,
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
