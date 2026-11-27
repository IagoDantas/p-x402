# p-x402 for Python

Client SDK for [p-x402](../../README.md): call an API that answers `402 Payment Required` with a
Pix charge, and let the SDK pay it and retry. It behaves like the TypeScript `@p-x402/client`
(`wrapFetch`) and passes every case in [`spec/test-vectors/`](../../spec/test-vectors/README.md).

- Package `p-x402`, import name `px402`. Python 3.9 or later. One dependency: `httpx`.
- Sync and async `httpx` transports, plus `Px402Client` / `AsyncPx402Client` that wrap them.
- A spending policy that is on by default: R$ 10,00 per request, R$ 50,00 per client.
- Payers: `SimulatePayer` (development, no money moves) and `TerminalPayer` (prints the Pix
  "copia e cola" code and waits for a person to pay it). No bank integration.
- Client only: the server side (paywall middleware) is a later step.

## Install

Not on PyPI yet. From a checkout of this repository:

```bash
pip install ./sdks/python
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

## Example against the TypeScript demo

From the repository root, start the facilitator with the fake PSP and the demo server:

```bash
PX402_PROVIDER=mock PX402_MERCHANT_TOKEN=tok-local PX402_DEV_SIMULATE=1 PX402_DB_PATH= bun run dev:facilitator
```

```bash
PX402_MERCHANT_TOKEN=tok-local PX402_FACILITATOR_URL=http://localhost:4020 bun run dev:server
```

Then:

```bash
python sdks/python/examples/buy_report.py
```

## Tests

```bash
bun run test:python
```

That runs `sdks/python/scripts/test.sh`, which creates `sdks/python/.venv` on first use, installs the
package with its test dependency (`pytest`) and runs every case in `spec/test-vectors/` (codec in
both directions, validation, requirement matching, error codes, and each client transcript replayed
through the sync and the async transport) plus tests for behaviour the vectors leave out.
