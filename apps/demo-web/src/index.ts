import { bunSqliteStore } from "@p-x402/facilitator/stores/bun-sqlite"
import { createAbacatePayProvider, createMockPixProvider, type PixProvider } from "@p-x402/psp"
import { createDemoWeb } from "./app"
import { readConfig } from "./config"
import { everyDayAtUtcHour } from "./schedule"
import page from "./web/index.html"

// `bun run demo:web`: the public demo service (agent, seller, facilitator, page) on one port.
function main() {
  let config: ReturnType<typeof readConfig>
  try {
    config = readConfig(Bun.env)
  } catch (error) {
    console.error(`demo-web: ${(error as Error).message}`)
    process.exit(1)
  }

  let provider: PixProvider
  let wireWebhooks: ((fetch: (request: Request) => Promise<Response>) => void) | undefined
  if (config.provider === "abacatepay" && config.abacatepayApiKey) {
    provider = createAbacatePayProvider({
      apiKey: config.abacatepayApiKey,
      ...(config.abacatepayWebhookSecret ? { webhookSecret: config.abacatepayWebhookSecret } : {}),
    })
    if (!config.abacatepayWebhookSecret) {
      console.warn("demo-web: ABACATEPAY_WEBHOOK_SECRET not set; the webhook route is off")
    }
  } else {
    const mock = createMockPixProvider({
      idPrefix: `pix_char_mock_${crypto.randomUUID().slice(0, 8)}_`,
    })
    wireWebhooks = (fetch) => mock.setWebhookSink(fetch)
    provider = mock
  }

  const demo = createDemoWeb({
    provider,
    store: config.dbPath ? bunSqliteStore(config.dbPath) : undefined,
    storeName: config.dbPath ? "sqlite" : "memoria",
    ...(config.merchantToken ? { token: config.merchantToken } : {}),
    allowedOrigins: config.allowedOrigins,
    ...(config.adminSecret ? { adminSecret: config.adminSecret } : {}),
    ...(config.clientIpHeader ? { clientIpHeader: config.clientIpHeader } : {}),
    runsPerIpPerHour: config.runsPerIpPerHour,
    chargesPerIpPerMinute: config.chargesPerIpPerMinute,
    merchantChargesPerMinute: config.merchantChargesPerMinute,
    ...(config.stepTimeoutSeconds ? { stepTimeoutMs: config.stepTimeoutSeconds * 1000 } : {}),
  })
  wireWebhooks?.((request) => demo.facilitatorFetch(request))

  if (config.resetUtcHour !== undefined) {
    everyDayAtUtcHour(config.resetUtcHour, () => {
      demo.agent.resetAll()
      console.log("demo-web: daily reset done")
    })
  }

  const server = Bun.serve({
    port: config.port,
    // SSE connections stay open; the app sends a keep-alive every 5 s.
    idleTimeout: 30,
    // Hot reload re-runs the page script and would drop its state; only for UI work.
    development: Bun.env.NODE_ENV === "development",
    routes: { "/": page },
    fetch: demo.app.fetch,
  })
  console.log(
    `p-x402 demo (PSP ${provider.name}, ${config.dbPath ? "sqlite" : "memória"}) em ${server.url}`,
  )
  if (provider.name !== "mock") {
    console.log(`webhook do PSP: <endereço público>/facilitator/webhooks/pix`)
  }
}

if (import.meta.main) main()
