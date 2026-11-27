"""Codec for the three p-x402 headers: standard base64 of the UTF-8 bytes of compact JSON.

Encoding matches JavaScript's ``JSON.stringify`` + ``btoa`` byte for byte (no whitespace, raw
UTF-8, ``/`` unescaped, padded base64). Decoding matches ``decodeJsonHeader`` in
``packages/core/src/codec.ts``: it trims surrounding whitespace, accepts missing padding, refuses
the URL-safe alphabet, invalid UTF-8 and anything over 16384 characters, and raises
``Px402Error("invalid_header")`` for every failure.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Callable, List, Tuple, TypeVar, Union

from .constants import MAX_HEADER_LENGTH
from .errors import Px402Error
from .models import PaymentPayload, PaymentRequired, SchemaError, SettlementResponse

__all__ = [
    "encode_json_header",
    "decode_json_header",
    "encode_payment_required",
    "decode_payment_required",
    "encode_payment_payload",
    "decode_payment_payload",
    "encode_settlement_response",
    "decode_settlement_response",
    "to_json",
]

_BASE64_RE = re.compile(r"[A-Za-z0-9+/]*")
_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")
_ASCII_WHITESPACE = "\t\n\x0c\r "
_ARRAY_INDEX_MAX = 2**32 - 2


def _is_array_index(key: str) -> bool:
    return key.isdigit() and key.isascii() and (key == "0" or key[0] != "0") and int(key) <= _ARRAY_INDEX_MAX


def _js_ordered(pairs: List[Tuple[str, Any]]) -> dict:
    """Object key order as JavaScript keeps it: array-index keys ascending first, then the rest."""
    index_keys = sorted((int(k), k) for k, _ in pairs if _is_array_index(k))
    out = {k: None for _, k in index_keys}
    for key, value in pairs:
        out[key] = value
    return out


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return _js_ordered([(str(k), _normalize(v)) for k, v in value.items()])
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return int(value)
    return value


def to_json(value: Any) -> str:
    """``JSON.stringify(value)`` for JSON-compatible Python values."""
    if hasattr(value, "to_dict"):
        value = value.to_dict()
    text = json.dumps(_normalize(value), separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    # JSON.stringify escapes lone surrogates instead of writing invalid UTF-8
    return _LONE_SURROGATE_RE.sub(lambda m: "\\u%04x" % ord(m.group()), text)


def encode_json_header(value: Any) -> str:
    """Standard, padded base64 of the UTF-8 bytes of ``JSON.stringify(value)``."""
    data = to_json(value).encode("utf-8")
    return base64.b64encode(data).decode("ascii")


def _atob(text: str) -> bytes:
    """WHATWG forgiving-base64 decode, as ``atob`` does it."""
    data = "".join(ch for ch in text if ch not in _ASCII_WHITESPACE)
    if len(data) % 4 == 0:
        if data.endswith("=="):
            data = data[:-2]
        elif data.endswith("="):
            data = data[:-1]
    if len(data) % 4 == 1 or not _BASE64_RE.fullmatch(data):
        raise ValueError("not base64")
    return base64.b64decode(data + "=" * (-len(data) % 4))


def _reject_constant(name: str) -> Any:
    raise ValueError(f"not JSON: {name}")


def decode_json_header(header: str) -> Any:
    """Inverse of :func:`encode_json_header`. Raises ``Px402Error("invalid_header")``."""
    if not isinstance(header, str):
        raise Px402Error("invalid_header", "header is not a string")
    value = header.strip()
    if len(value) == 0 or len(value) > MAX_HEADER_LENGTH:
        raise Px402Error("invalid_header", "header is empty or too large")
    try:
        raw = _atob(value)
        # utf-8-sig: TextDecoder drops a leading BOM, and fatal mode refuses invalid bytes
        text = raw.decode("utf-8-sig", errors="strict")
        return json.loads(text, object_pairs_hook=_js_ordered, parse_constant=_reject_constant)
    except (ValueError, binascii.Error, UnicodeDecodeError, RecursionError):
        raise Px402Error("invalid_header", "header is not base64-encoded JSON") from None


T = TypeVar("T")


def _decode_with(parse: Callable[[Any], T], header: str, what: str) -> T:
    value = decode_json_header(header)
    try:
        return parse(value)
    except SchemaError as error:
        raise Px402Error(
            "invalid_header",
            f"{what} does not match the schema",
            {"issues": [{"path": error.path, "message": str(error)}]},
        ) from None


def encode_payment_required(value: Union[PaymentRequired, dict]) -> str:
    return encode_json_header(value)


def decode_payment_required(header: str) -> PaymentRequired:
    return _decode_with(PaymentRequired.from_dict, header, "PAYMENT-REQUIRED")


def encode_payment_payload(value: Union[PaymentPayload, dict]) -> str:
    return encode_json_header(value)


def decode_payment_payload(header: str) -> PaymentPayload:
    return _decode_with(PaymentPayload.from_dict, header, "PAYMENT-SIGNATURE")


def encode_settlement_response(value: Union[SettlementResponse, dict]) -> str:
    return encode_json_header(value)


def decode_settlement_response(header: str) -> SettlementResponse:
    return _decode_with(SettlementResponse.from_dict, header, "PAYMENT-RESPONSE")
