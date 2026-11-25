import { describe, expect, test } from "bun:test"
import { type PaymentEvent, wrapFetch } from "@p-x402/client"
import {
  decodePaymentRequired,
  decodeSettlementResponse,
  encodePaymentPayload,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isPx402Error,
} from "@p-x402/core"
import { createDemoServer } from "@p-x402/demo-server"
import { createFacilitator } from "@p-x402/facilitator"
import { memoryStore } from "@p-x402/facilitator/stores/memory"
import { createMockPixProvider } from "@p-x402/psp"
import { type Px402Variables, pixPaywall } from "@p-x402/server/hono"
import { Hono } from "hono"

const TOKEN = "e2e-token"
const SELLER = "http://loja.test"

function setup() {
  let t = Date.parse("2026-11-25T12:00:00Z")
  const now = () => t
  const advance = (ms: number) => {
    t += ms
  }
  const mock = createMockPixProvider({ now })
  const store = memoryStore()
  const facilitator = createFacilitator({
    provider: mock,
    store,
    merchants: [{ id: "loja1", token: TOKEN, payTo: "loja1" }],
    now,
    pspCacheMs: 0,
  })
  mock.setWebhookSink(async (request) => facilitator.fetch(request))
  const facilitatorFetch = async (request: Request) => facilitator.fetch(request)

  const seller = new Hono<{ Variables: Px402Variables }>()
  const pix = pixPaywall({
    facilitatorUrl: "http://facilitator.test",
    token: TOKEN,
    fetch: facilitatorFetch,
    now,
  })
  let failNext = 0
  let handlerRuns = 0
  seller.get("/relatorio", pix({ amount: "500", description: "Relatório" }), (c) => {
    handlerRuns++
    if (failNext > 0) {
      failNext--
      return c.json({ error: "temporário" }, 503)
    }
    return c.json({ ok: true, chargeId: c.get("px402").chargeId })
  })
  seller.onError((_error, c) => c.json({ error: "internal" }, 500))
  seller.get("/explode", pix({ amount: "500" }), () => {
    throw new Error("boom")
  })
  const sellerFetch = async (request: Request) => seller.fetch(request)

  return {
    now,
    advance,
    mock,
    store,
    sellerFetch,
    failHandler: (n = 1) => {
      failNext = n
    },
    handlerRuns: () => handlerRuns,
  }
}

function buyer(env: ReturnType<typeof setup>, payImmediately = true) {
  const paid: string[] = []
  const events: PaymentEvent[] = []
  const fetchPaid = wrapFetch(env.sellerFetch, {
    payer: {
      async pay(charge) {
        paid.push(charge.chargeId)
        if (payImmediately) await env.mock.simulatePayment(charge.chargeId)
      },
    },
    onPayment: (event) => events.push(event),
    now: env.now,
    sleep: async (ms) => env.advance(ms),
  })
  return { fetchPaid, paid, events }
}

describe("402 → Pix → 200 round trip (mock PSP)", () => {
  test("happy path: one call, one payment, 200 with a settled PAYMENT-RESPONSE", async () => {
    const env = setup()
    const { fetchPaid, paid } = buyer(env)
    const response = await fetchPaid(`${SELLER}/relatorio`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { chargeId: string }
    expect(paid).toEqual(["pix_char_mock_0001"])
    expect(body.chargeId).toBe("pix_char_mock_0001")
    const header = response.headers.get(HEADER_PAYMENT_RESPONSE)
    expect(header).not.toBeNull()
    expect(decodeSettlementResponse(header ?? "")).toEqual({
      success: true,
      transaction: "pix_char_mock_0001",
      network: "pix:br",
      amount: "500",
    })
    expect((await env.store.get("pix_char_mock_0001"))?.consumedAt).not.toBeNull()
  })

  test("early retry gets settlement_pending with the same charge, then 200 once the PSP confirms", async () => {
    const env = setup()
    const paid: string[] = []
    // Payment lands 3 s after the payer returns.
    let slept = 0
    const fetchWithLatePayment = wrapFetch(env.sellerFetch, {
      payer: {
        async pay(charge) {
          paid.push(charge.chargeId)
        },
      },
      now: env.now,
      sleep: async (ms) => {
        slept += ms
        env.advance(ms)
        if (slept >= 3000) {
          const id = paid[0]
          if (id && env.mock.peek(id)?.status === "PENDING") await env.mock.simulatePayment(id)
        }
      },
    })
    const response = await fetchWithLatePayment(`${SELLER}/relatorio`)
    expect(response.status).toBe(200)
    expect(paid).toHaveLength(1)
    expect(env.mock.calls.createCharge).toBe(1)
    expect(slept).toBeGreaterThanOrEqual(2000)
  })

  test("the early retry response itself: 402, same charge, settlement_pending, Retry-After 2", async () => {
    const env = setup()
    const first = await env.sellerFetch(new Request(`${SELLER}/relatorio`))
    expect(first.status).toBe(402)
    const required = decodePaymentRequired(first.headers.get(HEADER_PAYMENT_REQUIRED) ?? "")
    const accepted = required.accepts[0]
    if (!accepted) throw new Error("no accepts")
    const signature = encodePaymentPayload({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { chargeId: String(accepted.extra?.chargeId) },
    })
    const early = await env.sellerFetch(
      new Request(`${SELLER}/relatorio`, { headers: { [HEADER_PAYMENT_SIGNATURE]: signature } }),
    )
    expect(early.status).toBe(402)
    expect(early.headers.get("retry-after")).toBe("2")
    const again = decodePaymentRequired(early.headers.get(HEADER_PAYMENT_REQUIRED) ?? "")
    expect(again.accepts[0]?.extra?.chargeId).toBe(accepted.extra?.chargeId)
    expect(
      decodeSettlementResponse(early.headers.get(HEADER_PAYMENT_RESPONSE) ?? ""),
    ).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: accepted.extra?.chargeId,
    })
    expect(env.mock.calls.createCharge).toBe(1)
  })

  test("handler failure leaves the charge paid and unused; resuming with the same signature succeeds", async () => {
    const env = setup()
    const { fetchPaid, paid, events } = buyer(env)
    env.failHandler(1)
    const failed = await fetchPaid(`${SELLER}/relatorio`)
    expect(failed.status).toBe(503)
    expect(failed.headers.get(HEADER_PAYMENT_RESPONSE)).toBeNull()
    const record = await env.store.get("pix_char_mock_0001")
    expect(record?.consumedAt ?? null).toBeNull()
    const signature = events[0]?.paymentSignature
    if (!signature) throw new Error("no payment event")
    const resumed = await fetchPaid(`${SELLER}/relatorio`, {
      headers: { [HEADER_PAYMENT_SIGNATURE]: signature },
    })
    expect(resumed.status).toBe(200)
    expect(paid).toHaveLength(1)
    expect(env.handlerRuns()).toBe(2)
  })

  test("a handler that throws gets a 500 and does not consume the charge", async () => {
    const env = setup()
    const { fetchPaid } = buyer(env)
    const response = await fetchPaid(`${SELLER}/explode`)
    expect(response.status).toBe(500)
    expect((await env.store.get("pix_char_mock_0001"))?.consumedAt ?? null).toBeNull()
  })

  test("replay of a consumed charge is refused", async () => {
    const env = setup()
    const { fetchPaid, events } = buyer(env)
    expect((await fetchPaid(`${SELLER}/relatorio`)).status).toBe(200)
    const signature = events[0]?.paymentSignature ?? ""
    const replay = await env.sellerFetch(
      new Request(`${SELLER}/relatorio`, { headers: { [HEADER_PAYMENT_SIGNATURE]: signature } }),
    )
    expect(replay.status).toBe(402)
    expect(
      decodeSettlementResponse(replay.headers.get(HEADER_PAYMENT_RESPONSE) ?? "").errorReason,
    ).toBe("charge_already_consumed")
  })

  test("two concurrent requests with one paid charge: exactly one 200, handler runs once more", async () => {
    const env = setup()
    const { fetchPaid, events } = buyer(env)
    env.failHandler(1)
    await fetchPaid(`${SELLER}/relatorio`) // pays, handler fails, charge stays usable
    expect(env.handlerRuns()).toBe(1)
    const signature = events[0]?.paymentSignature ?? ""
    const send = () =>
      env.sellerFetch(
        new Request(`${SELLER}/relatorio`, { headers: { [HEADER_PAYMENT_SIGNATURE]: signature } }),
      )
    const results = await Promise.all([send(), send(), send()])
    expect(results.map((r) => r.status).sort()).toEqual([200, 402, 402])
    for (const r of results.filter((x) => x.status === 402)) {
      const reason = decodeSettlementResponse(
        r.headers.get(HEADER_PAYMENT_RESPONSE) ?? "",
      ).errorReason
      expect(["settlement_pending", "charge_already_consumed"]).toContain(reason ?? "")
    }
    // The per-charge lock keeps the other two from running the handler.
    expect(env.handlerRuns()).toBe(2)
    const after = await send()
    expect(
      decodeSettlementResponse(after.headers.get(HEADER_PAYMENT_RESPONSE) ?? "").errorReason,
    ).toBe("charge_already_consumed")
  })

  test("unpaid charge expires: client keeps the same charge, then throws charge_expired", async () => {
    const env = setup()
    const { fetchPaid, paid } = buyer(env, false)
    let error: unknown
    try {
      await fetchPaid(`${SELLER}/relatorio`)
    } catch (e) {
      error = e
    }
    // The last try after expiry gets the facilitator's verdict; details let the caller resume if it paid late.
    expect(isPx402Error(error) && error.code).toBe("charge_expired")
    expect(isPx402Error(error) && typeof error.details?.paymentSignature).toBe("string")
    expect(paid).toHaveLength(1)
    expect(env.mock.calls.createCharge).toBe(1)
    expect(env.now()).toBeGreaterThan(Date.parse("2026-11-25T12:05:00Z"))
  })

  test("client policy refuses an over-limit charge without paying", async () => {
    const env = setup()
    let payerCalls = 0
    const fetchPaid = wrapFetch(env.sellerFetch, {
      payer: {
        async pay() {
          payerCalls++
        },
      },
      policy: { maxPerRequest: 499 },
    })
    let error: unknown
    try {
      await fetchPaid(`${SELLER}/relatorio`)
    } catch (e) {
      error = e
    }
    expect(isPx402Error(error) && error.code).toBe("policy_exceeded")
    expect(payerCalls).toBe(0)
  })

  test("demo server: GET /relatorio costs R$ 5,00", async () => {
    const env = setup()
    const facilitator = createFacilitator({
      provider: env.mock,
      store: memoryStore(),
      merchants: [{ id: "loja1", token: TOKEN, payTo: "loja1" }],
    })
    const demo = createDemoServer({
      facilitatorUrl: "http://facilitator.test",
      token: TOKEN,
      fetch: async (r) => facilitator.fetch(r),
    })
    const response = await demo.fetch(new Request(`${SELLER}/relatorio`))
    expect(response.status).toBe(402)
    const required = decodePaymentRequired(response.headers.get(HEADER_PAYMENT_REQUIRED) ?? "")
    expect(required.accepts[0]?.amount).toBe("500")
  })

  test("a lost /settle answer is retried with the same Idempotency-Key and still delivers", async () => {
    const env = setup()
    const facilitator = createFacilitator({
      provider: env.mock,
      store: env.store,
      merchants: [{ id: "loja1", token: TOKEN, payTo: "loja1" }],
      now: env.now,
    })
    const keys: string[] = []
    let dropped = false
    // The first /settle reaches the facilitator (the charge is consumed) but its answer is lost.
    const flaky = async (request: Request) => {
      const response = await facilitator.fetch(request)
      if (new URL(request.url).pathname === "/settle") {
        keys.push(request.headers.get("idempotency-key") ?? "")
        if (!dropped) {
          dropped = true
          return new Response("bad gateway", { status: 502 })
        }
      }
      return response
    }
    const seller = new Hono<{ Variables: Px402Variables }>()
    seller.get(
      "/relatorio",
      pixPaywall({
        facilitatorUrl: "http://facilitator.test",
        token: TOKEN,
        fetch: flaky,
        now: env.now,
      })({
        amount: "500",
      }),
      (c) => c.json({ ok: true }),
    )
    const fetchPaid = wrapFetch(async (r) => seller.fetch(r), {
      payer: { pay: (charge) => env.mock.simulatePayment(charge.chargeId) },
      now: env.now,
      sleep: async (ms) => env.advance(ms),
    })
    const response = await fetchPaid(`${SELLER}/relatorio`)
    expect(response.status).toBe(200)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1] ?? "")
  })

  test("a facilitator with a 600 s charge TTL still settles", async () => {
    const env = setup()
    const facilitator = createFacilitator({
      provider: env.mock,
      store: memoryStore(),
      merchants: [{ id: "loja1", token: TOKEN, payTo: "loja1" }],
      now: env.now,
      chargeTtlSeconds: 600,
    })
    const demo = createDemoServer({
      facilitatorUrl: "http://facilitator.test",
      token: TOKEN,
      fetch: async (r) => facilitator.fetch(r),
    })
    const fetchPaid = wrapFetch(async (r) => demo.fetch(r), {
      payer: { pay: (charge) => env.mock.simulatePayment(charge.chargeId) },
      now: env.now,
      sleep: async (ms) => env.advance(ms),
    })
    const response = await fetchPaid(`${SELLER}/relatorio`)
    expect(response.status).toBe(200)
  })
})
