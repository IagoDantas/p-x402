"""client-transcripts.json, replayed through the sync and the async transport.

The HTTP layer under the p-x402 transport is a mock that serves each exchange's response and
checks the request the client sent. Requests go through a real ``httpx.Client`` with
``follow_redirects=True``: a response with ``redirected: true`` is served as a ``302`` to its
``url`` followed by the response itself, so httpx follows the redirect as the vector describes.

The only header ignored in the comparison is ``host``: httpx always sends it (HTTP/1.1 requires it)
and it is derived from the URL, which is compared.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
import pytest
from conftest import cases, ids

import px402

TRANSCRIPTS = cases("client-transcripts.json")
IGNORED_REQUEST_HEADERS = {"host"}


def _epoch(text: str) -> float:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


class FakeClock:
    def __init__(self, start: str) -> None:
        self.now = _epoch(start)
        self.sleeps: List[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    async def asleep(self, seconds: float) -> None:
        self.sleep(seconds)


class RecordingPayer:
    def __init__(self, pays_br_code: bool) -> None:
        self.pays_br_code = pays_br_code
        self.payments: List[Dict[str, Any]] = []

    def pay(self, charge: px402.PixChargeToPay) -> None:
        self.payments.append(charge.to_dict())


class ReplayHTTP:
    """Serves the exchanges of one call in order and asserts each request."""

    def __init__(self) -> None:
        self.exchanges: List[Dict[str, Any]] = []
        self.index = 0
        self.redirect_target: Optional[Dict[str, Any]] = None

    def load(self, exchanges: List[Dict[str, Any]]) -> None:
        self.exchanges = exchanges
        self.index = 0
        self.redirect_target = None

    def done(self) -> bool:
        return self.index == len(self.exchanges) and self.redirect_target is None

    def respond(self, request: httpx.Request) -> httpx.Response:
        if self.redirect_target is not None:
            response = self.redirect_target
            self.redirect_target = None
            assert str(request.url) == response["url"], "the client did not follow the redirect"
            return self._response(response)

        assert self.index < len(self.exchanges), f"unexpected extra request {request.method} {request.url}"
        exchange = self.exchanges[self.index]
        self.index += 1
        expected = exchange["request"]
        assert request.method == expected["method"]
        assert str(request.url) == expected["url"]
        sent = {k.lower(): v for k, v in request.headers.items() if k.lower() not in IGNORED_REQUEST_HEADERS}
        assert sent == {k.lower(): v for k, v in expected["headers"].items()}

        response = exchange["response"]
        if response.get("redirected"):
            self.redirect_target = response
            return httpx.Response(302, headers={"location": response["url"]}, content=b"")
        return self._response(response)

    @staticmethod
    def _response(response: Dict[str, Any]) -> httpx.Response:
        return httpx.Response(
            response["status"], headers=list(response["headers"].items()), content=response["body"].encode("utf-8")
        )


class SyncReplay(httpx.BaseTransport):
    def __init__(self, http: ReplayHTTP) -> None:
        self.http = http

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return self.http.respond(request)


class AsyncReplay(httpx.AsyncBaseTransport):
    def __init__(self, http: ReplayHTTP) -> None:
        self.http = http

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        return self.http.respond(request)


def _options(case: Dict[str, Any]) -> Dict[str, Any]:
    client = case["client"]
    policy = client.get("policy", {})
    retry = client.get("retry", {})
    return {
        "policy": px402.SpendingPolicy(
            max_per_request=policy.get("maxPerRequest", 1000),
            max_total=policy.get("maxTotal", 5000),
            allowed_origins=policy.get("allowedOrigins"),
        ),
        "retry": px402.RetryOptions(
            initial_delay=retry.get("initialDelayMs", 500) / 1000,
            max_delay=retry.get("maxDelayMs", 5000) / 1000,
            factor=retry.get("factor", 2),
        ),
    }


def _outcome_of_response(response: httpx.Response) -> Dict[str, Any]:
    return {"type": "response", "status": response.status_code, "body": response.text}


def _outcome_of_error(error: px402.Px402Error, expected: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"type": "error", "code": error.code}
    if "reason" in expected:
        out["reason"] = error.reason
    return out


def _check_call(call: Dict[str, Any], outcome: Dict[str, Any], http: ReplayHTTP, payer: RecordingPayer,
                clock: FakeClock, start_payments: int, start_sleeps: int, spent: int) -> None:
    assert outcome == call["outcome"]
    assert http.done(), f"only {http.index} of {len(http.exchanges)} exchanges were used"
    assert payer.payments[start_payments:] == call["payments"]
    assert [round(s * 1000) for s in clock.sleeps[start_sleeps:]] == call["sleepsMs"]
    assert spent == call["spentAfter"]


def _new_client_parts(case: Dict[str, Any]):
    clock = FakeClock(case["client"]["clockStart"])
    payer = RecordingPayer(case["client"]["payer"].get("paysBrCode", True))
    return clock, payer, ReplayHTTP()


@pytest.mark.parametrize("case", TRANSCRIPTS, ids=ids(TRANSCRIPTS))
def test_transcript_sync(case: Dict[str, Any]) -> None:
    clock, payer, http = _new_client_parts(case)
    transport = px402.Px402Transport(
        payer, transport=SyncReplay(http), clock=clock, sleep=clock.sleep, **_options(case)
    )
    with httpx.Client(transport=transport, follow_redirects=True) as client:
        client.headers.clear()  # only the headers the caller and p-x402 set
        for call in case["calls"]:
            http.load(call["exchanges"])
            before_payments, before_sleeps = len(payer.payments), len(clock.sleeps)
            request = call["request"]
            try:
                response = client.request(request["method"], request["url"], headers=request["headers"])
                outcome = _outcome_of_response(response)
            except px402.Px402Error as error:
                outcome = _outcome_of_error(error, call["outcome"])
            _check_call(call, outcome, http, payer, clock, before_payments, before_sleeps, transport.spent)


@pytest.mark.parametrize("case", TRANSCRIPTS, ids=ids(TRANSCRIPTS))
def test_transcript_async(case: Dict[str, Any]) -> None:
    clock, payer, http = _new_client_parts(case)
    transport = px402.AsyncPx402Transport(
        payer, transport=AsyncReplay(http), clock=clock, sleep=clock.asleep, **_options(case)
    )

    async def run() -> None:
        async with httpx.AsyncClient(transport=transport, follow_redirects=True) as client:
            client.headers.clear()
            for call in case["calls"]:
                http.load(call["exchanges"])
                before_payments, before_sleeps = len(payer.payments), len(clock.sleeps)
                request = call["request"]
                try:
                    response = await client.request(request["method"], request["url"], headers=request["headers"])
                    outcome = _outcome_of_response(response)
                except px402.Px402Error as error:
                    outcome = _outcome_of_error(error, call["outcome"])
                _check_call(call, outcome, http, payer, clock, before_payments, before_sleeps, transport.spent)

    asyncio.run(run())
