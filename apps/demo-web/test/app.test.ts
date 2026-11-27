import { describe, expect, test } from "bun:test"
import { memoryStore } from "@p-x402/facilitator/stores/memory"
import { createMockPixProvider } from "@p-x402/psp"
import { createDemoWeb, type DemoWebOptions } from "../src/app"
import { readConfig } from "../src/config"
import { createHub, type HubEvent } from "../src/hub"
import { observedStore } from "../src/observe"
import { msUntilUtcHour } from "../src/schedule"

const ORIGIN = "http://demo.test"
const ADMIN = "a".repeat(40)

function sessionId() {
  return `sessao_${crypto.randomUUID().replaceAll("-", "")}`
}

function setup(options: Partial<DemoWebOptions> = {}) {
  const mock = createMockPixProvider()
  const demo = createDemoWeb({ provider: mock, heartbeatMs: 20, ...options })
  mock.setWebhookSink((request) => demo.facilitatorFetch(request))
  const fetch = async (request: Request) => demo.app.fetch(request)
  const post = (path: string, session: string, body: unknown = {}, headers: HeadersInit = {}) =>
    fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-px402-sessao": session, ...headers },
        body: JSON.stringify(body),
      }),
    )
  return { mock, demo, fetch, post }
}

interface SseMessage {
  event: string
  data: Record<string, unknown>
}

/** Opens /api/eventos for a session and collects messages. */
async function openEvents(fetch: (request: Request) => Promise<Response>, session: string) {
  const response = await fetch(new Request(`${ORIGIN}/api/eventos?sessao=${session}`))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  if (!response.body) throw new Error("no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const messages: SseMessage[] = []
  let buffer = ""
  let raw = ""
  let comments = 0
  let reading: Promise<void> | undefined

  async function pump() {
    const { value, done } = await reader.read()
    if (done) throw new Error("stream ended")
    const text = decoder.decode(value, { stream: true })
    raw += text
    buffer += text
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

  async function until(done: (all: SseMessage[]) => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (!done(messages)) {
      if (Date.now() > deadline) throw new Error(`timeout; got ${messages.map((m) => m.event)}`)
      reading ??= pump().finally(() => {
        reading = undefined
      })
      await Promise.race([reading, Bun.sleep(20)])
    }
    return messages
  }

  return {
    messages,
    until,
    raw: () => raw,
    comments: () => comments,
    close: () => reader.cancel(),
  }
}

const has =
  (type: string, extra: (m: SseMessage) => boolean = () => true) =>
  (all: SseMessage[]) =>
    all.some((m) => m.event === type && extra(m))

const count = (type: string, n: number) => (all: SseMessage[]) =>
  all.filter((m) => m.event === type).length >= n

describe("public surface", () => {
  test("health answers, CORS allows exactly the configured origins", async () => {
    const { fetch } = setup({ allowedOrigins: ["https://demo.p-x402.com"] })
    const ok = await fetch(
      new Request(`${ORIGIN}/health`, { headers: { origin: "https://demo.p-x402.com" } }),
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://demo.p-x402.com")
    expect(await ok.json()).toMatchObject({ ok: true, provider: "mock", store: "memoria" })

    const other = await fetch(
      new Request(`${ORIGIN}/api/estado?sessao=${sessionId()}`, {
        headers: { origin: "https://evil.example" },
      }),
    )
    expect(other.headers.get("access-control-allow-origin")).toBeNull()

    const preflight = await fetch(
      new Request(`${ORIGIN}/api/compras`, {
        method: "OPTIONS",
        headers: {
          origin: "https://demo.p-x402.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-px402-sessao",
        },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-px402-sessao")
  })

  test("the seller and simulate-payment are not public; the webhook and supported are", async () => {
    const { fetch, post } = setup()
    expect((await fetch(new Request(`${ORIGIN}/relatorio`))).status).toBe(404)
    expect((await fetch(new Request(`${ORIGIN}/loja/relatorio`))).status).toBe(404)
    const simulate = await post("/facilitator/dev/charges/x/simulate-payment", sessionId())
    expect(simulate.status).toBe(404)
    expect((await fetch(new Request(`${ORIGIN}/facilitator/supported`))).status).toBe(200)
    // Reaches the facilitator's webhook handler, which rejects a delivery without the secret.
    const webhook = await post("/facilitator/webhooks/pix", sessionId())
    expect(webhook.status).toBe(401)
  })

  test("a malformed session id is refused", async () => {
    const { fetch, post } = setup()
    expect((await post("/api/compras", "curta")).status).toBe(400)
    expect((await fetch(new Request(`${ORIGIN}/api/eventos?sessao=x`))).status).toBe(400)
    expect((await fetch(new Request(`${ORIGIN}/api/estado`))).status).toBe(400)
  })
})

describe("one-click run", () => {
  test("streams every protocol step to the session and moves its balances once", async () => {
    const { fetch, post } = setup()
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))

    const started = await post("/api/compras", sid)
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }
    const all = await events.until(has("compra.fim"))

    const kinds = all.map((m) =>
      m.event === "facilitator"
        ? `facilitator ${m.data.path}`
        : m.event === "http.resposta"
          ? `http ${m.data.status}`
          : m.event,
    )
    expect(kinds).toEqual([
      "estado",
      "compra.inicio",
      "http.pedido",
      "http 402",
      "cobranca",
      // Published before the 402 reached the agent, so held until the charge was linked to the run.
      "facilitator /pix/charges",
      "pix.enviado",
      "pix.confirmado",
      "saldos",
      "http.pedido",
      "facilitator /verify",
      "liquidado",
      "facilitator /settle",
      "http 200",
      "compra.fim",
    ])
    for (const m of all.slice(1)) {
      if (m.event !== "saldos") expect(m.data.runId).toBe(runId)
    }

    const byType = (type: string) => all.filter((m) => m.event === type).map((m) => m.data)
    const required = byType("http.resposta")[0]
    expect(required?.requisitosDecodificados).toMatchObject({ accepts: [{ amount: "500" }] })
    const charge = byType("cobranca")[0]
    expect(typeof charge?.brCode).toBe("string")
    expect(byType("http.pedido")[1]?.assinaturaDecodificada).toMatchObject({
      payload: { chargeId: charge?.chargeId },
    })
    expect(byType("pix.confirmado")[0]?.latenciaServidorMs).toBeGreaterThanOrEqual(0)
    const done = byType("http.resposta")[1]
    expect(done?.liquidacaoDecodificada).toMatchObject({ success: true })
    expect(done?.corpo).toMatchObject({ pagoCom: charge?.chargeId })
    expect(byType("compra.fim")[0]).toMatchObject({ status: "ok", gasto: 500 })

    const state = (await (
      await fetch(new Request(`${ORIGIN}/api/estado?sessao=${sid}`))
    ).json()) as { saldos: unknown; gasto: number }
    expect(state.saldos).toEqual({ pagador: 9500, recebedor: 500 })
    expect(state.gasto).toBe(500)
    await events.close()
  })

  test("a session sees only its own runs", async () => {
    const { fetch, post } = setup()
    const a = sessionId()
    const b = sessionId()
    const eventsA = await openEvents(fetch, a)
    const eventsB = await openEvents(fetch, b)
    await eventsA.until(has("estado"))
    await eventsB.until(has("estado"))
    await post("/api/compras", a)
    await eventsA.until(has("compra.fim"))
    await Bun.sleep(30)
    await eventsB.until(() => true)
    expect(eventsB.messages.map((m) => m.event)).toEqual(["estado"])
    const stateB = (await (
      await fetch(new Request(`${ORIGIN}/api/estado?sessao=${b}`))
    ).json()) as { saldos: unknown }
    expect(stateB.saldos).toEqual({ pagador: 10_000, recebedor: 0 })
    await eventsA.close()
    await eventsB.close()
  })

  test("never streams the payer's name or tax id carried by the PSP webhook", async () => {
    const { fetch, post } = setup()
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    await post("/api/compras", sid)
    await events.until(has("compra.fim"))
    // The mock PSP's webhook carries customer and payerInformation; none of it may leak.
    expect(events.raw()).not.toContain("Fulano")
    expect(events.raw()).not.toContain("taxId")
    expect(events.raw()).not.toContain("123.***")
    await events.close()
  })

  test("with a slow bank the agent meets settlement_pending, then succeeds", async () => {
    const { fetch, post } = setup({ slowBankMs: 60 })
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    await post("/api/compras", sid, { lento: true })
    const all = await events.until(has("compra.fim"))
    const pending = all.find(
      (m) => m.event === "http.resposta" && m.data.status === 402 && m.data.liquidacao,
    )
    expect(pending?.data.liquidacaoDecodificada).toMatchObject({
      errorReason: "settlement_pending",
    })
    expect(pending?.data.retryAfter).toBe("0")
    expect(all.at(-1)?.data.status).toBe("ok")
    await events.close()
  })
})

describe("step-by-step mode", () => {
  test("waits for pagar and tentar, refusing clicks out of order", async () => {
    const { fetch, post } = setup()
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))

    expect((await post("/api/passos", sid, { acao: "pagar" })).status).toBe(409)
    expect((await post("/api/passos", sid, { acao: "pedir" })).status).toBe(202)
    await events.until(has("aguardando", (m) => m.data.acao === "pagar"))
    expect(events.messages.some((m) => m.event === "pix.enviado")).toBe(false)
    expect((await post("/api/passos", sid, { acao: "tentar" })).status).toBe(409)

    expect((await post("/api/passos", sid, { acao: "pagar" })).status).toBe(202)
    await events.until(has("aguardando", (m) => m.data.acao === "tentar"))
    expect(events.messages.some((m) => m.event === "pix.confirmado")).toBe(true)
    expect(events.messages.filter((m) => m.event === "http.pedido")).toHaveLength(1)

    expect((await post("/api/passos", sid, { acao: "tentar" })).status).toBe(202)
    const all = await events.until(has("compra.fim"))
    expect(all.at(-1)?.data).toMatchObject({ status: "ok" })
    expect((await post("/api/passos", sid, { acao: "ruim" })).status).toBe(400)
    await events.close()
  })

  test("a paused run expires, frees its slot and says so", async () => {
    const { fetch, post } = setup({ stepTimeoutMs: 40, maxRunsPerSession: 1 })
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    expect((await post("/api/passos", sid, { acao: "pedir" })).status).toBe(202)
    const busy = await post("/api/compras", sid)
    expect(busy.status).toBe(429)
    expect(await busy.json()).toEqual({ erro: "limite_simultaneas" })
    const all = await events.until(has("compra.fim"))
    expect(all.at(-1)?.data).toMatchObject({
      status: "expirada",
      erro: { code: "expirada" },
      // Nothing was paid, so nothing counts against the agent's policy.
      gasto: 0,
    })
    // The slot is free again.
    expect((await post("/api/compras", sid)).status).toBe(202)
    await events.until(count("compra.fim", 2))
    await events.close()
  })

  test("a paused run ends when the page's event stream goes away", async () => {
    const { demo, fetch, post } = setup({ disconnectGraceMs: 20 })
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    await post("/api/passos", sid, { acao: "pedir" })
    await events.until(has("aguardando"))
    expect(demo.agent.stats().runs).toBe(1)
    await events.close()
    const deadline = Date.now() + 2000
    while (demo.agent.stats().runs > 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(demo.agent.stats().runs).toBe(0)
  })
})

describe("abuse limits and resets", () => {
  test("caps runs per IP per hour, per IP from the configured proxy header", async () => {
    const { fetch, post } = setup({ runsPerIpPerHour: 2, clientIpHeader: "fly-client-ip" })
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    const ip = { "fly-client-ip": "203.0.113.7" }
    expect((await post("/api/compras", sid, {}, ip)).status).toBe(202)
    await events.until(count("compra.fim", 1))
    expect((await post("/api/compras", sid, {}, ip)).status).toBe(202)
    await events.until(count("compra.fim", 2))
    const third = await post("/api/compras", sid, {}, ip)
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({ erro: "limite_por_hora" })
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0)
    // Another IP still has its own allowance.
    const other = await post("/api/compras", sid, {}, { "fly-client-ip": "203.0.113.8" })
    expect(other.status).toBe(202)
    await events.until(count("compra.fim", 3))
    await events.close()
  })

  test("admin reset needs the secret and clears every session", async () => {
    const { fetch, post } = setup({ adminSecret: ADMIN, runsPerIpPerHour: 1 })
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    await post("/api/compras", sid)
    await events.until(has("compra.fim"))
    expect((await post("/api/compras", sid)).status).toBe(429)

    expect((await post("/api/admin/reset", sid)).status).toBe(401)
    const wrong = await post("/api/admin/reset", sid, {}, { authorization: "Bearer errado" })
    expect(wrong.status).toBe(401)
    const reset = await post("/api/admin/reset", sid, {}, { authorization: `Bearer ${ADMIN}` })
    expect(reset.status).toBe(200)
    await events.until(has("reiniciado"))
    const all = await events.until(count("estado", 2))
    expect(all.filter((m) => m.event === "estado").at(-1)?.data).toMatchObject({
      saldos: { pagador: 10_000, recebedor: 0 },
      gasto: 0,
    })
    // The per-IP run allowance starts over too.
    expect((await post("/api/compras", sid)).status).toBe(202)
    await events.until(count("compra.fim", 2))
    await events.close()
  })

  test("admin reset is off without a secret", async () => {
    const { post } = setup()
    const response = await post("/api/admin/reset", sessionId(), {}, { authorization: "Bearer x" })
    expect(response.status).toBe(404)
  })

  test("a visitor can reset their own session", async () => {
    const { fetch, post } = setup()
    const sid = sessionId()
    const events = await openEvents(fetch, sid)
    await events.until(has("estado"))
    await post("/api/compras", sid)
    await events.until(has("compra.fim"))
    expect((await post("/api/sessao/reiniciar", sid)).status).toBe(200)
    const all = await events.until(count("estado", 2))
    expect(all.at(-1)?.data).toMatchObject({ saldos: { pagador: 10_000, recebedor: 0 }, gasto: 0 })
    await events.close()
  })

  test("sends keep-alive comments", async () => {
    const { fetch } = setup()
    const events = await openEvents(fetch, sessionId())
    await events.until(() => events.comments() >= 1)
    await events.close()
  })
})

describe("config", () => {
  test("mock without a key, AbacatePay with one, PX402_PROVIDER overrides", () => {
    expect(readConfig({}).provider).toBe("mock")
    expect(readConfig({ ABACATEPAY_API_KEY: "k" }).provider).toBe("abacatepay")
    expect(readConfig({ ABACATEPAY_API_KEY: "k", PX402_PROVIDER: "mock" }).provider).toBe("mock")
    expect(() => readConfig({ PX402_PROVIDER: "abacatepay" })).toThrow("ABACATEPAY_API_KEY")
    expect(() => readConfig({ PX402_PROVIDER: "stripe" })).toThrow("PX402_PROVIDER")
  })

  test("reads origins, limits, secrets and the reset hour", () => {
    const config = readConfig({
      DEMO_ALLOWED_ORIGINS: "https://demo.p-x402.com, https://p-x402.com",
      DEMO_RUNS_PER_IP_PER_HOUR: "12",
      DEMO_CLIENT_IP_HEADER: "Fly-Client-IP",
      DEMO_ADMIN_SECRET: ADMIN,
      PX402_DB_PATH: "/data/p-x402.sqlite",
    })
    expect(config).toMatchObject({
      allowedOrigins: ["https://demo.p-x402.com", "https://p-x402.com"],
      runsPerIpPerHour: 12,
      clientIpHeader: "fly-client-ip",
      adminSecret: ADMIN,
      dbPath: "/data/p-x402.sqlite",
      resetUtcHour: 7,
      port: 4030,
    })
    expect(readConfig({ DEMO_RESET_UTC_HOUR: "off" }).resetUtcHour).toBeUndefined()
    expect(readConfig({}).stepTimeoutSeconds).toBeUndefined()
    expect(readConfig({ DEMO_STEP_TIMEOUT_SECONDS: "60" }).stepTimeoutSeconds).toBe(60)
    expect(() => readConfig({ DEMO_STEP_TIMEOUT_SECONDS: "301" })).toThrow("DEMO_STEP_TIMEOUT")
    expect(() => readConfig({ DEMO_ALLOWED_ORIGINS: "https://x.com/path" })).toThrow(
      "DEMO_ALLOWED_ORIGINS",
    )
    expect(() => readConfig({ DEMO_ADMIN_SECRET: "curto" })).toThrow("DEMO_ADMIN_SECRET")
    expect(() => readConfig({ DEMO_RUNS_PER_IP_PER_HOUR: "0" })).toThrow(
      "DEMO_RUNS_PER_IP_PER_HOUR",
    )
  })

  test("msUntilUtcHour finds the next occurrence", () => {
    expect(msUntilUtcHour(Date.parse("2026-11-30T06:30:00Z"), 7)).toBe(30 * 60_000)
    expect(msUntilUtcHour(Date.parse("2026-11-30T07:00:00Z"), 7)).toBe(24 * 3600_000)
    expect(msUntilUtcHour(Date.parse("2026-11-30T08:00:00Z"), 7)).toBe(23 * 3600_000)
  })
})

describe("hub and observed store", () => {
  test("a charge confirmed twice is announced once", () => {
    const hub = createHub()
    const seen: string[] = []
    hub.subscribe((event) => seen.push(event.type))
    hub.paid("a", 500)
    hub.paid("a", 500)
    hub.settled("a", 500)
    hub.settled("a", 500)
    expect(seen).toEqual(["pix.confirmado", "liquidado"])
    hub.reset()
    hub.paid("a", 500)
    expect(seen).toEqual(["pix.confirmado", "liquidado", "pix.confirmado"])
  })

  test("observedStore announces markPaid and a winning consume, and nothing else", async () => {
    const hub = createHub()
    const seen: HubEvent[] = []
    hub.subscribe((event) => seen.push(event))
    const store = observedStore(memoryStore(), hub)
    await store.insert({
      id: "c1",
      merchantId: "loja1",
      payTo: "loja1",
      amount: "250",
      resourceUrl: `${ORIGIN}/relatorio`,
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
    expect(seen.map((e) => e.type)).toEqual(["pix.confirmado", "liquidado"])
    expect(seen[0]).toMatchObject({ chargeId: "c1", amount: 250 })
  })
})
