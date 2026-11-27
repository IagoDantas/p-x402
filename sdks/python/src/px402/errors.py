"""Stable error codes, the same list as `packages/core/src/errors.ts`."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

PX402_ERROR_CODES: Tuple[str, ...] = (
    # protocol and input
    "invalid_header",
    "invalid_payload",
    "invalid_payment_requirements",
    "invalid_x402_version",
    "unsupported_scheme",
    "unsupported_network",
    "invalid_request",
    # verify and settle
    "charge_not_found",
    "merchant_mismatch",
    "amount_mismatch",
    "pay_to_mismatch",
    "resource_mismatch",
    "requirements_mismatch",
    "settlement_pending",
    "charge_expired",
    "charge_failed",
    "charge_disputed",
    "charge_refunded",
    "charge_already_consumed",
    # infrastructure
    "unauthorized",
    "rate_limited",
    "psp_error",
    "facilitator_error",
    "unexpected_error",
    # webhook
    "invalid_webhook_secret",
    "invalid_webhook_payload",
    # client
    "policy_exceeded",
    "no_supported_requirements",
    "payment_timeout",
    "payer_failed",
    "payment_rejected",
)

_CODE_SET = frozenset(PX402_ERROR_CODES)


def is_px402_error_code(value: object) -> bool:
    return isinstance(value, str) and value in _CODE_SET


class Px402Error(Exception):
    """Error with a stable ``code``. Codes are public API: never renamed.

    ``details`` carries context such as ``reason`` for ``policy_exceeded`` or the
    ``payment_signature`` that lets a caller resume a paid request.
    """

    def __init__(
        self, code: str, message: Optional[str] = None, details: Optional[Dict[str, Any]] = None
    ) -> None:
        if code not in _CODE_SET:
            raise ValueError(f"unknown p-x402 error code: {code!r}")
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.details: Dict[str, Any] = dict(details or {})

    @property
    def reason(self) -> Optional[str]:
        """The detail for ``policy_exceeded`` and BR Code refusals, when there is one."""
        value = self.details.get("reason")
        return value if isinstance(value, str) else None

    def __repr__(self) -> str:
        return f"Px402Error(code={self.code!r}, message={self.message!r})"
