"""Minimal reader for Pix BR Codes (EMV merchant-presented payload), from ``packages/core/src/brcode.ts``.

The client uses it to check that the code it is about to pay asks for the advertised amount.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

__all__ = ["EmvField", "BrCodeInfo", "crc16", "encode_emv", "parse_emv", "brl_to_centavos", "parse_br_code"]

_TWO_DIGITS = re.compile(r"[0-9]{2}")
_BRL = re.compile(r"([0-9]{1,13})(?:\.([0-9]{1,2}))?")


@dataclass(frozen=True)
class EmvField:
    id: str
    value: str


@dataclass
class BrCodeInfo:
    crc_valid: bool
    has_location: bool
    fields: List[EmvField] = field(default_factory=list)
    #: Tag 54 converted to centavos, when present.
    amount: Optional[str] = None


def crc16(text: str) -> str:
    """CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as uppercase hex."""
    crc = 0xFFFF
    for ch in text:
        crc ^= (ord(ch) & 0xFF) << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return format(crc, "04X")


def encode_emv(fields: List[EmvField]) -> str:
    """Encodes TLV fields and appends tag 63 with the CRC."""
    body = "".join(f"{f.id}{len(f.value):02d}{f.value}" for f in fields)
    without_crc = f"{body}6304"
    return without_crc + crc16(without_crc)


def parse_emv(text: str) -> Optional[List[EmvField]]:
    fields: List[EmvField] = []
    i = 0
    while i < len(text):
        if i + 4 > len(text):
            return None
        tag = text[i : i + 2]
        length_text = text[i + 2 : i + 4]
        if not _TWO_DIGITS.fullmatch(tag) or not _TWO_DIGITS.fullmatch(length_text):
            return None
        length = int(length_text)
        value = text[i + 4 : i + 4 + length]
        if len(value) != length:
            return None
        fields.append(EmvField(tag, value))
        i += 4 + length
    return fields


def brl_to_centavos(value: str) -> Optional[str]:
    """Converts "5.00" to "500". None for anything but a plain decimal with up to 2 places."""
    match = _BRL.fullmatch(value)
    if not match:
        return None
    units, cents = match.group(1), match.group(2) or ""
    return str(int(units) * 100 + int(cents.ljust(2, "0")))


def parse_br_code(text: str) -> Optional[BrCodeInfo]:
    """None when the text is not a well-formed EMV payload."""
    fields = parse_emv(text)
    if not fields:
        return None
    last = fields[-1]
    crc_valid = last.id == "63" and len(last.value) == 4 and crc16(text[:-4]) == last.value.upper()
    merchant = next((f for f in fields if f.id == "26"), None)
    sub = (parse_emv(merchant.value) or []) if merchant else []
    has_location = any(f.id == "25" for f in sub)
    raw_amount = next((f.value for f in fields if f.id == "54"), None)
    amount = None if raw_amount is None else brl_to_centavos(raw_amount)
    return BrCodeInfo(crc_valid=crc_valid, has_location=has_location, fields=fields, amount=amount)
