"""Buys the demo report from a p-x402 server, paying the Pix charge on the way.

Start the TypeScript stack with the fake PSP first (from the repository root):

    PX402_PROVIDER=mock PX402_MERCHANT_TOKEN=tok-local PX402_DEV_SIMULATE=1 PX402_DB_PATH= bun run dev:facilitator
    PX402_MERCHANT_TOKEN=tok-local PX402_FACILITATOR_URL=http://localhost:4020 bun run dev:server

Then:

    python examples/buy_report.py                    # SimulatePayer: the facilitator marks the charge paid
    python examples/buy_report.py --async            # same, with the async client
    python examples/buy_report.py --payer terminal   # prints the Pix code and waits for you
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

import httpx

import px402


def show(response, spent: int) -> None:
    receipt = response.headers.get(px402.HEADER_PAYMENT_RESPONSE)
    print(f"HTTP {response.status_code}")
    print(json.dumps(response.json(), ensure_ascii=False, indent=2))
    if receipt:
        settled = px402.decode_settlement_response(receipt)
        print(f"receipt: success={settled.success} transaction={settled.transaction} amount={settled.amount}")
    print(f"spent so far: {px402.format_brl(spent)}")


class LoggingTransport(httpx.BaseTransport):
    """Prints every HTTP exchange the p-x402 transport makes, with the x402 headers decoded."""

    def __init__(self, inner: httpx.BaseTransport) -> None:
        self.inner = inner

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        signature = request.headers.get(px402.HEADER_PAYMENT_SIGNATURE)
        extra = ""
        if signature:
            extra = f" PAYMENT-SIGNATURE(chargeId={px402.decode_payment_payload(signature).payload.get('chargeId')})"
        print(f"  -> {request.method} {request.url}{extra}", flush=True)
        response = self.inner.handle_request(request)
        notes = []
        required = response.headers.get(px402.HEADER_PAYMENT_REQUIRED)
        if required:
            challenge = px402.decode_payment_required(required)
            option = challenge.accepts[0]
            notes.append(f"PAYMENT-REQUIRED({option.amount} centavos, chargeId={(option.extra or {}).get('chargeId')})")
        settled = response.headers.get(px402.HEADER_PAYMENT_RESPONSE)
        if settled:
            receipt = px402.decode_settlement_response(settled)
            notes.append(f"PAYMENT-RESPONSE(success={receipt.success}, {receipt.error_reason or receipt.transaction})")
        print(f"  <- {response.status_code} {' '.join(notes)}".rstrip(), flush=True)
        return response

    def close(self) -> None:
        self.inner.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://localhost:4021/relatorio")
    parser.add_argument("--facilitator", default="http://localhost:4020")
    parser.add_argument("--payer", choices=("simulate", "terminal"), default="simulate")
    parser.add_argument("--async", dest="use_async", action="store_true")
    parser.add_argument("--verbose", action="store_true", help="print every HTTP exchange (sync client only)")
    args = parser.parse_args()

    payer = px402.SimulatePayer(args.facilitator) if args.payer == "simulate" else px402.TerminalPayer()
    policy = px402.SpendingPolicy(max_per_request=1000, max_total=5000)

    def on_payment(event: px402.PaymentEvent) -> None:
        print(f"paid {px402.format_brl(event.amount)} for {event.resource_url} (charge {event.charge_id})")

    try:
        if args.use_async:

            async def run() -> None:
                async with px402.AsyncPx402Client(payer, policy=policy, on_payment=on_payment, timeout=30) as client:
                    show(await client.get(args.url), client.spent)

            asyncio.run(run())
        else:
            inner = LoggingTransport(httpx.HTTPTransport()) if args.verbose else None
            with px402.Px402Client(payer, policy=policy, on_payment=on_payment, transport=inner, timeout=30) as client:
                show(client.get(args.url), client.spent)
    except px402.Px402Error as error:
        print(f"p-x402 refused: {error.code} ({error.message}) {error.details}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
