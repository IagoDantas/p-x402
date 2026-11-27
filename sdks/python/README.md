# p-x402 for Python

Python SDK for [p-x402](../../README.md), both sides of the protocol:

- **client**: call an API that answers `402 Payment Required` with a Pix charge and let the SDK pay
  it and retry. Behaves like the TypeScript `@p-x402/client` (`wrapFetch`).
- **server** (`px402.server`): put a Pix price on a route. Behaves like `@p-x402/server` and talks to
  the TypeScript facilitator over HTTP; it holds no PSP key and no database.

Both pass every case in [`spec/test-vectors/`](../../spec/test-vectors/README.md).

- Package `p-x402`, import name `px402`. Python 3.9 or later. One dependency: `httpx`.
- Sync and async `httpx` transports, plus `Px402Client` / `AsyncPx402Client` that wrap them.
- A spending policy that is on by default: R$ 10,00 per request, R$ 50,00 per client.
- Payers: `SimulatePayer` (development, no money moves) and `TerminalPayer` (prints the Pix
  "copia e cola" code and waits for a person to pay it). No bank integration.
- A framework-free paywall core plus a FastAPI / Starlette adapter (optional extra `fastapi`).

## Install

Not on PyPI yet. From a checkout of this repository:

```bash
pip install ./sdks/python               # client and server core
pip install "./sdks/python[fastapi]"    # plus the FastAPI / Starlette adapter
```

## Usage

```python
import px402

payer = px402.SimulatePayer("http://localhost:4020")  # dev only: the facilitator marks the charge paid
policy = px402.SpendingPolicy(max_per_request=1000, max_total=5000, allowed_origins=["localhost:4021"])

with px402.Px402Client(payer, policy=policy) as client:
    response = client.get("http://localhost:4021/relatorio")  # 402 -> Pix -> 200, handled here
    print(response.status_code, response.json())
    print("spent (centavos):", client.spent)
```

The transport can also go into a client you already configure:

```python
import httpx, px402

transport = px402.Px402Transport(px402.TerminalPayer(), policy=px402.SpendingPolicy(max_per_request=500))
client = httpx.Client(transport=transport, timeout=30)
```

Async:

```python
async with px402.AsyncPx402Client(px402.SimulatePayer("http://localhost:4020")) as client:
    response = await client.get("http://localhost:4021/relatorio")
```

When the SDK will not pay, it raises `px402.Px402Error` with a stable `code` (the same codes as the
TypeScript SDK, listed in `spec/test-vectors/error-codes.json`):

```python
try:
    client.get(url)
except px402.Px402Error as error:
    error.code     # "policy_exceeded", "charge_expired", "charge_already_consumed", ...
    error.reason   # for policy_exceeded: "max_per_request", "max_total", "origin_not_allowed", "redirected", ...
    error.details  # context; after "payer_failed" it holds "payment_signature" so you can resume
```

To resume a paid request (for example after a crash, using the signature from `on_payment` or from
a `payer_failed` error), send the same request with the `PAYMENT-SIGNATURE` header set. Nothing is
paid again.

### What the client checks before paying

In this order, as in TypeScript: the 402 was not reached through a redirect; a valid Pix option
exists; its `resourceUrl` equals the challenge's `resource.url` and has the request's origin; the
origin is in `allowed_origins` (when set); the BR Code asks for exactly `amount` (skipped for
`SimulatePayer`, which never pays the code); `amount <= max_per_request`; `spent + amount <= max_total`.
The amount counts as spent as soon as the payer is called. After paying, it retries with
`PAYMENT-SIGNATURE`, waits `max(Retry-After, backoff)` on `settlement_pending` until the charge
expires (`payment_timeout`), and raises the server's code for any other refusal (`payment_rejected`
for codes it does not know).

### Writing a payer

A payer is any object with `pay(charge)` (sync) and, for the async transport, optionally
`async apay(charge)`. Raise to signal failure. Set `pays_br_code = False` only if the payer never
pays the BR Code itself.

```python
class MyPayer:
    pays_br_code = True

    def pay(self, charge: px402.PixChargeToPay) -> None:
        # charge.br_code is the Pix copia e cola; never pay more than charge.amount (centavos)
        ...
```

## Server: a paid route

```python
import os
from fastapi import Depends, FastAPI
from px402.server.fastapi import Payment, PixPaywall

app = FastAPI()
pix = PixPaywall("http://localhost:4020", token=os.environ["PX402_MERCHANT_TOKEN"])
pix.install(app)  # one middleware (settles after the handler) and one exception handler

@app.get("/relatorio")
async def relatorio(payment: Payment = Depends(pix.require(amount=500, description="Relatório"))):
    return {"pagoCom": payment.charge_id}
```

What happens, as in TypeScript:

- No `PAYMENT-SIGNATURE`: the per-IP cap (10 charges a minute by default, IPv6 counted per /64;
  `429` with `Retry-After` past it), then `POST /pix/charges`, then `402` with `PAYMENT-REQUIRED`.
- With one: the paywall takes an in-process lock on the charge and calls `/verify`. If the payment is
  not confirmed yet the answer is `402` with `settlement_pending`, `Retry-After: 2` and the same
  charge. If it is valid, the handler runs; after it returns, the middleware calls `/settle` (with an
  Idempotency-Key, retried twice on transport errors and 5xx) and adds `PAYMENT-RESPONSE`.
- A handler that raises or answers with a status >= 400 is not settled: the client's paid charge
  stays unused and the same signature works on a retry.
- `HEAD` and `OPTIONS` never create or settle a charge. Behind a proxy, pass
  `public_origin="https://api.example.com"` and a `client_ip=` function that reads your proxy's header.

The core works without any framework:

```python
from px402.server import Paywall, PaywallRequest, PaywallResponse, PaywallRoute

paywall = Paywall("http://localhost:4020", token)
result = await paywall.handle(PaywallRequest(method, url, headers, client_ip), PaywallRoute(amount=500))
if isinstance(result, PaywallResponse):
    ...  # send result.status, result.headers, result.body as is
else:
    try:
        output = await run_handler()  # your route, giving a PaywallResponse
    except Exception:
        result.release()
        raise
    response = await result.finalize(output)  # settled, with PAYMENT-RESPONSE (or the refusal)
```

The paywall keeps its locks and rate-limit counters in memory: run one per process, and with several
processes use sticky routing per charge or handlers that are safe to run twice.

## Interoperability

The Python and TypeScript SDKs speak the same protocol and use the same TypeScript facilitator, so any
client works with any server:

| Client | Paid API | Facilitator |
|---|---|---|
| Python (`Px402Client`) | TypeScript (`@p-x402/server`, demo server) | TypeScript, mock PSP |
| TypeScript (`wrapFetch`) | Python (FastAPI + `px402.server`) | TypeScript, mock PSP |
| Python (`Px402Client`) | Python (FastAPI + `px402.server`) | TypeScript, mock PSP |

One command starts the facilitator, both paid APIs on free local ports, runs all three pairs, prints
every step and fails if any pair fails:

```bash
bun run interop
```

## Example against the TypeScript demo

From the repository root, start the facilitator with the fake PSP and the demo server:

```bash
PX402_PROVIDER=mock PX402_MERCHANT_TOKEN=tok-local PX402_DEV_SIMULATE=1 PX402_DB_PATH= bun run dev:facilitator
```

```bash
PX402_MERCHANT_TOKEN=tok-local PX402_FACILITATOR_URL=http://localhost:4020 bun run dev:server
```

Then buy the report from the TypeScript demo server:

```bash
python sdks/python/examples/buy_report.py --verbose
```

Or start the Python paid API (`examples/paid_api.py`, port 4022) and buy from it instead:

```bash
PX402_MERCHANT_TOKEN=tok-local PX402_FACILITATOR_URL=http://localhost:4020 python sdks/python/examples/paid_api.py
```

```bash
python sdks/python/examples/buy_report.py --url http://localhost:4022/relatorio --verbose
```

## Tests

```bash
bun run test:python
```

That runs `sdks/python/scripts/test.sh`, which creates `sdks/python/.venv` on first use, installs the
package with its dev extras (`pytest`, FastAPI, uvicorn) and runs every case in `spec/test-vectors/`:
codec in both directions, validation, requirement matching, error codes, each client transcript
replayed through the sync and the async transport, and each paywall transcript replayed through
`px402.server.Paywall` against a stubbed facilitator. On top of that: client behaviour the vectors
leave out, and the FastAPI adapter in process.
