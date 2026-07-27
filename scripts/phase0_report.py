#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = PROJECT.parent
MANIFEST = PROJECT / "data" / "manifests" / "build_manifest.json"
SOURCE = WORKSPACE / "ITSPE.csv"

CATEGORIES = {
    "identity": [
        "SSL", "SQUARE", "SUFFIX", "LOT", "PRESSL", "PIPARENTLOT",
        "PCHILDCODE", "ABTLOTCODE",
    ],
    "location": [
        "PREMISEADD", "LOWNUMBER", "STREETNAME", "QDRNTNAME", "UNITNUMBER",
        "PRMS_WARD", "NBHD", "NBHDNAME", "SUBNBHD",
    ],
    "classification": [
        "PROPTYPE", "TRIGROUP", "USECODE", "LANDAREA", "CLASSTYPE", "TAXRATE",
        "MIXEDUSE", "OWNOCCT", "HSTDCODE", "DELCODE",
    ],
    "ownership": [
        "OWNERNAME", "OWNNAME2", "CAREOFNAME", "ADDRESS1", "ADDRESS2",
        "CITYSTZIP", "MORTGAGECO",
    ],
    "assessment": [
        "OLDLAND", "OLDIMPR", "OLDTOTAL", "PHASELAND", "PHASEBUILD",
        "ASSESSMENT", "NEWLAND", "NEWIMPR", "NEWTOTAL", "CAPCURR", "CAPPROP",
    ],
    "tax": [
        "ANNUALTAX", "DUEDATE1", "AMTDUE1", "DUEDATE2", "AMTDUE2",
        "TOTDUEAMT", "TOTCOLAMT", "TOTBALAMT", "LASTPAYDT",
    ],
    "sale_and_deed": [
        "SALEPRICE", "SALEDATE", "ACCEPTCODE", "SALETYPE", "DEEDDATE", "INST_NO",
    ],
    "special_assessment": [
        "BIDNAME", "BIDTOTALDUE", "BIDCOLLECTED", "BIDBALANCE",
        "SEWSTOTALDUE", "SEWSCOLLECTED", "SEWSBALANCE", "PACETOTALDUE",
        "PACECOLLECTED", "PACEBALANCE", "SWWSADTOTALDUE", "SWWSADCOLLECTED",
        "SWWSADBALANCE",
    ],
}

EXAMPLE_PREDICATES = [
    ("commercial_office", lambda row: (row.get("PROPTYPE") or "").startswith("Commercial-Office")),
    ("retail", lambda row: "Retail" in (row.get("PROPTYPE") or "") or (row.get("PROPTYPE") or "").startswith("Store-")),
    ("multifamily", lambda row: "Apartment" in (row.get("PROPTYPE") or "") or "Multi-Family" in (row.get("PROPTYPE") or "")),
    ("condominium", lambda row: "Condominium" in (row.get("PROPTYPE") or "")),
    ("deleted_account", lambda row: (row.get("DELCODE") or "").strip() == "Y"),
]


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    inventory_lines = [
        "# Canonical source inventory",
        "",
        "| Source | Rows | Columns | Extract-date range | SHA-256 |",
        "| --- | ---: | ---: | --- | --- |",
    ]
    for source in manifest["canonical_sources"]:
        date_min = source.get("extract_date_min") or source.get("sale_date_min")
        date_max = source.get("extract_date_max") or source.get("sale_date_max")
        date_range = f"{date_min} to {date_max}"
        inventory_lines.append(
            f"| `{source['source_id']}` | {source['rows']:,} | "
            f"{source['columns']} | {date_range} | `{source['sha256']}` |"
        )
    inventory_lines.extend(
        [
            "",
            "Focused exports and `assessment_history_available.csv` are derived artifacts,",
            "not independent canonical inputs. Assessment history is rebuilt from the raw",
            "snapshots because the old normalized file overloaded snapshot timing.",
            "",
        ]
    )
    (PROJECT / "docs" / "source-inventory.md").write_text(
        "\n".join(inventory_lines), encoding="utf-8"
    )

    matrix_path = PROJECT / "docs" / "source-field-matrix.csv"
    with matrix_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "category", "semantic_field_key", "source_id", "source_field",
                "fact_date_field", "evidence_strategy", "definition_status",
            ]
        )
        for category, fields in CATEGORIES.items():
            for field in fields:
                writer.writerow(
                    [
                        category,
                        f"{category}.{field.lower()}",
                        "itspe_current",
                        field,
                        "EXTRACTDAT",
                        "human_portal_with_exact_lookup_inputs",
                        "source_label_only",
                    ]
                )
        for field, semantic_key in [
            ("OBJECTID", "sale.history.source_record_id"),
            ("SALE_DATE", "sale.history.date"),
            ("SALE_PRICE", "sale.history.price"),
            ("QUALIFIED", "sale.history.qualified_code"),
            ("SALE_CODE", "sale.history.sale_code"),
            ("SALE_CURR_OWNER", "sale.history.current_owner_flag"),
        ]:
            writer.writerow(
                [
                    "sale_history",
                    semantic_key,
                    "cama_sales_current",
                    field,
                    "SALE_DATE",
                    "human_dc_open_data_portal_with_ssl_and_source_record_id",
                    "official",
                ]
            )

    examples: dict[str, dict[str, object]] = {}
    with SOURCE.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            for label, predicate in EXAMPLE_PREDICATES:
                if label not in examples and predicate(row):
                    ssl = (row.get("SSL") or "").strip()
                    address = (row.get("PREMISEADD") or "").strip()
                    examples[label] = {
                        "ssl": ssl,
                        "address": address,
                        "property_type": (row.get("PROPTYPE") or "").strip(),
                        "record_extract_at": (row.get("EXTRACTDAT") or "")[:10].replace("/", "-"),
                        "human_portal_url": (
                            "https://mytax.dc.gov/?Link=PropertySearch&Check=1"
                        ),
                        "verification_steps": [
                            f"Enter address {address} or SSL {ssl}",
                            "Select Search",
                            "Open the matching account and select the relevant tab",
                        ],
                    }
            if len(examples) == len(EXAMPLE_PREDICATES):
                break
    output = PROJECT / "docs" / "evidence-examples.json"
    output.write_text(json.dumps(examples, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
