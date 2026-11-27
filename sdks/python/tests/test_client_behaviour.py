"""Client behaviour the vectors leave out on purpose: payer failures, timeouts, hooks, payers."""

from __future__ import annotations

import asyncio
import io
from typing import Callable, List

import httpx
import pytest

import px402
from px402.brcode import EmvField, encode_emv

RESOURCE = "https://api.example.com/relatorio"
EXPIRES = "2026-11-25T15:05:00.000Z"
START = 1795618800.0  # 2026-11-25T15:00:00Z


def br_code(reais: str = "5.00") -> str:
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


def challenge(resource: str = RESOURCE, amount: str = "500", charge_id: str = "pix_char_test_0001") -> str:
    reais = f"{int(amount) // 100}.{int(amount) % 100:02d}"
    return px402.encode_payment_required(
        {
            "x402Version": 2,
            "resource": {"url": resource},
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "pix:br",
                    "amount": amount,
                    "asset": "BRL",
                    "payTo": "loja-exemplo",
                    "maxTimeoutSeconds": 300,
                    "extra": {
                        "paymentFlow": "upfront",
                        "assetTransferMethod": "pix-charge",
                        "provider": "mock",
                        "resourceUrl": resource,
                        "chargeId": charge_id,
                        "brCode": br_code(reais),
                        "expiresAt": EXPIRES,
                    },
                }
            ],
        }
    )


def settlement(reason: str = "", success: bool = False) -> str:
    body = {"success": success, "transaction": "pix_char_test_0001", "network": "pix:br"}
    if reason:
        body = {"success": success, "errorReason": reason, "transaction": "pix_char_test_0001", "network": "pix:br"}
    return px402.encode_settlement_response(body)


class Payer:
    pays_br_code = True

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.paid: List[px402.PixChargeToPay] = []

    def pay(self, charge: px402.PixChargeToPay) -> None:
        self.paid.append(charge)
        if self.fail:
            raise RuntimeError("bank app crashed")


def server(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def paywall(pending: int = 0, refuse: str = "") -> Callable[[httpx.Request], httpx.Response]:
    state = {"pending": pending}

    def handle(request: httpx.Request) -> httpx.Response:
        if "payment-signature" not in request.headers:
            return httpx.Response(402, headers={"payment-required": challenge()}, json={})
        if refuse:
            return httpx.Response(402, headers={"payment-response": settlement(refuse)}, json={})
        if state["pending"] > 0:
            state["pending"] -= 1
            return httpx.Response(402, headers={"payment-response": settlement("settlement_pending")}, json={})
        return httpx.Response(200, headers={"payment-response": settlement(success=True)}, json={"ok": True})

    return handle


def test_payer_failure_carries_the_signature_for_resume() -> None:
    payer = Payer(fail=True)
    transport = px402.Px402Transport(payer, transport=server(paywall()))
    with httpx.Client(transport=transport) as client, pytest.raises(px402.Px402Error) as info:
        client.get(RESOURCE)
    assert info.value.code == "payer_failed"
    assert isinstance(info.value.__cause__, RuntimeError)
    signature = info.value.details["payment_signature"]
    assert px402.decode_payment_payload(signature).payload == {"chargeId": "pix_char_test_0001"}
    assert transport.spent == 500  # the payer was called: the amount stays spent

    # resume: the caller resends the signature, nothing is paid again
    resumed = px402.Px402Transport(Payer(), transport=server(paywall()), clock=lambda: START)
    with httpx.Client(transport=resumed) as client:
        response = client.get(RESOURCE, headers={"PAYMENT-SIGNATURE": signature})
    assert response.status_code == 200
    assert resumed.spent == 0


def test_on_payment_hook_gets_the_signature_and_its_errors_are_ignored() -> None:
    events: List[px402.PaymentEvent] = []

    def hook(event: px402.PaymentEvent) -> None:
        events.append(event)
        raise ValueError("logging is down")

    transport = px402.Px402Transport(
        Payer(), transport=server(paywall()), on_payment=hook, clock=lambda: START
    )
    with httpx.Client(transport=transport) as client:
        assert client.get(RESOURCE).json() == {"ok": True}
    assert [(e.charge_id, e.amount, e.resource_url) for e in events] == [("pix_char_test_0001", "500", RESOURCE)]


def test_settlement_pending_until_the_charge_expires_times_out() -> None:
    now = [START]
    sleeps: List[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    transport = px402.Px402Transport(
        Payer(), transport=server(paywall(pending=10_000)), clock=lambda: now[0], sleep=sleep
    )
    with httpx.Client(transport=transport) as client, pytest.raises(px402.Px402Error) as info:
        client.get(RESOURCE)
    assert info.value.code == "payment_timeout"
    assert now[0] > START + 300  # gave up only after expiresAt
    assert max(sleeps) <= 5.0  # backoff capped at max_delay


def test_resume_with_unknown_signature_tries_once() -> None:
    transport = px402.Px402Transport(Payer(), transport=server(paywall(pending=1)), clock=lambda: START)
    with httpx.Client(transport=transport) as client, pytest.raises(px402.Px402Error) as info:
        client.get(RESOURCE, headers={"PAYMENT-SIGNATURE": "bm90LWEtc2lnbmF0dXJl"})
    assert info.value.code == "payment_timeout"


def test_allowed_origins_accepts_hosts_and_origins() -> None:
    for allowed in (["api.example.com"], ["https://api.example.com"], ["HTTPS://API.EXAMPLE.COM:443"]):
        transport = px402.Px402Transport(
            Payer(), transport=server(paywall()), clock=lambda: START,
            policy=px402.SpendingPolicy(allowed_origins=allowed),
        )
        with httpx.Client(transport=transport) as client:
            assert client.get(RESOURCE).status_code == 200
    transport = px402.Px402Transport(
        Payer(), transport=server(paywall()), policy=px402.SpendingPolicy(allowed_origins=["api.example.com:8443"])
    )
    with httpx.Client(transport=transport) as client, pytest.raises(px402.Px402Error) as info:
        client.get(RESOURCE)
    assert info.value.reason == "origin_not_allowed"


def test_default_policy_is_conservative() -> None:
    policy = px402.SpendingPolicy()
    assert (policy.max_per_request, policy.max_total, policy.allowed_origins) == (1000, 5000, None)


def test_post_body_is_resent_on_the_paid_retry() -> None:
    bodies: List[bytes] = []

    def handle(request: httpx.Request) -> httpx.Response:
        bodies.append(request.read())
        return paywall()(request)

    transport = px402.Px402Transport(Payer(), transport=server(handle), clock=lambda: START)
    with httpx.Client(transport=transport) as client:
        assert client.post(RESOURCE, json={"pergunta": "olá"}).status_code == 200
    assert len(bodies) == 2 and bodies[0] == bodies[1] and b"pergunta" in bodies[0]


def test_cross_origin_redirect_to_a_402_is_refused_with_real_redirects() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.example.com":
            return httpx.Response(302, headers={"location": "https://pagamentos.example.net/relatorio"})
        return httpx.Response(402, headers={"payment-required": challenge("https://pagamentos.example.net/relatorio")})

    payer = Payer()
    transport = px402.Px402Transport(payer, transport=server(handle))
    with httpx.Client(transport=transport, follow_redirects=True) as client, pytest.raises(px402.Px402Error) as info:
        client.get(RESOURCE)
    assert (info.value.code, info.value.reason) == ("policy_exceeded", "redirected")
    assert payer.paid == []


def test_retry_after_http_date() -> None:
    now = [START]
    sleeps: List[float] = []
    state = {"first": True}

    def handle(request: httpx.Request) -> httpx.Response:
        if "payment-signature" not in request.headers:
            return httpx.Response(402, headers={"payment-required": challenge()})
        if state["first"]:
            state["first"] = False
            return httpx.Response(
                402,
                headers={"payment-response": settlement("settlement_pending"),
                         "retry-after": "Wed, 25 Nov 2026 15:00:03 GMT"},
            )
        return httpx.Response(200)

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    transport = px402.Px402Transport(Payer(), transport=server(handle), clock=lambda: now[0], sleep=sleep)
    with httpx.Client(transport=transport) as client:
        assert client.get(RESOURCE).status_code == 200
    assert sleeps == [3.0]


def test_sync_transport_refuses_an_async_only_payer() -> None:
    class AsyncOnly:
        async def pay(self, charge: px402.PixChargeToPay) -> None:  # pragma: no cover
            return None

    with pytest.raises(TypeError):
        px402.Px402Transport(AsyncOnly())


def test_async_transport_uses_apay_and_the_async_client() -> None:
    class AsyncPayer:
        pays_br_code = True

        def __init__(self) -> None:
            self.paid: List[str] = []

        async def apay(self, charge: px402.PixChargeToPay) -> None:
            await asyncio.sleep(0)
            self.paid.append(charge.charge_id)

    handler = paywall(pending=1)

    async def run() -> None:
        payer = AsyncPayer()
        slept: List[float] = []

        async def sleep(seconds: float) -> None:
            slept.append(seconds)

        transport = httpx.MockTransport(handler)
        async with px402.AsyncPx402Client(payer, transport=transport) as client:
            client.px402._sleep = sleep
            client.px402._engine.clock = lambda: START
            response = await client.get(RESOURCE)
            assert response.status_code == 200
            assert client.spent == 500
        assert payer.paid == ["pix_char_test_0001"]
        assert slept == [0.5]

    asyncio.run(run())


def test_px402_client_wraps_httpx_client() -> None:
    with px402.Px402Client(Payer(), transport=server(paywall())) as client:
        client.px402._engine.clock = lambda: START
        assert client.get(RESOURCE).json() == {"ok": True}
        assert client.spent == 500


# --- payers ---------------------------------------------------------------------------------

CHARGE = px402.PixChargeToPay(
    charge_id="pix_char_mock_0001",
    amount="123456",
    br_code="000201...6304ABCD",
    expires_at=EXPIRES,
    resource_url=RESOURCE,
)


def test_simulate_payer_calls_the_facilitator_dev_route() -> None:
    seen: List[str] = []

    def facilitator(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.method} {request.url}")
        return httpx.Response(200 if "mock_0001" in str(request.url) else 404, json={})

    payer = px402.SimulatePayer("http://localhost:4020/", http_client=httpx.Client(transport=server(facilitator)))
    assert payer.pays_br_code is False
    payer.pay(CHARGE)
    assert seen == ["POST http://localhost:4020/dev/charges/pix_char_mock_0001/simulate-payment"]
    with pytest.raises(px402.Px402Error) as info:
        payer.pay(px402.PixChargeToPay("other/../x", "1", "b", EXPIRES, RESOURCE))
    assert info.value.code == "payer_failed"
    assert seen[-1].endswith("/dev/charges/other%2F..%2Fx/simulate-payment")

    async def run() -> None:
        async with httpx.AsyncClient(transport=server(facilitator)) as http:
            await px402.SimulatePayer("http://localhost:4020", async_http_client=http).apay(CHARGE)

    asyncio.run(run())


def test_simulate_payer_with_a_function() -> None:
    calls: List[str] = []
    px402.SimulatePayer(simulate=calls.append).pay(CHARGE)
    assert calls == ["pix_char_mock_0001"]
    with pytest.raises(TypeError):
        px402.SimulatePayer()


def test_terminal_payer_prints_the_code_and_waits() -> None:
    out = io.StringIO()
    prompts: List[str] = []
    payer = px402.TerminalPayer(output=out, input_fn=lambda prompt: prompts.append(prompt) or "")
    payer.pay(CHARGE)
    text = out.getvalue()
    assert "R$ 1.234,56" in text and CHARGE.br_code in text and CHARGE.charge_id in text
    assert len(prompts) == 1

    cancelling = px402.TerminalPayer(output=io.StringIO(), input_fn=lambda _: "n")
    with pytest.raises(px402.Px402Error) as info:
        cancelling.pay(CHARGE)
    assert info.value.code == "payer_failed"


def test_format_brl() -> None:
    assert px402.format_brl("500") == "R$ 5,00"
    assert px402.format_brl(1) == "R$ 0,01"
    assert px402.format_brl("100000000") == "R$ 1.000.000,00"


# --- codec details beyond the vectors -------------------------------------------------------


def test_codec_mirrors_javascript_details() -> None:
    import base64

    # array-index keys come first, as in a JavaScript object
    assert px402.decode_json_header(px402.encode_json_header({"b": 1, "10": 2, "2": 3})) == {"2": 3, "10": 2, "b": 1}
    assert list(px402.decode_json_header(base64.b64encode(b'{"b":1,"10":2,"2":3}').decode())) == ["2", "10", "b"]
    # TextDecoder drops a UTF-8 BOM
    assert px402.decode_json_header(base64.b64encode(b"\xef\xbb\xbf{}").decode()) == {}
    # NaN is not JSON
    with pytest.raises(px402.Px402Error):
        px402.decode_json_header(base64.b64encode(b'{"a":NaN}').decode())
    # a trailing newline is trimmed like any other whitespace
    assert px402.decode_json_header(px402.encode_json_header({"a": 1}) + "\n") == {"a": 1}
    # whole floats are written as integers, like JSON.stringify
    assert px402.encode_json_header({"n": 300.0}) == px402.encode_json_header({"n": 300})


def test_a_redirected_paid_retry_never_pays_again() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "pagamentos.example.net":
            return httpx.Response(402, headers={"payment-required": challenge("https://pagamentos.example.net/x")})
        if "payment-signature" in request.headers:
            return httpx.Response(307, headers={"location": "https://pagamentos.example.net/x"})
        return httpx.Response(402, headers={"payment-required": challenge()})

    payer = Payer()
    transport = px402.Px402Transport(payer, transport=server(handle), clock=lambda: START)
    with httpx.Client(transport=transport, follow_redirects=True) as client, pytest.raises(px402.Px402Error) as info:
        client.get(RESOURCE)
    assert (info.value.code, info.value.reason) == ("policy_exceeded", "redirected")
    assert len(payer.paid) == 1 and transport.spent == 500


def test_px402_client_keeps_httpx_transport_options() -> None:
    with px402.Px402Client(Payer(), verify=False, proxy="http://127.0.0.1:9") as client:
        assert client._mounts == {}  # a proxy mount would bypass the p-x402 transport
        assert isinstance(client._transport, px402.Px402Transport)
