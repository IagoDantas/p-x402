"""``matchPixRequirements`` from ``packages/core/src/matching.ts``."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Union

from .codec import to_json
from .constants import PIX_ASSET_TRANSFER_METHOD, PIX_DYNAMIC_EXTRA_KEYS
from .models import PaymentRequirements

__all__ = ["MatchResult", "match_pix_requirements"]

_MISSING = object()
_DYNAMIC = frozenset(PIX_DYNAMIC_EXTRA_KEYS)
_CORE_FIELDS = (
    ("scheme", "scheme"),
    ("network", "network"),
    ("asset", "asset"),
    ("max_timeout_seconds", "maxTimeoutSeconds"),
)


@dataclass(frozen=True)
class MatchResult:
    ok: bool
    reason: Optional[str] = None
    field: Optional[str] = None


def _as_requirements(value: Union[PaymentRequirements, Mapping[str, Any]]) -> PaymentRequirements:
    if isinstance(value, PaymentRequirements):
        return value
    return PaymentRequirements.from_dict(value)


def _with_defaults(extra: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"assetTransferMethod": PIX_ASSET_TRANSFER_METHOD}
    out.update(extra or {})
    return out


def _same_json(a: Any, b: Any) -> bool:
    if a is _MISSING or b is _MISSING:
        return a is b
    return to_json(a) == to_json(b)


def match_pix_requirements(
    accepted: Union[PaymentRequirements, Mapping[str, Any]],
    required: Union[PaymentRequirements, Mapping[str, Any]],
) -> MatchResult:
    """Compares what the client accepted against what the server requires now.

    Order (first difference wins): amount, payTo, scheme, network, asset, maxTimeoutSeconds,
    extra.resourceUrl, then every non-dynamic key of ``required.extra``. Dynamic keys
    (chargeId, brCode, brCodeBase64, expiresAt) and keys only in ``accepted.extra`` are ignored;
    a missing assetTransferMethod counts as "pix-charge" on both sides.
    """
    a = _as_requirements(accepted)
    r = _as_requirements(required)
    if a.amount != r.amount:
        return MatchResult(False, "amount_mismatch", "amount")
    if a.pay_to != r.pay_to:
        return MatchResult(False, "pay_to_mismatch", "payTo")
    for attr, name in _CORE_FIELDS:
        if getattr(a, attr) != getattr(r, attr):
            return MatchResult(False, "requirements_mismatch", name)
    a_extra = _with_defaults(a.extra)
    r_extra = _with_defaults(r.extra)
    if not _same_json(a_extra.get("resourceUrl", _MISSING), r_extra.get("resourceUrl", _MISSING)):
        return MatchResult(False, "resource_mismatch", "extra.resourceUrl")
    for key, value in r_extra.items():
        if key in _DYNAMIC:
            continue
        if not _same_json(a_extra.get(key, _MISSING), value):
            return MatchResult(False, "requirements_mismatch", f"extra.{key}")
    return MatchResult(True)
