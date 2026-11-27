import type { FetchLike } from "@p-x402/core"
import { type Px402Variables, pixPaywall } from "@p-x402/server/hono"
import { Hono } from "hono"

/**
 * The seller is only reachable in-process, from the demo agent, which passes the visitor's IP here
 * so the paywall's per-IP charge cap applies per visitor.
 */
export const CLIENT_IP_HEADER = "x-demo-client-ip"

export interface DemoSellerOptions {
  facilitatorUrl: string
  token: string
  fetch: FetchLike
  /** Price of GET /relatorio in centavos. */
  price: number
  /** Charges per client IP per minute (the paywall's own cap). */
  chargesPerMinute: number
  /** Retry-After sent with settlement_pending, in seconds. */
  pendingRetryAfterSeconds: number
}

/**
 * Same paid route as apps/demo-server (GET /relatorio behind `pixPaywall`), with a configurable
 * per-IP charge cap and a shorter Retry-After while the Pix is pending, so the agent's retry lands
 * right after the PSP confirms.
 */
export function createDemoSeller(options: DemoSellerOptions) {
  const app = new Hono<{ Variables: Px402Variables }>()
  const pix = pixPaywall({
    facilitatorUrl: options.facilitatorUrl,
    token: options.token,
    fetch: options.fetch,
    ipRateLimit: { limit: options.chargesPerMinute, windowMs: 60_000 },
    settlementPendingRetryAfterSeconds: options.pendingRetryAfterSeconds,
    getClientIp: (c) => c.req.header(CLIENT_IP_HEADER) || undefined,
  })

  app.get(
    "/relatorio",
    pix({
      amount: String(options.price),
      description: "Relatório de vendas",
      mimeType: "application/json",
    }),
    (c) =>
      c.json({
        titulo: "Relatório de vendas — novembro de 2026",
        itens: [
          { produto: "Café especial 250 g", unidades: 312, receita: "R$ 12.168,00" },
          { produto: "Moedor manual", unidades: 41, receita: "R$ 7.339,00" },
        ],
        pagoCom: c.get("px402").chargeId,
      }),
  )

  return app
}
