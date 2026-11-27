import {
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  encodeJsonHeader,
  isPx402Error,
  PaymentRequirementsSchema,
  PixPaymentPayloadSchema,
  PixPaymentRequirementsSchema,
} from "@p-x402/core"
import { createPaywall } from "@p-x402/server"
import { runChecks } from "../../../apps/facilitator/src/checks"
import {
  CHARGE_ID,
  ORIGIN,
  paymentRequired,
  pixPayload,
  pixRequirements,
  RESOURCE,
} from "../fixtures"

/**
 * Object types and where the reference implementation checks them:
 * - PaymentRequired, SettlementResponse: decoding the header (client side). Any schema failure is
 *   `invalid_header`.
 * - PaymentPayload: the paywall reading PAYMENT-SIGNATURE. Not a PaymentPayload at all is
 *   `invalid_header`; a PaymentPayload that is not a p-x402 Pix payload is `invalid_payload`.
 * - PaymentRequirements: the facilitator's /verify and /settle checks (accepted = requirements =
 *   the object). Not x402 requirements at all is `invalid_payload`; another scheme or network is
 *   `unsupported_scheme` / `unsupported_network`; x402 requirements that break the Pix profile are
 *   `invalid_payment_requirements`.
 */
export type ValidatedType =
  | "PaymentRequired"
  | "PaymentRequirements"
  | "PaymentPayload"
  | "SettlementResponse"

interface Case {
  id: string
  description: string
  type: ValidatedType
  value: unknown
}

type Expected = { valid: true } | { valid: false; errorCode: string }

function omit<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const { [key]: _drop, ...rest } = value
  return rest
}

const req = pixRequirements() as Record<string, unknown> & { extra: Record<string, unknown> }
const withReq = (patch: Record<string, unknown>) => ({ ...req, ...patch })
const withExtra = (patch: Record<string, unknown>) => ({
  ...req,
  extra: { ...req.extra, ...patch },
})
const pr = paymentRequired([pixRequirements()]) as Record<string, unknown>
const pp = pixPayload() as Record<string, unknown>
const settled = { success: true, transaction: CHARGE_ID, network: "pix:br", amount: "500" }

const cases: Case[] = [
  // PaymentRequired
  {
    id: "payment-required/valid",
    description: "one Pix option",
    type: "PaymentRequired",
    value: pr,
  },
  {
    id: "payment-required/valid-non-pix-option",
    description: "a PaymentRequired may carry options of any scheme; the client then picks Pix",
    type: "PaymentRequired",
    value: {
      ...pr,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1",
          asset: "USDC",
          payTo: "0x1",
          maxTimeoutSeconds: 60,
        },
      ],
    },
  },
  {
    id: "payment-required/x402-version-1",
    description: "x402Version must be 2",
    type: "PaymentRequired",
    value: { ...pr, x402Version: 1 },
  },
  {
    id: "payment-required/missing-resource",
    description: "resource is required",
    type: "PaymentRequired",
    value: omit(pr, "resource"),
  },
  {
    id: "payment-required/resource-not-http",
    description: "resource.url must be an absolute http(s) URL",
    type: "PaymentRequired",
    value: { ...pr, resource: { url: "ftp://api.example.com/relatorio" } },
  },
  {
    id: "payment-required/resource-with-fragment",
    description: "resource.url must not have a fragment",
    type: "PaymentRequired",
    value: { ...pr, resource: { url: `${RESOURCE}#parte-2` } },
  },
  {
    id: "payment-required/empty-accepts",
    description: "accepts needs at least one option",
    type: "PaymentRequired",
    value: { ...pr, accepts: [] },
  },
  {
    id: "payment-required/accepts-missing-pay-to",
    description: "each option needs payTo",
    type: "PaymentRequired",
    value: { ...pr, accepts: [omit(req, "payTo")] },
  },
  {
    id: "payment-required/max-timeout-zero",
    description: "maxTimeoutSeconds must be a positive integer",
    type: "PaymentRequired",
    value: { ...pr, accepts: [withReq({ maxTimeoutSeconds: 0 })] },
  },

  // PaymentRequirements (Pix profile)
  {
    id: "requirements/valid",
    description: "Pix requirements",
    type: "PaymentRequirements",
    value: req,
  },
  {
    id: "requirements/valid-without-asset-transfer-method",
    description: "extra.assetTransferMethod may be omitted; it defaults to pix-charge",
    type: "PaymentRequirements",
    value: { ...req, extra: omit(req.extra, "assetTransferMethod") },
  },
  {
    id: "requirements/valid-with-qr-image",
    description: "extra.brCodeBase64 (QR image) is optional",
    type: "PaymentRequirements",
    value: withExtra({ brCodeBase64: "iVBORw0KGgo=" }),
  },
  {
    id: "requirements/valid-expires-at-offset",
    description: "expiresAt may use a numeric UTC offset",
    type: "PaymentRequirements",
    value: withExtra({ expiresAt: "2026-11-25T12:05:00-03:00" }),
  },
  {
    id: "requirements/scheme-upto",
    description: "scheme other than exact",
    type: "PaymentRequirements",
    value: withReq({ scheme: "upto" }),
  },
  {
    id: "requirements/network-evm",
    description: "network other than pix:br",
    type: "PaymentRequirements",
    value: withReq({ network: "eip155:8453" }),
  },
  {
    id: "requirements/asset-usd",
    description: "asset must be BRL",
    type: "PaymentRequirements",
    value: withReq({ asset: "USD" }),
  },
  {
    id: "requirements/amount-leading-zero",
    description: "amount is a positive integer string without leading zeros",
    type: "PaymentRequirements",
    value: withReq({ amount: "0500" }),
  },
  {
    id: "requirements/amount-zero",
    description: "amount must be positive",
    type: "PaymentRequirements",
    value: withReq({ amount: "0" }),
  },
  {
    id: "requirements/amount-decimal",
    description: "amount is in centavos, never reais with a decimal point",
    type: "PaymentRequirements",
    value: withReq({ amount: "5.00" }),
  },
  {
    id: "requirements/amount-number",
    description: "amount must be a string, not a JSON number",
    type: "PaymentRequirements",
    value: withReq({ amount: 500 }),
  },
  {
    id: "requirements/amount-17-digits",
    description: "amount has at most 16 digits",
    type: "PaymentRequirements",
    value: withReq({ amount: "12345678901234567" }),
  },
  {
    id: "requirements/payment-flow-deferred",
    description: "extra.paymentFlow must be upfront",
    type: "PaymentRequirements",
    value: withExtra({ paymentFlow: "deferred" }),
  },
  {
    id: "requirements/asset-transfer-method-other",
    description: "extra.assetTransferMethod, when present, must be pix-charge",
    type: "PaymentRequirements",
    value: withExtra({ assetTransferMethod: "pix-automatico" }),
  },
  {
    id: "requirements/missing-charge-id",
    description: "extra.chargeId is required",
    type: "PaymentRequirements",
    value: { ...req, extra: omit(req.extra, "chargeId") },
  },
  {
    id: "requirements/missing-br-code",
    description: "extra.brCode is required",
    type: "PaymentRequirements",
    value: { ...req, extra: omit(req.extra, "brCode") },
  },
  {
    id: "requirements/expires-at-no-offset",
    description: "extra.expiresAt needs Z or an offset",
    type: "PaymentRequirements",
    value: withExtra({ expiresAt: "2026-11-25T15:05:00" }),
  },
  {
    id: "requirements/resource-url-relative",
    description: "extra.resourceUrl must be absolute",
    type: "PaymentRequirements",
    value: withExtra({ resourceUrl: "/relatorio" }),
  },
  {
    id: "requirements/missing-extra",
    description: "Pix requirements need extra",
    type: "PaymentRequirements",
    value: omit(req, "extra"),
  },
  {
    id: "requirements/negative-timeout",
    description: "not x402 requirements at all: maxTimeoutSeconds negative",
    type: "PaymentRequirements",
    value: withReq({ maxTimeoutSeconds: -1 }),
  },
  {
    id: "requirements/empty-pay-to",
    description: "not x402 requirements at all: payTo empty",
    type: "PaymentRequirements",
    value: withReq({ payTo: "" }),
  },

  // PaymentPayload
  { id: "payload/valid", description: "Pix retry payload", type: "PaymentPayload", value: pp },
  {
    id: "payload/valid-without-resource",
    description: "resource is optional",
    type: "PaymentPayload",
    value: omit(pp, "resource"),
  },
  {
    id: "payload/x402-version-1",
    description: "x402Version must be 2",
    type: "PaymentPayload",
    value: { ...pp, x402Version: 1 },
  },
  {
    id: "payload/missing-accepted",
    description: "accepted is required",
    type: "PaymentPayload",
    value: omit(pp, "accepted"),
  },
  {
    id: "payload/payload-not-object",
    description: "payload must be an object",
    type: "PaymentPayload",
    value: { ...pp, payload: CHARGE_ID },
  },
  {
    id: "payload/missing-charge-id",
    description: "a valid x402 payload, but the Pix payload needs chargeId",
    type: "PaymentPayload",
    value: { ...pp, payload: {} },
  },
  {
    id: "payload/charge-id-not-string",
    description: "a valid x402 payload, but chargeId must be a string",
    type: "PaymentPayload",
    value: { ...pp, payload: { chargeId: 1 } },
  },
  {
    id: "payload/accepted-not-pix",
    description: "a valid x402 payload whose accepted option is not Pix",
    type: "PaymentPayload",
    value: { ...pp, accepted: withReq({ network: "eip155:8453" }) },
  },

  // SettlementResponse
  {
    id: "settlement/valid-success",
    description: "settled with amount",
    type: "SettlementResponse",
    value: settled,
  },
  {
    id: "settlement/valid-failure",
    description: "refusal with errorReason",
    type: "SettlementResponse",
    value: {
      success: false,
      errorReason: "charge_expired",
      transaction: CHARGE_ID,
      network: "pix:br",
    },
  },
  {
    id: "settlement/missing-transaction",
    description: "transaction is required (empty string when unknown)",
    type: "SettlementResponse",
    value: omit(settled, "transaction"),
  },
  {
    id: "settlement/success-as-string",
    description: "success must be a boolean",
    type: "SettlementResponse",
    value: { ...settled, success: "true" },
  },
  {
    id: "settlement/missing-network",
    description: "network is required",
    type: "SettlementResponse",
    value: omit(settled, "network"),
  },
]

function headerError(fn: () => unknown): Expected {
  try {
    fn()
    return { valid: true }
  } catch (error) {
    if (isPx402Error(error)) return { valid: false, errorCode: error.code }
    throw error
  }
}

/** Status and `error` of the paywall's answer to a request carrying `value` as PAYMENT-SIGNATURE. */
async function paywallAnswer(value: unknown): Promise<{ status: number; error: unknown }> {
  const paywall = createPaywall({
    facilitatorUrl: "https://facilitator.example.com",
    token: "vector-token",
    fetch: async () => {
      throw new Error("the paywall should refuse this payload before calling the facilitator")
    },
  })
  const request = new Request(RESOURCE, {
    headers: { "PAYMENT-SIGNATURE": encodeJsonHeader(value) },
  })
  const result = await paywall.handle(request, { amount: "500" })
  if (result.type !== "response") throw new Error("paywall accepted an invalid payload")
  const body = (await result.response.json()) as { error?: unknown }
  return { status: result.response.status, error: body.error }
}

export async function expectedFor(type: ValidatedType, value: unknown): Promise<Expected> {
  switch (type) {
    case "PaymentRequired":
      return headerError(() => decodePaymentRequired(encodeJsonHeader(value)))
    case "SettlementResponse":
      return headerError(() => decodeSettlementResponse(encodeJsonHeader(value)))
    case "PaymentPayload": {
      const decoded = headerError(() => decodePaymentPayload(encodeJsonHeader(value)))
      const pixValid = decoded.valid && PixPaymentPayloadSchema.safeParse(value).success
      if (pixValid) return { valid: true }
      const answer = await paywallAnswer(value)
      if (answer.status !== 400 || typeof answer.error !== "string") {
        throw new Error(`unexpected paywall answer ${answer.status}`)
      }
      return { valid: false, errorCode: answer.error }
    }
    case "PaymentRequirements": {
      if (PixPaymentRequirementsSchema.safeParse(value).success) return { valid: true }
      const extra = (value as { extra?: { chargeId?: unknown } }).extra
      const chargeId = typeof extra?.chargeId === "string" ? extra.chargeId : CHARGE_ID
      const body = {
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: value, payload: { chargeId } },
        paymentRequirements: value,
      }
      // Every refusal below happens before the context is used.
      const result = await runChecks({} as Parameters<typeof runChecks>[0], body)
      if (result.ok) throw new Error("facilitator accepted invalid requirements")
      if (
        PaymentRequirementsSchema.safeParse(value).success ===
        (result.reason === "invalid_payload")
      ) {
        throw new Error("generic-schema validity and invalid_payload disagree")
      }
      return { valid: false, errorCode: result.reason }
    }
  }
}

export async function buildValidationVectors() {
  const out: unknown[] = []
  for (const c of cases) out.push({ ...c, expected: await expectedFor(c.type, c.value) })
  return {
    area: "validation",
    format: {
      types: {
        PaymentRequired:
          "checked by decoding PAYMENT-REQUIRED (client); any schema failure is invalid_header",
        SettlementResponse:
          "checked by decoding PAYMENT-RESPONSE (client); any schema failure is invalid_header",
        PaymentPayload:
          "checked by the paywall reading PAYMENT-SIGNATURE (HTTP 400, body {error}); not a PaymentPayload is invalid_header, a PaymentPayload that is not a p-x402 Pix payload is invalid_payload",
        PaymentRequirements:
          "checked against the p-x402 Pix profile by the facilitator's /verify and /settle (accepted = requirements = value); not x402 requirements at all is invalid_payload, another scheme or network is unsupported_scheme / unsupported_network, any other Pix profile failure is invalid_payment_requirements",
      },
      origin: ORIGIN,
    },
    cases: out,
  }
}
