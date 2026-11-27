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

import px402


def show(response, spent: int) -> None:
    receipt = response.headers.get(px402.HEADER_PAYMENT_RESPONSE)
    print(f"HTTP {response.status_code}")
    print(json.dumps(response.json(), ensure_ascii=False, indent=2))
    if receipt:
        settled = px402.decode_settlement_response(receipt)
        print(f"receipt: success={settled.success} transaction={settled.transaction} amount={settled.amount}")
    print(f"spent so far: {px402.format_brl(spent)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://localhost:4021/relatorio")
    parser.add_argument("--facilitator", default="http://localhost:4020")
    parser.add_argument("--payer", choices=("simulate", "terminal"), default="simulate")
    parser.add_argument("--async", dest="use_async", action="store_true")
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
            with px402.Px402Client(payer, policy=policy, on_payment=on_payment, timeout=30) as client:
                show(client.get(args.url), client.spent)
    except px402.Px402Error as error:
        print(f"p-x402 refused: {error.code} ({error.message}) {error.details}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
