"""paywall-transcripts.json, replayed through px402.server.Paywall with a stubbed facilitator.

The paywall's httpx client has its default headers removed, so the facilitator requests carry only
what the paywall sets. ``host`` and ``content-length`` are ignored in the comparison: httpx adds
them at the transport level from the URL and the body, and both of those are compared.
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from typing import Any, Dict, List

import httpx
import pytest
from conftest import cases, ids, load

from px402.server import PaidRequest, Paywall, PaywallRequest, PaywallResponse, PaywallRoute

PAYWALL = cases("paywall-transcripts.json")
FORMAT = load("paywall-transcripts.json")["format"]
IGNORED = {"host", "content-length"}
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


class Facilitator:
    """Serves one step's scripted answers and checks each request the paywall sends."""

    def __init__(self) -> None:
        self.script: List[Dict[str, Any]] = []
        self.index = 0
        self.keys: set = set()

    def load(self, exchanges: List[Dict[str, Any]]) -> None:
        self.script, self.index, self.keys = exchanges, 0, set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert self.index < len(self.script), f"unscripted facilitator call to {request.url}"
        exchange = self.script[self.index]
        self.index += 1
        expected = exchange["request"]
        headers = {k.lower(): v for k, v in request.headers.items() if k.lower() not in IGNORED}
        key = headers.get("idempotency-key")
        if key is not None:
            assert UUID_RE.fullmatch(key), key
            self.keys.add(key)
            headers["idempotency-key"] = "<uuid>"
        assert request.method == expected["method"]
        assert str(request.url) == expected["url"]
        assert headers == expected["headers"]
        assert request.content.decode("utf-8") == expected["body"]  # exact JSON text, key order included
        answer = exchange["response"]
        if answer.get("network"):
            raise httpx.ConnectError("network error", request=request)
        return httpx.Response(
            answer["status"],
            headers={"content-type": "application/json", **answer.get("headers", {})},
            content=json.dumps(answer["body"], separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        )


def _response(response: PaywallResponse) -> Dict[str, Any]:
    return {"status": response.status, "headers": response.headers, "body": response.body.decode("utf-8")}


def _handler(script: Dict[str, Any]) -> PaywallResponse:
    return PaywallResponse(script["status"], dict(script["headers"]), script["body"].encode("utf-8"))


def _route(route: Dict[str, Any]) -> PaywallRoute:
    return PaywallRoute(
        amount=route["amount"],
        description=route.get("description"),
        mime_type=route.get("mimeType"),
        resource=route.get("resource"),
    )


def test_format_mentions_the_placeholder() -> None:
    assert "<uuid>" in FORMAT["facilitatorRequests"]


@pytest.mark.parametrize("case", PAYWALL, ids=ids(PAYWALL))
def test_paywall_transcript(case: Dict[str, Any]) -> None:
    config = case["config"]
    facilitator = Facilitator()
    clock = datetime.fromisoformat(config["clock"].replace("Z", "+00:00")).timestamp()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(facilitator)) as http:
            http.headers.clear()
            limit = config.get("ipRateLimit")
            paywall = Paywall(
                config["facilitatorUrl"],
                config["token"],
                http_client=http,
                clock=lambda: clock,
                public_origin=config.get("publicOrigin"),
                **({"ip_rate_limit": (limit["limit"], limit["windowMs"] / 1000)} if limit else {}),
            )
            held: Dict[int, PaidRequest] = {}
            for index, step in enumerate(case["steps"]):
                facilitator.load(step["facilitator"])
                expected = step["outcome"]
                if step["kind"] == "finalize":
                    out = await held.pop(step["step"]).finalize(_handler(step["handler"]))
                    assert {"type": "response", "response": _response(out)} == expected
                else:
                    request = step["request"]
                    result = await paywall.handle(
                        PaywallRequest(
                            method=request["method"],
                            url=request["url"],
                            headers=request["headers"],
                            client_ip=request.get("clientIp"),
                        ),
                        _route(step["route"]),
                    )
                    if isinstance(result, PaywallResponse):
                        assert {"type": "response", "response": _response(result)} == expected
                    else:
                        assert expected["type"] == "paid", f"step {index}: paid, expected {expected}"
                        assert (result.charge_id, result.amount) == (expected["chargeId"], expected["amount"])
                        handler = expected["handler"]
                        if handler == "throws":
                            result.release()
                        elif handler == "hold":
                            held[index] = result
                        else:
                            out = await result.finalize(_handler(handler))
                            assert _response(out) == expected["response"]
                assert facilitator.index == len(step["facilitator"]), "facilitator answers left unused"
                assert len(facilitator.keys) <= 1, "the idempotency key changed between settle attempts"

    asyncio.run(run())
