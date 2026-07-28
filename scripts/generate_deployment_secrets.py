#!/usr/bin/env python3
"""Create ignored deployment credentials without printing secret values."""
from __future__ import annotations

import secrets
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT / ".env.hosted"


def strong_secret(length: int = 40) -> str:
    # URL-safe output avoids connection-string quoting problems.
    return secrets.token_urlsafe(length)


def main() -> None:
    if OUTPUT.exists():
        raise SystemExit(f"Refusing to overwrite existing secret file: {OUTPUT}")
    OUTPUT.write_text(
        "\n".join(
            [
                f"DATABASE_ADMIN_PASSWORD={strong_secret()}",
                f"DC_PROPERTY_RUNTIME_PASSWORD={strong_secret()}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    print(f"Created ignored deployment secret file: {OUTPUT}")


if __name__ == "__main__":
    main()
