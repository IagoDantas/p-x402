import {
  encodePaymentPayload,
  type FetchLike,
  type PixPaymentRequirements,
  type SettlementResponse,
  type VerifyResponse,
} from "@p-x402/core"

export const FACILITATOR = "http://facilitator.test"
export const TOKEN = "tok_merchant"

export interface RecordedCall {
  path: string
  auth: string | null
  body: unknown
}

export function fakeClock(start = Date.parse("2026-11-25T15:00:00.000Z")) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

export function pixRequirements(
  overrides: { chargeId?: string; amount?: string; resourceUrl?: string } = {},
): PixPaymentRequirements {
  return {
    scheme: "exact",
    network: "pix:br",
    asset: "BRL",
    amount: overrides.amount ?? "500",
    payTo: "loja1",
    maxTimeoutSeconds: 300,
    extra: {
      paymentFlow: "upfront",
      assetTransferMethod: "pix-charge",
      provider: "mock",
      resourceUrl: overrides.resourceUrl ?? "http://shop.test/relatorio",
      chargeId: overrides.chargeId ?? "pix_char_mock_0001",
      brCode: "00020101021226",
      expiresAt: "2026-11-25T15:05:00.000Z",
    },
  }
}

export function paymentSignature(accepted: PixPaymentRequirements | Record<string, unknown>) {
  const extra = (accepted as { extra: { chargeId: string } }).extra
  return encodePaymentPayload({
    x402Version: 2,
    accepted: accepted as PixPaymentRequirements,
    payload: { chargeId: extra.chargeId },
  })
}

type Reply = Response | (() => Response | Promise<Response>)

/** In-process facilitator stub: records every call; replies are programmable per path. */
export function stubFacilitator(events: string[] = []) {
  const calls: RecordedCall[] = []
  let charges = 0
  const replies: Record<string, Reply | undefined> = {}
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const fetch: FetchLike = async (request) => {
    const path = new URL(request.url).pathname
    const body: unknown = await request.json()
    calls.push({ path, auth: request.headers.get("authorization"), body })
    events.push(path)
    const reply = replies[path]
    if (reply) return typeof reply === "function" ? reply() : reply.clone()
    if (path === "/pix/charges") {
      charges += 1
      const req = body as { amount: string; resource: { url: string } }
      return json({
        paymentRequirements: pixRequirements({
          chargeId: `pix_char_mock_${String(charges).padStart(4, "0")}`,
          amount: req.amount,
          resourceUrl: req.resource.url,
        }),
      })
    }
    if (path === "/verify") return json({ isValid: true } satisfies VerifyResponse)
    if (path === "/settle") {
      const chargeId = (body as { paymentRequirements: PixPaymentRequirements }).paymentRequirements
        .extra.chargeId
      return json({
        success: true,
        transaction: chargeId,
        network: "pix:br",
        amount: "500",
      } satisfies SettlementResponse)
    }
    return json({ error: "not_found" }, 404)
  }

  return {
    fetch,
    calls,
    events,
    json,
    reply(path: string, value: Reply | undefined) {
      replies[path] = value
    },
    callsTo(path: string) {
      return calls.filter((call) => call.path === path)
    },
  }
}
