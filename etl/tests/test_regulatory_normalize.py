from __future__ import annotations

import csv
import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dc_property_etl.regulatory_normalize import (  # noqa: E402
    ARTIFACT_HEADERS,
    _record_type,
    _source_family_mode,
    normalize_regulatory_data,
    normalize_ssl_values,
    normalize_street_key,
)
from dc_property_etl.regulatory_verify import (  # noqa: E402
    RegulatoryVerificationError,
    verify_normalized_release,
)
from dc_property_etl.source_registry import (  # noqa: E402
    SOURCES,
    SOURCE_BY_ID,
)


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _write_deterministic_gzip(path: Path, payload: bytes) -> None:
    with path.open("xb") as raw:
        with gzip.GzipFile(
            filename="",
            fileobj=raw,
            mode="wb",
            mtime=0,
        ) as compressed:
            compressed.write(payload)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_accounts(path: Path, rows: list[dict[str, object]]) -> None:
    header = (
        "account_id",
        "ssl_normalized",
        "premise_address",
        "address_normalized",
    )
    text = []
    output = __import__("io").StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    text.append(output.getvalue())
    _write_deterministic_gzip(path, "".join(text).encode("utf-8"))


def _write_source(
    run_directory: Path,
    source_id: str,
    rows: list[dict[str, object]],
) -> dict[str, object]:
    source = SOURCE_BY_ID[source_id]
    data_path = run_directory / f"{source_id}.jsonl.gz"
    canonical_lines = b"".join(
        (_canonical_json(row) + "\n").encode("utf-8")
        for row in sorted(rows, key=lambda row: int(row["OBJECTID"]))
    )
    _write_deterministic_gzip(data_path, canonical_lines)
    manifest = {
        "manifest_kind": "dc-property-arcgis-source",
        "manifest_version": 1,
        "status": "complete",
        "retrieved_at": "2026-07-28T08:00:00Z",
        "source": asdict(source),
        "arcgis": {
            "object_id_field": "OBJECTID",
            "service_last_edit_ms": 1785200000000,
            "schema_fingerprint": "a" * 64,
            "fields": [
                {
                    "name": field,
                    "type": (
                        "esriFieldTypeOID"
                        if field == "OBJECTID"
                        else "esriFieldTypeString"
                    ),
                }
                for field in source.fields
            ],
        },
        "artifact": {
            "file": data_path.name,
            "rows": len(rows),
            "bytes": data_path.stat().st_size,
            "gzip_sha256": _sha256(data_path),
            "canonical_rows_sha256": hashlib.sha256(
                canonical_lines
            ).hexdigest(),
        },
    }
    manifest_path = run_directory / f"{source_id}.manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {
        "source_id": source_id,
        "family": source.family,
        "rows": len(rows),
        "gzip_sha256": manifest["artifact"]["gzip_sha256"],
        "schema_fingerprint": "a" * 64,
    }


def _write_run(
    run_directory: Path,
    source_rows: dict[str, list[dict[str, object]]],
) -> None:
    run_directory.mkdir()
    sources = [
        _write_source(run_directory, source_id, rows)
        for source_id, rows in source_rows.items()
    ]
    run_manifest = {
        "manifest_kind": "dc-property-arcgis-run",
        "manifest_version": 1,
        "run_id": run_directory.name,
        "completed_at": "2026-07-28T08:01:00Z",
        "status": "complete",
        "source_count": len(sources),
        "completed_source_count": len(sources),
        "failed_source_count": 0,
        "total_rows": sum(int(source["rows"]) for source in sources),
        "sources": sorted(sources, key=lambda source: source["source_id"]),
        "failures": [],
    }
    (run_directory / "run.manifest.json").write_text(
        json.dumps(run_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _read_csv(path: Path) -> list[dict[str, str]]:
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


class RegulatoryNormalizationUnitTests(unittest.TestCase):
    def test_every_registered_family_has_a_record_and_link_policy(
        self,
    ) -> None:
        for family in sorted({source.family for source in SOURCES}):
            destination, record_type = _record_type(family)
            self.assertIn(destination, ARTIFACT_HEADERS)
            self.assertTrue(record_type)
            self.assertIn(
                _source_family_mode(family),
                {
                    "exact_ssl_only",
                    "parcel",
                    "shared_building",
                    "proximity",
                },
            )

    def test_ssl_split_is_exact_and_rejects_malformed_values(self) -> None:
        self.assertEqual(
            normalize_ssl_values("5244    0012, 5244-0804"),
            ("52440012", "52440804"),
        )
        self.assertEqual(
            normalize_ssl_values("SSL: 5244 0012 / 5244 0804"),
            ("52440012", "52440804"),
        )
        self.assertEqual(normalize_ssl_values("N/A"), ())
        self.assertEqual(normalize_ssl_values("5244"), ())

    def test_street_key_is_conservative_and_removes_dc_tail_and_unit(
        self,
    ) -> None:
        self.assertEqual(
            normalize_street_key(
                "0601 19th Street NW, Washington, DC 20006-1234"
            ),
            "601 19TH ST NW",
        )
        self.assertEqual(
            normalize_street_key(
                "0001 Main Avenue NW # 4, Washington DC 20001"
            ),
            "1 MAIN AVE NW",
        )
        self.assertIsNone(normalize_street_key("WASHINGTON DC 20001"))
        self.assertIsNone(normalize_street_key("1000"))
        self.assertIsNone(normalize_street_key("UNKNOWN"))


class RegulatoryNormalizationIntegrationTests(unittest.TestCase):
    def test_run_manifest_must_bind_every_source_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accounts = root / "accounts.csv.gz"
            _write_accounts(
                accounts,
                [
                    {
                        "account_id": 1,
                        "ssl_normalized": "00010001",
                        "premise_address": (
                            "1 TEST ST NW WASHINGTON DC 20001"
                        ),
                        "address_normalized": "",
                    }
                ],
            )
            acquisition = root / "unbound_acquisition"
            _write_run(
                acquisition,
                {
                    "dob_building_permits_2026": [
                        {
                            "OBJECTID": 1,
                            "PERMIT_ID": "B1",
                            "SSL": "0001 0001",
                        }
                    ]
                },
            )
            run_manifest_path = acquisition / "run.manifest.json"
            run_manifest = json.loads(
                run_manifest_path.read_text(encoding="utf-8")
            )
            run_manifest["sources"] = []
            run_manifest["source_count"] = 0
            run_manifest["completed_source_count"] = 0
            run_manifest_path.write_text(
                json.dumps(run_manifest, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output = root / "generated" / "unbound"

            with self.assertRaisesRegex(
                RuntimeError, "is not bound by acquisition run manifest"
            ):
                normalize_regulatory_data(
                    account_path=accounts,
                    acquisition_run_directories=[acquisition],
                    output_directory=output,
                    run_id="unbound",
                )
            self.assertFalse(output.exists())

    def test_exact_contextual_multi_parcel_and_proximity_policies(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accounts = root / "accounts.csv.gz"
            _write_accounts(
                accounts,
                [
                    {
                        "account_id": 1,
                        "ssl_normalized": "00010001",
                        "premise_address": (
                            "0001 MAIN STREET NW WASHINGTON DC 20001"
                        ),
                        "address_normalized": "",
                    },
                    {
                        "account_id": 2,
                        "ssl_normalized": "00010002",
                        "premise_address": (
                            "1 MAIN ST NW # 2 WASHINGTON DC 20001"
                        ),
                        "address_normalized": "",
                    },
                    {
                        "account_id": 3,
                        "ssl_normalized": "00020001",
                        "premise_address": (
                            "2 SECOND ST NE WASHINGTON DC 20002"
                        ),
                        "address_normalized": "",
                    },
                ],
            )
            acquisition = root / "fixture_acquisition"
            _write_run(
                acquisition,
                {
                    "cama_residential_current": [
                        {
                            "OBJECTID": 11,
                            "SSL": "0001    0001",
                            "AYB": 1900,
                            "PRICE": None,
                        }
                    ],
                    "dob_building_permits_2026": [
                        {
                            "OBJECTID": 12,
                            "PERMIT_ID": "B2600012",
                            "APPLICATION_STATUS_NAME": "PERMIT ISSUED",
                            "FULL_ADDRESS": (
                                "1 MAIN ST NW, WASHINGTON, DC 20001"
                            ),
                            "SSL": "0001 0001",
                            "ISSUE_DATE": 1769403600000,
                        }
                    ],
                    "dob_building_permits_2025": [
                        {
                            "OBJECTID": 13,
                            "PERMIT_ID": "B2500013",
                            "FULL_ADDRESS": (
                                "0002 SECOND STREET NE, "
                                "WASHINGTON, DC 20002"
                            ),
                        }
                    ],
                    "dlcp_basic_business_licenses": [
                        {
                            "OBJECTID": 14,
                            "CUSTOMERNUMBER": "LIC-14",
                            "LICENSESTATUS": "Active",
                            "PREMISEADDRESS": (
                                "1 MAIN ST NW, WASHINGTON, DC 20001"
                            ),
                            "SSL": "0001 0001, 0001 0002",
                        }
                    ],
                    "doee_energy_benchmarking": [
                        {
                            "OBJECTID": 15,
                            "PID": "PM15",
                            "REPORTSTATUS": "Complete",
                            "ADDRESSOFRECORD": "1 MAIN ST NW",
                            "SSL": "0001 0001",
                            "REPORTINGYEAR": 2025,
                            "ENERGYSTARSCORE": 87,
                            "UNUSED_NULL": None,
                        }
                    ],
                    "ddot_tops_construction_permits": [
                        {
                            "OBJECTID": 16,
                            "PermitNumber": "PA-16",
                            "Status": "Issued",
                            "WorkLocationFullAddress": "2 SECOND ST NE",
                        }
                    ],
                    "ddot_emergency_work_requests": [
                        {
                            "OBJECTID": 17,
                            "CONSTRUCTIONTRACKINGNUMBER": "EW-17",
                            "STATUS": "Approved",
                            "LOCATIONDESCRIPTION": "2 SECOND ST NE",
                            "ISSUEDDATE": 1769403600000,
                        }
                    ],
                },
            )
            output = root / "generated" / "fixture"

            manifest = normalize_regulatory_data(
                account_path=accounts,
                acquisition_run_directories=[acquisition],
                output_directory=output,
                run_id="fixture",
            )

            links = _read_csv(output / "source_record_links.csv.gz")
            by_record = {}
            for link in links:
                by_record.setdefault(
                    (link["source_id"], link["source_record_id"]), []
                ).append(link)

            cama = by_record[("cama_residential_current", "11")]
            self.assertEqual(len(cama), 1)
            self.assertEqual(
                (
                    cama[0]["account_id"],
                    cama[0]["link_scope"],
                    cama[0]["link_method"],
                    cama[0]["match_quality"],
                    cama[0]["link_confidence"],
                ),
                ("1", "exact_property", "ssl", "exact", "1.0000"),
            )
            permit_ssl = by_record[("dob_building_permits_2026", "12")]
            self.assertEqual(
                (
                    permit_ssl[0]["link_scope"],
                    permit_ssl[0]["link_method"],
                ),
                ("exact_property", "ssl"),
            )
            permit_address = by_record[
                ("dob_building_permits_2025", "13")
            ]
            self.assertEqual(
                (
                    permit_address[0]["account_id"],
                    permit_address[0]["link_scope"],
                    permit_address[0]["link_method"],
                    permit_address[0]["match_quality"],
                    permit_address[0]["link_confidence"],
                ),
                (
                    "3",
                    "shared_building",
                    "normalized_address",
                    "contextual",
                    "0.8000",
                ),
            )
            business = by_record[("dlcp_basic_business_licenses", "14")]
            self.assertEqual(
                {link["account_id"] for link in business}, {"1", "2"}
            )
            self.assertEqual(
                {link["link_scope"] for link in business}, {"multi_parcel"}
            )
            self.assertEqual(
                {link["match_quality"] for link in business}, {"contextual"}
            )
            energy = by_record[("doee_energy_benchmarking", "15")]
            self.assertEqual(len(energy), 1)
            self.assertEqual(
                (
                    energy[0]["link_scope"],
                    energy[0]["link_method"],
                    energy[0]["match_quality"],
                ),
                ("shared_building", "ssl", "contextual"),
            )
            ddot = by_record[("ddot_tops_construction_permits", "16")]
            self.assertEqual(
                (
                    ddot[0]["account_id"],
                    ddot[0]["link_scope"],
                    ddot[0]["link_method"],
                    ddot[0]["match_quality"],
                ),
                (
                    "3",
                    "proximity_context",
                    "normalized_address",
                    "contextual",
                ),
            )
            emergency = by_record[
                ("ddot_emergency_work_requests", "17")
            ]
            self.assertEqual(
                emergency[0]["link_scope"], "proximity_context"
            )

            context = _read_csv(
                output / "property_context_records.csv.gz"
            )
            self.assertEqual(
                {row["record_type"] for row in context},
                {"cama_building_profile", "energy_benchmark"},
            )
            energy_facts = next(
                json.loads(row["facts_json"])
                for row in context
                if row["record_type"] == "energy_benchmark"
            )
            self.assertNotIn("UNUSED_NULL", energy_facts)
            regulatory = _read_csv(
                output / "regulatory_records.csv.gz"
            )
            emergency_record = next(
                row
                for row in regulatory
                if row["source_id"] == "ddot_emergency_work_requests"
            )
            self.assertEqual(emergency_record["record_number"], "EW-17")
            self.assertEqual(
                emergency_record["event_date"], "2026-01-26"
            )
            self.assertEqual(manifest["totals"]["unlinked_records"], 0)

    def test_ambiguous_address_over_safe_cap_is_not_served(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accounts = root / "accounts.csv.gz"
            _write_accounts(
                accounts,
                [
                    {
                        "account_id": index,
                        "ssl_normalized": f"1000{index:04d}",
                        "premise_address": (
                            f"99 LARGE AVE NW # {index} "
                            "WASHINGTON DC 20001"
                        ),
                        "address_normalized": "",
                    }
                    for index in range(1, 66)
                ],
            )
            acquisition = root / "ambiguous_acquisition"
            _write_run(
                acquisition,
                {
                    "dlcp_basic_business_licenses": [
                        {
                            "OBJECTID": 101,
                            "CUSTOMERNUMBER": "LIC-101",
                            "PREMISEADDRESS": "99 LARGE AVE NW",
                        }
                    ],
                    "cama_residential_current": [
                        {
                            "OBJECTID": 102,
                            "SSL": None,
                            "AYB": 1900,
                        }
                    ],
                },
            )
            output = root / "generated" / "ambiguous"

            manifest = normalize_regulatory_data(
                account_path=accounts,
                acquisition_run_directories=[acquisition],
                output_directory=output,
                run_id="ambiguous",
            )

            self.assertEqual(
                _read_csv(output / "source_record_links.csv.gz"), []
            )
            self.assertEqual(
                _read_csv(output / "regulatory_records.csv.gz"), []
            )
            self.assertEqual(
                _read_csv(output / "property_context_records.csv.gz"), []
            )
            self.assertEqual(manifest["totals"]["ambiguous_records"], 1)
            self.assertEqual(manifest["totals"]["unlinked_records"], 1)
            self.assertEqual(
                manifest["safe_max_accounts_per_address"], 64
            )

    def test_outputs_are_byte_deterministic_and_have_fixed_headers(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accounts = root / "accounts.csv.gz"
            _write_accounts(
                accounts,
                [
                    {
                        "account_id": 7,
                        "ssl_normalized": "00070007",
                        "premise_address": (
                            "7 TEST ST SE WASHINGTON DC 20003"
                        ),
                        "address_normalized": "",
                    }
                ],
            )
            acquisition = root / "stable_acquisition"
            _write_run(
                acquisition,
                {
                    "dob_building_permits_2026": [
                        {
                            "OBJECTID": 77,
                            "PERMIT_ID": "B77",
                            "SSL": "0007 0007",
                            "DESC_OF_WORK": "Stable",
                        }
                    ]
                },
            )
            first = root / "one" / "stable"
            second = root / "two" / "stable"

            first_manifest = normalize_regulatory_data(
                account_path=accounts,
                acquisition_run_directories=[acquisition],
                output_directory=first,
                run_id="stable",
            )
            second_manifest = normalize_regulatory_data(
                account_path=accounts,
                acquisition_run_directories=[acquisition],
                output_directory=second,
                run_id="stable",
            )

            for filename, header in ARTIFACT_HEADERS.items():
                self.assertEqual(
                    _sha256(first / filename),
                    _sha256(second / filename),
                )
                with gzip.open(
                    first / filename,
                    "rt",
                    encoding="utf-8",
                    newline="",
                ) as handle:
                    self.assertEqual(
                        next(csv.reader(handle)),
                        list(header),
                    )
            self.assertEqual(first_manifest, second_manifest)
            self.assertEqual(
                (first / "manifest.json").read_bytes(),
                (second / "manifest.json").read_bytes(),
            )
            verified = verify_normalized_release(first)
            self.assertEqual(verified["source_count"], 1)
            self.assertEqual(verified["served_records"], 1)

            with (
                first / "source_record_links.csv.gz"
            ).open("ab") as handle:
                handle.write(b"tamper")
            with self.assertRaisesRegex(
                RegulatoryVerificationError,
                "artifact SHA-256 mismatch",
            ):
                verify_normalized_release(first)


if __name__ == "__main__":
    unittest.main()
