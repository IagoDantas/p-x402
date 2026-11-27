import { createAbacatePayProvider, createMockPixProvider, type PixProvider } from "@p-x402/psp"
import { createDemoWeb } from "./app"
import page from "./web/index.html"

// `bun run demo:web`: seller, facilitator and the visual demo on one port.
// Default PSP is the in-memory mock (no secrets). PX402_PROVIDER=abacatepay uses the sandbox.
function main() {
  const port = Number(Bun.env.DEMO_WEB_PORT ?? "4030")
  const providerName = Bun.env.PX402_PROVIDER ?? "mock"

  let provider: PixProvider
  let wireWebhooks: ((fetch: (request: Request) => Promise<Response>) => void) | undefined
  if (providerName === "abacatepay") {
    const apiKey = Bun.env.ABACATEPAY_API_KEY?.trim()
    if (!apiKey) {
      console.error("demo-web: ABACATEPAY_API_KEY is required with PX402_PROVIDER=abacatepay")
      process.exit(1)
    }
    const webhookSecret = Bun.env.ABACATEPAY_WEBHOOK_SECRET?.trim()
    provider = createAbacatePayProvider({ apiKey, ...(webhookSecret ? { webhookSecret } : {}) })
  } else if (providerName === "mock") {
    const mock = createMockPixProvider({
      idPrefix: `pix_char_mock_${crypto.randomUUID().slice(0, 8)}_`,
    })
    wireWebhooks = (fetch) => mock.setWebhookSink(fetch)
    provider = mock
  } else {
    console.error(`demo-web: unknown PX402_PROVIDER ${providerName}`)
    process.exit(1)
  }

  const demo = createDemoWeb({ provider })
  wireWebhooks?.(async (request) => demo.facilitatorFetch(request))

  const server = Bun.serve({
    port,
    // SSE connections stay open; the app sends a keep-alive every 5 s.
    idleTimeout: 30,
    development: Bun.env.NODE_ENV !== "production",
    routes: { "/": page },
    fetch: demo.app.fetch,
  })
  console.log(`p-x402 demo visual (PSP ${provider.name}) em ${server.url}`)
  if (provider.name !== "mock") {
    console.log(`webhook do PSP: ${server.url}facilitator/webhooks/pix (via túnel)`)
  }
}

if (import.meta.main) main()
