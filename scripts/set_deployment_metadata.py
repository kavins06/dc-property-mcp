#!/usr/bin/env python3
"""Set a non-secret deployment metadata value in the ignored environment file."""
from __future__ import annotations

import argparse
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT / ".env.hosted"
ALLOWED = {
    "SUPABASE_PROJECT_REF",
    "SUPABASE_REGION",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_HYPERDRIVE_ID",
    "WORKOS_AUTHKIT_DOMAIN",
    "WORKOS_RESOURCE_URI",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("name", choices=sorted(ALLOWED))
    parser.add_argument("value")
    args = parser.parse_args()

    existing = OUTPUT.read_text(encoding="utf-8").splitlines() if OUTPUT.exists() else []
    prefix = f"{args.name}="
    lines = [line for line in existing if not line.startswith(prefix)]
    lines.append(prefix + args.value)
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Set {args.name} in ignored deployment metadata.")


if __name__ == "__main__":
    main()
