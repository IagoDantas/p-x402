import type { FetchLike } from "@p-x402/core"
import { type Px402Variables, pixPaywall } from "@p-x402/server/hono"
import { Hono } from "hono"

export interface DemoServerOptions {
  facilitatorUrl: string
  token: string
  fetch?: FetchLike
  /** Public origin when behind a proxy, e.g. https://api.loja.com.br */
  publicOrigin?: string
}

/** Demo seller API with one paid route: GET /relatorio for R$ 5,00. */
export function createDemoServer(options: DemoServerOptions) {
  const app = new Hono<{ Variables: Px402Variables }>()
  const pix = pixPaywall({
    facilitatorUrl: options.facilitatorUrl,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  })

  app.get("/", (c) => c.json({ rotas: { "GET /relatorio": "R$ 5,00 via Pix (x402)" } }))

  app.get(
    "/relatorio",
    pix({ amount: "500", description: "Relatório de vendas", mimeType: "application/json" }),
    (c) => {
      const payment = c.get("px402")
      return c.json({
        titulo: "Relatório de vendas — novembro de 2026",
        itens: [
          { produto: "Café especial 250 g", unidades: 312, receita: "R$ 12.168,00" },
          { produto: "Moedor manual", unidades: 41, receita: "R$ 7.339,00" },
        ],
        pagoCom: payment.chargeId,
      })
    },
  )

  return app
}
