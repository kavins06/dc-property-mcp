from __future__ import annotations

import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dc_property_etl.parcel_normalize import (  # noqa: E402
    normalize_address_row,
    normalize_address_ssl_row,
    normalize_parcel_data,
    normalize_residential_unit_row,
)
from dc_property_etl.source_registry import (  # noqa: E402
    PARCEL_SOURCES,
    SOURCE_BY_ID,
)


def _write_source(
    directory: Path,
    source_id: str,
    rows: list[dict[str, object]],
) -> None:
    source = SOURCE_BY_ID[source_id]
    lines = b"".join(
        (json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n").encode()
        for row in sorted(rows, key=lambda item: int(item["OBJECTID"]))
    )
    data_path = directory / f"{source_id}.jsonl.gz"
    with data_path.open("xb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as output:
            output.write(lines)
    manifest = {
        "manifest_kind": "dc-property-arcgis-source",
        "manifest_version": 1,
        "status": "complete",
        "retrieved_at": "2026-08-05T12:00:00Z",
        "source": asdict(source),
        "arcgis": {"schema_fingerprint": "a" * 64},
        "artifact": {
            "file": data_path.name,
            "rows": len(rows),
            "bytes": data_path.stat().st_size,
            "gzip_sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
            "canonical_rows_sha256": hashlib.sha256(lines).hexdigest(),
        },
    }
    (directory / f"{source_id}.manifest.json").write_text(
        json.dumps(manifest, sort_keys=True), encoding="utf-8"
    )


class ParcelSourceContractTests(unittest.TestCase):
    def test_exact_official_source_set_is_registered(self) -> None:
        self.assertEqual(
            {source.source_id for source in PARCEL_SOURCES},
            {
                "mar_address_current",
                "mar_address_ssl_current",
                "mar_residential_unit_current",
            },
        )
        for source in PARCEL_SOURCES:
            self.assertIn("OBJECTID", source.fields)
            self.assertTrue(source.human_portal_url.startswith("https://"))
            self.assertNotIn("/rest/", source.human_portal_url.lower())

    def test_address_row_preserves_official_identity(self) -> None:
        self.assertEqual(
            normalize_address_row(
                {
                    "OBJECTID": 10,
                    "MAR_ID": 123,
                    "ADDRESS": "1 TEST STREET NW",
                    "STATUS": "ACTIVE",
                    "SSL": "0001    0001",
                }
            ),
            {
                "source_record_id": 10,
                "mar_id": 123,
                "address_source_value": "1 TEST STREET NW",
                "status": "ACTIVE",
                "base_ssl_normalized": "00010001",
            },
        )

    def test_address_rows_without_a_human_address_are_excluded(self) -> None:
        self.assertIsNone(normalize_address_row({
            "OBJECTID": 1,
            "MAR_ID": 2,
            "ADDRESS": None,
            "STATUS": "ACTIVE",
            "SSL": "0001    0001",
        }))

    def test_address_ssl_row_preserves_lot_classification(self) -> None:
        self.assertEqual(
            normalize_address_ssl_row(
                {
                    "OBJECTID": 20,
                    "MARID": 123,
                    "SSL": "0001 0002",
                    "SQUARE": "0001",
                    "SUFFIX": "",
                    "LOT": "0002",
                    "COL": "Y",
                    "PARCEL": None,
                    "RESERVATION": None,
                    "LOT_TYPE": "TAX LOT",
                }
            )["lot_type"],
            "TAX LOT",
        )

    def test_address_ssl_preserves_official_non_tax_lot_identifiers(self) -> None:
        self.assertEqual(
            normalize_address_ssl_row({
                "OBJECTID": 21,
                "MARID": 123,
                "SSL": "1065NE  0044",
                "LOT_TYPE": "RECORD LOT",
            })["ssl_normalized"],
            "1065NE0044",
        )
        self.assertEqual(
            normalize_address_ssl_row({
                "OBJECTID": 22,
                "MARID": 123,
                "SSL": "RES 343B0000",
                "LOT_TYPE": "RESERVATION",
            })["ssl_normalized"],
            "RES343B0000",
        )

    def test_unit_row_narrows_only_with_an_official_condo_ssl(self) -> None:
        row = normalize_residential_unit_row(
            {
                "OBJECTID": 30,
                "UNIT_ID": 456,
                "MAR_ID": 123,
                "FULL_ADDRESS": "1 TEST STREET NW UNIT 4",
                "PRIMARY_ADDRESS": "1 TEST STREET NW",
                "UNIT_NUMBER": "4",
                "UNIT_TYPE": "CONDO",
                "CONDO_SSL": "0001 2004",
                "STATUS": "ACTIVE",
            }
        )
        self.assertEqual(row["condo_ssl_normalized"], "00012004")
        self.assertEqual(row["unit_number"], "4")

    def test_unit_rows_without_searchable_addresses_are_excluded(self) -> None:
        self.assertIsNone(normalize_residential_unit_row({
            "OBJECTID": 30,
            "UNIT_ID": 0,
            "MAR_ID": 123,
            "FULL_ADDRESS": None,
            "PRIMARY_ADDRESS": "1 TEST STREET NW",
            "UNIT_NUMBER": "4",
            "STATUS": "RETIRE",
        }))

    def test_malformed_official_identifiers_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "MAR_ID"):
            normalize_address_row(
                {
                    "OBJECTID": 10,
                    "MAR_ID": "not-an-id",
                    "ADDRESS": "1 TEST STREET NW",
                    "STATUS": "ACTIVE",
                    "SSL": "0001 0001",
                }
            )
        with self.assertRaisesRegex(ValueError, "SSL"):
            normalize_address_ssl_row(
                {
                    "OBJECTID": 20,
                    "MARID": 123,
                    "SSL": "0001",
                    "LOT_TYPE": "TAX LOT",
                }
            )

    def test_normalized_artifacts_are_complete_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            acquisition = root / "raw"
            acquisition.mkdir()
            _write_source(
                acquisition,
                "mar_address_current",
                [{
                    "OBJECTID": 1,
                    "MAR_ID": 100,
                    "ADDRESS": "1 TEST STREET NW",
                    "STATUS": "ACTIVE",
                    "SSL": "0001 0001",
                }],
            )
            _write_source(
                acquisition,
                "mar_address_ssl_current",
                [{
                    "OBJECTID": 2,
                    "MARID": 100,
                    "SSL": "0001 0001",
                    "SQUARE": "0001",
                    "SUFFIX": "",
                    "LOT": "0001",
                    "COL": "N",
                    "PARCEL": None,
                    "RESERVATION": None,
                    "LOT_TYPE": "TAX LOT",
                }, {
                    "OBJECTID": 4,
                    "MARID": 999,
                    "SSL": "0001 0002",
                    "LOT_TYPE": "TAX LOT",
                }],
            )
            _write_source(
                acquisition,
                "mar_residential_unit_current",
                [{
                    "OBJECTID": 3,
                    "UNIT_ID": 200,
                    "MAR_ID": 100,
                    "FULL_ADDRESS": "1 TEST STREET NW UNIT 4",
                    "PRIMARY_ADDRESS": "1 TEST STREET NW",
                    "UNIT_NUMBER": "4",
                    "UNIT_TYPE": "CONDO",
                    "CONDO_SSL": "0001 2004",
                    "STATUS": "ACTIVE",
                }, {
                    "OBJECTID": 5,
                    "UNIT_ID": 201,
                    "MAR_ID": 999,
                    "FULL_ADDRESS": "2 TEST STREET NW UNIT 5",
                    "PRIMARY_ADDRESS": "2 TEST STREET NW",
                    "UNIT_NUMBER": "5",
                    "UNIT_TYPE": "CONDO",
                    "CONDO_SSL": "0001 2005",
                    "STATUS": "ACTIVE",
                }],
            )

            first = root / "first"
            second = root / "second"
            first_manifest = normalize_parcel_data(acquisition, first)
            second_manifest = normalize_parcel_data(acquisition, second)

            self.assertEqual(first_manifest, second_manifest)
            self.assertEqual(first_manifest["source_count"], 3)
            self.assertEqual(
                first_manifest["artifacts"]["mar_address_ssls.csv.gz"]["rows"],
                1,
            )
            self.assertEqual(
                first_manifest["artifacts"]["mar_residential_units.csv.gz"]["rows"],
                1,
            )
            for name in first_manifest["artifacts"]:
                self.assertEqual(
                    (first / name).read_bytes(),
                    (second / name).read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
