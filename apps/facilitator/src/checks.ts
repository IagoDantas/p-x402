import {
  FacilitatorRequestSchema,
  isPx402Error,
  matchPixRequirements,
  type PaymentRequirements,
  PIX_NETWORK,
  PIX_SCHEME,
  PixPayloadSchema,
  type PixPaymentRequirements,
  PixPaymentRequirementsSchema,
  type Px402ErrorCode,
  X402_VERSION,
} from "@p-x402/core"
import type { PixChargeState, PixProvider } from "@p-x402/psp"
import { z } from "zod"
import type { ChargeRecord, ChargeStore } from "./store"

export interface FacilitatorMerchant {
  id: string
  /** Bearer token the merchant's resource server sends. */
  token: string
  /** Value placed in `payTo` of this merchant's requirements. */
  payTo: string
}

/** PSP answer or the fact that asking failed. */
export type PspObservation = { state: PixChargeState } | { error: unknown }

export interface CheckContext {
  provider: PixProvider
  store: ChargeStore
  merchant: FacilitatorMerchant
  now: () => number
  paidGraceMs: number
  /** Effective charge lifetime; requirements must carry it as maxTimeoutSeconds. */
  chargeTtlSeconds: number
  /** Asks the PSP for the charge state (coalesced by the caller). */
  observe: (chargeId: string) => Promise<PixChargeState>
}

export type CheckResult =
  | { ok: true; chargeId: string; record: ChargeRecord; observation: PspObservation }
  | {
      ok: false
      reason: Px402ErrorCode
      /** "" when no chargeId could be read. */
      chargeId: string
      /**
       * 400 only when the outer x402 envelope cannot be read; a Pix-specific part that fails its
       * schema (requirements, payload) is an ordinary 200 refusal.
       */
      status: 200 | 400
      record?: ChargeRecord
      observation?: PspObservation
    }

// Loose outer shape: versions checked as a rule, not as a parse error.
const LooseBodySchema = z.object({
  x402Version: z.number(),
  paymentPayload: z.object({ x402Version: z.number() }).loose(),
  paymentRequirements: z.unknown(),
})

function fail(
  reason: Px402ErrorCode,
  chargeId: string,
  extra: { status?: 200 | 400; record?: ChargeRecord; observation?: PspObservation } = {},
): CheckResult {
  return { ok: false, reason, chargeId, status: extra.status ?? 200, ...extra }
}

function guessChargeId(body: unknown): string {
  const extra = (body as { paymentRequirements?: { extra?: { chargeId?: unknown } } } | null)
    ?.paymentRequirements?.extra
  const id = extra?.chargeId
  return typeof id === "string" && id.length <= 128 ? id : ""
}

function pixKindCheck(req: PaymentRequirements): Px402ErrorCode | null {
  if (req.scheme !== PIX_SCHEME) return "unsupported_scheme"
  if (req.network !== PIX_NETWORK) return "unsupported_network"
  return null
}

/** Decides from the PSP answer alone whether the charge is payable now. */
function judgePsp(
  record: ChargeRecord,
  observation: PspObservation,
  now: number,
  paidGraceMs: number,
): Px402ErrorCode | null {
  if ("error" in observation) return "settlement_pending"
  const { state } = observation
  const expiresAt = Date.parse(record.expiresAt)
  switch (state.status) {
    case "PAID": {
      const candidates = [
        state.paidAt === undefined ? Number.NaN : Date.parse(state.paidAt),
        record.paidAt ?? Number.NaN,
        expiresAt,
      ].filter((v) => Number.isFinite(v))
      if (candidates.length === 0) return "charge_expired"
      return now <= Math.min(...candidates) + paidGraceMs ? null : "charge_expired"
    }
    case "UNDER_DISPUTE":
      return "charge_disputed"
    case "REFUNDED":
      return "charge_refunded"
    case "EXPIRED":
      return "charge_expired"
    case "CANCELLED":
    case "FAILED":
      return "charge_failed"
    default:
      // PENDING, UNKNOWN: not paid
      return now > expiresAt ? "charge_expired" : "settlement_pending"
  }
}

/** Every check shared by /verify and /settle, in the design's order. Writes nothing. */
export async function runChecks(ctx: CheckContext, body: unknown): Promise<CheckResult> {
  const guessed = guessChargeId(body)
  const loose = LooseBodySchema.safeParse(body)
  if (!loose.success) return fail("invalid_payload", guessed, { status: 400 })
  if (
    loose.data.x402Version !== X402_VERSION ||
    loose.data.paymentPayload.x402Version !== X402_VERSION
  ) {
    return fail("invalid_x402_version", guessed)
  }
  const parsed = FacilitatorRequestSchema.safeParse(body)
  if (!parsed.success) return fail("invalid_payload", guessed, { status: 400 })
  const { paymentPayload, paymentRequirements } = parsed.data
  const accepted = paymentPayload.accepted

  // Both sides must be Pix requirements.
  const kindError = pixKindCheck(paymentRequirements) ?? pixKindCheck(accepted)
  if (kindError) return fail(kindError, guessed)
  const reqParsed = PixPaymentRequirementsSchema.safeParse(paymentRequirements)
  const accParsed = PixPaymentRequirementsSchema.safeParse(accepted)
  if (!reqParsed.success || !accParsed.success) {
    return fail("invalid_payment_requirements", guessed)
  }
  const requirements: PixPaymentRequirements = reqParsed.data
  const chargeId = requirements.extra.chargeId

  // The proof names the same charge.
  const payload = PixPayloadSchema.safeParse(paymentPayload.payload)
  if (!payload.success) return fail("invalid_payload", chargeId)
  if (payload.data.chargeId !== chargeId || accParsed.data.extra.chargeId !== chargeId) {
    return fail("requirements_mismatch", chargeId)
  }

  // Accepted vs requirements (raw objects so server-declared extra keys are compared).
  const match = matchPixRequirements(accepted, paymentRequirements)
  if (!match.ok) return fail(match.reason, chargeId)
  if (requirements.extra.provider !== ctx.provider.name) {
    return fail("requirements_mismatch", chargeId)
  }

  // Requirements vs our record.
  const record = await ctx.store.get(chargeId)
  if (!record) return fail("charge_not_found", chargeId)
  if (record.merchantId !== ctx.merchant.id) return fail("merchant_mismatch", chargeId)
  if (requirements.payTo !== ctx.merchant.payTo) return fail("pay_to_mismatch", chargeId)
  if (record.amount !== requirements.amount) return fail("amount_mismatch", chargeId)
  if (record.payTo !== requirements.payTo) return fail("pay_to_mismatch", chargeId)
  if (record.resourceUrl !== requirements.extra.resourceUrl) {
    return fail("resource_mismatch", chargeId)
  }
  if (
    record.provider !== requirements.extra.provider ||
    record.brCode !== requirements.extra.brCode ||
    record.expiresAt !== requirements.extra.expiresAt ||
    requirements.maxTimeoutSeconds !== ctx.chargeTtlSeconds
  ) {
    return fail("requirements_mismatch", chargeId)
  }
  if (record.consumedAt !== null) return fail("charge_already_consumed", chargeId, { record })
  if (record.refundedAt !== null) return fail("charge_refunded", chargeId, { record })
  if (record.disputedAt !== null) return fail("charge_disputed", chargeId, { record })
  // Past expiresAt + grace no PSP answer can make the charge payable (see judgePsp): refuse without
  // asking, so replaying an old signature cannot make us call the PSP.
  if (ctx.now() > Date.parse(record.expiresAt) + ctx.paidGraceMs) {
    return fail("charge_expired", chargeId, { record })
  }

  // The PSP is the truth.
  let observation: PspObservation
  try {
    observation = { state: await ctx.observe(chargeId) }
  } catch (error) {
    // Answered as settlement_pending; log the cause (never the provider key, which errors omit).
    console.error(
      "facilitator: getCharge failed",
      chargeId,
      isPx402Error(error) ? error.code : error,
    )
    observation = { error }
  }
  const reason = judgePsp(record, observation, ctx.now(), ctx.paidGraceMs)
  if (reason) return fail(reason, chargeId, { record, observation })
  return { ok: true, chargeId, record, observation }
}
