import {
  encodeEmv,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "@p-x402/core"

/**
 * Fixed, fictitious values shared by every vector file. Nothing here is real personal data: the
 * Pix key is a made-up random-key (EVP) UUID, the merchant and city are placeholders.
 */
export const ORIGIN = "https://api.example.com"
export const RESOURCE = `${ORIGIN}/relatorio`
export const CLOCK_START = "2026-11-25T15:00:00.000Z"
export const EXPIRES_AT = "2026-11-25T15:05:00.000Z"
export const PAY_TO = "loja-exemplo"
export const PIX_KEY = "123e4567-e89b-42d3-a456-426614174000"
export const CHARGE_ID = "pix_char_vector_0001"

/** A static Pix BR Code (no location URL) for `amountBrl` reais, built with the real encoder. */
export function brCode(amountBrl: string | undefined, txid = "PX402VECTOR0001"): string {
  const fields = [
    { id: "00", value: "01" },
    { id: "26", value: `0014br.gov.bcb.pix01${String(PIX_KEY.length).padStart(2, "0")}${PIX_KEY}` },
    { id: "52", value: "0000" },
    { id: "53", value: "986" },
    ...(amountBrl === undefined ? [] : [{ id: "54", value: amountBrl }]),
    { id: "58", value: "BR" },
    { id: "59", value: "LOJA EXEMPLO" },
    { id: "60", value: "SAO PAULO" },
    { id: "62", value: `05${String(txid.length).padStart(2, "0")}${txid}` },
  ]
  return encodeEmv(fields)
}

export function centsToBrl(amount: string): string {
  return (Number(amount) / 100).toFixed(2)
}

export interface RequirementsOverrides {
  amount?: string
  chargeId?: string
  resourceUrl?: string
  brCodeAmountBrl?: string
  extra?: Record<string, unknown>
}

/** Pix requirements in the key order the facilitator and the decoders produce. */
export function pixRequirements(o: RequirementsOverrides = {}): PaymentRequirements {
  const amount = o.amount ?? "500"
  const chargeId = o.chargeId ?? CHARGE_ID
  return {
    scheme: "exact",
    network: "pix:br",
    amount,
    asset: "BRL",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      paymentFlow: "upfront",
      assetTransferMethod: "pix-charge",
      provider: "mock",
      resourceUrl: o.resourceUrl ?? RESOURCE,
      chargeId,
      brCode: brCode(o.brCodeAmountBrl ?? centsToBrl(amount)),
      expiresAt: EXPIRES_AT,
      ...o.extra,
    },
  }
}

export function paymentRequired(
  accepts: PaymentRequirements[],
  resource: PaymentRequired["resource"] = { url: RESOURCE },
): PaymentRequired {
  return { x402Version: 2, error: "payment_required", resource, accepts }
}

export function pixPayload(requirements: PaymentRequirements = pixRequirements()): PaymentPayload {
  const chargeId = (requirements.extra as { chargeId: string }).chargeId
  return {
    x402Version: 2,
    resource: { url: (requirements.extra as { resourceUrl: string }).resourceUrl },
    accepted: requirements,
    payload: { chargeId },
  }
}
