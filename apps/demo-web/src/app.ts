import { timingSafeEqual } from "@p-x402/core"
import { type ChargeStore, createFacilitator } from "@p-x402/facilitator"
import { memoryStore } from "@p-x402/facilitator/stores/memory"
import type { PixProvider } from "@p-x402/psp"
import { defaultClientIp } from "@p-x402/server/hono"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { createDemoAgent, type DemoAgent, type SessionEvent } from "./agent"
import { clock, createHub, type DemoHub } from "./hub"
import { observedFetch, observedStore } from "./observe"
import { createDemoSeller } from "./seller"

export type { SessionEvent } from "./agent"
export type { DemoHub } from "./hub"

/** Price of GET /relatorio in the demo seller, in centavos. */
export const RESOURCE_PRICE = 500
export const RESOURCE_PATH = "/relatorio"
export const MERCHANT_ID = "loja1"
/** The seller is never public; the agent reaches it in-process at this origin. */
const SELLER_ORIGIN = "http://loja.p-x402.interno"
const SESSION_HEADER = "x-px402-sessao"

export interface DemoWebOptions {
  provider: PixProvider
  /** Charge store. Default: in memory. */
  store?: ChargeStore
  /** Merchant token shared by the seller and the facilitator. Default: random per process. */
  token?: string
  /** Simulated payer bank balance per session, in centavos. Default 10000 (R$ 100,00). */
  initialPayerBalance?: number
  /** SSE keep-alive comment interval. Default 5000 (below Bun's 10 s idle timeout). */
  heartbeatMs?: number
  /** The paywall's per-IP charge cap, per minute. Default 20. */
  chargesPerIpPerMinute?: number
  /** The facilitator's per-merchant charge cap, per minute (all visitors share it). Default 60. */
  merchantChargesPerMinute?: number
  /** Demo runs per client IP per hour. Default 30. */
  runsPerIpPerHour?: number
  /** Runs at the same time per session. Default 3. */
  maxRunsPerSession?: number
  /** Retry-After sent with settlement_pending, in seconds. Default 0 (the agent's backoff paces it). */
  pendingRetryAfterSeconds?: number
  /** Browser origins allowed by CORS on /api and /health. Default: none (same origin only). */
  allowedOrigins?: string[]
  /** Bearer secret for POST /api/admin/reset. Unset: the endpoint answers 404. */
  adminSecret?: string
  /** Header with the client IP set by the proxy in front (e.g. fly-client-ip). Default: socket IP. */
  clientIpHeader?: string
  /** Passed through to the agent (tests). */
  disconnectGraceMs?: number
  stepTimeoutMs?: number
  slowBankMs?: number
  /** Label for /health. */
  storeName?: string
}

export interface DemoWeb {
  app: Hono
  hub: DemoHub
  agent: DemoAgent
  /** The facilitator app; the mock PSP delivers its webhooks here. */
  facilitatorFetch: (request: Request) => Promise<Response>
}

/**
 * The public p-x402 demo service:
 * - `GET  /health`
 * - `GET  /api/estado`, `GET /api/eventos?sessao=` (SSE, only the caller's session)
 * - `POST /api/compras` one-click run, `POST /api/passos` step mode (`pedir`, `pagar`, `tentar`)
 * - `POST /api/sessao/reiniciar` resets the caller's session
 * - `POST /api/admin/reset` clears every session (Bearer secret)
 * - `POST /facilitator/webhooks/pix` the PSP webhook, `GET /facilitator/supported`
 *
 * The seller (pixPaywall) and the facilitator's dev simulate-payment route are not exposed: the
 * demo agent calls them in-process.
 */
export function createDemoWeb(options: DemoWebOptions): DemoWeb {
  const hub = createHub()
  const token = options.token ?? crypto.randomUUID()
  const heartbeatMs = options.heartbeatMs ?? 5000
  const allowed = new Set(options.allowedOrigins ?? [])

  const facilitator = createFacilitator({
    provider: options.provider,
    store: observedStore(options.store ?? memoryStore(), hub),
    merchants: [{ id: MERCHANT_ID, token, payTo: MERCHANT_ID }],
    devSimulate: true,
    merchantRateLimit: { limit: options.merchantChargesPerMinute ?? 60, windowMs: 60_000 },
  })
  const facilitatorFetch = async (request: Request) => facilitator.fetch(request)

  const seller = createDemoSeller({
    facilitatorUrl: "http://facilitator.interno",
    token,
    fetch: observedFetch(facilitatorFetch, hub),
    price: RESOURCE_PRICE,
    chargesPerMinute: options.chargesPerIpPerMinute ?? 20,
    pendingRetryAfterSeconds: options.pendingRetryAfterSeconds ?? 0,
  })

  const agent = createDemoAgent({
    hub,
    sellerFetch: async (request) => seller.fetch(request),
    facilitatorFetch,
    resourceUrl: `${SELLER_ORIGIN}${RESOURCE_PATH}`,
    ...(options.initialPayerBalance === undefined
      ? {}
      : { initialPayerBalance: options.initialPayerBalance }),
    ...(options.runsPerIpPerHour === undefined
      ? {}
      : { runsPerIpPerHour: options.runsPerIpPerHour }),
    ...(options.maxRunsPerSession === undefined
      ? {}
      : { maxRunsPerSession: options.maxRunsPerSession }),
    ...(options.disconnectGraceMs === undefined
      ? {}
      : { disconnectGraceMs: options.disconnectGraceMs }),
    ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
    ...(options.slowBankMs === undefined ? {} : { slowBankMs: options.slowBankMs }),
  })

  const info = () => ({
    provider: options.provider.name,
    merchant: MERCHANT_ID,
    resource: { path: RESOURCE_PATH, amount: RESOURCE_PRICE },
  })

  function clientIp(c: Context): string {
    if (options.clientIpHeader) {
      const value = c.req.header(options.clientIpHeader)?.split(",")[0]?.trim()
      if (value) return value
    }
    return defaultClientIp(c) ?? "desconhecido"
  }

  const sessionOf = (c: Context) => c.req.header(SESSION_HEADER) ?? c.req.query("sessao") ?? ""

  async function readBody(c: Context): Promise<Record<string, unknown>> {
    try {
      const value: unknown = JSON.parse(await c.req.text())
      return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  function startAnswer(c: Context, result: ReturnType<DemoAgent["start"]>) {
    if (result.ok) return c.json({ runId: result.runId }, 202)
    if (result.retryAfterSeconds !== undefined) {
      c.header("Retry-After", String(result.retryAfterSeconds))
    }
    return c.json({ erro: result.error }, result.status)
  }

  const app = new Hono()

  app.onError((error, c) => {
    console.error("demo-web: unexpected error", error)
    return c.json({ erro: "erro_inesperado" }, 500)
  })

  const corsMiddleware = cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", SESSION_HEADER],
    maxAge: 600,
  })
  app.use("/api/*", corsMiddleware)
  app.use("/health", corsMiddleware)

  app.get("/health", (c) =>
    c.json({ ok: true, ...info(), store: options.storeName ?? "memoria", time: clock() }),
  )

  app.get("/api/estado", (c) => {
    const snapshot = agent.state(sessionOf(c))
    if (!snapshot) return c.json({ erro: "sessao_invalida" }, 400)
    return c.json({ ...info(), ...snapshot, time: clock() })
  })

  app.post("/api/compras", async (c) => {
    const body = await readBody(c)
    return startAnswer(c, agent.start(sessionOf(c), clientIp(c), "auto", body.lento === true))
  })

  app.post("/api/passos", async (c) => {
    const action = (await readBody(c)).acao
    if (action === "pedir")
      return startAnswer(c, agent.start(sessionOf(c), clientIp(c), "passos", false))
    if (action === "pagar" || action === "tentar")
      return startAnswer(c, agent.step(sessionOf(c), action))
    return c.json({ erro: "acao_invalida" }, 400)
  })

  app.post("/api/sessao/reiniciar", (c) => {
    const result = agent.resetOne(sessionOf(c))
    if (result.ok) return c.json({ ok: true })
    return c.json(
      { erro: result.status === 400 ? "sessao_invalida" : "compra_em_andamento" },
      result.status,
    )
  })

  app.post("/api/admin/reset", async (c) => {
    if (!options.adminSecret) return c.notFound()
    const given = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? ""
    if (!given || !(await timingSafeEqual(given, options.adminSecret))) {
      return c.json({ erro: "nao_autorizado" }, 401)
    }
    agent.resetAll()
    return c.json({ ok: true, ...agent.stats() })
  })

  app.get("/api/eventos", (c) => {
    let push: (event: SessionEvent) => void = () => undefined
    const connection = agent.connect(sessionOf(c), (event) => push(event))
    if (!connection) return c.json({ erro: "sessao_invalida" }, 400)
    c.header("Cache-Control", "no-store")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      let seq = 0
      // Events published while a write is in flight are chained so their order is kept.
      let chain: Promise<void> = Promise.resolve()
      const send = (event: string, data: unknown) => {
        const message = { event, data: JSON.stringify(data), id: String(++seq) }
        chain = chain.then(() => stream.writeSSE(message)).catch(() => undefined)
        return chain
      }
      push = (event) => {
        void send(event.type, event)
      }
      stream.onAbort(() => connection.close())
      try {
        await send("estado", { type: "estado", ...info(), ...connection.snapshot, time: clock() })
        while (!stream.aborted && !stream.closed) {
          await stream.sleep(heartbeatMs)
          if (stream.aborted || stream.closed) break
          let failed = false
          chain = chain.then(async () => {
            await stream.write(": ping\n\n").catch(() => {
              failed = true
            })
          })
          await chain
          if (failed) break
        }
      } finally {
        connection.close()
      }
    })
  })

  // The only facilitator routes on the public internet: the PSP webhook and the capability list.
  const toFacilitator = (c: Context, path: string) => {
    const url = new URL(c.req.url)
    url.pathname = path
    return facilitator.fetch(new Request(url, c.req.raw))
  }
  app.post("/facilitator/webhooks/pix", (c) => toFacilitator(c, "/webhooks/pix"))
  app.get("/facilitator/supported", (c) => toFacilitator(c, "/supported"))

  return { app, hub, agent, facilitatorFetch }
}
