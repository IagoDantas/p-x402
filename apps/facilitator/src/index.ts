import type { FetchLike } from "@p-x402/core"
import { createAbacatePayProvider, createMockPixProvider, type PixProvider } from "@p-x402/psp"
import { createFacilitator } from "./app"
import type { ChargeStore } from "./store"
import { bunSqliteStore } from "./stores/bun-sqlite"
import { memoryStore } from "./stores/memory"

function required(name: string): string {
  const value = Bun.env[name]?.trim()
  if (!value) {
    console.error(`facilitator: ${name} is required`)
    process.exit(1)
  }
  return value
}

function main() {
  const port = Number(Bun.env.PORT ?? "4020")
  const providerName = Bun.env.PX402_PROVIDER ?? "mock"
  const devSimulate = Bun.env.PX402_DEV_SIMULATE === "1"
  const merchantId = Bun.env.PX402_MERCHANT_ID?.trim() || "loja1"
  const merchant = {
    id: merchantId,
    token: required("PX402_MERCHANT_TOKEN"),
    payTo: Bun.env.PX402_PAY_TO?.trim() || merchantId,
  }

  let provider: PixProvider
  let onReady: ((fetch: FetchLike) => void) | undefined
  if (providerName === "abacatepay") {
    const webhookSecret = Bun.env.ABACATEPAY_WEBHOOK_SECRET?.trim()
    if (!webhookSecret) {
      console.warn("facilitator: ABACATEPAY_WEBHOOK_SECRET not set; /webhooks/pix is disabled")
    }
    provider = createAbacatePayProvider({
      apiKey: required("ABACATEPAY_API_KEY"),
      ...(webhookSecret ? { webhookSecret } : {}),
    })
  } else if (providerName === "mock") {
    // A per-process prefix keeps charge ids unique across restarts when PX402_DB_PATH persists them.
    const mock = createMockPixProvider({
      idPrefix: `pix_char_mock_${crypto.randomUUID().slice(0, 8)}_`,
    })
    // Simulated payments deliver their webhook straight to this app.
    onReady = (fetch) => mock.setWebhookSink(fetch)
    provider = mock
  } else {
    console.error(`facilitator: unknown PX402_PROVIDER ${providerName}`)
    process.exit(1)
  }

  const dbPath = Bun.env.PX402_DB_PATH?.trim()
  const store: ChargeStore = dbPath ? bunSqliteStore(dbPath) : memoryStore()
  if (!dbPath) console.warn("facilitator: PX402_DB_PATH not set; charges are kept in memory only")
  if (devSimulate) {
    console.warn("facilitator: PX402_DEV_SIMULATE=1, anyone can mark charges as paid")
  }

  const app = createFacilitator({ provider, store, merchants: [merchant], devSimulate })
  onReady?.((request) => Promise.resolve(app.fetch(request)))
  const server = Bun.serve({ port, fetch: app.fetch })
  console.log(`p-x402 facilitator (${provider.name}) on http://localhost:${server.port}`)
}

if (import.meta.main) main()
