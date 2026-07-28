import csv
import gzip
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]
ETL_SOURCE = PROJECT / "etl" / "src" / "dc_property_etl"
sys.path.insert(0, str(ETL_SOURCE))

import build  # noqa: E402


def load_artifact_validator():
    path = PROJECT / "scripts" / "validate_artifacts.py"
    spec = importlib.util.spec_from_file_location("validate_artifacts", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class PipelineContractTests(unittest.TestCase):
    def test_current_itspe_is_the_only_active_assessment_source(self):
        self.assertEqual(build.ITSPE_SOURCE["source_id"], "itspe_current")
        self.assertEqual(
            build.ITSPE_SOURCE["years"],
            {"prior": 2025, "current": 2026, "proposed": 2027},
        )
        self.assertFalse(hasattr(build, "build_assessments"))

    def test_build_emits_only_current_tax_and_sales_artifacts(self):
        self.assertEqual(
            tuple(build.ARTIFACT_BUILDERS),
            ("property_account_current", "tax_series", "sale_series"),
        )

    def test_validator_requires_only_current_tax_and_sales_artifacts(self):
        validator = load_artifact_validator()
        self.assertEqual(
            tuple(validator.EXPECTED),
            (
                "property_account_current.csv.gz",
                "tax_series.csv.gz",
                "sale_series.csv.gz",
            ),
        )
        self.assertFalse(hasattr(validator, "validate_assessments"))

    def test_validator_rejects_current_rows_missing_an_assessment_stage(self):
        validator = load_artifact_validator()
        fields = [
            "account_id",
            "source_id",
            "ssl_normalized",
            "prior_land_value",
            "prior_improvement_value",
            "prior_total_value",
            "current_land_value",
            "current_improvement_value",
            "current_total_value",
            "proposed_land_value",
            "proposed_improvement_value",
            "proposed_total_value",
        ]
        row = {field: "1" for field in fields}
        row["source_id"] = "itspe_current"
        row["ssl_normalized"] = "55760001"
        row["proposed_total_value"] = ""
        with tempfile.TemporaryDirectory() as temp:
            artifact = Path(temp) / "property_account_current.csv.gz"
            with gzip.open(
                artifact,
                "wt",
                encoding="utf-8",
                newline="",
            ) as handle:
                writer = csv.DictWriter(handle, fieldnames=fields)
                writer.writeheader()
                writer.writerow(row)
            with self.assertRaisesRegex(
                ValueError,
                "missing prior/current/proposed assessment values",
            ):
                validator.validate_current(artifact)


if __name__ == "__main__":
    unittest.main()
