import { createDemoServer } from "./app"

const facilitatorUrl = process.env.PX402_FACILITATOR_URL ?? "http://localhost:4020"
const token = process.env.PX402_MERCHANT_TOKEN
if (!token) {
  console.error("PX402_MERCHANT_TOKEN is required (see .env.example)")
  process.exit(1)
}
const port = Number(process.env.DEMO_SERVER_PORT ?? 4021)
const app = createDemoServer({
  facilitatorUrl,
  token,
  ...(process.env.PX402_PUBLIC_ORIGIN ? { publicOrigin: process.env.PX402_PUBLIC_ORIGIN } : {}),
})

const server = Bun.serve({ port, fetch: app.fetch })
console.log(`demo-server em ${server.url} (facilitator: ${facilitatorUrl})`)
