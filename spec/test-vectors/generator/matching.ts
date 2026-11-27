import { matchPixRequirements, type PaymentRequirements } from "@p-x402/core"
import { ORIGIN, pixRequirements } from "../fixtures"

interface Case {
  id: string
  description: string
  accepted: PaymentRequirements
  required: PaymentRequirements
}

const base = pixRequirements()
const extra = base.extra as Record<string, unknown>
const change = (patch: Partial<PaymentRequirements>): PaymentRequirements => ({ ...base, ...patch })
const changeExtra = (patch: Record<string, unknown>): PaymentRequirements => ({
  ...base,
  extra: { ...extra, ...patch },
})
const dropExtra = (key: string): PaymentRequirements => {
  const { [key]: _drop, ...rest } = extra
  return { ...base, extra: rest }
}

const cases: Case[] = [
  { id: "match/identical", description: "same requirements", accepted: base, required: base },
  {
    id: "match/dynamic-keys-differ",
    description: "chargeId, brCode, brCodeBase64 and expiresAt are not compared here",
    accepted: changeExtra({
      chargeId: "pix_char_vector_0002",
      brCode: "000201",
      brCodeBase64: "iVBORw0KGgo=",
      expiresAt: "2026-11-25T15:10:00.000Z",
    }),
    required: base,
  },
  {
    id: "match/asset-transfer-method-default",
    description: "a missing assetTransferMethod counts as pix-charge on either side",
    accepted: dropExtra("assetTransferMethod"),
    required: base,
  },
  {
    id: "match/extra-key-only-in-accepted",
    description: "extra keys only the client sent are ignored",
    accepted: changeExtra({ clientNote: "x" }),
    required: base,
  },
  {
    id: "match/amount",
    description: "amount differs",
    accepted: change({ amount: "400" }),
    required: base,
  },
  {
    id: "match/pay-to",
    description: "payee differs",
    accepted: change({ payTo: "outra-loja" }),
    required: base,
  },
  {
    id: "match/amount-before-pay-to",
    description: "amount is checked before payTo",
    accepted: change({ amount: "400", payTo: "outra-loja" }),
    required: base,
  },
  {
    id: "match/scheme",
    description: "scheme differs",
    accepted: change({ scheme: "upto" }),
    required: base,
  },
  {
    id: "match/network",
    description: "network differs",
    accepted: change({ network: "pix:sandbox" }),
    required: base,
  },
  {
    id: "match/asset",
    description: "asset differs",
    accepted: change({ asset: "USD" }),
    required: base,
  },
  {
    id: "match/max-timeout",
    description: "maxTimeoutSeconds differs",
    accepted: change({ maxTimeoutSeconds: 600 }),
    required: base,
  },
  {
    id: "match/resource",
    description: "resourceUrl differs",
    accepted: changeExtra({ resourceUrl: `${ORIGIN}/outro-relatorio` }),
    required: base,
  },
  {
    id: "match/resource-before-provider",
    description: "resourceUrl is checked before the other extra keys",
    accepted: changeExtra({ resourceUrl: `${ORIGIN}/outro-relatorio`, provider: "abacatepay" }),
    required: base,
  },
  {
    id: "match/provider",
    description: "extra.provider differs",
    accepted: changeExtra({ provider: "abacatepay" }),
    required: base,
  },
  {
    id: "match/payment-flow",
    description: "extra.paymentFlow differs",
    accepted: changeExtra({ paymentFlow: "deferred" }),
    required: base,
  },
  {
    id: "match/server-extra-key-missing",
    description: "a non-dynamic extra key the server declared is missing from accepted",
    accepted: base,
    required: changeExtra({ tier: "premium" }),
  },
  {
    id: "match/amount-string-vs-number",
    description: 'amounts compare as strings: "500" and "0500" differ',
    accepted: change({ amount: "0500" }),
    required: base,
  },
]

export function buildMatchingVectors() {
  return {
    area: "requirement-matching",
    format: {
      function:
        "matchPixRequirements(accepted, required): accepted is what the client put in PAYMENT-SIGNATURE, required is what the server requires now",
      order:
        "amount, payTo, scheme, network, asset, maxTimeoutSeconds, extra.resourceUrl, then every non-dynamic key of required.extra in its order; the first difference wins",
      equality:
        "core fields compare with ===; extra values compare by their JSON text; a missing assetTransferMethod is pix-charge",
      dynamicExtraKeys: ["chargeId", "brCode", "brCodeBase64", "expiresAt"],
      note: "these cases test the function alone; in the facilitator, a scheme or network other than exact / pix:br on either side is refused as unsupported_scheme / unsupported_network before this function runs",
    },
    cases: cases.map((c) => ({ ...c, expected: matchPixRequirements(c.accepted, c.required) })),
  }
}
