#!/usr/bin/env python3
"""Rotate one ignored deployment secret without printing its value."""
from __future__ import annotations

import argparse
import secrets
import string
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT / ".env.hosted"
ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*()-_=+"


def strong_password(length: int = 48) -> str:
    while True:
        value = "".join(secrets.choice(ALPHABET) for _ in range(length))
        if (
            any(c.islower() for c in value)
            and any(c.isupper() for c in value)
            and any(c.isdigit() for c in value)
            and any(c in "!@#$%^&*()-_=+" for c in value)
        ):
            return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("name", choices=["SUPABASE_DB_PASSWORD", "DC_PROPERTY_RUNTIME_PASSWORD"])
    args = parser.parse_args()

    lines = OUTPUT.read_text(encoding="utf-8").splitlines()
    prefix = f"{args.name}="
    replaced = False
    output_lines: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            output_lines.append(prefix + strong_password())
            replaced = True
        else:
            output_lines.append(line)
    if not replaced:
        output_lines.append(prefix + strong_password())
    OUTPUT.write_text("\n".join(output_lines) + "\n", encoding="utf-8")
    print(f"Rotated {args.name} in ignored deployment secret file.")


if __name__ == "__main__":
    main()
