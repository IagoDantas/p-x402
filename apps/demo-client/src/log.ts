import {
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  type FetchLike,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
} from "@p-x402/core"

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

let step = 0
export function say(text: string) {
  step++
  console.log(`\n${bold(`${step}.`)} ${text}`)
}

export function show(label: string, value: unknown) {
  console.log(dim(`   ${label}:`))
  for (const line of JSON.stringify(value, null, 2).split("\n")) console.log(dim(`     ${line}`))
}

export function brl(centavos: string | number): string {
  return `R$ ${(Number(centavos) / 100).toFixed(2).replace(".", ",")}`
}

/** Wraps a fetch and prints each request and response with the x402 headers decoded. */
export function loggingFetch(inner: FetchLike): FetchLike {
  return async (request) => {
    const signature = request.headers.get(HEADER_PAYMENT_SIGNATURE)
    say(
      `${request.method} ${request.url}${signature ? " com PAYMENT-SIGNATURE" : " (sem pagamento)"}`,
    )
    if (signature) {
      const payload = decodePaymentPayload(signature)
      show("PAYMENT-SIGNATURE (resumo)", {
        accepted: { amount: payload.accepted.amount, payTo: payload.accepted.payTo },
        payload: payload.payload,
      })
    }
    const response = await inner(request)
    console.log(`   ← HTTP ${response.status}`)
    const required = response.headers.get(HEADER_PAYMENT_REQUIRED)
    if (required) {
      const decoded = decodePaymentRequired(required)
      const brCode = decoded.accepts[0]?.extra?.brCode
      show("PAYMENT-REQUIRED", {
        ...decoded,
        accepts: decoded.accepts.map((a) => ({
          ...a,
          extra: {
            ...a.extra,
            brCode: typeof brCode === "string" ? `${brCode.slice(0, 32)}…` : brCode,
          },
        })),
      })
    }
    const paymentResponse = response.headers.get(HEADER_PAYMENT_RESPONSE)
    if (paymentResponse) show("PAYMENT-RESPONSE", decodeSettlementResponse(paymentResponse))
    const retryAfter = response.headers.get("retry-after")
    if (retryAfter) console.log(dim(`   Retry-After: ${retryAfter}`))
    return response
  }
}
