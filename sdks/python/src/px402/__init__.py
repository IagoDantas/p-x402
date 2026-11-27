"""p-x402 client SDK: call APIs that answer ``402 Payment Required`` with a Pix charge.

>>> import px402
>>> with px402.Px402Client(payer=px402.SimulatePayer("http://localhost:4020")) as client:
...     response = client.get("http://localhost:3000/relatorio")
"""

from .brcode import BrCodeInfo, parse_br_code
from .client import AsyncPx402Client, AsyncPx402Transport, Px402Client, Px402Transport
from .codec import (
    decode_json_header,
    decode_payment_payload,
    decode_payment_required,
    decode_settlement_response,
    encode_json_header,
    encode_payment_payload,
    encode_payment_required,
    encode_settlement_response,
)
from .constants import (
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_RESPONSE,
    HEADER_PAYMENT_SIGNATURE,
    MAX_HEADER_LENGTH,
    PIX_ASSET,
    PIX_NETWORK,
    PIX_SCHEME,
    X402_VERSION,
)
from .errors import PX402_ERROR_CODES, Px402Error, is_px402_error_code
from .matching import MatchResult, match_pix_requirements
from .models import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    PixExtra,
    PixPaymentPayload,
    PixPaymentRequirements,
    ResourceInfo,
    SchemaError,
    SettlementResponse,
    parse_pix_payment_payload,
    parse_pix_requirements,
    pix_requirements_error,
)
from .payers import SimulatePayer, TerminalPayer, format_brl
from .types import AsyncPayer, Payer, PaymentEvent, PixChargeToPay, RetryOptions, SpendingPolicy

__version__ = "0.1.0"

__all__ = [
    "AsyncPayer",
    "AsyncPx402Client",
    "AsyncPx402Transport",
    "BrCodeInfo",
    "HEADER_PAYMENT_REQUIRED",
    "HEADER_PAYMENT_RESPONSE",
    "HEADER_PAYMENT_SIGNATURE",
    "MAX_HEADER_LENGTH",
    "MatchResult",
    "PIX_ASSET",
    "PIX_NETWORK",
    "PIX_SCHEME",
    "PX402_ERROR_CODES",
    "Payer",
    "PaymentEvent",
    "PaymentPayload",
    "PaymentRequired",
    "PaymentRequirements",
    "PixChargeToPay",
    "PixExtra",
    "PixPaymentPayload",
    "PixPaymentRequirements",
    "Px402Client",
    "Px402Error",
    "Px402Transport",
    "ResourceInfo",
    "RetryOptions",
    "SchemaError",
    "SettlementResponse",
    "SimulatePayer",
    "SpendingPolicy",
    "TerminalPayer",
    "X402_VERSION",
    "decode_json_header",
    "decode_payment_payload",
    "decode_payment_required",
    "decode_settlement_response",
    "encode_json_header",
    "encode_payment_payload",
    "encode_payment_required",
    "encode_settlement_response",
    "format_brl",
    "is_px402_error_code",
    "match_pix_requirements",
    "parse_br_code",
    "parse_pix_payment_payload",
    "parse_pix_requirements",
    "pix_requirements_error",
]
