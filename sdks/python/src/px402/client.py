"""httpx transports that pay p-x402 Pix 402s, mirroring ``wrapFetch`` in ``packages/client``.

On a ``402`` with a ``PAYMENT-REQUIRED`` header the transport checks, before paying and in this
order: the 402 was not reached through a redirect, a valid Pix option exists, its ``resourceUrl``
equals ``resource.url`` and has the request's origin, the origin is allowed, the BR Code's amount
equals ``amount``, ``amount <= max_per_request`` and ``spent + amount <= max_total``. It then calls
the payer and retries the same request with ``PAYMENT-SIGNATURE`` until the server stops
answering ``settlement_pending``.
"""

from __future__ import annotations

import email.utils
import inspect
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable, List, Optional
from urllib.parse import urlsplit

import httpx

from .brcode import parse_br_code
from .codec import decode_payment_payload, decode_payment_required, decode_settlement_response, encode_payment_payload
from .constants import HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, HEADER_PAYMENT_SIGNATURE, X402_VERSION
from .errors import Px402Error, is_px402_error_code
from .models import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    PixPaymentRequirements,
    SchemaError,
    parse_pix_payment_payload,
    parse_pix_requirements,
)
from .types import PaymentEvent, PixChargeToPay, RetryOptions, SpendingPolicy

__all__ = ["Px402Transport", "AsyncPx402Transport", "Px402Client", "AsyncPx402Client"]

#: Request extension set on a request whose response was a redirect. httpx copies extensions into
#: the request it builds for the next hop, so a 402 at the end of a redirect chain is recognised.
REDIRECT_EXTENSION = "px402.redirected"
_REDIRECT_STATUSES = frozenset((301, 302, 303, 307, 308))
_DEFAULT_PORTS = {"http": 80, "https": 443}
_ISO_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?", re.ASCII | re.IGNORECASE
)

Clock = Callable[[], float]
OnPayment = Callable[[PaymentEvent], Any]


# --- helpers shared by both transports ------------------------------------------------------


def _parse_instant(text: str) -> float:
    """``Date.parse`` for the ISO timestamps p-x402 uses, in epoch seconds (ms precision)."""
    match = _ISO_RE.fullmatch(text.strip())
    if not match:
        return float("nan")
    base, fraction, zone = match.groups()
    millis = (fraction or "").ljust(3, "0")[:3]
    zone = "+00:00" if zone is None or zone.upper() == "Z" else zone
    try:
        return datetime.fromisoformat(f"{base}.{millis}{zone}").timestamp()
    except ValueError:
        return float("nan")


def _hostname(parts: Any) -> Optional[str]:
    host = parts.hostname
    if not host:
        return None
    try:
        host.encode("ascii")
    except UnicodeEncodeError:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            return None
    return f"[{host}]" if ":" in host else host


def _host_and_origin(url: str) -> Optional[tuple]:
    """(host, origin) as WHATWG URL computes them, or None when the URL has no usable origin."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = _hostname(parts)
    if host is None or scheme not in _DEFAULT_PORTS:
        return None
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        host = f"{host}:{port}"
    return host, f"{scheme}://{host}"


def _origin(url: str) -> Optional[str]:
    parsed = _host_and_origin(url)
    return parsed[1] if parsed else None


def _origin_allowed(url: str, allowed: List[str]) -> bool:
    parsed = _host_and_origin(url)
    if parsed is None:
        return False
    host, origin = parsed
    for entry in allowed:
        if "://" in entry:
            if _origin(entry) == origin:
                return True
        elif entry.lower() == host:
            return True
    return False


def _pick_pix(accepts: List[PaymentRequirements]) -> Optional[PixPaymentRequirements]:
    for raw in accepts:
        try:
            return parse_pix_requirements(raw)
        except SchemaError:
            continue
    return None


def _check_resource(required: PaymentRequired, requirements: PixPaymentRequirements, request_url: str) -> None:
    resource_url = requirements.extra.resource_url
    request_origin = _origin(request_url)
    if resource_url != required.resource.url or _origin(resource_url) != request_origin:
        raise Px402Error(
            "policy_exceeded",
            "payment resource does not match the request",
            {
                "reason": "resource_origin_mismatch",
                "resource_url": resource_url,
                "resource": required.resource.url,
                "origin": request_origin,
            },
        )


def _check_br_code(br_code: str, amount: str) -> None:
    info = parse_br_code(br_code)

    def fail(reason: str, message: str) -> Px402Error:
        return Px402Error("invalid_payment_requirements", message, {"reason": reason, "amount": amount})

    if info is None or not info.crc_valid:
        raise fail("brcode_invalid", "BR Code is malformed or has a bad CRC")
    if info.amount is None:
        raise fail("brcode_amount_missing", "BR Code has no amount")
    if info.amount != amount:
        raise fail("brcode_amount_mismatch", f"BR Code asks for {info.amount}, requirements say {amount}")


def _read_error_reason(header: Optional[str]) -> Optional[str]:
    if header is None:
        return None
    try:
        return decode_settlement_response(header).error_reason
    except Px402Error:
        return None


def _retry_after_seconds(response: httpx.Response, now: float) -> float:
    """Retry-After as delta-seconds or an HTTP date. 0 when absent or unreadable."""
    value = (response.headers.get("retry-after") or "").strip()
    if not value:
        return 0.0
    if value.isdigit() and value.isascii():
        return float(int(value))
    try:
        at = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return 0.0
    if at is None:
        return 0.0
    if at.tzinfo is None:
        return 0.0
    return max(0.0, at.timestamp() - now)


def _with_signature(request: httpx.Request, signature: str) -> httpx.Request:
    headers = httpx.Headers(request.headers)
    headers[HEADER_PAYMENT_SIGNATURE] = signature
    return httpx.Request(
        request.method,
        request.url,
        headers=headers,
        stream=request.stream,  # already read: replayable, and no Content-Length is added
        extensions=dict(request.extensions),
    )


def _mark_redirect(request: httpx.Request, response: httpx.Response) -> None:
    if response.status_code in _REDIRECT_STATUSES and "location" in response.headers:
        request.extensions[REDIRECT_EXTENSION] = True


@dataclass
class _Plan:
    charge: PixChargeToPay
    signature: str
    deadline: float


@dataclass
class _Wait:
    seconds: float


class _Engine:
    """State and decisions shared by the sync and async transports (no I/O here)."""

    def __init__(
        self,
        payer: Any,
        policy: Optional[SpendingPolicy],
        retry: Optional[RetryOptions],
        on_payment: Optional[OnPayment],
        clock: Optional[Clock],
    ) -> None:
        if payer is None or not (hasattr(payer, "pay") or hasattr(payer, "apay")):
            raise TypeError("payer must have a pay() or apay() method")
        self.payer = payer
        self.policy = policy or SpendingPolicy()
        self.retry = retry or RetryOptions()
        self.on_payment = on_payment
        self.clock: Clock = clock or time.time
        self.spent = 0
        self._lock = threading.Lock()

    def plan(self, request: httpx.Request, response: httpx.Response, header: str) -> _Plan:
        """Runs every check and reserves the amount. Raises Px402Error when it must not pay."""
        request_url = str(request.url)
        if request.extensions.get(REDIRECT_EXTENSION):
            raise Px402Error(
                "policy_exceeded",
                "402 came from a redirected response",
                {"reason": "redirected", "origin": _origin(request_url), "response_url": request_url},
            )
        required = decode_payment_required(header)
        picked = _pick_pix(required.accepts)
        if picked is None:
            raise Px402Error(
                "no_supported_requirements",
                "no Pix payment option offered",
                {"accepts": [{"scheme": a.scheme, "network": a.network} for a in required.accepts]},
            )
        extra, amount = picked.extra, picked.amount
        policy = self.policy
        with self._lock:
            _check_resource(required, picked, request_url)
            if policy.allowed_origins is not None and not _origin_allowed(request_url, policy.allowed_origins):
                raise Px402Error(
                    "policy_exceeded",
                    "origin not allowed",
                    {"reason": "origin_not_allowed", "origin": _origin(request_url)},
                )
            if getattr(self.payer, "pays_br_code", True) is not False:
                _check_br_code(extra.br_code, amount)
            value = int(amount)
            if value > policy.max_per_request:
                raise Px402Error(
                    "policy_exceeded",
                    "amount above max_per_request",
                    {"reason": "max_per_request", "amount": amount, "max_per_request": policy.max_per_request},
                )
            if self.spent + value > policy.max_total:
                raise Px402Error(
                    "policy_exceeded",
                    "amount would exceed max_total",
                    {"reason": "max_total", "amount": amount, "spent": self.spent, "max_total": policy.max_total},
                )
            signature = encode_payment_payload(
                PaymentPayload(
                    x402_version=X402_VERSION,
                    resource=required.resource,
                    accepted=picked.raw,
                    payload={"chargeId": extra.charge_id},
                )
            )
            self.spent += value  # stays spent once the payer is called
        charge = PixChargeToPay(
            charge_id=extra.charge_id,
            amount=amount,
            br_code=extra.br_code,
            br_code_base64=extra.br_code_base64,
            expires_at=extra.expires_at,
            resource_url=extra.resource_url,
        )
        return _Plan(charge=charge, signature=signature, deadline=_parse_instant(extra.expires_at))

    def payer_failed(self, plan: _Plan, cause: BaseException) -> Px402Error:
        # payment_signature lets the caller resume if the payer failed after money moved
        error = Px402Error(
            "payer_failed",
            "payer failed",
            {"charge_id": plan.charge.charge_id, "payment_signature": plan.signature},
        )
        error.__cause__ = cause
        return error

    def notify(self, plan: _Plan) -> None:
        if self.on_payment is None:
            return
        try:
            self.on_payment(
                PaymentEvent(
                    charge_id=plan.charge.charge_id,
                    amount=plan.charge.amount,
                    resource_url=plan.charge.resource_url,
                    payment_signature=plan.signature,
                )
            )
        except Exception:
            pass  # a logging hook must not lose a paid request

    def resume_plan(self, signature: str) -> tuple:
        """(charge_id, deadline) for a caller-supplied PAYMENT-SIGNATURE."""
        try:
            pix = parse_pix_payment_payload(decode_payment_payload(signature))
            return pix.charge_id, _parse_instant(pix.accepted.extra.expires_at)
        except (Px402Error, SchemaError):
            return "", float("-inf")  # unknown expiry: try once

    def judge_retry(
        self, response: httpx.Response, charge_id: str, signature: str, deadline: float, backoff: List[float]
    ) -> Optional[_Wait]:
        """None: return the response. _Wait: sleep and retry. Raises when the payment was refused."""
        if response.status_code != 402:
            return None
        details = {"charge_id": charge_id, "payment_signature": signature}
        reason = _read_error_reason(response.headers.get(HEADER_PAYMENT_RESPONSE))
        if reason == "settlement_pending":
            now = self.clock()
            if now > deadline:
                raise Px402Error("payment_timeout", "charge expired before settlement", details)
            wait = max(_retry_after_seconds(response, now), backoff[0])
            backoff[0] = min(backoff[0] * self.retry.factor, self.retry.max_delay)
            # Never sleep much past the deadline: one last attempt right after it.
            return _Wait(min(wait, max(0.0, deadline - now) + 0.001))
        if reason is not None and is_px402_error_code(reason):
            raise Px402Error(reason, f"payment refused: {reason}", details)
        raise Px402Error("payment_rejected", "payment refused by the server", {**details, "error_reason": reason})


def _is_challenge(response: httpx.Response) -> Optional[str]:
    if response.status_code != 402:
        return None
    return response.headers.get(HEADER_PAYMENT_REQUIRED)


# --- sync -----------------------------------------------------------------------------------


class Px402Transport(httpx.BaseTransport):
    """Sync httpx transport that pays Pix 402s within a spending policy.

    ``spent`` is the total reserved or paid so far, in centavos (it never decreases).

    >>> client = httpx.Client(transport=Px402Transport(payer=SimulatePayer("http://localhost:4020")))
    """

    def __init__(
        self,
        payer: Any,
        *,
        policy: Optional[SpendingPolicy] = None,
        retry: Optional[RetryOptions] = None,
        on_payment: Optional[OnPayment] = None,
        transport: Optional[httpx.BaseTransport] = None,
        clock: Optional[Clock] = None,
        sleep: Optional[Callable[[float], None]] = None,
    ) -> None:
        if not hasattr(payer, "pay") or inspect.iscoroutinefunction(getattr(payer, "pay", None)):
            raise TypeError("Px402Transport needs a payer with a synchronous pay(); use AsyncPx402Transport")
        self._engine = _Engine(payer, policy, retry, on_payment, clock)
        self._inner = transport or httpx.HTTPTransport()
        self._sleep = sleep or time.sleep

    @property
    def spent(self) -> int:
        return self._engine.spent

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        request.read()
        existing = request.headers.get(HEADER_PAYMENT_SIGNATURE)
        if existing is not None:
            charge_id, deadline = self._engine.resume_plan(existing)
            return self._retry_loop(request, existing, charge_id, deadline)

        response = self._inner.handle_request(request)
        _mark_redirect(request, response)
        header = _is_challenge(response)
        if header is None:
            return response
        response.close()
        plan = self._engine.plan(request, response, header)
        try:
            self._engine.payer.pay(plan.charge)
        except Exception as cause:
            raise self._engine.payer_failed(plan, cause) from cause
        self._engine.notify(plan)
        return self._retry_loop(request, plan.signature, plan.charge.charge_id, plan.deadline)

    def _retry_loop(self, request: httpx.Request, signature: str, charge_id: str, deadline: float) -> httpx.Response:
        backoff = [self._engine.retry.initial_delay]
        while True:
            response = self._inner.handle_request(_with_signature(request, signature))
            _mark_redirect(request, response)  # never pay again further down a redirect chain
            if response.status_code == 402:
                response.close()
            wait = self._engine.judge_retry(response, charge_id, signature, deadline, backoff)
            if wait is None:
                return response
            self._sleep(wait.seconds)

    def close(self) -> None:
        self._inner.close()


# --- async ----------------------------------------------------------------------------------


async def _default_async_sleep(seconds: float) -> None:
    import anyio

    await anyio.sleep(seconds)


class AsyncPx402Transport(httpx.AsyncBaseTransport):
    """Async httpx transport that pays Pix 402s within a spending policy.

    The payer may define ``async apay(charge)``; otherwise ``pay(charge)`` is called and awaited when
    it returns an awaitable.
    """

    def __init__(
        self,
        payer: Any,
        *,
        policy: Optional[SpendingPolicy] = None,
        retry: Optional[RetryOptions] = None,
        on_payment: Optional[OnPayment] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        clock: Optional[Clock] = None,
        sleep: Optional[Callable[[float], Awaitable[None]]] = None,
    ) -> None:
        self._engine = _Engine(payer, policy, retry, on_payment, clock)
        self._inner = transport or httpx.AsyncHTTPTransport()
        self._sleep = sleep or _default_async_sleep

    @property
    def spent(self) -> int:
        return self._engine.spent

    async def _pay(self, charge: PixChargeToPay) -> None:
        payer = self._engine.payer
        if hasattr(payer, "apay"):
            await payer.apay(charge)
            return
        result = payer.pay(charge)
        if inspect.isawaitable(result):
            await result

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        existing = request.headers.get(HEADER_PAYMENT_SIGNATURE)
        if existing is not None:
            charge_id, deadline = self._engine.resume_plan(existing)
            return await self._retry_loop(request, existing, charge_id, deadline)

        response = await self._inner.handle_async_request(request)
        _mark_redirect(request, response)
        header = _is_challenge(response)
        if header is None:
            return response
        await response.aclose()
        plan = self._engine.plan(request, response, header)
        try:
            await self._pay(plan.charge)
        except Exception as cause:
            raise self._engine.payer_failed(plan, cause) from cause
        self._engine.notify(plan)
        return await self._retry_loop(request, plan.signature, plan.charge.charge_id, plan.deadline)

    async def _retry_loop(
        self, request: httpx.Request, signature: str, charge_id: str, deadline: float
    ) -> httpx.Response:
        backoff = [self._engine.retry.initial_delay]
        while True:
            response = await self._inner.handle_async_request(_with_signature(request, signature))
            _mark_redirect(request, response)  # never pay again further down a redirect chain
            if response.status_code == 402:
                await response.aclose()
            wait = self._engine.judge_retry(response, charge_id, signature, deadline, backoff)
            if wait is None:
                return response
            await self._sleep(wait.seconds)

    async def aclose(self) -> None:
        await self._inner.aclose()


# --- clients --------------------------------------------------------------------------------

#: httpx.Client options that configure its default transport. httpx ignores them when a transport
#: is given, so Px402Client passes them to the transport it wraps instead.
_TRANSPORT_OPTIONS = ("verify", "cert", "trust_env", "http1", "http2", "limits", "proxy")


def _transport_options(kwargs: dict) -> dict:
    options = {key: kwargs[key] for key in _TRANSPORT_OPTIONS if key in kwargs}
    kwargs.pop("proxy", None)  # a proxy given to httpx.Client would bypass the p-x402 transport
    return options



class Px402Client(httpx.Client):
    """An ``httpx.Client`` whose transport pays Pix 402s. Extra keyword arguments go to httpx.

    >>> with Px402Client(payer=SimulatePayer("http://localhost:4020")) as client:
    ...     client.get("http://localhost:3000/relatorio").json()
    """

    def __init__(
        self,
        payer: Any,
        *,
        policy: Optional[SpendingPolicy] = None,
        retry: Optional[RetryOptions] = None,
        on_payment: Optional[OnPayment] = None,
        transport: Optional[httpx.BaseTransport] = None,
        **kwargs: Any,
    ) -> None:
        inner = transport or httpx.HTTPTransport(**_transport_options(kwargs))
        self.px402 = Px402Transport(payer, policy=policy, retry=retry, on_payment=on_payment, transport=inner)
        super().__init__(transport=self.px402, **kwargs)

    @property
    def spent(self) -> int:
        """Centavos reserved or paid so far by this client."""
        return self.px402.spent


class AsyncPx402Client(httpx.AsyncClient):
    """An ``httpx.AsyncClient`` whose transport pays Pix 402s. Extra keyword arguments go to httpx."""

    def __init__(
        self,
        payer: Any,
        *,
        policy: Optional[SpendingPolicy] = None,
        retry: Optional[RetryOptions] = None,
        on_payment: Optional[OnPayment] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        **kwargs: Any,
    ) -> None:
        inner = transport or httpx.AsyncHTTPTransport(**_transport_options(kwargs))
        self.px402 = AsyncPx402Transport(payer, policy=policy, retry=retry, on_payment=on_payment, transport=inner)
        super().__init__(transport=self.px402, **kwargs)

    @property
    def spent(self) -> int:
        """Centavos reserved or paid so far by this client."""
        return self.px402.spent

