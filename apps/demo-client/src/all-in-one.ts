import { wrapFetch } from "@p-x402/client"
import { defaultFetch } from "@p-x402/core"
import { createDemoServer } from "@p-x402/demo-server"
import { createFacilitator } from "@p-x402/facilitator"
import { memoryStore } from "@p-x402/facilitator/stores/memory"
import { createMockPixProvider } from "@p-x402/psp"
import { brl, loggingFetch, say, show } from "./log"

// `bun run demo:local`: facilitator, seller API and buyer in one process, with the in-memory mock PSP.
const token = "demo-token-loja1"
const mock = createMockPixProvider()
const facilitator = createFacilitator({
  provider: mock,
  store: memoryStore(),
  merchants: [{ id: "loja1", token, payTo: "loja1" }],
})
mock.setWebhookSink(async (request) => facilitator.fetch(request))
const facilitatorServer = Bun.serve({ port: 0, fetch: facilitator.fetch })
const facilitatorUrl = facilitatorServer.url.origin

const seller = createDemoServer({ facilitatorUrl, token })
const sellerServer = Bun.serve({ port: 0, fetch: seller.fetch })
const resourceUrl = new URL("/relatorio", sellerServer.url).toString()

console.log("p-x402 — demo local (PSP mock, nada de dinheiro real)")
console.log(`facilitator: ${facilitatorUrl}   vendedor: ${sellerServer.url.origin}`)

// The payer "sends" the Pix and returns; the mock PSP confirms it 1.5 s later, like a real bank would.
const fetchPaid = wrapFetch(loggingFetch(defaultFetch), {
  payer: {
    async pay(charge) {
      say(
        `política ok — pagando ${brl(charge.amount)} via Pix (cobrança ${charge.chargeId}); o PSP confirma em ~1,5 s`,
      )
      setTimeout(() => {
        mock.simulatePayment(charge.chargeId).then(
          () => say(`PSP mock: cobrança ${charge.chargeId} PAGA (webhook enviado ao facilitator)`),
          (error: unknown) => console.error("simulatePayment falhou", error),
        )
      }, 1500)
    },
  },
  policy: { maxPerRequest: 1000, maxTotal: 5000, allowedOrigins: [sellerServer.url.origin] },
})

try {
  const response = await fetchPaid(resourceUrl)
  say(`resultado final: HTTP ${response.status}`)
  show("corpo", await response.json())
  if (response.status !== 200) process.exitCode = 1
} finally {
  sellerServer.stop(true)
  facilitatorServer.stop(true)
}
