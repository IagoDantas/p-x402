"""FastAPI / Starlette adapter: a per-route dependency plus one middleware that settles.

    from fastapi import Depends, FastAPI
    from px402.server.fastapi import Payment, PixPaywall

    app = FastAPI()
    pix = PixPaywall("http://localhost:4020", token=os.environ["PX402_MERCHANT_TOKEN"])
    pix.install(app)

    @app.get("/relatorio")
    async def relatorio(payment: Payment = Depends(pix.require(amount=500, description="Relatório"))):
        return {"pagoCom": payment.charge_id}

The dependency answers unpaid requests itself (402, 400, 429...) and verifies paid ones. The
middleware runs after the handler: it settles with the facilitator and adds ``PAYMENT-RESPONSE``,
or replaces the handler's output when settling fails. A handler that raises or answers with a
status >= 400 is never settled, so the client's paid charge stays usable.

Needs the ``fastapi`` extra (``pip install "p-x402[fastapi]"``); only Starlette is imported here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

try:
    from starlette.requests import Request
    from starlette.responses import Response
except ImportError as error:  # pragma: no cover
    raise ImportError('px402.server.fastapi needs Starlette: pip install "p-x402[fastapi]"') from error

from ._core import PaidRequest, Paywall, PaywallRequest, PaywallResponse, PaywallRoute

__all__ = ["Payment", "PaywallRequired", "PixPaywall", "Px402Middleware"]

_PAID_KEY = "px402.paid"
_INSTALLED_KEY = "px402.middleware"


@dataclass(frozen=True)
class Payment:
    """What a paid handler learns about the payment."""

    charge_id: str
    #: Centavos.
    amount: str


class PaywallRequired(Exception):
    """Raised by the dependency when the paywall answers by itself (402, 400, 429, 5xx)."""

    def __init__(self, response: PaywallResponse) -> None:
        super().__init__(f"p-x402 paywall answered {response.status}")
        self.response = response


def _to_starlette(response: PaywallResponse) -> Response:
    headers = {k: v for k, v in response.headers.items() if k != "content-type"}
    return Response(
        content=response.body,
        status_code=response.status,
        headers=headers,
        media_type=response.headers.get("content-type"),
    )


def _default_client_ip(request: Request) -> Optional[str]:
    return request.client.host if request.client else None


class PixPaywall:
    """Holds one :class:`~px402.server.Paywall` and builds route dependencies for it."""

    def __init__(
        self,
        facilitator_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        paywall: Optional[Paywall] = None,
        client_ip: Callable[[Request], Optional[str]] = _default_client_ip,
        **paywall_options: Any,
    ) -> None:
        if paywall is None:
            if facilitator_url is None or token is None:
                raise TypeError("pass facilitator_url and token, or paywall")
            paywall = Paywall(facilitator_url, token, **paywall_options)
        self.paywall = paywall
        self._client_ip = client_ip

    def install(self, app: Any) -> None:
        """Adds the settling middleware and the exception handler for unpaid answers."""
        app.add_middleware(Px402Middleware, pix=self)
        app.add_exception_handler(PaywallRequired, self.exception_handler)

    @staticmethod
    async def exception_handler(request: Request, exc: Exception) -> Response:
        assert isinstance(exc, PaywallRequired)
        return _to_starlette(exc.response)

    def require(
        self,
        amount: Union[int, str],
        description: Optional[str] = None,
        mime_type: Optional[str] = None,
        resource: Optional[str] = None,
    ) -> Callable[[Request], Any]:
        """A dependency that charges ``amount`` centavos for the route."""
        route = PaywallRoute(amount=amount, description=description, mime_type=mime_type, resource=resource)

        async def dependency(request: Request) -> Payment:
            if request.scope.get(_INSTALLED_KEY) is not self:
                # Without the middleware nothing would settle: refuse before verifying anything.
                raise RuntimeError("PixPaywall.install(app) was not called for this app")
            result = await self.paywall.handle(
                PaywallRequest(
                    method=request.method,
                    url=str(request.url),
                    headers=request.headers.items(),
                    client_ip=self._client_ip(request),
                ),
                route,
            )
            if isinstance(result, PaywallResponse):
                raise PaywallRequired(result)
            request.scope[_PAID_KEY] = result
            return Payment(charge_id=result.charge_id, amount=result.amount)

        return dependency


def _raw_headers(headers: Dict[str, str], body: bytes) -> List[Tuple[bytes, bytes]]:
    out = [
        (k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items() if k.lower() != "content-length"
    ]
    out.append((b"content-length", str(len(body)).encode("latin-1")))
    return out


class Px402Middleware:
    """Pure ASGI middleware: settles paid requests after their handler (see :class:`PixPaywall`)."""

    def __init__(self, app: Any, pix: PixPaywall) -> None:
        self.app = app
        self.pix = pix

    async def __call__(self, scope: Dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        scope[_INSTALLED_KEY] = self.pix
        state: Dict[str, Any] = {"start": None, "body": [], "passthrough": False}

        async def capture(message: Dict[str, Any]) -> None:
            if state["passthrough"]:
                await send(message)
                return
            if message["type"] == "http.response.start":
                if scope.get(_PAID_KEY) is None:
                    state["passthrough"] = True
                    await send(message)
                    return
                state["start"] = message
                return
            if message["type"] == "http.response.body":
                state["body"].append(message.get("body", b""))
                return
            await send(message)

        try:
            await self.app(scope, receive, capture)
        except BaseException:
            paid = scope.get(_PAID_KEY)
            if isinstance(paid, PaidRequest):
                paid.release()  # the handler raised: never settle
            raise
        paid = scope.get(_PAID_KEY)
        if state["passthrough"] or not isinstance(paid, PaidRequest):
            return
        start = state["start"]
        if start is None:
            paid.release()
            return
        raw: List[Tuple[bytes, bytes]] = list(start.get("headers", []))
        body = b"".join(state["body"])
        handler = PaywallResponse(
            status=start["status"],
            headers={k.decode("latin-1").lower(): v.decode("latin-1") for k, v in raw},
            body=body,
        )
        out = await paid.finalize(handler)
        if out is handler:  # not settled (status >= 400): send it untouched
            headers = raw
        elif out.body is body and out.status == handler.status:  # settled: keep every original header
            headers = raw + [(b"payment-response", out.headers["payment-response"].encode("latin-1"))]
        else:  # settle failed: the handler output is discarded
            headers = _raw_headers(out.headers, out.body)
        await send({"type": "http.response.start", "status": out.status, "headers": headers})
        await send({"type": "http.response.body", "body": out.body, "more_body": False})
