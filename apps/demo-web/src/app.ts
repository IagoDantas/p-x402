import { createFacilitator } from "@p-x402/facilitator"
import { memoryStore } from "@p-x402/facilitator/stores/memory"
import type { PixProvider } from "@p-x402/psp"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { clock, createHub, type DemoEvent, type DemoHub } from "./hub"
import { observedFetch, observedStore } from "./observe"
import { createDemoSeller } from "./seller"

export type { DemoEvent, DemoHub } from "./hub"

/** Price of GET /loja/relatorio in the demo seller, in centavos. */
export const RESOURCE_PRICE = 500
export const RESOURCE_PATH = "/loja/relatorio"
export const MERCHANT_ID = "loja1"

export interface DemoWebOptions {
  provider: PixProvider
  /** Merchant token shared by the seller and the facilitator. Default: random per process. */
  token?: string
  /** Simulated payer bank balance, in centavos. Default 10000 (R$ 100,00). */
  initialPayerBalance?: number
  /** SSE keep-alive comment interval. Default 5000 (below Bun's 10 s idle timeout). */
  heartbeatMs?: number
  /** Charges per client IP per minute at the seller. Default 120. */
  chargesPerMinute?: number
  /** Retry-After sent with settlement_pending, in seconds. Default 0 (the agent's backoff paces it). */
  pendingRetryAfterSeconds?: number
}

export interface DemoWeb {
  app: Hono
  hub: DemoHub
  /** The facilitator app; the mock PSP delivers its webhooks here. */
  facilitatorFetch: (request: Request) => Response | Promise<Response>
}

/**
 * One origin for the whole demo:
 * - `/loja/*`        the demo seller (GET /relatorio behind `pixPaywall`)
 * - `/facilitator/*` the p-x402 facilitator (dev simulate-payment on, for the browser payer)
 * - `/api/eventos`   Server-Sent Events: facilitator calls, PSP confirmations, settlements, balances
 * - `/api/estado`    snapshot for a freshly opened page
 * - `/api/reiniciar` resets the simulated balances
 */
export function createDemoWeb(options: DemoWebOptions): DemoWeb {
  const hub = createHub(
    options.initialPayerBalance === undefined
      ? {}
      : { initialPayerBalance: options.initialPayerBalance },
  )
  const token = options.token ?? crypto.randomUUID()
  const heartbeatMs = options.heartbeatMs ?? 5000

  const facilitator = createFacilitator({
    provider: options.provider,
    store: observedStore(memoryStore(), hub),
    merchants: [{ id: MERCHANT_ID, token, payTo: MERCHANT_ID }],
    devSimulate: true,
    // Matches the seller's per-IP limit so a fast-clicking visitor meets one limit, not two.
    merchantRateLimit: { limit: options.chargesPerMinute ?? 120, windowMs: 60_000 },
  })
  const facilitatorFetch = (request: Request) => facilitator.fetch(request)

  // The seller reaches the facilitator in-process; every call is published on the hub.
  const seller = createDemoSeller({
    facilitatorUrl: "http://facilitator.interno",
    token,
    fetch: observedFetch(async (request) => facilitatorFetch(request), hub),
    price: RESOURCE_PRICE,
    chargesPerMinute: options.chargesPerMinute ?? 120,
    pendingRetryAfterSeconds: options.pendingRetryAfterSeconds ?? 0,
  })

  const snapshot = () => ({
    provider: options.provider.name,
    merchant: MERCHANT_ID,
    resource: { path: RESOURCE_PATH, amount: RESOURCE_PRICE },
    saldoInicialPagador: hub.initialPayerBalance,
    saldos: hub.balances(),
    pagamentos: hub.payments(),
    at: clock(),
  })

  const app = new Hono()
  app.route("/loja", seller)
  app.route("/facilitator", facilitator)

  app.get("/api/estado", (c) => c.json(snapshot()))

  app.post("/api/reiniciar", (c) => {
    hub.reset()
    return c.json(snapshot())
  })

  app.get("/api/eventos", (c) => {
    c.header("Cache-Control", "no-store")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      let id = 0
      // Events published while a write is in flight are chained so their order is kept.
      let chain: Promise<void> = Promise.resolve()
      const send = (event: string, data: unknown) => {
        const message = { event, data: JSON.stringify(data), id: String(++id) }
        chain = chain.then(() => stream.writeSSE(message)).catch(() => undefined)
        return chain
      }
      const unsubscribe = hub.subscribe((event: DemoEvent) => {
        void send(event.type, event)
      })
      stream.onAbort(unsubscribe)
      try {
        await send("estado", snapshot())
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
        unsubscribe()
      }
    })
  })

  return { app, hub, facilitatorFetch }
}
