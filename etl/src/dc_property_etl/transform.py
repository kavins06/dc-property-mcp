from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


_SPACE_RE = re.compile(r"\s+")
_ADDRESS_PUNCT_RE = re.compile(r"[^A-Z0-9 ]+")
_PROPERTY_TYPE_REPAIRS = {
    "Residential-Condominium (Garag": "Residential-Condominium (Garage)",
    "Commercial-Office (Condominium": "Commercial-Office (Condominium)",
    "Commercial-Office (Miscellaneo": "Commercial-Office (Miscellaneous)",
    "Office-Condominium (Horizontal": "Office-Condominium (Horizontal)",
}


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


def canonical_property_type(value: str | None) -> str:
    """Return a stable display label while preserving the source label separately."""
    raw = (value or "").strip()
    if not raw:
        return ""
    repaired = _PROPERTY_TYPE_REPAIRS.get(raw, raw)
    if repaired == "Vacant-True":
        return "Vacant"
    match = re.fullmatch(r"(.+?) \((.+)\)", repaired)
    if match:
        base = match.group(1).replace("-", " ")
        detail = match.group(2).replace("-", " ")
        return f"{base} — {detail}"
    return repaired.replace("-", " ")


def property_quality_flags(record: dict[str, str]) -> list[str]:
    """Flag source anomalies without changing the reported public-record values."""
    flags: list[str] = []
    mailing = (record.get("mailing_city_state_zip") or "").upper()
    if "SEOUL" in mailing and "NORTH KOREA" in mailing:
        flags.append("mailing_jurisdiction_conflict")

    assessment_raw = (record.get("current_total_value") or "").strip()
    sale_raw = (record.get("latest_sale_price_dollars") or "").strip()
    try:
        assessment = Decimal(assessment_raw)
        sale = Decimal(sale_raw)
    except InvalidOperation:
        assessment = Decimal(0)
        sale = Decimal(0)
    if assessment > 0 and sale > 0:
        ratio = sale / assessment
        if ratio < Decimal("0.05") or ratio > Decimal("20"):
            flags.append("sale_price_assessment_outlier")

    if len(record.get("property_type") or "") >= 30:
        flags.append("property_type_source_length_limit")
    if len(record.get("premise_address") or "") >= 50:
        flags.append("premise_address_source_length_limit")
    return flags


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
