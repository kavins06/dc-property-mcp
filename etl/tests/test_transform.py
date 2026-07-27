import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "src" / "dc_property_etl")
)

from transform import (  # noqa: E402
    canonical_property_type,
    display_ssl,
    iso_date,
    money_to_cents,
    normalize_address,
    normalize_ssl,
    pg_array,
    property_quality_flags,
    whole_dollars,
)


class TransformTests(unittest.TestCase):
    def test_ssl_variants(self):
        self.assertEqual(normalize_ssl("5576    0001"), "55760001")
        self.assertEqual(normalize_ssl("5576- -0001"), "55760001")
        self.assertEqual(normalize_ssl("PI 0002730075"), "PI0002730075")
        self.assertEqual(display_ssl("5576    0001"), "5576--0001")

    def test_address(self):
        self.assertEqual(
            normalize_address("1101 4th St., SW  #2"),
            "1101 4TH ST SW 2",
        )

    def test_money(self):
        self.assertEqual(money_to_cents("$1,700.745"), "170075")
        self.assertEqual(money_to_cents("-2.50"), "-250")
        self.assertEqual(whole_dollars("580,820"), "580820")
        self.assertEqual(money_to_cents(""), "")

    def test_dates(self):
        self.assertEqual(iso_date("2026/04/06 00:00:00+00"), "2026-04-06")

    def test_pg_array(self):
        self.assertEqual(pg_array(["1", "", "-2"]), "{1,NULL,-2}")
        self.assertEqual(pg_array(["CY1", "CY2"], quote=True), '{"CY1","CY2"}')

    def test_property_type_keeps_source_and_adds_stable_canonical_label(self):
        self.assertEqual(
            canonical_property_type("Residential-Condominium (Garag"),
            "Residential Condominium — Garage",
        )
        self.assertEqual(
            canonical_property_type("Vacant-True"),
            "Vacant",
        )

    def test_quality_flags_preserve_but_flag_source_jurisdiction_conflicts(self):
        flags = property_quality_flags(
            {
                "mailing_city_state_zip": "SEOUL  00000 NORTH KOREA",
                "mailing_address_1": "MIRAE ASSET CENTER1",
                "current_total_value": "515000000",
                "latest_sale_price_dollars": "445000000",
                "property_type": "Commercial-Office (Large)",
            }
        )
        self.assertIn("mailing_jurisdiction_conflict", flags)
        self.assertNotIn("source_value_rewritten", flags)

    def test_quality_flags_detect_material_price_assessment_outlier(self):
        flags = property_quality_flags(
            {
                "mailing_city_state_zip": "WASHINGTON DC 20001",
                "current_total_value": "100000000",
                "latest_sale_price_dollars": "1000000",
                "property_type": "Commercial-Office (Large)",
            }
        )
        self.assertIn("sale_price_assessment_outlier", flags)


if __name__ == "__main__":
    unittest.main()
