import { PX402_ERROR_CODES } from "@p-x402/core"

type Group = "protocol" | "verify-settle" | "infrastructure" | "webhook" | "client"

/**
 * One line per code. Codes that exist only on other branches are listed too so that merging them
 * only needs `bun run vectors`; only codes in PX402_ERROR_CODES are written out.
 */
const MEANINGS: Record<string, [Group, string]> = {
  invalid_header: [
    "protocol",
    "a payment header is not standard base64 of UTF-8 JSON, or fails its schema",
  ],
  invalid_payload: [
    "protocol",
    "a request body or PAYMENT-SIGNATURE is readable but is not a valid p-x402 Pix payload",
  ],
  invalid_payment_requirements: [
    "protocol",
    "requirements are x402 but break the p-x402 Pix profile (client: BR Code check failed)",
  ],
  invalid_x402_version: ["protocol", "x402Version is not 2"],
  unsupported_scheme: ["protocol", "scheme is not exact"],
  unsupported_network: ["protocol", "network is not pix:br"],
  invalid_request: ["protocol", "a request to the facilitator or a paywall route is malformed"],
  method_not_payable: ["protocol", "HEAD and OPTIONS requests never create or settle a charge"],
  charge_not_found: ["verify-settle", "the facilitator has no charge with this chargeId"],
  merchant_mismatch: ["verify-settle", "the charge belongs to another merchant"],
  amount_mismatch: [
    "verify-settle",
    "accepted amount differs from the required amount or the charge record",
  ],
  pay_to_mismatch: [
    "verify-settle",
    "accepted payTo differs from the required payee or the charge record",
  ],
  resource_mismatch: [
    "verify-settle",
    "accepted resourceUrl differs from the requested resource or the charge record",
  ],
  requirements_mismatch: [
    "verify-settle",
    "another requirements field (scheme, network, asset, timeout, extra key, chargeId) differs",
  ],
  settlement_pending: [
    "verify-settle",
    "the Pix payment is not confirmed yet; retry after Retry-After seconds",
  ],
  charge_expired: [
    "verify-settle",
    "the charge expired unpaid, or was paid longer ago than the grace period",
  ],
  charge_failed: ["verify-settle", "the PSP reports the charge cancelled or failed"],
  charge_disputed: ["verify-settle", "the payment is under dispute (MED)"],
  charge_refunded: ["verify-settle", "the payment was refunded"],
  charge_already_consumed: ["verify-settle", "the paid charge was already used for a request"],
  unauthorized: [
    "infrastructure",
    "the merchant token sent to the facilitator is missing or wrong",
  ],
  rate_limited: ["infrastructure", "too many charges created for this client or merchant"],
  psp_error: ["infrastructure", "the Pix provider failed or answered something unusable"],
  facilitator_error: [
    "infrastructure",
    "the paywall could not get a usable answer from the facilitator",
  ],
  unexpected_error: ["infrastructure", "an internal error with no more specific code"],
  invalid_webhook_secret: ["webhook", "the PSP webhook secret or signature is wrong"],
  invalid_webhook_payload: ["webhook", "the PSP webhook body is unreadable"],
  webhook_retry: [
    "webhook",
    "the webhook was valid but could not be processed now; the PSP should retry",
  ],
  policy_exceeded: [
    "client",
    "the client's spending policy or a safety check refused to pay (see reason)",
  ],
  no_supported_requirements: ["client", "the 402 offers no valid p-x402 Pix option"],
  payment_timeout: ["client", "the client gave up waiting for settlement"],
  payer_failed: [
    "client",
    "the payer threw while paying; the signature is kept so the request can be resumed",
  ],
  payment_rejected: [
    "client",
    "the server refused the paid request with a reason that is not a p-x402 code",
  ],
}

export function buildErrorCodeVectors() {
  const codes = PX402_ERROR_CODES.map((code) => {
    const meaning = MEANINGS[code]
    if (!meaning) throw new Error(`error code ${code} has no meaning in generator/error-codes.ts`)
    return { code, group: meaning[0], meaning: meaning[1] }
  })
  return {
    area: "error-codes",
    format: {
      stability: "codes are public API: never renamed or reused; new codes may be added",
      whereTheyAppear:
        "errorReason in PAYMENT-RESPONSE, invalidReason / errorReason in facilitator answers, error in JSON error bodies, and the code of errors a client raises (group client codes never go on the wire)",
      unknownCodes:
        "a client that receives an errorReason it does not know treats it as payment_rejected",
    },
    codes,
  }
}
