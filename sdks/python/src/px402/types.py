"""Client-side types: what a payer receives, the spending policy, retry options."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

__all__ = ["PixChargeToPay", "Payer", "AsyncPayer", "PaymentEvent", "SpendingPolicy", "RetryOptions"]

#: Default spending limits, in centavos: R$ 10,00 per request, R$ 50,00 per client.
DEFAULT_MAX_PER_REQUEST = 1000
DEFAULT_MAX_TOTAL = 5000


@dataclass(frozen=True)
class PixChargeToPay:
    """What a payer receives. Contract: never pay more than ``amount`` (centavos)."""

    charge_id: str
    #: Centavos, positive integer string.
    amount: str
    #: The Pix "copia e cola" code (EMV BR Code).
    br_code: str
    expires_at: str
    resource_url: str
    #: QR code image as a data URL, when the server sent one.
    br_code_base64: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Same keys as the TypeScript ``PixChargeToPay``."""
        out: Dict[str, Any] = {"chargeId": self.charge_id, "amount": self.amount, "brCode": self.br_code}
        if self.br_code_base64 is not None:
            out["brCodeBase64"] = self.br_code_base64
        out["expiresAt"] = self.expires_at
        out["resourceUrl"] = self.resource_url
        return out


@runtime_checkable
class Payer(Protocol):
    """Pays one Pix charge, synchronously. Raise to signal failure.

    Set ``pays_br_code = False`` only for payers that never pay the BR Code itself (such as
    :class:`~px402.SimulatePayer`, which marks the charge paid by id). The client then skips the
    BR Code amount check. Payers without the attribute are treated as paying the BR Code.
    """

    def pay(self, charge: PixChargeToPay) -> None: ...


class AsyncPayer(Protocol):
    """A payer for :class:`~px402.AsyncPx402Transport`.

    The async transport calls ``apay`` when the payer has it, otherwise ``pay`` (awaiting the result
    when it is awaitable).
    """

    async def apay(self, charge: PixChargeToPay) -> None: ...


@dataclass(frozen=True)
class PaymentEvent:
    charge_id: str
    amount: str
    resource_url: str
    #: The PAYMENT-SIGNATURE header value; lets a caller resume after a crash.
    payment_signature: str


@dataclass(frozen=True)
class SpendingPolicy:
    """Limits checked before every payment. On by default with conservative limits."""

    #: Centavos. Default 1000 (R$ 10,00).
    max_per_request: int = DEFAULT_MAX_PER_REQUEST
    #: Centavos, over the lifetime of the transport. Default 5000 (R$ 50,00).
    max_total: int = DEFAULT_MAX_TOTAL
    #: Full origins ("https://api.x.com") or hosts ("api.x.com", "localhost:3000").
    #: None means any origin.
    allowed_origins: Optional[List[str]] = field(default=None)


@dataclass(frozen=True)
class RetryOptions:
    """Backoff while the server answers ``settlement_pending``. Seconds."""

    initial_delay: float = 0.5
    max_delay: float = 5.0
    factor: float = 2.0

