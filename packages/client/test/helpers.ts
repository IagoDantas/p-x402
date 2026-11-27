import {
  decodePaymentPayload,
  encodeEmv,
  encodePaymentRequired,
  encodeSettlementResponse,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  type PaymentRequired,
  type PaymentRequirements,
} from "@p-x402/core"
import type { PixChargeToPay, PixPayer } from "../src"

export const ORIGIN = "https://api.example.com"
export const RESOURCE = `${ORIGIN}/relatorio`
export const START = Date.parse("2026-11-25T15:00:00.000Z")
export const EXPIRES_AT = "2026-11-25T15:05:00.000Z"

export function brCode(amountBrl: string | undefined): string {
  const fields = [
    { id: "00", value: "01" },
    { id: "26", value: "0014br.gov.bcb.pix0105abcde" },
    { id: "53", value: "986" },
    ...(amountBrl === undefined ? [] : [{ id: "54", value: amountBrl }]),
    { id: "58", value: "BR" },
  ]
  return encodeEmv(fields)
}

export function pixRequirements(
  overrides: { amount?: string; chargeId?: string; extra?: Record<string, unknown> } = {},
): PaymentRequirements {
  const amount = overrides.amount ?? "500"
  return {
    scheme: "exact",
    network: "pix:br",
    asset: "BRL",
    amount,
    payTo: "loja1",
    maxTimeoutSeconds: 300,
    extra: {
      paymentFlow: "upfront",
      assetTransferMethod: "pix-charge",
      provider: "mock",
      resourceUrl: RESOURCE,
      chargeId: overrides.chargeId ?? "pix_char_mock_0001",
      brCode: brCode((Number(amount) / 100).toFixed(2)),
      expiresAt: EXPIRES_AT,
      ...overrides.extra,
    },
  }
}

export function paymentRequired(
  accepts: PaymentRequirements[],
  resourceUrl: string = RESOURCE,
): PaymentRequired {
  return { x402Version: 2, resource: { url: resourceUrl }, accepts }
}

export function challenge(required: PaymentRequired): Response {
  return new Response(JSON.stringify(required), {
    status: 402,
    headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(required) },
  })
}

export function refused(errorReason: string, chargeId: string, retryAfter?: string): Response {
  const headers: Record<string, string> = {
    [HEADER_PAYMENT_RESPONSE]: encodeSettlementResponse({
      success: false,
      errorReason,
      transaction: chargeId,
      network: "pix:br",
    }),
  }
  if (retryAfter !== undefined) headers["Retry-After"] = retryAfter
  return new Response("{}", { status: 402, headers })
}

export interface Seen {
  method: string
  url: string
  signature: string | null
  body: string
}

/** A FetchLike that answers by attempt index and records what it saw. */
export function scriptedServer(
  answer: (attempt: number, request: Request, seen: Seen) => Response | Promise<Response>,
) {
  const seen: Seen[] = []
  const fetch = async (request: Request): Promise<Response> => {
    const entry: Seen = {
      method: request.method,
      url: request.url,
      signature: request.headers.get(HEADER_PAYMENT_SIGNATURE),
      body: await request.text(),
    }
    seen.push(entry)
    return answer(seen.length - 1, request, entry)
  }
  return { fetch, seen }
}

/** Plays a paywall: 402 challenge without signature, 200 with one. */
export function simplePaywall(requirements: PaymentRequirements = pixRequirements()) {
  return scriptedServer((_attempt, _request, seen) =>
    seen.signature === null
      ? challenge(paymentRequired([requirements]))
      : new Response("ok", { status: 200 }),
  )
}

export function fakeClock(start = START) {
  const clock = {
    t: start,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms)
      clock.t += ms
    },
  }
  return clock
}

export function countingPayer(impl?: (charge: PixChargeToPay) => Promise<void>) {
  const charges: PixChargeToPay[] = []
  const payer: PixPayer = {
    async pay(charge) {
      charges.push(charge)
      if (impl) await impl(charge)
    },
  }
  return { payer, charges }
}

export function chargeIdOf(signature: string | null): unknown {
  if (signature === null) return undefined
  return decodePaymentPayload(signature).payload.chargeId
}
