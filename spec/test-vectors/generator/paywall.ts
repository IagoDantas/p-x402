import { encodeJsonHeader, encodePaymentPayload } from "@p-x402/core"
import { createPaywall, type PaywallResult, type PaywallRoute } from "@p-x402/server"
import { CHARGE_ID, CLOCK_START, ORIGIN, pixPayload, pixRequirements, RESOURCE } from "../fixtures"

/**
 * Paywall transcripts: the server SDK core (`createPaywall`) driven step by step against a
 * scripted facilitator. Each step is one incoming request (or the finalize of an earlier one);
 * the vector records every request the paywall sent to the facilitator and the response it gave.
 */

export const FACILITATOR_URL = "https://facilitator.example.com"
export const MERCHANT_TOKEN = "vector-merchant-token"
/** Stands for the random UUID the paywall sends as Idempotency-Key on /settle. */
export const IDEMPOTENCY_KEY_PLACEHOLDER = "<uuid>"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface PaywallWireRequest {
  method: string
  url: string
  headers: Record<string, string>
  clientIp?: string
}

export interface ScriptedAnswer {
  status: number
  headers?: Record<string, string>
  body: unknown
}

/** `network` stands for a transport error (the facilitator could not be reached). */
export type FacilitatorScript = ScriptedAnswer | { network: true }

export interface HandlerScript {
  status: number
  headers: Record<string, string>
  body: string
}

export type PaywallStep =
  | {
      kind: "request"
      request: PaywallWireRequest
      route: PaywallRoute & { amount: string }
      /** Facilitator answers, in order, for everything this step triggers (verify and settle). */
      facilitator: FacilitatorScript[]
      /** What the route handler returns when the request is paid; "throws" or "hold". */
      handler?: HandlerScript | "throws" | "hold"
    }
  | {
      kind: "finalize"
      /** Index of an earlier step whose handler was "hold". */
      step: number
      handler: HandlerScript
      facilitator: FacilitatorScript[]
    }

export interface PaywallScenario {
  id: string
  description: string
  config: { ipRateLimit?: { limit: number; windowMs: number }; publicOrigin?: string }
  steps: PaywallStep[]
}

const IP = "203.0.113.7"
const signature = encodePaymentPayload(pixPayload())
const signed = (url = RESOURCE): PaywallWireRequest => ({
  method: "GET",
  url,
  headers: { "payment-signature": signature },
  clientIp: IP,
})
const unsigned = (url = RESOURCE, method = "GET", clientIp: string | undefined = IP) => ({
  method,
  url,
  headers: {},
  ...(clientIp === undefined ? {} : { clientIp }),
})
const route = { amount: "500" }
const charge = (o: Parameters<typeof pixRequirements>[0] = {}): ScriptedAnswer => ({
  status: 200,
  body: { paymentRequirements: pixRequirements(o) },
})
const valid: ScriptedAnswer = { status: 200, body: { isValid: true } }
const invalid = (reason: string): ScriptedAnswer => ({
  status: 200,
  body: { isValid: false, invalidReason: reason },
})
const settled: ScriptedAnswer = {
  status: 200,
  body: { success: true, transaction: CHARGE_ID, network: "pix:br", amount: "500", payer: "x" },
}
const settleFailed = (reason: string): ScriptedAnswer => ({
  status: 200,
  body: { success: false, errorReason: reason, transaction: CHARGE_ID, network: "pix:br" },
})
const report: HandlerScript = {
  status: 200,
  headers: { "content-type": "application/json", "x-handler": "1" },
  body: JSON.stringify({ titulo: "Relatório", linhas: 3 }),
}

export const scenarios: PaywallScenario[] = [
  {
    id: "paywall/charge-created",
    description:
      "no PAYMENT-SIGNATURE: the paywall asks the facilitator for a charge and answers 402 with PAYMENT-REQUIRED",
    config: {},
    steps: [{ kind: "request", request: unsigned(), route, facilitator: [charge()] }],
  },
  {
    id: "paywall/charge-with-description",
    description:
      "route description and mimeType go into resource; the description is sent to /pix/charges",
    config: {},
    steps: [
      {
        kind: "request",
        request: unsigned(),
        route: { amount: "500", description: "Relatório de vendas", mimeType: "application/json" },
        facilitator: [charge()],
      },
    ],
  },
  {
    id: "paywall/public-origin",
    description:
      "behind a proxy, publicOrigin replaces the request origin in the resource URL (query kept)",
    config: { publicOrigin: "https://api.example.com" },
    steps: [
      {
        kind: "request",
        request: unsigned("http://10.0.0.5:8080/relatorio?mes=11"),
        route,
        facilitator: [charge({ resourceUrl: `${ORIGIN}/relatorio?mes=11` })],
      },
    ],
  },
  {
    id: "paywall/head-not-payable",
    description: "HEAD never creates, verifies or settles a charge",
    config: {},
    steps: [{ kind: "request", request: unsigned(RESOURCE, "HEAD"), route, facilitator: [] }],
  },
  {
    id: "paywall/ip-rate-limit",
    description:
      "charge creation is capped per client IP; the refused request gets 429 with Retry-After and no facilitator call",
    config: { ipRateLimit: { limit: 1, windowMs: 60_000 } },
    steps: [
      { kind: "request", request: unsigned(), route, facilitator: [charge()] },
      { kind: "request", request: unsigned(), route, facilitator: [] },
    ],
  },
  {
    id: "paywall/ip-rate-limit-ipv6-prefix",
    description: "IPv6 clients share a bucket per /64 prefix",
    config: { ipRateLimit: { limit: 1, windowMs: 60_000 } },
    steps: [
      {
        kind: "request",
        request: unsigned(RESOURCE, "GET", "2001:db8:1:2::10"),
        route,
        facilitator: [charge()],
      },
      {
        kind: "request",
        request: unsigned(RESOURCE, "GET", "2001:db8:1:2:ffff::1"),
        route,
        facilitator: [],
      },
    ],
  },
  {
    id: "paywall/ip-rate-limit-mapped-ipv4",
    description: "an IPv4-mapped IPv6 address counts as the IPv4 address",
    config: { ipRateLimit: { limit: 1, windowMs: 60_000 } },
    steps: [
      { kind: "request", request: unsigned(RESOURCE, "GET", IP), route, facilitator: [charge()] },
      {
        kind: "request",
        request: unsigned(RESOURCE, "GET", `::ffff:${IP}`),
        route,
        facilitator: [],
      },
    ],
  },
  {
    id: "paywall/facilitator-rate-limited",
    description: "a 429 from /pix/charges is passed on with its Retry-After",
    config: {},
    steps: [
      {
        kind: "request",
        request: unsigned(),
        route,
        facilitator: [
          { status: 429, headers: { "retry-after": "7" }, body: { error: "rate_limited" } },
        ],
      },
    ],
  },
  {
    id: "paywall/facilitator-down",
    description: "the facilitator cannot be reached: 502 facilitator_error",
    config: {},
    steps: [{ kind: "request", request: unsigned(), route, facilitator: [{ network: true }] }],
  },
  {
    id: "paywall/facilitator-unauthorized",
    description: "the facilitator refuses the merchant token: 500 unauthorized",
    config: {},
    steps: [
      {
        kind: "request",
        request: unsigned(),
        route,
        facilitator: [{ status: 401, body: { error: "unauthorized" } }],
      },
    ],
  },
  {
    id: "paywall/charge-for-another-amount",
    description: "a charge whose amount differs from the route price is never offered: 502",
    config: {},
    steps: [
      { kind: "request", request: unsigned(), route, facilitator: [charge({ amount: "400" })] },
    ],
  },
  {
    id: "paywall/invalid-header",
    description: "an unreadable PAYMENT-SIGNATURE: 400 invalid_header",
    config: {},
    steps: [
      {
        kind: "request",
        request: {
          method: "GET",
          url: RESOURCE,
          headers: { "payment-signature": "%%%" },
          clientIp: IP,
        },
        route,
        facilitator: [],
      },
    ],
  },
  {
    id: "paywall/invalid-payload",
    description: "a PaymentPayload that is not a p-x402 Pix payload: 400 invalid_payload",
    config: {},
    steps: [
      {
        kind: "request",
        request: {
          method: "GET",
          url: RESOURCE,
          headers: {
            "payment-signature": encodeJsonHeader({ ...pixPayload(), payload: { other: true } }),
          },
          clientIp: IP,
        },
        route,
        facilitator: [],
      },
    ],
  },
  {
    id: "paywall/paid",
    description:
      "verify, run the handler, settle; the reply carries PAYMENT-RESPONSE without payer data",
    config: {},
    steps: [
      { kind: "request", request: signed(), route, facilitator: [valid, settled], handler: report },
    ],
  },
  {
    id: "paywall/server-owned-fields",
    description:
      "the requirements sent to the facilitator take amount and resourceUrl from the route and the request, not from the client",
    config: {},
    steps: [
      {
        kind: "request",
        request: {
          method: "GET",
          url: RESOURCE,
          headers: {
            "payment-signature": encodePaymentPayload(
              pixPayload(pixRequirements({ amount: "1", resourceUrl: `${ORIGIN}/barato` })),
            ),
          },
          clientIp: IP,
        },
        route,
        facilitator: [invalid("amount_mismatch")],
      },
    ],
  },
  {
    id: "paywall/settlement-pending",
    description:
      "verify says settlement_pending: 402 with PAYMENT-REQUIRED (error settlement_pending), PAYMENT-RESPONSE and Retry-After: 2, the same charge",
    config: {},
    steps: [
      { kind: "request", request: signed(), route, facilitator: [invalid("settlement_pending")] },
    ],
  },
  {
    id: "paywall/charge-expired",
    description: "verify refuses with charge_expired: 402 with PAYMENT-RESPONSE",
    config: {},
    steps: [
      { kind: "request", request: signed(), route, facilitator: [invalid("charge_expired")] },
    ],
  },
  {
    id: "paywall/handler-error-not-settled",
    description:
      "the handler answers 500: the response passes through and the charge is not settled",
    config: {},
    steps: [
      {
        kind: "request",
        request: signed(),
        route,
        facilitator: [valid],
        handler: { status: 500, headers: { "content-type": "text/plain" }, body: "boom" },
      },
    ],
  },
  {
    id: "paywall/handler-4xx-not-settled",
    description: "any handler status >= 400 skips settle, not only 5xx",
    config: {},
    steps: [
      {
        kind: "request",
        request: signed(),
        route,
        facilitator: [valid],
        handler: {
          status: 404,
          headers: { "content-type": "application/json" },
          body: '{"erro":"nao achei"}',
        },
      },
    ],
  },
  {
    id: "paywall/handler-throws-then-retry",
    description:
      "the handler throws: no settle, the lock is released, and the same signature is verified again",
    config: {},
    steps: [
      { kind: "request", request: signed(), route, facilitator: [valid], handler: "throws" },
      { kind: "request", request: signed(), route, facilitator: [valid, settled], handler: report },
    ],
  },
  {
    id: "paywall/concurrent-same-charge",
    description:
      "while one request for a charge is between verify and settle, another gets settlement_pending without verify",
    config: {},
    steps: [
      { kind: "request", request: signed(), route, facilitator: [valid], handler: "hold" },
      { kind: "request", request: signed(), route, facilitator: [] },
      { kind: "finalize", step: 0, handler: report, facilitator: [settled] },
    ],
  },
  {
    id: "paywall/settle-retried-with-same-key",
    description: "a transport error and a 5xx on /settle are retried with the same Idempotency-Key",
    config: {},
    steps: [
      {
        kind: "request",
        request: signed(),
        route,
        facilitator: [valid, { network: true }, { status: 503, body: {} }, settled],
        handler: report,
      },
    ],
  },
  {
    id: "paywall/settle-gives-up",
    description:
      "three failed /settle attempts: 502 facilitator_error, the handler output is discarded",
    config: {},
    steps: [
      {
        kind: "request",
        request: signed(),
        route,
        facilitator: [valid, { network: true }, { network: true }, { status: 500, body: {} }],
        handler: report,
      },
    ],
  },
  {
    id: "paywall/settle-refused",
    description:
      "settle refuses with charge_already_consumed: 402 with PAYMENT-RESPONSE, the handler output is discarded",
    config: {},
    steps: [
      {
        kind: "request",
        request: signed(),
        route,
        facilitator: [valid, settleFailed("charge_already_consumed")],
        handler: report,
      },
    ],
  },
  {
    id: "paywall/verify-unauthorized",
    description: "the facilitator refuses the merchant token on /verify: 500 unauthorized",
    config: {},
    steps: [
      {
        kind: "request",
        request: signed(),
        route,
        facilitator: [{ status: 401, body: { error: "unauthorized" } }],
      },
    ],
  },
]

interface RecordedFacilitatorRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name] = value
  })
  return out
}

async function wire(response: Response) {
  return {
    status: response.status,
    headers: headersOf(response.headers),
    body: await response.text(),
  }
}

function toHandlerResponse(handler: HandlerScript): Response {
  return new Response(handler.body, { status: handler.status, headers: handler.headers })
}

/** Runs one scenario through the real createPaywall with a scripted facilitator. */
export async function runPaywallScenario(scenario: PaywallScenario) {
  const queue: FacilitatorScript[] = []
  let recorded: RecordedFacilitatorRequest[] = []
  let stepKeys = new Set<string>()
  const fetchImpl = async (request: Request): Promise<Response> => {
    const headers = headersOf(request.headers)
    const key = headers["idempotency-key"]
    if (key !== undefined) {
      if (!UUID_RE.test(key)) throw new Error(`${scenario.id}: idempotency key is not a UUID`)
      headers["idempotency-key"] = IDEMPOTENCY_KEY_PLACEHOLDER
      stepKeys.add(key)
    }
    recorded.push({ method: request.method, url: request.url, headers, body: await request.text() })
    const next = queue.shift()
    if (!next) throw new Error(`${scenario.id}: unscripted facilitator call to ${request.url}`)
    if ("network" in next) throw new TypeError("network error")
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    })
  }
  const paywall = createPaywall({
    facilitatorUrl: FACILITATOR_URL,
    token: MERCHANT_TOKEN,
    fetch: fetchImpl,
    now: () => Date.parse(CLOCK_START),
    ...scenario.config,
  })
  const held = new Map<number, Extract<PaywallResult, { type: "paid" }>>()
  const steps: unknown[] = []
  const quiet = { error: console.error, warn: console.warn }
  console.error = () => undefined
  console.warn = () => undefined
  try {
    for (const [index, step] of scenario.steps.entries()) {
      queue.push(...step.facilitator)
      recorded = []
      stepKeys = new Set<string>()
      let outcome: unknown
      if (step.kind === "request") {
        const request = new Request(step.request.url, {
          method: step.request.method,
          headers: step.request.headers,
        })
        const ctx = step.request.clientIp === undefined ? {} : { clientIp: step.request.clientIp }
        const result = await paywall.handle(request, step.route, ctx)
        if (result.type === "response") {
          if (step.handler !== undefined)
            throw new Error(`${scenario.id}: step ${index} was not paid`)
          outcome = { type: "response", response: await wire(result.response) }
        } else {
          const paid = { chargeId: result.chargeId, amount: result.amount }
          if (step.handler === undefined)
            throw new Error(`${scenario.id}: step ${index} has no handler`)
          if (step.handler === "throws") {
            result.release()
            outcome = { type: "paid", ...paid, handler: "throws" }
          } else if (step.handler === "hold") {
            held.set(index, result)
            outcome = { type: "paid", ...paid, handler: "hold" }
          } else {
            const response = await result.finalize(toHandlerResponse(step.handler))
            outcome = {
              type: "paid",
              ...paid,
              handler: step.handler,
              response: await wire(response),
            }
          }
        }
        steps.push({
          kind: "request",
          request: step.request,
          route: step.route,
          facilitator: [],
          outcome,
        })
      } else {
        const result = held.get(step.step)
        if (!result) throw new Error(`${scenario.id}: step ${step.step} is not held`)
        const response = await result.finalize(toHandlerResponse(step.handler))
        steps.push({
          kind: "finalize",
          step: step.step,
          handler: step.handler,
          facilitator: [],
          outcome: { type: "response", response: await wire(response) },
        })
      }
      if (queue.length > 0)
        throw new Error(`${scenario.id}: step ${index} left facilitator answers unused`)
      if (stepKeys.size > 1)
        throw new Error(`${scenario.id}: step ${index} changed the idempotency key`)
      const facilitator = recorded.map((request, i) => ({ request, response: step.facilitator[i] }))
      ;(steps[steps.length - 1] as { facilitator: unknown }).facilitator = facilitator
    }
  } finally {
    console.error = quiet.error
    console.warn = quiet.warn
  }
  return steps
}

export async function buildPaywallVectors() {
  const cases: unknown[] = []
  for (const scenario of scenarios) {
    cases.push({
      id: scenario.id,
      description: scenario.description,
      config: {
        facilitatorUrl: FACILITATOR_URL,
        token: MERCHANT_TOKEN,
        clock: CLOCK_START,
        ...scenario.config,
      },
      steps: await runPaywallScenario(scenario),
    })
  }
  return {
    area: "paywall-transcripts",
    format: {
      replay:
        "for each case build one paywall with `config`, then run the steps in order against a facilitator stub that serves each step's `facilitator[i].response` to the paywall's i-th facilitator request and asserts the request equals `facilitator[i].request`",
      request:
        "a request step hands the paywall `request` (method, url, headers, clientIp for the per-IP cap) and `route` (amount in centavos, optional description, mimeType, resource)",
      outcome:
        "{type: response, response} when the paywall answered by itself; {type: paid, chargeId, amount, handler, response?} when the request was paid: the handler output `handler` is handed to finalize and `response` is what the paywall returns; handler `throws` means the handler raised (release, no settle) and `hold` means finalize runs in a later `finalize` step",
      facilitatorRequests: `method, url, headers and the exact JSON body text; header names are lowercase; the Idempotency-Key on /settle is a random UUID written as "${IDEMPOTENCY_KEY_PLACEHOLDER}" and must be the same on every attempt of one settle`,
      facilitatorResponses:
        "{status, headers?, body} is served as JSON with content-type application/json; {network: true} is a transport error",
      responses:
        "status, every header (lowercase names) and the exact body text; header values that are base64 headers compare byte for byte",
      clock: "the paywall's clock is fixed at `config.clock` for every step",
    },
    cases,
  }
}
