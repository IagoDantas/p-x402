import {
  type PaidFetch,
  type PaymentPolicy,
  type PixChargeToPay,
  type RetryOptions,
  wrapFetch,
} from "@p-x402/client"
import {
  encodePaymentPayload,
  encodePaymentRequired,
  encodeSettlementResponse,
  isPx402Error,
  type PaymentRequired,
} from "@p-x402/core"
import {
  CHARGE_ID,
  CLOCK_START,
  ORIGIN,
  paymentRequired,
  pixPayload,
  pixRequirements,
  RESOURCE,
} from "../fixtures"

/** One HTTP response as the transport hands it to the client. */
export interface WireResponse {
  status: number
  headers: Record<string, string>
  body: string
  /** Final URL when the transport followed a redirect (fetch's `response.url`). */
  url?: string
  /** The transport followed at least one redirect (fetch's `response.redirected`). */
  redirected?: boolean
}

export interface WireRequest {
  method: string
  url: string
  headers: Record<string, string>
}

export interface CallScript {
  request: WireRequest
  /** Responses the server gives, in order. Every one must be consumed. */
  responses: WireResponse[]
}

export interface Scenario {
  id: string
  description: string
  policy: Required<Pick<PaymentPolicy, "maxPerRequest" | "maxTotal">> &
    Pick<PaymentPolicy, "allowedOrigins">
  calls: CallScript[]
}

export const RETRY: Required<Pick<RetryOptions, "initialDelayMs" | "maxDelayMs" | "factor">> = {
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
}

const DEFAULT_POLICY = { maxPerRequest: 1000, maxTotal: 5000 }

function challenge(required: PaymentRequired): WireResponse {
  return {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": encodePaymentRequired(required),
    },
    body: JSON.stringify(required),
  }
}

function refused(errorReason: string, chargeId = CHARGE_ID, retryAfter?: string): WireResponse {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "payment-response": encodeSettlementResponse({
      success: false,
      errorReason,
      transaction: chargeId,
      network: "pix:br",
    }),
  }
  if (retryAfter !== undefined) headers["retry-after"] = retryAfter
  return { status: 402, headers, body: "{}" }
}

function pending(retryAfter?: string): WireResponse {
  const base = refused("settlement_pending", CHARGE_ID, retryAfter)
  const required: PaymentRequired = {
    x402Version: 2,
    error: "settlement_pending",
    resource: { url: RESOURCE },
    accepts: [pixRequirements()],
  }
  return {
    ...base,
    headers: { ...base.headers, "payment-required": encodePaymentRequired(required) },
    body: JSON.stringify(required),
  }
}

function ok(body: string, amount = "500", chargeId = CHARGE_ID): WireResponse {
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "payment-response": encodeSettlementResponse({
        success: true,
        transaction: chargeId,
        network: "pix:br",
        amount,
      }),
    },
    body,
  }
}

const get = (url: string, headers: Record<string, string> = {}): WireRequest => ({
  method: "GET",
  url,
  headers,
})

const reportBody = JSON.stringify({ titulo: "Relatório", linhas: 3 })

export const scenarios: Scenario[] = [
  {
    id: "client/no-payment",
    description: "a 200 passes through untouched; nothing is paid",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(`${ORIGIN}/status`),
        responses: [
          { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' },
        ],
      },
    ],
  },
  {
    id: "client/402-without-header",
    description:
      "a 402 without PAYMENT-REQUIRED is not an x402 challenge: returned as is, nothing paid",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [
          { status: 402, headers: { "content-type": "text/plain" }, body: "pague antes" },
        ],
      },
    ],
  },
  {
    id: "client/pay-then-200",
    description:
      "402 challenge, the payer pays the Pix charge, the retry carries PAYMENT-SIGNATURE and gets 200",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [challenge(paymentRequired([pixRequirements()])), ok(reportBody)],
      },
    ],
  },
  {
    id: "client/settlement-pending-then-200",
    description:
      "after paying, the server answers settlement_pending twice: first with Retry-After: 2 (wait max(2000, backoff 500)), then without it (wait backoff 1000); the third retry succeeds",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [
          challenge(paymentRequired([pixRequirements()])),
          pending("2"),
          pending(),
          ok(reportBody),
        ],
      },
    ],
  },
  {
    id: "client/charge-expired",
    description:
      "the server refuses the paid retry with charge_expired: the client stops with that code",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [challenge(paymentRequired([pixRequirements()])), refused("charge_expired")],
      },
    ],
  },
  {
    id: "client/charge-already-consumed",
    description:
      "the caller resends a PAYMENT-SIGNATURE from an earlier request (resume); the server says the charge was already used; nothing is paid",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE, { "payment-signature": encodePaymentPayload(pixPayload()) }),
        responses: [refused("charge_already_consumed")],
      },
    ],
  },
  {
    id: "client/unknown-error-reason",
    description: "a refusal whose errorReason is not a p-x402 code ends as payment_rejected",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [challenge(paymentRequired([pixRequirements()])), refused("insufficient_funds")],
      },
    ],
  },
  {
    id: "client/policy-max-per-request",
    description: "the charge (500) is above maxPerRequest (400): refused before paying, no retry",
    policy: { maxPerRequest: 400, maxTotal: 5000 },
    calls: [
      { request: get(RESOURCE), responses: [challenge(paymentRequired([pixRequirements()]))] },
    ],
  },
  {
    id: "client/policy-max-total",
    description:
      "maxTotal 800: the first 500 is paid; a second 500 would make 1000, so it is refused before paying",
    policy: { maxPerRequest: 1000, maxTotal: 800 },
    calls: [
      {
        request: get(RESOURCE),
        responses: [challenge(paymentRequired([pixRequirements()])), ok(reportBody)],
      },
      {
        request: get(`${ORIGIN}/relatorio-2`),
        responses: [
          challenge(
            paymentRequired(
              [
                pixRequirements({
                  chargeId: "pix_char_vector_0002",
                  resourceUrl: `${ORIGIN}/relatorio-2`,
                }),
              ],
              { url: `${ORIGIN}/relatorio-2` },
            ),
          ),
        ],
      },
    ],
  },
  {
    id: "client/policy-origin-not-allowed",
    description: "allowedOrigins does not include the request origin: refused before paying",
    policy: {
      ...DEFAULT_POLICY,
      allowedOrigins: ["https://outra-api.example.com", "localhost:3000"],
    },
    calls: [
      { request: get(RESOURCE), responses: [challenge(paymentRequired([pixRequirements()]))] },
    ],
  },
  {
    id: "client/redirected-402",
    description:
      "the transport followed a redirect to another origin, which answered 402: the client refuses to pay",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [
          {
            ...challenge(
              paymentRequired(
                [pixRequirements({ resourceUrl: "https://pagamentos.example.net/relatorio" })],
                {
                  url: "https://pagamentos.example.net/relatorio",
                },
              ),
            ),
            url: "https://pagamentos.example.net/relatorio",
            redirected: true,
          },
        ],
      },
    ],
  },
  {
    id: "client/same-origin-redirected-402",
    description: "a 402 reached through any followed redirect is refused, even on the same origin",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(`${ORIGIN}/relatorio-antigo`),
        responses: [
          { ...challenge(paymentRequired([pixRequirements()])), url: RESOURCE, redirected: true },
        ],
      },
    ],
  },
  {
    id: "client/resource-mismatch",
    description: "the charge is for another resource than the one requested: refused before paying",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [
          challenge(
            paymentRequired([
              pixRequirements({ resourceUrl: "https://outra-api.example.com/relatorio" }),
            ]),
          ),
        ],
      },
    ],
  },
  {
    id: "client/no-pix-option",
    description: "no option is a valid p-x402 Pix option: no_supported_requirements, nothing paid",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [
          challenge(
            paymentRequired([
              {
                scheme: "exact",
                network: "eip155:8453",
                amount: "10000",
                asset: "0x0000000000000000000000000000000000000001",
                payTo: "0x0000000000000000000000000000000000000002",
                maxTimeoutSeconds: 60,
              },
            ]),
          ),
        ],
      },
    ],
  },
  {
    id: "client/br-code-amount-mismatch",
    description:
      "the BR Code asks for R$ 50.00 while the requirements say 500 centavos: refused before paying",
    policy: DEFAULT_POLICY,
    calls: [
      {
        request: get(RESOURCE),
        responses: [challenge(paymentRequired([pixRequirements({ brCodeAmountBrl: "50.00" })]))],
      },
    ],
  },
]

function toResponse(wire: WireResponse): Response {
  const response = new Response(wire.body, { status: wire.status, headers: wire.headers })
  if (wire.url !== undefined) Object.defineProperty(response, "url", { value: wire.url })
  if (wire.redirected !== undefined) {
    Object.defineProperty(response, "redirected", { value: wire.redirected })
  }
  return response
}

function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name] = value
  })
  return out
}

export interface Clock {
  t: number
  sleeps: number[]
}

/**
 * Runs `scenario` through the real wrapFetch. `answer` supplies each server response given the
 * call index, the attempt index and the request the client sent.
 */
export async function runScenario(
  scenario: Scenario,
  answer: (call: number, attempt: number, request: WireRequest) => WireResponse,
) {
  const clock: Clock = { t: Date.parse(CLOCK_START), sleeps: [] }
  let payments: PixChargeToPay[] = []
  let exchanges: { request: WireRequest; response: WireResponse }[] = []
  let call = 0
  const fetchImpl = async (request: Request): Promise<Response> => {
    const seen: WireRequest = {
      method: request.method,
      url: request.url,
      headers: headersOf(request.headers),
    }
    const response = answer(call, exchanges.length, seen)
    exchanges.push({ request: seen, response })
    return toResponse(response)
  }
  const paid: PaidFetch = wrapFetch(fetchImpl, {
    payer: {
      async pay(charge) {
        payments.push(charge)
      },
    },
    policy: scenario.policy,
    retry: RETRY,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps.push(ms)
      clock.t += ms
    },
  })
  const calls: unknown[] = []
  for (const script of scenario.calls) {
    payments = []
    exchanges = []
    clock.sleeps = []
    let outcome: unknown
    try {
      const response = await paid(script.request.url, {
        method: script.request.method,
        headers: script.request.headers,
      })
      outcome = {
        type: "response",
        status: response.status,
        body: await response.text(),
      }
    } catch (error) {
      if (!isPx402Error(error)) throw error
      const reason = error.details?.reason
      outcome = {
        type: "error",
        code: error.code,
        ...(typeof reason === "string" ? { reason } : {}),
      }
    }
    calls.push({
      request: script.request,
      exchanges,
      payments,
      sleepsMs: clock.sleeps,
      outcome,
      spentAfter: paid.spent,
    })
    call++
  }
  return calls
}

export async function buildTranscriptVectors() {
  const cases: unknown[] = []
  for (const scenario of scenarios) {
    const calls = await runScenario(scenario, (call, attempt) => {
      const response = scenario.calls[call]?.responses[attempt]
      if (!response) throw new Error(`${scenario.id}: client sent more requests than scripted`)
      return response
    })
    calls.forEach((c, i) => {
      const used = (c as { exchanges: unknown[] }).exchanges.length
      if (used !== scenario.calls[i]?.responses.length) {
        throw new Error(`${scenario.id}: call ${i} used ${used} of the scripted responses`)
      }
    })
    cases.push({
      id: scenario.id,
      description: scenario.description,
      client: {
        policy: scenario.policy,
        retry: RETRY,
        clockStart: CLOCK_START,
        payer: { paysBrCode: true },
      },
      calls,
    })
  }
  return {
    area: "client-transcripts",
    format: {
      replay:
        "for each case build one client with `client`, then for each call make `request`; serve the exchanges' responses in order, assert each request the client sends equals the exchange's request, then compare payments, sleepsMs, outcome and spentAfter",
      headerNames:
        "lowercase; HTTP header names are case-insensitive. Request headers list every header the client sent",
      clock: "the client's clock starts at clockStart and advances only by the client's own sleeps",
      outcome:
        "{type: response, status, body} when the client returned a response; {type: error, code, reason?} when it raised (reason is the policy or check detail, when there is one)",
      payments: "what the payer was asked to pay, in order (centavos)",
      redirects:
        "url and redirected on a response describe a redirect the transport already followed",
    },
    cases,
  }
}
