import { defaultFetch, type FetchLike, Px402Error } from "@p-x402/core"
import type { PixPayer } from "./types"

export type SimulatePayerOptions =
  | { facilitatorUrl: string; fetch?: FetchLike }
  | { simulate: (chargeId: string) => Promise<void> }

/**
 * Dev-only payer: marks the charge paid instead of moving money.
 * Either calls the facilitator's `POST /dev/charges/:id/simulate-payment` or a function you provide.
 */
export function simulatePayer(options: SimulatePayerOptions): PixPayer {
  if ("simulate" in options) {
    const simulate = options.simulate
    return { pay: (charge) => simulate(charge.chargeId) }
  }
  const fetchImpl = options.fetch ?? defaultFetch
  const base = options.facilitatorUrl.replace(/\/+$/, "")
  return {
    async pay(charge) {
      const url = `${base}/dev/charges/${encodeURIComponent(charge.chargeId)}/simulate-payment`
      const response = await fetchImpl(new Request(url, { method: "POST" }))
      await response.body?.cancel().catch(() => undefined)
      if (!response.ok) {
        throw new Px402Error("payer_failed", `simulate-payment returned HTTP ${response.status}`, {
          chargeId: charge.chargeId,
          status: response.status,
        })
      }
    },
  }
}
