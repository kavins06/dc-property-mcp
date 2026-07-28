from __future__ import annotations

import http.client
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dc_property_etl.arcgis import (
    ArcGisAcquisitionError,
    _assert_snapshot_unchanged,
    _fetch_exact_object_id_batch,
    _object_id_inventory_sha256,
    _request_json,
    _snapshot_guard,
    _validate_object_id_inventory,
    _validate_page,
    schema_fingerprint,
)
from dc_property_etl.source_registry import SOURCES
from dc_property_etl.source_registry import SOURCE_BY_ID


class SourceRegistryTests(unittest.TestCase):
    def test_abca_records_use_family_specific_public_pages(
        self,
    ) -> None:
        expected = {
            "abca_alcohol_license_locations": (
                "https://abca.dc.gov/node/612672",
                "ABCA Current License Holders",
            ),
            "abca_medical_cannabis_nonretailers": (
                "https://abca.dc.gov/node/1657531",
                "ABCA Medical Cannabis Non-Retailer Licensees",
            ),
            "abca_medical_cannabis_retailers": (
                "https://abca.dc.gov/node/1751426",
                "ABCA Medical Cannabis Retailer Licensees",
            ),
        }
        for source_id, (portal_url, portal_name) in expected.items():
            source = SOURCE_BY_ID[source_id]
            self.assertEqual(
                source.human_portal_url,
                portal_url,
                source_id,
            )
            self.assertEqual(
                source.human_portal_name,
                portal_name,
                source_id,
            )
            self.assertNotEqual(
                source.human_portal_url,
                "https://abca.dc.gov/page/licensing",
                source_id,
            )

    def test_energy_records_use_public_building_performance_portal(
        self,
    ) -> None:
        public_portal = "https://buildingperformancedc.org/"
        for source_id in (
            "doee_energy_benchmarking",
            "doee_beps_current",
        ):
            source = SOURCE_BY_ID[source_id]
            self.assertEqual(
                source.human_portal_url,
                public_portal,
                source_id,
            )
            self.assertEqual(
                source.human_portal_name,
                "Building Energy Performance DC",
                source_id,
            )
            self.assertNotIn(
                "beam-portal",
                source.human_portal_url.lower(),
                source_id,
            )

    def test_ddot_records_use_public_tops_map_lookup(
        self,
    ) -> None:
        direct_lookup = (
            "https://tops.ddot.dc.gov/DDOTPermitSystem/"
            "DDOTPermitOnline/MapLookup.aspx"
        )
        ddot_sources = [
            source
            for source in SOURCES
            if source.source_id.startswith("ddot_")
        ]
        self.assertGreaterEqual(len(ddot_sources), 7)
        for source in ddot_sources:
            self.assertEqual(
                source.human_portal_url,
                direct_lookup,
                source.source_id,
            )

    def test_business_license_verification_uses_public_scout(
        self,
    ) -> None:
        source = SOURCE_BY_ID["dlcp_basic_business_licenses"]
        self.assertEqual(
            source.human_portal_url,
            "https://scout.dob.dc.gov/",
        )
        self.assertEqual(
            source.human_portal_name,
            "D.C. Department of Buildings SCOUT",
        )

    def test_corrupt_annual_fee_field_is_scoped_out_only_where_needed(
        self,
    ) -> None:
        for year in (2018, 2019):
            source = SOURCE_BY_ID[f"dob_building_permits_{year}"]
            self.assertNotIn("FEES_PAID", source.fields)
            self.assertIn("FEES_PAID", source.source_limitations)
        for year in (2017, 2020):
            self.assertIn(
                "FEES_PAID",
                SOURCE_BY_ID[
                    f"dob_building_permits_{year}"
                ].fields,
            )

    def test_source_ids_and_layer_urls_are_unique(self) -> None:
        self.assertEqual(
            len({source.source_id for source in SOURCES}),
            len(SOURCES),
        )
        self.assertEqual(
            len({source.layer_url for source in SOURCES}),
            len(SOURCES),
        )

    def test_sources_have_human_portals_and_no_machine_evidence_url(
        self,
    ) -> None:
        forbidden = (
            "/rest/",
            "featureserver",
            "mapserver",
            "?f=json",
            "/api/",
        )
        for source in SOURCES:
            self.assertTrue(source.layer_url.startswith("https://"))
            self.assertTrue(source.human_portal_url.startswith("https://"))
            human = source.human_portal_url.lower()
            self.assertFalse(
                any(token in human for token in forbidden),
                source.source_id,
            )
            self.assertIn("OBJECTID", source.fields)
            self.assertGreater(source.expected_min_rows, 0)


class ArcGisValidationTests(unittest.TestCase):
    def test_snapshot_guard_detects_mid_download_source_change(self) -> None:
        metadata = {
            "editingInfo": {"lastEditDate": 1234},
        }
        fields = [
            {
                "name": "OBJECTID",
                "type": "esriFieldTypeOID",
            }
        ]
        before = _snapshot_guard(
            metadata=metadata,
            headers={"etag": '"v1"', "last-modified": "before"},
            object_id_field="OBJECTID",
            fields=fields,
            row_count=2,
            object_ids=[1, 2],
        )
        self.assertEqual(
            before["object_id_inventory_sha256"],
            _object_id_inventory_sha256([1, 2]),
        )
        _assert_snapshot_unchanged("fixture", before, dict(before))

        cases = {
            "row_count": 3,
            "object_id_inventory_sha256": (
                _object_id_inventory_sha256([1, 3])
            ),
            "service_last_edit_ms": 1235,
            "etag": '"v2"',
            "last_modified": "after",
            "schema_fingerprint": "f" * 64,
        }
        for field, changed_value in cases.items():
            with self.subTest(field=field):
                after = dict(before)
                after[field] = changed_value
                with self.assertRaisesRegex(
                    ArcGisAcquisitionError,
                    "changed during paged acquisition",
                ):
                    _assert_snapshot_unchanged("fixture", before, after)

    def test_remote_disconnect_is_wrapped_for_retry_handling(self) -> None:
        def disconnected(*_args: object, **_kwargs: object) -> None:
            raise http.client.RemoteDisconnected(
                "fixture disconnected"
            )

        with self.assertRaisesRegex(
            ArcGisAcquisitionError,
            "after 1 attempts",
        ):
            _request_json(
                "https://example.test/query",
                attempts=1,
                opener=disconnected,
            )

    def test_exact_batch_splits_short_transfer_limited_responses(
        self,
    ) -> None:
        calls: list[tuple[int, ...]] = []

        def fake_request(
            _url: str,
            parameters: dict[str, str],
        ) -> tuple[dict[str, object], dict[str, str]]:
            object_ids = tuple(
                int(value)
                for value in parameters["objectIds"].split(",")
            )
            calls.append(object_ids)
            returned = (
                object_ids[:2]
                if object_ids == (1, 2, 3, 4)
                else object_ids
            )
            return (
                {
                    "features": [
                        {"attributes": {"OBJECTID": object_id}}
                        for object_id in returned
                    ]
                },
                {},
            )

        rows = _fetch_exact_object_id_batch(
            "fixture",
            "https://example.test/FeatureServer/0/query",
            ("OBJECTID",),
            "OBJECTID",
            [1, 2, 3, 4],
            request_json=fake_request,
        )
        self.assertEqual(
            [row["OBJECTID"] for row in rows],
            [1, 2, 3, 4],
        )
        self.assertEqual(calls, [(1, 2, 3, 4), (1, 2), (3, 4)])

    def test_exact_batch_fails_closed_for_unretrievable_single_id(
        self,
    ) -> None:
        def fake_request(
            _url: str,
            _parameters: dict[str, str],
        ) -> tuple[dict[str, object], dict[str, str]]:
            return ({"features": []}, {})

        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "could not retrieve object ID 7"
        ):
            _fetch_exact_object_id_batch(
                "fixture",
                "https://example.test/FeatureServer/0/query",
                ("OBJECTID",),
                "OBJECTID",
                [7],
                request_json=fake_request,
            )

    def test_object_id_inventory_requires_exact_unique_count(self) -> None:
        payload = {
            "objectIdFieldName": "OBJECTID",
            "objectIds": [3, 1, 2],
        }
        self.assertEqual(
            _validate_object_id_inventory(
                "fixture",
                payload,
                "OBJECTID",
                3,
            ),
            [1, 2, 3],
        )
        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "duplicate object IDs"
        ):
            _validate_object_id_inventory(
                "fixture",
                {
                    "objectIdFieldName": "OBJECTID",
                    "objectIds": [1, 1],
                },
                "OBJECTID",
                2,
            )
        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "inventory has 2 IDs; expected 3"
        ):
            _validate_object_id_inventory(
                "fixture",
                {
                    "objectIdFieldName": "OBJECTID",
                    "objectIds": [1, 2],
                },
                "OBJECTID",
                3,
            )

    def test_object_id_inventory_rejects_wrong_field_and_non_integer(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "object-ID field"
        ):
            _validate_object_id_inventory(
                "fixture",
                {
                    "objectIdFieldName": "FID",
                    "objectIds": [1],
                },
                "OBJECTID",
                1,
            )
        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "non-integer object ID"
        ):
            _validate_object_id_inventory(
                "fixture",
                {
                    "objectIdFieldName": "OBJECTID",
                    "objectIds": ["1"],
                },
                "OBJECTID",
                1,
            )

    def test_schema_fingerprint_is_order_and_type_sensitive(self) -> None:
        fields = [
            {
                "name": "OBJECTID",
                "alias": "Object ID",
                "type": "esriFieldTypeOID",
                "nullable": False,
            },
            {
                "name": "SSL",
                "alias": "SSL",
                "type": "esriFieldTypeString",
                "length": 20,
                "nullable": True,
            },
        ]
        self.assertEqual(
            schema_fingerprint(fields),
            schema_fingerprint([dict(field) for field in fields]),
        )
        self.assertNotEqual(
            schema_fingerprint(fields),
            schema_fingerprint(list(reversed(fields))),
        )
        changed = [dict(field) for field in fields]
        changed[1]["type"] = "esriFieldTypeInteger"
        self.assertNotEqual(
            schema_fingerprint(fields),
            schema_fingerprint(changed),
        )

    def test_page_validation_rejects_duplicate_and_unordered_ids(
        self,
    ) -> None:
        seen = {1}
        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "duplicate object ID"
        ):
            _validate_page(
                "fixture",
                [{"attributes": {"OBJECTID": 1}}],
                "OBJECTID",
                seen,
            )
        with self.assertRaisesRegex(
            ArcGisAcquisitionError, "not ordered"
        ):
            _validate_page(
                "fixture",
                [
                    {"attributes": {"OBJECTID": 3}},
                    {"attributes": {"OBJECTID": 2}},
                ],
                "OBJECTID",
                set(),
            )

    def test_page_validation_returns_attributes_and_updates_seen(
        self,
    ) -> None:
        seen: set[int] = set()
        rows = _validate_page(
            "fixture",
            [
                {"attributes": {"OBJECTID": 2, "SSL": "00010001"}},
                {"attributes": {"OBJECTID": 3, "SSL": "00010002"}},
            ],
            "OBJECTID",
            seen,
        )
        self.assertEqual([row["OBJECTID"] for row in rows], [2, 3])
        self.assertEqual(seen, {2, 3})


if __name__ == "__main__":
    unittest.main()
