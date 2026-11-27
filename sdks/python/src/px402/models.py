"""Typed models and validation for the x402 v2 objects p-x402 uses.

Validation mirrors the Zod schemas in ``packages/core/src/schemas.ts``: unknown keys are dropped,
``to_dict()`` returns keys in schema order, and keys inside ``extra``, ``payload`` and
``extensions`` keep the order they arrived in. That keeps re-encoded headers byte-identical to the
TypeScript implementation.

There are two levels, as in TypeScript: the generic x402 models (any scheme or network) and the
p-x402 Pix profile on top (:func:`parse_pix_requirements`, :func:`parse_pix_payment_payload`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional
from urllib.parse import urlsplit

from .constants import (
    PIX_ASSET,
    PIX_ASSET_TRANSFER_METHOD,
    PIX_NETWORK,
    PIX_PAYMENT_FLOW,
    PIX_SCHEME,
    X402_VERSION,
)

__all__ = [
    "SchemaError",
    "ResourceInfo",
    "PaymentRequirements",
    "PaymentRequired",
    "PaymentPayload",
    "SettlementResponse",
    "PixExtra",
    "PixPaymentRequirements",
    "PixPaymentPayload",
    "parse_pix_requirements",
    "parse_pix_payment_payload",
    "pix_requirements_error",
]

_MAX_SAFE_INTEGER = 2**53 - 1
_AMOUNT_RE = re.compile(r"[1-9][0-9]{0,15}", re.ASCII)
_DATE = (
    r"(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29"
    r"|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)"
    r"|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
)
# Same pattern as Zod 4's z.iso.datetime({ offset: true }): seconds required, Z or +hh:mm.
_DATETIME_RE = re.compile(
    _DATE + r"T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)",
    re.ASCII,
)


class SchemaError(ValueError):
    """A value does not match a schema. ``path`` names the first offending field."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path or '(root)'}: {message}")
        self.path = path


# --- primitive checks -----------------------------------------------------------------------


def _js_length(text: str) -> int:
    """String length as JavaScript counts it (UTF-16 code units)."""
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _object(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise SchemaError(path, "expected an object")
    return value


def _string(value: Any, path: str, min_len: int = 0, max_len: Optional[int] = None) -> str:
    if not isinstance(value, str):
        raise SchemaError(path, "expected a string")
    length = _js_length(value)
    if length < min_len:
        raise SchemaError(path, f"must have at least {min_len} characters")
    if max_len is not None and length > max_len:
        raise SchemaError(path, f"must have at most {max_len} characters")
    return value


def _optional_string(
    obj: Mapping[str, Any], key: str, path: str, max_len: Optional[int] = None
) -> Optional[str]:
    if key not in obj:
        return None
    return _string(obj[key], _join(path, key), max_len=max_len)


def _positive_int(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SchemaError(path, "expected a number")
    if isinstance(value, float):
        if not value.is_integer():
            raise SchemaError(path, "expected an integer")
        value = int(value)
    if abs(value) > _MAX_SAFE_INTEGER:
        raise SchemaError(path, "expected a safe integer")
    if value <= 0:
        raise SchemaError(path, "must be positive")
    return value


def _literal(value: Any, expected: Any, path: str) -> Any:
    if isinstance(value, bool) != isinstance(expected, bool) or value != expected:
        raise SchemaError(path, f"expected {expected!r}")
    return expected


def _record(value: Any, path: str) -> Dict[str, Any]:
    return dict(_object(value, path))


def _optional_record(obj: Mapping[str, Any], key: str, path: str) -> Optional[Dict[str, Any]]:
    if key not in obj:
        return None
    return _record(obj[key], _join(path, key))


def _require(obj: Mapping[str, Any], key: str, path: str) -> Any:
    if key not in obj:
        raise SchemaError(_join(path, key), "required")
    return obj[key]


def is_http_url(value: str) -> bool:
    """Absolute http(s) URL without a fragment, at most 2048 characters (``HttpUrlSchema``)."""
    if _js_length(value) > 2048 or value != value.strip() or any(c in value for c in "\t\n\r"):
        return False
    try:
        parts = urlsplit(value)
        _ = parts.port  # raises ValueError on a bad port
    except ValueError:
        return False
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return False
    if " " in parts.netloc or not value.lower().startswith(parts.scheme.lower() + "://"):
        return False
    return parts.fragment == ""


def _http_url(value: Any, path: str) -> str:
    text = _string(value, path)
    if not is_http_url(text):
        raise SchemaError(path, "absolute http(s) URL without fragment")
    return text


def _datetime(value: Any, path: str) -> str:
    text = _string(value, path)
    if not _DATETIME_RE.fullmatch(text):
        raise SchemaError(path, "ISO 8601 date-time with Z or an offset")
    return text


def _put(out: Dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        out[key] = value


# --- generic x402 models --------------------------------------------------------------------


@dataclass
class ResourceInfo:
    url: str
    description: Optional[str] = None
    mime_type: Optional[str] = None

    @classmethod
    def from_dict(cls, value: Any, path: str = "") -> "ResourceInfo":
        obj = _object(value, path)
        return cls(
            url=_http_url(_require(obj, "url", path), _join(path, "url")),
            description=_optional_string(obj, "description", path, max_len=500),
            mime_type=_optional_string(obj, "mimeType", path, max_len=200),
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"url": self.url}
        _put(out, "description", self.description)
        _put(out, "mimeType", self.mime_type)
        return out


@dataclass
class PaymentRequirements:
    """Spec-level requirements: any scheme or network. ``extra`` keeps its key order."""

    scheme: str
    network: str
    amount: str
    asset: str
    pay_to: str
    max_timeout_seconds: int
    extra: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, value: Any, path: str = "") -> "PaymentRequirements":
        obj = _object(value, path)

        def text(key: str) -> str:
            return _string(_require(obj, key, path), _join(path, key), min_len=1)

        return cls(
            scheme=text("scheme"),
            network=text("network"),
            amount=text("amount"),
            asset=text("asset"),
            pay_to=text("payTo"),
            max_timeout_seconds=_positive_int(
                _require(obj, "maxTimeoutSeconds", path), _join(path, "maxTimeoutSeconds")
            ),
            extra=_optional_record(obj, "extra", path),
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "scheme": self.scheme,
            "network": self.network,
            "amount": self.amount,
            "asset": self.asset,
            "payTo": self.pay_to,
            "maxTimeoutSeconds": self.max_timeout_seconds,
        }
        _put(out, "extra", self.extra)
        return out


@dataclass
class PaymentRequired:
    """Body of the ``PAYMENT-REQUIRED`` header (the 402 challenge)."""

    resource: ResourceInfo
    accepts: List[PaymentRequirements]
    x402_version: int = X402_VERSION
    error: Optional[str] = None
    extensions: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, value: Any, path: str = "") -> "PaymentRequired":
        obj = _object(value, path)
        version = _literal(_require(obj, "x402Version", path), X402_VERSION, _join(path, "x402Version"))
        error = _optional_string(obj, "error", path)
        resource = ResourceInfo.from_dict(_require(obj, "resource", path), _join(path, "resource"))
        raw_accepts = _require(obj, "accepts", path)
        accepts_path = _join(path, "accepts")
        if not isinstance(raw_accepts, list):
            raise SchemaError(accepts_path, "expected an array")
        if len(raw_accepts) < 1:
            raise SchemaError(accepts_path, "needs at least one option")
        accepts = [
            PaymentRequirements.from_dict(item, f"{accepts_path}.{index}")
            for index, item in enumerate(raw_accepts)
        ]
        return cls(
            x402_version=version,
            error=error,
            resource=resource,
            accepts=accepts,
            extensions=_optional_record(obj, "extensions", path),
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"x402Version": self.x402_version}
        _put(out, "error", self.error)
        out["resource"] = self.resource.to_dict()
        out["accepts"] = [item.to_dict() for item in self.accepts]
        _put(out, "extensions", self.extensions)
        return out


@dataclass
class PaymentPayload:
    """Body of the ``PAYMENT-SIGNATURE`` header (the paid retry)."""

    accepted: PaymentRequirements
    payload: Dict[str, Any]
    x402_version: int = X402_VERSION
    resource: Optional[ResourceInfo] = None
    extensions: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, value: Any, path: str = "") -> "PaymentPayload":
        obj = _object(value, path)
        version = _literal(_require(obj, "x402Version", path), X402_VERSION, _join(path, "x402Version"))
        resource = (
            ResourceInfo.from_dict(obj["resource"], _join(path, "resource")) if "resource" in obj else None
        )
        accepted = PaymentRequirements.from_dict(_require(obj, "accepted", path), _join(path, "accepted"))
        payload = _record(_require(obj, "payload", path), _join(path, "payload"))
        return cls(
            x402_version=version,
            resource=resource,
            accepted=accepted,
            payload=payload,
            extensions=_optional_record(obj, "extensions", path),
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"x402Version": self.x402_version}
        if self.resource is not None:
            out["resource"] = self.resource.to_dict()
        out["accepted"] = self.accepted.to_dict()
        out["payload"] = self.payload
        _put(out, "extensions", self.extensions)
        return out


@dataclass
class SettlementResponse:
    """Body of the ``PAYMENT-RESPONSE`` header."""

    success: bool
    transaction: str
    network: str
    error_reason: Optional[str] = None
    payer: Optional[str] = None
    amount: Optional[str] = None
    extensions: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, value: Any, path: str = "") -> "SettlementResponse":
        obj = _object(value, path)
        success = _require(obj, "success", path)
        if not isinstance(success, bool):
            raise SchemaError(_join(path, "success"), "expected a boolean")
        return cls(
            success=success,
            error_reason=_optional_string(obj, "errorReason", path),
            payer=_optional_string(obj, "payer", path),
            transaction=_string(_require(obj, "transaction", path), _join(path, "transaction")),
            network=_string(_require(obj, "network", path), _join(path, "network")),
            amount=_optional_string(obj, "amount", path),
            extensions=_optional_record(obj, "extensions", path),
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"success": self.success}
        _put(out, "errorReason", self.error_reason)
        _put(out, "payer", self.payer)
        out["transaction"] = self.transaction
        out["network"] = self.network
        _put(out, "amount", self.amount)
        _put(out, "extensions", self.extensions)
        return out


# --- the p-x402 Pix profile -----------------------------------------------------------------


@dataclass
class PixExtra:
    payment_flow: str
    asset_transfer_method: str
    provider: str
    resource_url: str
    charge_id: str
    br_code: str
    expires_at: str
    br_code_base64: Optional[str] = None

    @classmethod
    def from_dict(cls, value: Any, path: str = "extra") -> "PixExtra":
        obj = _object(value, path)
        flow = _literal(_require(obj, "paymentFlow", path), PIX_PAYMENT_FLOW, _join(path, "paymentFlow"))
        method = PIX_ASSET_TRANSFER_METHOD
        if "assetTransferMethod" in obj:
            method = _literal(
                obj["assetTransferMethod"], PIX_ASSET_TRANSFER_METHOD, _join(path, "assetTransferMethod")
            )
        return cls(
            payment_flow=flow,
            asset_transfer_method=method,
            provider=_string(_require(obj, "provider", path), _join(path, "provider"), 1, 64),
            resource_url=_http_url(_require(obj, "resourceUrl", path), _join(path, "resourceUrl")),
            charge_id=_string(_require(obj, "chargeId", path), _join(path, "chargeId"), 1, 128),
            br_code=_string(_require(obj, "brCode", path), _join(path, "brCode"), 1, 1024),
            br_code_base64=_optional_string(obj, "brCodeBase64", path, max_len=4096),
            expires_at=_datetime(_require(obj, "expiresAt", path), _join(path, "expiresAt")),
        )

    def to_dict(self) -> Dict[str, Any]:
        """Keys in the order the Zod schema outputs them (unknown keys dropped, default filled)."""
        out: Dict[str, Any] = {
            "paymentFlow": self.payment_flow,
            "assetTransferMethod": self.asset_transfer_method,
            "provider": self.provider,
            "resourceUrl": self.resource_url,
            "chargeId": self.charge_id,
            "brCode": self.br_code,
        }
        _put(out, "brCodeBase64", self.br_code_base64)
        out["expiresAt"] = self.expires_at
        return out


@dataclass
class PixPaymentRequirements:
    """A requirements option that is a valid p-x402 Pix option. ``raw`` is the generic object."""

    amount: str
    pay_to: str
    max_timeout_seconds: int
    extra: PixExtra
    raw: PaymentRequirements
    scheme: str = PIX_SCHEME
    network: str = PIX_NETWORK
    asset: str = PIX_ASSET

    def to_dict(self) -> Dict[str, Any]:
        """The parsed Pix requirements in Zod output order (``raw`` keeps what arrived)."""
        return {
            "scheme": self.scheme,
            "network": self.network,
            "amount": self.amount,
            "asset": self.asset,
            "payTo": self.pay_to,
            "maxTimeoutSeconds": self.max_timeout_seconds,
            "extra": self.extra.to_dict(),
        }


def parse_pix_requirements(value: Any, path: str = "") -> PixPaymentRequirements:
    """Checks a requirements object (dict or :class:`PaymentRequirements`) against the Pix profile."""
    raw = value if isinstance(value, PaymentRequirements) else None
    obj = _object(raw.to_dict() if raw else value, path)
    _literal(_require(obj, "scheme", path), PIX_SCHEME, _join(path, "scheme"))
    _literal(_require(obj, "network", path), PIX_NETWORK, _join(path, "network"))
    amount = _string(_require(obj, "amount", path), _join(path, "amount"))
    if not _AMOUNT_RE.fullmatch(amount):
        raise SchemaError(_join(path, "amount"), "positive integer string")
    _literal(_require(obj, "asset", path), PIX_ASSET, _join(path, "asset"))
    pay_to = _string(_require(obj, "payTo", path), _join(path, "payTo"), 1, 128)
    timeout = _positive_int(_require(obj, "maxTimeoutSeconds", path), _join(path, "maxTimeoutSeconds"))
    extra = PixExtra.from_dict(_require(obj, "extra", path), _join(path, "extra"))
    return PixPaymentRequirements(
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=timeout,
        extra=extra,
        raw=raw or PaymentRequirements.from_dict(obj, path),
    )


def pix_requirements_error(value: Any) -> Optional[str]:
    """The code the facilitator's /verify and /settle give these requirements, or None if valid.

    Not x402 requirements at all is ``invalid_payload``; another scheme or network is
    ``unsupported_scheme`` / ``unsupported_network``; any other Pix profile failure is
    ``invalid_payment_requirements``.
    """
    try:
        parse_pix_requirements(value)
        return None
    except SchemaError:
        pass
    try:
        generic = PaymentRequirements.from_dict(value)
    except SchemaError:
        return "invalid_payload"
    if generic.scheme != PIX_SCHEME:
        return "unsupported_scheme"
    if generic.network != PIX_NETWORK:
        return "unsupported_network"
    return "invalid_payment_requirements"


@dataclass
class PixPaymentPayload:
    """A ``PAYMENT-SIGNATURE`` payload that is a p-x402 Pix payload."""

    charge_id: str
    accepted: PixPaymentRequirements
    raw: PaymentPayload = field(repr=False)


def parse_pix_payment_payload(value: Any) -> PixPaymentPayload:
    """Checks a payload (dict or :class:`PaymentPayload`) against the Pix profile."""
    generic = value if isinstance(value, PaymentPayload) else PaymentPayload.from_dict(value)
    accepted = parse_pix_requirements(generic.accepted.to_dict(), "accepted")
    charge_id = _string(_require(generic.payload, "chargeId", "payload"), "payload.chargeId", 1, 128)
    return PixPaymentPayload(charge_id=charge_id, accepted=accepted, raw=generic)
