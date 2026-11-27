"""Framework-free paywall core, mirroring ``createPaywall`` in ``packages/server/src/index.ts``.

The paywall holds no PSP key and no database: it talks to the p-x402 facilitator over HTTP
(``POST /pix/charges``, ``/verify``, ``/settle``) with the merchant token.

Flow for one request to a paid route:

- no ``PAYMENT-SIGNATURE``: per-IP cap, then ``/pix/charges``, then a ``402`` with ``PAYMENT-REQUIRED``;
- with one: decode it, take an in-process lock on the charge, ``/verify``; when valid the caller
  runs the handler and hands its response to :meth:`PaidRequest.finalize`, which settles
  (``/settle`` with an Idempotency-Key, retried on transport errors and 5xx) and adds
  ``PAYMENT-RESPONSE``. A handler response with status >= 400 is not settled, so the paid charge
  stays unused and the client can retry.

Concurrency: one chargeId is served by at most one request at a time per process. Deployments
with several processes need sticky routing per chargeId, or handlers that are safe to run twice.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Iterable, Mapping, Optional, Tuple, Union
from urllib.parse import urlsplit, urlunsplit

import httpx

from ..codec import decode_payment_payload, encode_payment_required, encode_settlement_response, to_json
from ..constants import (
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_RESPONSE,
    HEADER_PAYMENT_SIGNATURE,
    PIX_ASSET,
    PIX_ASSET_TRANSFER_METHOD,
    PIX_NETWORK,
    PIX_PAYMENT_FLOW,
    PIX_SCHEME,
    X402_VERSION,
)
from ..errors import Px402Error
from ..models import (
    SchemaError,
    SettlementResponse,
    _js_length,
    is_http_url,
    parse_pix_payment_payload,
    parse_pix_requirements,
)
from ._limits import UNKNOWN_IP_KEY, RateLimiter, client_ip_key

__all__ = ["Paywall", "PaywallRequest", "PaywallRoute", "PaywallResponse", "PaidRequest"]

log = logging.getLogger("px402.server")

#: Retry-After sent with ``settlement_pending``.
SETTLEMENT_PENDING_RETRY_AFTER_SECONDS = 2
DEFAULT_IP_RATE_LIMIT = (10, 60.0)
DEFAULT_FACILITATOR_TIMEOUT = 15.0
SETTLE_RETRIES = 2
LOCK_STALE_SECONDS = 60.0
LOCK_SWEEP_SIZE = 1024
UNPAYABLE_METHODS = frozenset(("HEAD", "OPTIONS"))
_AMOUNT_RE = re.compile(r"[1-9][0-9]{0,15}", re.ASCII)
_MAX_SAFE_INTEGER = 2**53 - 1
_DEFAULT_PORTS = {"http": 80, "https": 443}


# --- public data types ----------------------------------------------------------------------


@dataclass
class PaywallRoute:
    """A paid route. ``amount`` is in centavos."""

    amount: Union[str, int]
    description: Optional[str] = None
    mime_type: Optional[str] = None
    #: Absolute resource URL; overrides the request URL (but not ``public_origin``).
    resource: Optional[str] = None


class _Headers:
    """Case-insensitive read-only view over request headers."""

    def __init__(self, headers: Union[Mapping[str, str], Iterable[Tuple[str, str]], None]) -> None:
        items = headers.items() if isinstance(headers, Mapping) else (headers or [])
        self._values: Dict[str, str] = {}
        for name, value in items:
            self._values.setdefault(name.lower(), value)

    def get(self, name: str) -> Optional[str]:
        return self._values.get(name.lower())


@dataclass
class PaywallRequest:
    """What the paywall needs from an incoming request."""

    method: str
    #: The full request URL as the server received it.
    url: str
    headers: Union[Mapping[str, str], Iterable[Tuple[str, str]]] = field(default_factory=dict)
    #: For the per-IP cap on charge creation. None shares one "unknown" bucket.
    client_ip: Optional[str] = None


@dataclass
class PaywallResponse:
    """A response to send as is. Header names are lowercase."""

    status: int
    headers: Dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


def _json_response(status: int, body: Any, headers: Optional[Dict[str, str]] = None) -> PaywallResponse:
    out = {"content-type": "application/json"}
    out.update({k.lower(): v for k, v in (headers or {}).items()})
    return PaywallResponse(status, out, to_json(body).encode("utf-8"))


def _failure_settlement(reason: str, charge_id: str) -> SettlementResponse:
    return SettlementResponse(success=False, error_reason=reason, transaction=charge_id, network=PIX_NETWORK)


@dataclass
class _Outcome:
    kind: str  # "value" | "failed" | "response"
    value: Any = None
    reason: str = ""
    response: Optional[PaywallResponse] = None


class PaidRequest:
    """The request is paid (verified). Run the handler, then call :meth:`finalize` with its response.

    If the handler raises, call :meth:`release` instead so the charge can be used again.
    """

    def __init__(
        self,
        charge_id: str,
        amount: str,
        requirements: Dict[str, Any],
        finalize: Callable[["PaywallResponse"], Awaitable["PaywallResponse"]],
        release: Callable[[], None],
    ) -> None:
        self.charge_id = charge_id
        self.amount = amount
        self.requirements = requirements
        self._finalize = finalize
        self._release = release

    async def finalize(self, response: PaywallResponse) -> PaywallResponse:
        """Settles after the handler ran and returns the response to send. Always releases the lock."""
        return await self._finalize(response)

    def release(self) -> None:
        """Releases the charge lock without settling. Idempotent; finalize calls it too."""
        self._release()


# --- helpers --------------------------------------------------------------------------------


def _parse_origin(value: str) -> str:
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise Px402Error("invalid_request", "public_origin is not a URL") from None
    scheme = parts.scheme.lower()
    ok = (
        scheme in _DEFAULT_PORTS
        and bool(parts.hostname)
        and parts.path in ("",)
        and not parts.query
        and not parts.fragment
        and parts.username is None
        and parts.password is None
        and "?" not in value
        and "#" not in value
        and not value.endswith("/")
    )
    if not ok:
        raise Px402Error("invalid_request", "public_origin must be an http(s) origin")
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        host = f"{host}:{port}"
    return f"{scheme}://{host}"


def _split_request_url(url: str) -> Tuple[str, str, str]:
    """(origin, pathname, search) of an absolute request URL, the way WHATWG URL gives them."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise Px402Error("invalid_request", "request URL is not a URL") from None
    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parts.hostname:
        raise Px402Error("invalid_request", "request URL must be absolute http(s)")
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        host = f"{host}:{port}"
    path = parts.path or "/"
    search = f"?{parts.query}" if parts.query else ""
    return f"{scheme}://{host}", path, search


def _route_amount(amount: Union[str, int]) -> str:
    if isinstance(amount, bool):
        raise Px402Error("invalid_request", "route amount must be a positive integer")
    if isinstance(amount, int):
        if abs(amount) > _MAX_SAFE_INTEGER:
            raise Px402Error("invalid_request", "route amount must be a positive integer")
        text = str(amount)
    elif isinstance(amount, str):
        text = amount
    else:
        raise Px402Error("invalid_request", "route amount must be a positive integer")
    if not _AMOUNT_RE.fullmatch(text):
        raise Px402Error("invalid_request", "route amount must be a positive integer")
    return text


def _validate_route(route: PaywallRoute) -> str:
    amount = _route_amount(route.amount)
    if route.description is not None and _js_length(route.description) > 140:
        raise Px402Error("invalid_request", "route description is longer than 140 characters")
    if route.mime_type is not None and _js_length(route.mime_type) > 200:
        raise Px402Error("invalid_request", "route mimeType is too long")
    if route.resource is not None and not is_http_url(route.resource):
        raise Px402Error("invalid_request", "route resource must be an absolute http(s) URL")
    return amount


def _verify_response(body: Any) -> Optional[Tuple[bool, Optional[str]]]:
    """(isValid, invalidReason) when the body matches VerifyResponseSchema."""
    if not isinstance(body, dict) or not isinstance(body.get("isValid"), bool):
        return None
    for key in ("invalidReason", "payer"):
        if key in body and not isinstance(body[key], str):
            return None
    for key in ("extensions", "extra"):
        if key in body and not isinstance(body[key], dict):
            return None
    return body["isValid"], body.get("invalidReason")


@dataclass
class _Answer:
    ok: bool
    status: int = 0
    headers: Optional[httpx.Headers] = None
    body: Any = None


# --- the paywall ----------------------------------------------------------------------------


class Paywall:
    """Paywall core. One instance per process (it holds the per-IP cap and the charge locks).

    >>> paywall = Paywall("http://localhost:4020", token=os.environ["PX402_MERCHANT_TOKEN"])
    >>> result = await paywall.handle(PaywallRequest("GET", url, headers, client_ip), PaywallRoute(500))
    """

    def __init__(
        self,
        facilitator_url: str,
        token: str,
        *,
        http_client: Optional[httpx.AsyncClient] = None,
        clock: Optional[Callable[[], float]] = None,
        ip_rate_limit: Tuple[int, float] = DEFAULT_IP_RATE_LIMIT,
        public_origin: Optional[str] = None,
        facilitator_timeout: float = DEFAULT_FACILITATOR_TIMEOUT,
    ) -> None:
        try:
            parts = urlsplit(facilitator_url)
        except ValueError:
            parts = None
        if parts is None or not parts.scheme or not parts.netloc:
            raise Px402Error("invalid_request", "facilitator_url is not a URL")
        if not token:
            raise Px402Error("invalid_request", "token is required")
        self._base = facilitator_url.rstrip("/")
        self._token = token
        self._public_origin = None if public_origin is None else _parse_origin(public_origin)
        self._http = http_client
        self._timeout = facilitator_timeout
        self._clock = clock or time.time
        limit, window_seconds = ip_rate_limit
        self._limiter = RateLimiter(limit, window_seconds * 1000, lambda: self._clock() * 1000)
        self._warned_unknown_ip = False
        self._locks: Dict[str, object] = {}
        self._lock_times: Dict[str, float] = {}
        self._mutex = threading.Lock()

    # -- charge locks

    def _acquire(self, charge_id: str) -> Optional[Callable[[], None]]:
        with self._mutex:
            at = self._clock()
            held_at = self._lock_times.get(charge_id)
            if held_at is not None and at - held_at < LOCK_STALE_SECONDS:
                return None
            if len(self._locks) >= LOCK_SWEEP_SIZE:
                for cid in [c for c, t in self._lock_times.items() if at - t >= LOCK_STALE_SECONDS]:
                    self._locks.pop(cid, None)
                    self._lock_times.pop(cid, None)
            token = object()
            self._locks[charge_id] = token
            self._lock_times[charge_id] = at

        def release() -> None:
            with self._mutex:
                # A stale lock may have been taken over: release only our own.
                if self._locks.get(charge_id) is token:
                    del self._locks[charge_id]
                    del self._lock_times[charge_id]

        return release

    # -- facilitator HTTP

    async def _post(self, path: str, body: Any, extra_headers: Optional[Dict[str, str]] = None) -> _Answer:
        headers = {"authorization": f"Bearer {self._token}", "content-type": "application/json"}
        headers.update(extra_headers or {})
        url = f"{self._base}{path}"
        content = to_json(body).encode("utf-8")
        try:
            if self._http is not None:
                response = await self._http.post(url, content=content, headers=headers, timeout=self._timeout)
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    response = await client.post(url, content=content, headers=headers)
        except Exception:  # transport error, timeout: like a fetch that rejected
            return _Answer(ok=False)
        text = response.text
        try:
            parsed = None if text == "" else json.loads(text)
        except ValueError:
            parsed = None
        return _Answer(ok=True, status=response.status_code, headers=response.headers, body=parsed)

    def _facilitator_error(self, charge_id: str) -> PaywallResponse:
        return _json_response(
            502,
            {"error": "facilitator_error"},
            {HEADER_PAYMENT_RESPONSE: encode_settlement_response(_failure_settlement("facilitator_error", charge_id))},
        )

    @staticmethod
    def _unauthorized(path: str) -> PaywallResponse:
        log.error("p-x402: facilitator rejected the merchant token (401 on %s)", path)
        return _json_response(500, {"error": "unauthorized"})

    async def _verify_or_settle(
        self, path: str, body: Any, charge_id: str, idempotency_key: Optional[str] = None
    ) -> _Outcome:
        headers = {} if idempotency_key is None else {"idempotency-key": idempotency_key}
        answer = await self._post(path, body, headers)
        if idempotency_key is not None:
            retry = 0
            while retry < SETTLE_RETRIES and (not answer.ok or answer.status >= 500):
                answer = await self._post(path, body, headers)
                retry += 1
        if not answer.ok or answer.status >= 500:
            return _Outcome("response", response=self._facilitator_error(charge_id))
        if answer.status == 401:
            return _Outcome("response", response=self._unauthorized(path))
        if answer.status not in (200, 400):
            return _Outcome("response", response=self._facilitator_error(charge_id))
        # Success counts only on a 200; a 400 may carry a failure reason, never a success.
        if path == "/verify":
            verified = _verify_response(answer.body)
            if verified is None:
                return _Outcome("response", response=self._facilitator_error(charge_id))
            is_valid, reason = verified
            if is_valid:
                if answer.status != 200:
                    return _Outcome("response", response=self._facilitator_error(charge_id))
                return _Outcome("value")
            return _Outcome("failed", reason=reason if reason is not None else "unexpected_error")
        try:
            parsed = SettlementResponse.from_dict(answer.body)
        except SchemaError:
            return _Outcome("response", response=self._facilitator_error(charge_id))
        if parsed.success:
            if answer.status != 200:
                return _Outcome("response", response=self._facilitator_error(charge_id))
            # Rebuild instead of forwarding: never pass payer data (LGPD) or foreign fields on.
            return _Outcome(
                "value",
                value=SettlementResponse(
                    success=True, transaction=charge_id, network=PIX_NETWORK, amount=parsed.amount
                ),
            )
        reason = parsed.error_reason if parsed.error_reason is not None else "unexpected_error"
        return _Outcome("failed", reason=reason)

    @staticmethod
    def _failure_response(reason: str, charge_id: str, payment_required: Dict[str, Any]) -> PaywallResponse:
        settlement = encode_settlement_response(_failure_settlement(reason, charge_id))
        if reason == "settlement_pending":
            body = dict(payment_required)
            body["error"] = "settlement_pending"
            return _json_response(
                402,
                body,
                {
                    HEADER_PAYMENT_REQUIRED: encode_payment_required(body),
                    HEADER_PAYMENT_RESPONSE: settlement,
                    "retry-after": str(SETTLEMENT_PENDING_RETRY_AFTER_SECONDS),
                },
            )
        return _json_response(402, {}, {HEADER_PAYMENT_RESPONSE: settlement})

    @staticmethod
    def _bad_header(reason: str) -> PaywallResponse:
        return _json_response(
            400,
            {"error": reason},
            {HEADER_PAYMENT_RESPONSE: encode_settlement_response(_failure_settlement(reason, ""))},
        )

    def _resource_url(self, url: str, route: PaywallRoute) -> str:
        origin, path, search = _split_request_url(url)
        if self._public_origin is not None:
            return f"{self._public_origin}{path}{search}"
        if route.resource is not None:
            return route.resource
        scheme, netloc = origin.split("://", 1)
        return urlunsplit((scheme, netloc, path, search[1:], ""))

    async def _create_charge(
        self, resource: Dict[str, Any], amount: str, route: PaywallRoute, client_ip: Optional[str]
    ) -> PaywallResponse:
        key = client_ip_key(client_ip)
        if key == UNKNOWN_IP_KEY and not self._warned_unknown_ip:
            self._warned_unknown_ip = True
            log.warning("p-x402: client IP unknown; all such requests share one rate-limit bucket")
        cap = self._limiter.take(key)
        if not cap.ok:
            return _json_response(429, {"error": "rate_limited"}, {"retry-after": str(cap.retry_after_seconds)})

        body: Dict[str, Any] = {"resource": resource, "amount": amount}
        if route.description is not None:
            body["description"] = route.description
        answer = await self._post("/pix/charges", body)
        if not answer.ok or answer.status >= 500:
            return self._facilitator_error("")
        if answer.status == 401:
            return self._unauthorized("/pix/charges")
        if answer.status == 400:
            log.error("p-x402: facilitator refused the charge request (400)")
            return _json_response(500, {"error": "invalid_request"})
        if answer.status == 429:
            retry_after = answer.headers.get("retry-after") if answer.headers is not None else None
            valid = retry_after is not None and retry_after.isdigit() and retry_after.isascii()
            return _json_response(429, {"error": "rate_limited"}, {"retry-after": retry_after if valid else "1"})
        requirements = None
        if answer.status == 200 and isinstance(answer.body, dict) and "paymentRequirements" in answer.body:
            try:
                requirements = parse_pix_requirements(answer.body["paymentRequirements"])
            except SchemaError:
                requirements = None
        if requirements is None:
            return self._facilitator_error("")
        # The charge must be for this route and this resource.
        if requirements.amount != amount or requirements.extra.resource_url != resource["url"]:
            return self._facilitator_error(requirements.extra.charge_id)
        payment_required = {
            "x402Version": X402_VERSION,
            "error": "payment_required",
            "resource": resource,
            "accepts": [requirements.to_dict()],
        }
        return _json_response(
            402, payment_required, {HEADER_PAYMENT_REQUIRED: encode_payment_required(payment_required)}
        )

    async def handle(
        self, request: PaywallRequest, route: Union[PaywallRoute, Mapping[str, Any]]
    ) -> Union[PaywallResponse, PaidRequest]:
        """A ready response (402, 400, 429, 5xx) or a :class:`PaidRequest` to run the handler for.

        Raises ``Px402Error("invalid_request")`` for a bad route configuration.
        """
        if not isinstance(route, PaywallRoute):
            route = PaywallRoute(
                amount=route["amount"],
                description=route.get("description"),
                mime_type=route.get("mime_type", route.get("mimeType")),
                resource=route.get("resource"),
            )
        amount = _validate_route(route)
        # HEAD/OPTIONS never create, verify or settle a charge (and never touch the IP cap).
        if request.method.upper() in UNPAYABLE_METHODS:
            return _json_response(402, {"error": "method_not_payable"})
        resource_url = self._resource_url(request.url, route)
        resource: Dict[str, Any] = {"url": resource_url}
        if route.description is not None:
            resource["description"] = route.description
        if route.mime_type is not None:
            resource["mimeType"] = route.mime_type

        header = _Headers(request.headers).get(HEADER_PAYMENT_SIGNATURE)
        if header is None:
            return await self._create_charge(resource, amount, route, request.client_ip)

        try:
            payload = decode_payment_payload(header)
        except Px402Error:
            return self._bad_header("invalid_header")
        try:
            pix = parse_pix_payment_payload(payload)
        except SchemaError:
            return self._bad_header("invalid_payload")

        # Server-owned fields from config; only payTo, provider, maxTimeoutSeconds and per-charge
        # keys come from the client (the facilitator checks them against its charge record).
        accepted = pix.accepted
        charge_id = accepted.extra.charge_id
        extra: Dict[str, Any] = {
            "paymentFlow": PIX_PAYMENT_FLOW,
            "assetTransferMethod": PIX_ASSET_TRANSFER_METHOD,
            "provider": accepted.extra.provider,
            "resourceUrl": resource_url,
            "chargeId": charge_id,
            "brCode": accepted.extra.br_code,
        }
        if accepted.extra.br_code_base64 is not None:
            extra["brCodeBase64"] = accepted.extra.br_code_base64
        extra["expiresAt"] = accepted.extra.expires_at
        requirements: Dict[str, Any] = {
            "scheme": PIX_SCHEME,
            "network": PIX_NETWORK,
            "asset": PIX_ASSET,
            "amount": amount,
            "payTo": accepted.pay_to,
            "maxTimeoutSeconds": accepted.max_timeout_seconds,
            "extra": extra,
        }
        payment_required = {"x402Version": X402_VERSION, "resource": resource, "accepts": [requirements]}
        facilitator_body = {
            "x402Version": X402_VERSION,
            "paymentPayload": payload.to_dict(),
            "paymentRequirements": requirements,
        }

        # Another request for this charge is between /verify and settle: do not verify, do not
        # run the handler; the client retries after Retry-After.
        release = self._acquire(charge_id)
        if release is None:
            return self._failure_response("settlement_pending", charge_id, payment_required)

        try:
            verified = await self._verify_or_settle("/verify", facilitator_body, charge_id)
        except BaseException:
            release()
            raise
        if verified.kind != "value":
            release()
            if verified.kind == "response":
                assert verified.response is not None
                return verified.response
            return self._failure_response(verified.reason, charge_id, payment_required)

        async def finalize(response: PaywallResponse) -> PaywallResponse:
            try:
                # Handler failed: no settle, the paid charge stays unused.
                if response.status >= 400:
                    return response
                settled = await self._verify_or_settle("/settle", facilitator_body, charge_id, str(uuid.uuid4()))
                if settled.kind == "value" and settled.value is not None:
                    headers = {k.lower(): v for k, v in response.headers.items()}
                    headers[HEADER_PAYMENT_RESPONSE.lower()] = encode_settlement_response(settled.value)
                    return PaywallResponse(response.status, headers, response.body)
                # Handler output is discarded.
                if settled.kind == "response":
                    assert settled.response is not None
                    return settled.response
                reason = settled.reason if settled.kind == "failed" else "unexpected_error"
                return self._failure_response(reason, charge_id, payment_required)
            finally:
                release()

        return PaidRequest(charge_id, amount, requirements, finalize, release)
