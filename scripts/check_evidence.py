#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


PROJECT = Path(__file__).resolve().parents[1]
EXAMPLES = PROJECT / "docs" / "evidence-examples.json"
REPORT = PROJECT / "db" / "reports" / "generated" / "evidence_check.json"


def main() -> None:
    examples = json.loads(EXAMPLES.read_text(encoding="utf-8"))
    results: dict[str, object] = {
        "tested_at": datetime.now(timezone.utc).isoformat(),
        "examples": {},
    }
    checked_urls: dict[str, int] = {}
    for name, example in examples.items():
        url = example["human_portal_url"]
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            raise RuntimeError(f"{name}: human portal URL is not HTTPS")
        if any(marker in url.lower() for marker in (
            "/arcgis/rest/", "featureserver", "mapserver", "f=json", "/_/retrieve/"
        )):
            raise RuntimeError(f"{name}: machine or session URL used as human evidence")
        steps = example.get("verification_steps", [])
        if not example.get("ssl") or not example.get("address") or len(steps) < 3:
            raise RuntimeError(f"{name}: exact lookup inputs or verification steps are missing")
        source_record_id = example.get("source_record_id")
        if source_record_id and not any(
            str(source_record_id) in step for step in steps
        ):
            raise RuntimeError(
                f"{name}: source record ID is not carried into verification steps"
            )

        if url not in checked_urls:
            request = Request(
                url,
                headers={"User-Agent": "dc-property-mcp-evidence-check/0.3"},
            )
            with urlopen(request, timeout=30) as response:
                if response.status >= 500:
                    raise RuntimeError(
                        f"{name}: human portal failed with HTTP {response.status}"
                    )
                checked_urls[url] = response.status

        results["examples"][name] = {
            "http_status": checked_urls[url],
            "ssl_present": True,
            "address_present": True,
            "source_record_id_present": source_record_id is not None,
            "verification_steps_present": True,
            "human_portal_url": url,
        }

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
