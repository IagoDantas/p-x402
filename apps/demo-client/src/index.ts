import { simulatePayer, wrapFetch } from "@p-x402/client"
import { defaultFetch } from "@p-x402/core"
import { brl, loggingFetch, say, show } from "./log"

// Buys GET /relatorio from a running demo-server, paying with the facilitator's dev simulate route.
const serverUrl = process.env.DEMO_SERVER_URL ?? "http://localhost:4021/relatorio"
const facilitatorUrl = process.env.PX402_FACILITATOR_URL ?? "http://localhost:4020"

const payer = simulatePayer({ facilitatorUrl })
const fetchPaid = wrapFetch(loggingFetch(defaultFetch), {
  payer: {
    paysBrCode: payer.paysBrCode,
    async pay(charge) {
      say(`pagando ${brl(charge.amount)} via Pix (simulate-payment) — cobrança ${charge.chargeId}`)
      await payer.pay(charge)
    },
  },
  policy: { maxPerRequest: 1000, maxTotal: 5000, allowedOrigins: [new URL(serverUrl).origin] },
})

const response = await fetchPaid(serverUrl)
say(`resultado: HTTP ${response.status}`)
show("corpo", await response.json())
