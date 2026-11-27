"""The FastAPI adapter, in process (httpx.ASGITransport) against a fake facilitator."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List

import httpx
import pytest

pytest.importorskip("fastapi")

from fastapi import Depends, FastAPI, HTTPException  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

import px402  # noqa: E402
from px402.brcode import EmvField, encode_emv  # noqa: E402
from px402.server import Paywall  # noqa: E402
from px402.server.fastapi import Payment, PixPaywall  # noqa: E402

FACILITATOR = "http://facilitator.test"
EXPIRES = "2099-01-01T00:00:00.000Z"


def br_code(reais: str) -> str:
    return encode_emv(
        [
            EmvField("00", "01"),
            EmvField("26", "0014br.gov.bcb.pix0136123e4567-e89b-42d3-a456-426614174000"),
            EmvField("52", "0000"),
            EmvField("53", "986"),
            EmvField("54", reais),
            EmvField("58", "BR"),
            EmvField("59", "LOJA EXEMPLO"),
            EmvField("60", "SAO PAULO"),
        ]
    )


class FakeFacilitator:
    """Enough of the facilitator for the paywall and SimulatePayer: charges, verify, settle."""

    def __init__(self, settle_reason: str = "") -> None:
        self.charges: Dict[str, Dict[str, Any]] = {}
        self.paid: set = set()
        self.consumed: set = set()
        self.calls: List[str] = []
        self.settle_reason = settle_reason

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        if path.startswith("/dev/charges/"):
            self.paid.add(path.split("/")[3])
            return httpx.Response(200, json={"ok": True})
        assert request.headers["authorization"] == "Bearer tok-test"
        body = json.loads(request.content)
        if path == "/pix/charges":
            charge_id = f"pix_char_fake_{len(self.charges) + 1:04d}"
            amount = body["amount"]
            requirements = {
                "scheme": "exact",
                "network": "pix:br",
                "amount": amount,
                "asset": "BRL",
                "payTo": "loja-teste",
                "maxTimeoutSeconds": 300,
                "extra": {
                    "paymentFlow": "upfront",
                    "assetTransferMethod": "pix-charge",
                    "provider": "mock",
                    "resourceUrl": body["resource"]["url"],
                    "chargeId": charge_id,
                    "brCode": br_code(f"{int(amount) // 100}.{int(amount) % 100:02d}"),
                    "expiresAt": EXPIRES,
                },
            }
            self.charges[charge_id] = requirements
            return httpx.Response(200, json={"paymentRequirements": requirements})
        charge_id = body["paymentPayload"]["payload"]["chargeId"]
        if path == "/verify":
            if charge_id in self.consumed:
                return httpx.Response(200, json={"isValid": False, "invalidReason": "charge_already_consumed"})
            if charge_id not in self.paid:
                return httpx.Response(200, json={"isValid": False, "invalidReason": "settlement_pending"})
            return httpx.Response(200, json={"isValid": True})
        if path == "/settle":
            if self.settle_reason:
                failure = {"success": False, "errorReason": self.settle_reason, "transaction": charge_id}
                return httpx.Response(200, json={**failure, "network": "pix:br"})
            self.consumed.add(charge_id)
            return httpx.Response(
                200, json={"success": True, "transaction": charge_id, "network": "pix:br", "amount": "500"}
            )
        return httpx.Response(404, json={})


def make_app(facilitator: FakeFacilitator, install: bool = True) -> FastAPI:
    http = httpx.AsyncClient(transport=httpx.MockTransport(facilitator))
    pix = PixPaywall(paywall=Paywall(FACILITATOR, "tok-test", http_client=http))
    app = FastAPI()
    if install:
        pix.install(app)
    state = {"fail_once": True}

    @app.get("/relatorio")
    async def relatorio(payment: Payment = Depends(pix.require(amount=500, description="Relatório"))):
        response = JSONResponse({"pagoCom": payment.charge_id, "valor": payment.amount})
        response.set_cookie("a", "1")
        response.set_cookie("b", "2")
        return response

    @app.get("/sumiu", dependencies=[Depends(pix.require(amount=500))])
    async def sumiu() -> None:
        raise HTTPException(status_code=404, detail="não achei")

    @app.get("/instavel", dependencies=[Depends(pix.require(amount=500))])
    async def instavel() -> Dict[str, bool]:
        if state["fail_once"]:
            state["fail_once"] = False
            raise RuntimeError("handler crashed")
        return {"ok": True}

    @app.get("/livre")
    async def livre() -> Dict[str, bool]:
        return {"livre": True}

    return app


def asgi(app: FastAPI) -> httpx.AsyncBaseTransport:
    return httpx.ASGITransport(app=app, raise_app_exceptions=False, client=("198.51.100.4", 5000))


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_unpaid_request_gets_a_402_challenge() -> None:
    facilitator = FakeFacilitator()

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(transport=asgi(make_app(facilitator)), base_url="http://api.test") as c:
            return await c.get("/relatorio")

    response = run(go())
    assert response.status_code == 402
    challenge = px402.decode_payment_required(response.headers["payment-required"])
    assert challenge.resource.url == "http://api.test/relatorio"
    assert challenge.resource.description == "Relatório"
    assert challenge.accepts[0].amount == "500"
    assert response.json()["error"] == "payment_required"


def test_python_client_pays_the_fastapi_route_end_to_end() -> None:
    facilitator = FakeFacilitator()
    app = make_app(facilitator)
    payer = px402.SimulatePayer(
        FACILITATOR, async_http_client=httpx.AsyncClient(transport=httpx.MockTransport(facilitator))
    )

    async def go() -> None:
        async with px402.AsyncPx402Client(payer, transport=asgi(app), base_url="http://api.test") as client:
            response = await client.get("/relatorio")
            assert response.status_code == 200
            assert response.json() == {"pagoCom": "pix_char_fake_0001", "valor": "500"}
            receipt = px402.decode_settlement_response(response.headers["payment-response"])
            assert (receipt.success, receipt.transaction, receipt.amount) == (True, "pix_char_fake_0001", "500")
            assert receipt.payer is None
            assert response.headers.get_list("set-cookie") == ["a=1; Path=/; SameSite=lax", "b=2; Path=/; SameSite=lax"]
            assert client.spent == 500
            free = await client.get("/livre")
            assert free.json() == {"livre": True} and "payment-response" not in free.headers

    run(go())
    assert facilitator.calls == [
        "/pix/charges",
        "/dev/charges/pix_char_fake_0001/simulate-payment",
        "/verify",
        "/settle",
    ]


def test_handler_http_error_is_not_settled() -> None:
    facilitator = FakeFacilitator()
    facilitator.paid.add("pix_char_fake_0001")
    app = make_app(facilitator)

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(transport=asgi(app), base_url="http://api.test") as c:
            challenge = px402.decode_payment_required((await c.get("/sumiu")).headers["payment-required"])
            signature = px402.encode_payment_payload(
                px402.PaymentPayload(
                    resource=challenge.resource,
                    accepted=challenge.accepts[0],
                    payload={"chargeId": "pix_char_fake_0001"},
                )
            )
            return await c.get("/sumiu", headers={"PAYMENT-SIGNATURE": signature})

    response = run(go())
    assert response.status_code == 404 and "payment-response" not in response.headers
    assert "/settle" not in facilitator.calls


def test_handler_crash_releases_the_charge_for_a_retry() -> None:
    facilitator = FakeFacilitator()
    app = make_app(facilitator)
    payer = px402.SimulatePayer(
        FACILITATOR, async_http_client=httpx.AsyncClient(transport=httpx.MockTransport(facilitator))
    )
    signatures: List[str] = []

    async def go() -> None:
        async with px402.AsyncPx402Client(
            payer,
            transport=asgi(app),
            base_url="http://api.test",
            on_payment=lambda e: signatures.append(e.payment_signature),
        ) as client:
            first = await client.get("/instavel")
            assert first.status_code == 500
            # resume with the same signature: verified again (the lock was released), settled once
            second = await client.get("/instavel", headers={"PAYMENT-SIGNATURE": signatures[0]})
            assert second.status_code == 200 and second.json() == {"ok": True}
            assert client.spent == 500

    run(go())
    assert facilitator.calls.count("/verify") == 2 and facilitator.calls.count("/settle") == 1


def test_settle_refusal_replaces_the_handler_output() -> None:
    facilitator = FakeFacilitator(settle_reason="charge_already_consumed")
    app = make_app(facilitator)
    payer = px402.SimulatePayer(
        FACILITATOR, async_http_client=httpx.AsyncClient(transport=httpx.MockTransport(facilitator))
    )

    async def go() -> None:
        raw = httpx.AsyncClient(transport=asgi(app), base_url="http://api.test")
        async with px402.AsyncPx402Client(payer, transport=asgi(app), base_url="http://api.test") as client:
            with pytest.raises(px402.Px402Error) as info:
                await client.get("/relatorio")
            assert info.value.code == "charge_already_consumed"
        await raw.aclose()

    run(go())


def test_dependency_refuses_to_run_without_the_middleware() -> None:
    facilitator = FakeFacilitator()

    async def go() -> httpx.Response:
        app = make_app(facilitator, install=False)
        async with httpx.AsyncClient(transport=asgi(app), base_url="http://api.test") as c:
            return await c.get("/relatorio")

    assert run(go()).status_code == 500
    assert facilitator.calls == []


def test_pix_paywall_needs_a_facilitator() -> None:
    with pytest.raises(TypeError):
        PixPaywall()
