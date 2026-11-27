import { describe, expect, test } from "bun:test"
import { simulatePayer, wrapFetch } from "@p-x402/client"
import {
  decodePaymentRequired,
  decodeSettlementResponse,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
} from "@p-x402/core"
import { memoryStore } from "@p-x402/facilitator/stores/memory"
import { createMockPixProvider } from "@p-x402/psp"
import { createDemoWeb, RESOURCE_PRICE } from "../src/app"
import { createHub, type DemoEvent } from "../src/hub"
import { observedStore } from "../src/observe"

const ORIGIN = "http://demo.test"

function setup() {
  const mock = createMockPixProvider()
  const demo = createDemoWeb({ provider: mock, heartbeatMs: 20 })
  mock.setWebhookSink(async (request) => demo.facilitatorFetch(request))
  const fetch = async (request: Request) => demo.app.fetch(request)
  return { mock, demo, fetch }
}

interface SseMessage {
  event: string
  data: unknown
}

/** Opens /api/eventos and collects messages until `done` says stop. */
async function openEvents(fetch: (request: Request) => Promise<Response>) {
  const response = await fetch(new Request(`${ORIGIN}/api/eventos`))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  if (!response.body) throw new Error("no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const messages: SseMessage[] = []
  let buffer = ""
  let comments = 0

  async function until(done: (all: SseMessage[]) => boolean, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    while (!done(messages)) {
      if (Date.now() > deadline) throw new Error(`timeout; got ${messages.map((m) => m.event)}`)
      const { value, done: ended } = await reader.read()
      if (ended) throw new Error("stream ended")
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf("\n\n")
      while (cut !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        if (block.startsWith(":")) comments++
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event && data) messages.push({ event, data: JSON.parse(data) })
        cut = buffer.indexOf("\n\n")
      }
    }
    return messages
  }

  return {
    messages,
    until,
    comments: () => comments,
    close: () => reader.cancel(),
  }
}

describe("demo-web app", () => {
  test("mounts the seller behind the paywall and the facilitator on one origin", async () => {
    const { fetch } = setup()
    const supported = await fetch(new Request(`${ORIGIN}/facilitator/supported`))
    expect(supported.status).toBe(200)

    const response = await fetch(new Request(`${ORIGIN}/loja/relatorio`))
    expect(response.status).toBe(402)
    const required = decodePaymentRequired(response.headers.get(HEADER_PAYMENT_REQUIRED) ?? "")
    expect(required.resource.url).toBe(`${ORIGIN}/loja/relatorio`)
    expect(required.accepts[0]?.amount).toBe(String(RESOURCE_PRICE))
  })

  test("lets a visitor open more charges than the paywall default, then answers 429", async () => {
    const mock = createMockPixProvider()
    const demo = createDemoWeb({ provider: mock, chargesPerMinute: 12 })
    const statuses: number[] = []
    const original = console.warn
    console.warn = () => undefined
    try {
      for (let i = 0; i < 13; i++) {
        const response = await demo.app.fetch(new Request(`${ORIGIN}/loja/relatorio`))
        statuses.push(response.status)
      }
    } finally {
      console.warn = original
    }
    expect(statuses.slice(0, 12).every((status) => status === 402)).toBe(true)
    expect(statuses[12]).toBe(429)
  })

  test("streams the whole round trip over SSE and moves both balances once", async () => {
    const { demo, fetch } = setup()
    const events = await openEvents(fetch)
    const [first] = await events.until((all) => all.length >= 1)
    expect(first?.event).toBe("estado")
    expect(first?.data).toMatchObject({
      provider: "mock",
      saldos: { pagador: 10_000, recebedor: 0 },
    })

    const paidFetch = wrapFetch(fetch, {
      payer: simulatePayer({ facilitatorUrl: `${ORIGIN}/facilitator`, fetch }),
    })
    const response = await paidFetch(`${ORIGIN}/loja/relatorio`)
    expect(response.status).toBe(200)
    const settlement = decodeSettlementResponse(response.headers.get(HEADER_PAYMENT_RESPONSE) ?? "")
    expect(settlement.success).toBe(true)

    const all = await events.until((m) => m.some((e) => e.event === "liquidado"))
    const kinds = all.map((m) =>
      m.event === "facilitator" ? `facilitator ${(m.data as { path: string }).path}` : m.event,
    )
    expect(kinds).toEqual([
      "estado",
      "facilitator /pix/charges",
      "pix.confirmado",
      "saldos",
      "facilitator /verify",
      "liquidado",
    ])
    // /settle is published after its response arrives, so it follows "liquidado".
    const withSettle = await events.until((m) =>
      m.some((e) => e.event === "facilitator" && (e.data as { path: string }).path === "/settle"),
    )
    const chargeId = settlement.transaction
    for (const message of withSettle.slice(1)) {
      const data = message.data as DemoEvent
      if ("chargeId" in data) expect(data.chargeId).toBe(chargeId)
    }
    const settle = withSettle.at(-1)?.data as { ok: boolean; durationMs: number; status: number }
    expect(settle.ok).toBe(true)
    expect(settle.status).toBe(200)
    expect(settle.durationMs).toBeGreaterThanOrEqual(0)

    expect(demo.hub.balances()).toEqual({ pagador: 9500, recebedor: 500 })
    const state = (await (await fetch(new Request(`${ORIGIN}/api/estado`))).json()) as {
      pagamentos: { chargeId: string; settledAt: number | null }[]
    }
    expect(state.pagamentos).toHaveLength(1)
    expect(state.pagamentos[0]?.chargeId).toBe(chargeId)
    expect(state.pagamentos[0]?.settledAt).not.toBeNull()
    await events.close()
  })

  test("publishes a failed /verify while the Pix is still pending", async () => {
    const { fetch } = setup()
    const events = await openEvents(fetch)
    await events.until((all) => all.length >= 1)
    let pay: (() => Promise<void>) | undefined
    const retryAfter: (string | null)[] = []
    const recording = async (request: Request) => {
      const answer = await fetch(request)
      if (request.headers.has("payment-signature"))
        retryAfter.push(answer.headers.get("retry-after"))
      return answer
    }
    const paidFetch = wrapFetch(recording, {
      payer: {
        paysBrCode: false,
        async pay(charge) {
          const payer = simulatePayer({ facilitatorUrl: `${ORIGIN}/facilitator`, fetch })
          pay = () => payer.pay(charge)
        },
      },
      // The first retry finds the charge unpaid; pay it before the second.
      sleep: async () => {
        await pay?.()
      },
    })
    const response = await paidFetch(`${ORIGIN}/loja/relatorio`)
    expect(response.status).toBe(200)
    // settlement_pending tells the agent to come back at once; its own backoff paces the retries.
    expect(retryAfter[0]).toBe("0")
    const all = await events.until((m) => m.some((e) => e.event === "liquidado"))
    const verifies = all
      .filter((m) => m.event === "facilitator" && (m.data as { path: string }).path === "/verify")
      .map((m) => m.data as { ok: boolean; reason?: string })
    expect(verifies[0]).toMatchObject({ ok: false, reason: "settlement_pending" })
    expect(verifies.at(-1)).toMatchObject({ ok: true })
    await events.close()
  })

  test("reset puts the balances back and announces them", async () => {
    const { demo, fetch } = setup()
    demo.hub.paid("pix_x", 700)
    expect(demo.hub.balances()).toEqual({ pagador: 9300, recebedor: 700 })
    const events = await openEvents(fetch)
    await events.until((all) => all.length >= 1)
    const reset = await fetch(new Request(`${ORIGIN}/api/reiniciar`, { method: "POST" }))
    expect(reset.status).toBe(200)
    expect(((await reset.json()) as { saldos: unknown }).saldos).toEqual({
      pagador: 10_000,
      recebedor: 0,
    })
    const all = await events.until((m) => m.some((e) => e.event === "saldos"))
    expect(all.at(-1)?.data).toMatchObject({ saldos: { pagador: 10_000, recebedor: 0 } })
    expect(demo.hub.payments()).toEqual([])
    await events.close()
  })

  test("sends keep-alive comments and unsubscribes when the client goes away", async () => {
    const { demo, fetch } = setup()
    const events = await openEvents(fetch)
    await events.until(() => events.comments() >= 1)
    expect(demo.hub.listenerCount).toBe(1)
    await events.close()
    const deadline = Date.now() + 1000
    while (demo.hub.listenerCount > 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(demo.hub.listenerCount).toBe(0)
  })
})

describe("hub and observed store", () => {
  test("a charge confirmed twice moves the balances once", () => {
    const hub = createHub({ initialPayerBalance: 1000 })
    const seen: string[] = []
    hub.subscribe((event) => seen.push(event.type))
    hub.paid("a", 500)
    hub.paid("a", 500)
    hub.settled("a", 500)
    hub.settled("a", 500)
    expect(hub.balances()).toEqual({ pagador: 500, recebedor: 500 })
    expect(seen).toEqual(["pix.confirmado", "saldos", "liquidado"])
  })

  test("a throwing listener does not stop the others", () => {
    const hub = createHub()
    const seen: string[] = []
    const original = console.error
    console.error = () => undefined
    try {
      hub.subscribe(() => {
        throw new Error("boom")
      })
      hub.subscribe((event) => seen.push(event.type))
      hub.settled("a", 1)
    } finally {
      console.error = original
    }
    expect(seen).toEqual(["liquidado"])
  })

  test("observedStore announces markPaid and a winning consume, and nothing else", async () => {
    const hub = createHub()
    const seen: DemoEvent[] = []
    hub.subscribe((event) => seen.push(event))
    const store = observedStore(memoryStore(), hub)
    await store.insert({
      id: "c1",
      merchantId: "loja1",
      payTo: "loja1",
      amount: "250",
      resourceUrl: `${ORIGIN}/loja/relatorio`,
      provider: "mock",
      brCode: "000201",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      createdAt: Date.now(),
      paidAt: null,
      disputedAt: null,
      refundedAt: null,
      consumedAt: null,
      consumedKey: null,
    })
    expect(seen).toEqual([])
    await store.markPaid("c1", Date.now())
    await store.markPaid("missing", Date.now())
    expect(await store.consume("c1", Date.now(), "k1")).toBe(true)
    expect(await store.consume("c1", Date.now(), "k2")).toBe(false)
    expect(seen.map((e) => e.type)).toEqual(["pix.confirmado", "saldos", "liquidado"])
    expect(seen[0]).toMatchObject({ chargeId: "c1", amount: 250 })
  })
})
