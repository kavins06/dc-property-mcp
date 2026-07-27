from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


_SPACE_RE = re.compile(r"\s+")
_ADDRESS_PUNCT_RE = re.compile(r"[^A-Z0-9 ]+")


def normalize_ssl(value: str | None) -> str:
    """Return a stable compact lookup key without claiming physical-parcel identity."""
    raw = (value or "").strip().upper()
    return _SPACE_RE.sub("", raw.replace("-", ""))


def display_ssl(value: str | None) -> str:
    raw = (value or "").strip().upper()
    if raw.startswith("PI"):
        return raw
    compact = normalize_ssl(raw)
    if len(compact) >= 8:
        return f"{compact[:4]}-{compact[4:-4]}-{compact[-4:]}"
    return raw


def normalize_address(value: str | None) -> str:
    raw = (value or "").upper().strip()
    raw = _ADDRESS_PUNCT_RE.sub(" ", raw)
    return _SPACE_RE.sub(" ", raw).strip()


def money_to_cents(value: str | None) -> str:
    raw = (value or "").strip().replace(",", "").replace("$", "")
    if not raw:
        return ""
    try:
        amount = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid currency value: {value!r}") from exc
    return str(int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))


def whole_dollars(value: str | None) -> str:
    raw = (value or "").strip().replace(",", "").replace("$", "")
    if not raw:
        return ""
    try:
        amount = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid assessment value: {value!r}") from exc
    return str(int(amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP)))


def iso_date(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    return raw[:10].replace("/", "-")


def pg_array(values: list[str], quote: bool = False) -> str:
    items: list[str] = []
    for value in values:
        if value == "":
            items.append("NULL")
        elif quote:
            items.append('"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"')
        else:
            items.append(value)
    return "{" + ",".join(items) + "}"
