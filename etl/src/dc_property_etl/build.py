#!/usr/bin/env python3
from __future__ import annotations

import csv
import gzip
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from transform import (
    display_ssl,
    iso_date,
    money_to_cents,
    normalize_address,
    normalize_ssl,
    pg_array,
    whole_dollars,
)


PROJECT = Path(__file__).resolve().parents[3]
WORKSPACE = PROJECT.parent
GENERATED = PROJECT / "data" / "generated"
MANIFEST_DIR = PROJECT / "data" / "manifests"
REPORT_DIR = PROJECT / "db" / "reports" / "generated"

SOURCES = [
    {
        "source_id": "itspe_2017_archive",
        "path": WORKSPACE / "assessment_history_raw" / "ITSPE_snapshot_2017-02-16.csv",
        "archive_capture_at": "2017-02-16T21:19:48Z",
        "retrieved_at": None,
        "source_url": (
            "https://web.archive.org/web/20170216211948id_/"
            "http://opendata.dc.gov/datasets/496533836db640bcade61dd9078b0d63_53.csv"
        ),
        "years": {"prior": 2016, "current": 2017, "proposed": 2018},
    },
    {
        "source_id": "itspe_2021_archive",
        "path": WORKSPACE / "assessment_history_raw" / "ITSPE_snapshot_2021-11-26.csv",
        "archive_capture_at": "2021-11-26T11:42:11Z",
        "retrieved_at": None,
        "source_url": (
            "https://web.archive.org/web/20211126114211id_/"
            "https://opendata.dc.gov/datasets/496533836db640bcade61dd9078b0d63_53.csv"
        ),
        "years": {"prior": 2020, "current": 2021, "proposed": 2022},
    },
    {
        "source_id": "itspe_current",
        "path": WORKSPACE / "ITSPE.csv",
        "archive_capture_at": None,
        "retrieved_at": "2026-07-26T17:50:23-04:00",
        "source_url": (
            "https://opendata.dc.gov/api/download/v1/items/"
            "1476813cbc2d458394ce586ce06d3edd/csv?layers=53"
        ),
        "years": {"prior": 2025, "current": 2026, "proposed": 2027},
    },
]

CURRENT_FIELDS = [
    "INTERNALID", "OBJECTID", "SSL", "SQUARE", "SUFFIX", "LOT", "PRESSL",
    "PIPARENTLOT", "PCHILDCODE", "ABTLOTCODE", "ARN", "ASRNAME", "PROPTYPE",
    "TRIGROUP", "USECODE", "LANDAREA", "PREMISEADD", "LOWNUMBER", "STREETNAME",
    "QDRNTNAME", "UNITNUMBER", "PRMS_WARD", "NBHD", "NBHDNAME", "SUBNBHD",
    "OWNERNAME", "OWNNAME2", "CAREOFNAME", "ADDRESS1", "ADDRESS2", "CITYSTZIP",
    "OWNOCCT", "MORTGAGECO", "DELCODE", "HSTDCODE", "CLASSTYPE", "TAXRATE",
    "MIXEDUSE", "MIX1TXTYPE", "MIX1CLASS", "MIX1RATE", "MIX1LNDPCT",
    "MIX1LNDVAL", "MIX1BLDPCT", "MIX1BLDVAL", "MIX2TXTYPE", "MIX2CLASS",
    "MIX2RATE", "MIX2LNDPCT", "MIX2LNDVAL", "MIX2BLDPCT", "MIX2BLDVAL",
    "COOPUNITS", "OLDLAND", "OLDIMPR", "OLDTOTAL", "PHASELAND", "PHASEBUILD",
    "ASSESSMENT", "NEWLAND", "NEWIMPR", "NEWTOTAL", "CAPPROP", "CAPCURR",
    "SALEPRICE", "SALEDATE", "ACCEPTCODE", "SALETYPE", "DEEDDATE", "INST_NO",
    "ANNUALTAX", "DUEDATE1", "AMTDUE1", "DUEDATE2", "AMTDUE2", "DUEDATE3",
    "AMTDUE3", "TOTDUEAMT", "TOTCOLAMT", "TOTBALAMT", "LASTPAYDT",
    "BIDNAME", "BIDTOTALDUE", "BIDCOLLECTED", "BIDBALANCE", "SEWSTOTALDUE",
    "SEWSCOLLECTED", "SEWSBALANCE", "PACETOTALDUE", "PACECOLLECTED",
    "PACEBALANCE", "SWWSADTOTALDUE", "SWWSADCOLLECTED", "SWWSADBALANCE",
    "EXTRACTDAT",
]

ASSESSMENT_FIELDS = {
    "prior": ("OLDLAND", "OLDIMPR", "OLDTOTAL"),
    "current": ("PHASELAND", "PHASEBUILD", "ASSESSMENT"),
    "proposed": ("NEWLAND", "NEWIMPR", "NEWTOTAL"),
}

TAX_SLOTS = ["CY1", "CY2"] + [f"PY{i}" for i in range(1, 11)]
TAX_SUFFIXES = ["YEAR", "TXSALE", "TAX", "PEN", "INT", "FEE", "TOTDUE", "COLL", "BAL", "CR"]

WHOLE_DOLLAR_FIELDS = {
    "LANDAREA", "OLDLAND", "OLDIMPR", "OLDTOTAL", "PHASELAND", "PHASEBUILD",
    "ASSESSMENT", "NEWLAND", "NEWIMPR", "NEWTOTAL", "MIX1LNDVAL", "MIX1BLDVAL",
    "MIX2LNDVAL", "MIX2BLDVAL", "SALEPRICE",
}
MONEY_FIELDS = {
    "ANNUALTAX", "AMTDUE1", "AMTDUE2", "AMTDUE3", "TOTDUEAMT", "TOTCOLAMT",
    "TOTBALAMT", "BIDTOTALDUE", "BIDCOLLECTED", "BIDBALANCE", "SEWSTOTALDUE",
    "SEWSCOLLECTED", "SEWSBALANCE", "PACETOTALDUE", "PACECOLLECTED",
    "PACEBALANCE", "SWWSADTOTALDUE", "SWWSADCOLLECTED", "SWWSADBALANCE",
}
DATE_FIELDS = {"SALEDATE", "DEEDDATE", "DUEDATE1", "DUEDATE2", "DUEDATE3", "LASTPAYDT", "EXTRACTDAT"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_profile(source: dict[str, object]) -> dict[str, object]:
    path = Path(source["path"])
    rows = 0
    blank_ssl = 0
    ssl_counts: Counter[str] = Counter()
    extract_dates: list[str] = []
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        for row in reader:
            rows += 1
            ssl = (row.get("SSL") or "").strip()
            if ssl:
                ssl_counts[ssl] += 1
            else:
                blank_ssl += 1
            extract_date = iso_date(row.get("EXTRACTDAT"))
            if extract_date:
                extract_dates.append(extract_date)
    return {
        "source_id": source["source_id"],
        "file": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "rows": rows,
        "columns": len(fields),
        "blank_ssl_rows": blank_ssl,
        "duplicate_ssl_keys": sum(1 for count in ssl_counts.values() if count > 1),
        "extract_date_min": min(extract_dates) if extract_dates else None,
        "extract_date_max": max(extract_dates) if extract_dates else None,
        "distinct_extract_dates": len(set(extract_dates)),
        "archive_capture_at": source["archive_capture_at"],
        "retrieved_at": source["retrieved_at"],
        "source_url": source["source_url"],
    }


def convert_current(field: str, value: str | None) -> str:
    if field in WHOLE_DOLLAR_FIELDS:
        return whole_dollars(value)
    if field in MONEY_FIELDS:
        return money_to_cents(value)
    if field in DATE_FIELDS:
        return iso_date(value)
    return (value or "").strip()


def build_current() -> dict[str, object]:
    source = SOURCES[-1]
    path = Path(source["path"])
    output = GENERATED / "property_account_current.csv.gz"
    output_fields = [
        "account_id", "source_id", "source_row_number", "raw_objectid",
        "raw_internalid", "ssl_raw", "ssl_normalized", "ssl_display", "square",
        "suffix", "lot", "predecessor_ssl", "parent_lot", "is_deleted",
        "premise_address", "address_normalized", "unit_number", "ward",
        "neighborhood_code", "neighborhood_name", "sub_neighborhood",
        "property_type", "tri_group", "use_code", "tax_class", "tax_rate",
        "land_area", "owner_name", "owner_name_2", "care_of_name",
        "mailing_address_1", "mailing_address_2", "mailing_city_state_zip",
        "owner_occupancy_flag", "mortgage_company_source_label",
        "homestead_code", "mixed_use_flag", "cooperative_units",
        "prior_land_value", "prior_improvement_value", "prior_total_value",
        "current_land_value", "current_improvement_value", "current_total_value",
        "proposed_land_value", "proposed_improvement_value", "proposed_total_value",
        "cap_current_value", "cap_proposed_value", "annual_tax_cents",
        "total_due_cents", "total_collected_cents", "total_balance_cents",
        "last_payment_date", "bid_name", "bid_total_due_cents",
        "bid_collected_cents", "bid_balance_cents", "sews_total_due_cents",
        "sews_collected_cents", "sews_balance_cents", "pace_total_due_cents",
        "pace_collected_cents", "pace_balance_cents", "swwsad_total_due_cents",
        "swwsad_collected_cents", "swwsad_balance_cents",
        "latest_sale_price_dollars", "latest_sale_date", "latest_sale_type",
        "latest_sale_acceptance_code", "latest_deed_date",
        "latest_instrument_number", "record_extract_at",
    ]
    rows = 0
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as in_handle, gzip.open(
        output, "wt", encoding="utf-8", newline="", compresslevel=6
    ) as out_handle:
        reader = csv.DictReader(in_handle)
        missing = [field for field in CURRENT_FIELDS if field not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"Current source is missing fields: {missing}")
        writer = csv.DictWriter(out_handle, fieldnames=output_fields)
        writer.writeheader()
        for source_row, row in enumerate(reader, start=2):
            out = {
                "account_id": source_row - 1,
                "source_id": source["source_id"],
                "source_row_number": source_row,
                "raw_objectid": (row.get("OBJECTID") or "").strip(),
                "raw_internalid": (row.get("INTERNALID") or "").strip(),
                "ssl_raw": (row.get("SSL") or "").strip(),
                "ssl_normalized": normalize_ssl(row.get("SSL")),
                "ssl_display": display_ssl(row.get("SSL")),
                "square": (row.get("SQUARE") or "").strip(),
                "suffix": (row.get("SUFFIX") or "").strip(),
                "lot": (row.get("LOT") or "").strip(),
                "predecessor_ssl": (row.get("PRESSL") or "").strip(),
                "parent_lot": (row.get("PIPARENTLOT") or "").strip(),
                "is_deleted": "true" if (row.get("DELCODE") or "").strip() == "Y" else "false",
                "premise_address": (row.get("PREMISEADD") or "").strip(),
                "address_normalized": normalize_address(row.get("PREMISEADD")),
                "unit_number": (row.get("UNITNUMBER") or "").strip(),
                "ward": (row.get("PRMS_WARD") or "").strip(),
                "neighborhood_code": (row.get("NBHD") or "").strip(),
                "neighborhood_name": (row.get("NBHDNAME") or "").strip(),
                "sub_neighborhood": (row.get("SUBNBHD") or "").strip(),
                "property_type": (row.get("PROPTYPE") or "").strip(),
                "tri_group": (row.get("TRIGROUP") or "").strip(),
                "use_code": (row.get("USECODE") or "").strip(),
                "tax_class": (row.get("CLASSTYPE") or "").strip(),
                "tax_rate": (row.get("TAXRATE") or "").strip(),
                "land_area": whole_dollars(row.get("LANDAREA")),
                "owner_name": (row.get("OWNERNAME") or "").strip(),
                "owner_name_2": (row.get("OWNNAME2") or "").strip(),
                "care_of_name": (row.get("CAREOFNAME") or "").strip(),
                "mailing_address_1": (row.get("ADDRESS1") or "").strip(),
                "mailing_address_2": (row.get("ADDRESS2") or "").strip(),
                "mailing_city_state_zip": (row.get("CITYSTZIP") or "").strip(),
                "owner_occupancy_flag": (row.get("OWNOCCT") or "").strip(),
                "mortgage_company_source_label": (row.get("MORTGAGECO") or "").strip(),
                "homestead_code": (row.get("HSTDCODE") or "").strip(),
                "mixed_use_flag": (row.get("MIXEDUSE") or "").strip(),
                "cooperative_units": (row.get("COOPUNITS") or "").strip(),
                "prior_land_value": whole_dollars(row.get("OLDLAND")),
                "prior_improvement_value": whole_dollars(row.get("OLDIMPR")),
                "prior_total_value": whole_dollars(row.get("OLDTOTAL")),
                "current_land_value": whole_dollars(row.get("PHASELAND")),
                "current_improvement_value": whole_dollars(row.get("PHASEBUILD")),
                "current_total_value": whole_dollars(row.get("ASSESSMENT")),
                "proposed_land_value": whole_dollars(row.get("NEWLAND")),
                "proposed_improvement_value": whole_dollars(row.get("NEWIMPR")),
                "proposed_total_value": whole_dollars(row.get("NEWTOTAL")),
                "cap_current_value": whole_dollars(row.get("CAPCURR")),
                "cap_proposed_value": whole_dollars(row.get("CAPPROP")),
                "annual_tax_cents": money_to_cents(row.get("ANNUALTAX")),
                "total_due_cents": money_to_cents(row.get("TOTDUEAMT")),
                "total_collected_cents": money_to_cents(row.get("TOTCOLAMT")),
                "total_balance_cents": money_to_cents(row.get("TOTBALAMT")),
                "last_payment_date": iso_date(row.get("LASTPAYDT")),
                "bid_name": (row.get("BIDNAME") or "").strip(),
                "bid_total_due_cents": money_to_cents(row.get("BIDTOTALDUE")),
                "bid_collected_cents": money_to_cents(row.get("BIDCOLLECTED")),
                "bid_balance_cents": money_to_cents(row.get("BIDBALANCE")),
                "sews_total_due_cents": money_to_cents(row.get("SEWSTOTALDUE")),
                "sews_collected_cents": money_to_cents(row.get("SEWSCOLLECTED")),
                "sews_balance_cents": money_to_cents(row.get("SEWSBALANCE")),
                "pace_total_due_cents": money_to_cents(row.get("PACETOTALDUE")),
                "pace_collected_cents": money_to_cents(row.get("PACECOLLECTED")),
                "pace_balance_cents": money_to_cents(row.get("PACEBALANCE")),
                "swwsad_total_due_cents": money_to_cents(row.get("SWWSADTOTALDUE")),
                "swwsad_collected_cents": money_to_cents(row.get("SWWSADCOLLECTED")),
                "swwsad_balance_cents": money_to_cents(row.get("SWWSADBALANCE")),
                "latest_sale_price_dollars": whole_dollars(row.get("SALEPRICE")),
                "latest_sale_date": iso_date(row.get("SALEDATE")),
                "latest_sale_type": (row.get("SALETYPE") or "").strip(),
                "latest_sale_acceptance_code": (row.get("ACCEPTCODE") or "").strip(),
                "latest_deed_date": iso_date(row.get("DEEDDATE")),
                "latest_instrument_number": (row.get("INST_NO") or "").strip(),
                "record_extract_at": iso_date(row.get("EXTRACTDAT")),
            }
            writer.writerow(out)
            rows += 1
    return artifact(output, rows)


def build_assessments() -> dict[str, object]:
    output = GENERATED / "assessment_snapshot_record.csv.gz"
    fields = [
        "assessment_record_id", "source_id", "source_row_number", "account_id",
        "ssl_raw", "ssl_normalized",
        "source_internalid", "source_objectid", "source_globalid",
        "record_extract_at", "archive_capture_at", "dataset_retrieved_at",
    ]
    for stage in ("prior", "current", "proposed"):
        fields.extend(
            [
                f"{stage}_tax_year", f"{stage}_land_value",
                f"{stage}_improvement_value", f"{stage}_total_value",
            ]
        )
    rows = 0
    current_account_by_ssl: dict[str, int] = {}
    with Path(SOURCES[-1]["path"]).open(
        "r", encoding="utf-8-sig", errors="replace", newline=""
    ) as current_handle:
        for source_row, row in enumerate(csv.DictReader(current_handle), start=2):
            current_account_by_ssl[normalize_ssl(row.get("SSL"))] = source_row - 1
    with gzip.open(output, "wt", encoding="utf-8", newline="", compresslevel=6) as out_handle:
        writer = csv.DictWriter(out_handle, fieldnames=fields)
        writer.writeheader()
        for source in SOURCES:
            path = Path(source["path"])
            source_ssl_counts: Counter[str] = Counter()
            with path.open(
                "r", encoding="utf-8-sig", errors="replace", newline=""
            ) as count_handle:
                for count_row in csv.DictReader(count_handle):
                    source_ssl_counts[normalize_ssl(count_row.get("SSL"))] += 1
            with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as in_handle:
                reader = csv.DictReader(in_handle)
                for source_row, row in enumerate(reader, start=2):
                    normalized_ssl = normalize_ssl(row.get("SSL"))
                    linked_account = (
                        current_account_by_ssl.get(normalized_ssl, "")
                        if normalized_ssl and source_ssl_counts[normalized_ssl] == 1
                        else ""
                    )
                    out = {
                        "assessment_record_id": rows + 1,
                        "source_id": source["source_id"],
                        "source_row_number": source_row,
                        "account_id": linked_account,
                        "ssl_raw": (row.get("SSL") or "").strip(),
                        "ssl_normalized": normalized_ssl,
                        "source_internalid": (row.get("INTERNALID") or "").strip(),
                        "source_objectid": (row.get("OBJECTID") or row.get("ObjectId") or "").strip(),
                        "source_globalid": (row.get("GlobalID") or row.get("GLOBALID") or "").strip(),
                        "record_extract_at": iso_date(row.get("EXTRACTDAT")),
                        "archive_capture_at": source["archive_capture_at"] or "",
                        "dataset_retrieved_at": source["retrieved_at"] or "",
                    }
                    for stage, value_fields in ASSESSMENT_FIELDS.items():
                        out[f"{stage}_tax_year"] = source["years"][stage]
                        out[f"{stage}_land_value"] = whole_dollars(row.get(value_fields[0]))
                        out[f"{stage}_improvement_value"] = whole_dollars(row.get(value_fields[1]))
                        out[f"{stage}_total_value"] = whole_dollars(row.get(value_fields[2]))
                    writer.writerow(out)
                    rows += 1
    return artifact(output, rows)


def build_tax_arrays() -> dict[str, object]:
    source = SOURCES[-1]
    path = Path(source["path"])
    output = GENERATED / "tax_series.csv.gz"
    fields = [
        "account_id", "source_id", "source_row_number", "record_extract_at",
        "slot_codes", "tax_years", "tax_sale_flags", "tax_cents", "penalty_cents",
        "interest_cents", "fee_cents", "total_due_cents", "collected_cents",
        "balance_cents", "credit_cents",
    ]
    rows = 0
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as in_handle, gzip.open(
        output, "wt", encoding="utf-8", newline="", compresslevel=6
    ) as out_handle:
        reader = csv.DictReader(in_handle)
        writer = csv.DictWriter(out_handle, fieldnames=fields)
        writer.writeheader()
        for source_row, row in enumerate(reader, start=2):
            values: dict[str, list[str]] = {suffix: [] for suffix in TAX_SUFFIXES}
            for slot in TAX_SLOTS:
                for suffix in TAX_SUFFIXES:
                    raw = row.get(f"{slot}{suffix}")
                    values[suffix].append(
                        money_to_cents(raw) if suffix in {"TAX", "PEN", "INT", "FEE", "TOTDUE", "COLL", "BAL", "CR"}
                        else (raw or "").strip()
                    )
            writer.writerow(
                {
                    "account_id": source_row - 1,
                    "source_id": source["source_id"],
                    "source_row_number": source_row,
                    "record_extract_at": iso_date(row.get("EXTRACTDAT")),
                    "slot_codes": pg_array(TAX_SLOTS, quote=True),
                    "tax_years": pg_array(values["YEAR"]),
                    "tax_sale_flags": pg_array(values["TXSALE"], quote=True),
                    "tax_cents": pg_array(values["TAX"]),
                    "penalty_cents": pg_array(values["PEN"]),
                    "interest_cents": pg_array(values["INT"]),
                    "fee_cents": pg_array(values["FEE"]),
                    "total_due_cents": pg_array(values["TOTDUE"]),
                    "collected_cents": pg_array(values["COLL"]),
                    "balance_cents": pg_array(values["BAL"]),
                    "credit_cents": pg_array(values["CR"]),
                }
            )
            rows += 1
    return artifact(output, rows)


def artifact(path: Path, rows: int) -> dict[str, object]:
    return {
        "file": str(path),
        "rows": rows,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def main() -> None:
    for directory in (GENERATED, MANIFEST_DIR, REPORT_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    profiles = [source_profile(source) for source in SOURCES]
    artifacts = {
        "property_account_current": build_current(),
        "assessment_snapshot_record": build_assessments(),
        "tax_series": build_tax_arrays(),
    }
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "canonical_sources": profiles,
        "generated_artifacts": artifacts,
        "temporal_contract": {
            "record_extract_at": "Per-row EXTRACTDAT from the source",
            "dataset_retrieved_at": "Local download time; not a fact effective date",
            "archive_capture_at": "Archive capture time; not a fact effective date",
        },
    }
    manifest_path = MANIFEST_DIR / "build_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    report_path = REPORT_DIR / "artifact_sizes.json"
    report_path.write_text(json.dumps(artifacts, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
