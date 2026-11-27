export const PX402_ERROR_CODES = [
  // protocol and input
  "invalid_header",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_x402_version",
  "unsupported_scheme",
  "unsupported_network",
  "invalid_request",
  "method_not_payable",
  // verify and settle
  "charge_not_found",
  "merchant_mismatch",
  "amount_mismatch",
  "pay_to_mismatch",
  "resource_mismatch",
  "requirements_mismatch",
  "settlement_pending",
  "charge_expired",
  "charge_failed",
  "charge_disputed",
  "charge_refunded",
  "charge_already_consumed",
  // infrastructure
  "unauthorized",
  "rate_limited",
  "psp_error",
  "facilitator_error",
  "unexpected_error",
  // webhook
  "invalid_webhook_secret",
  "invalid_webhook_payload",
  "webhook_retry",
  // client
  "policy_exceeded",
  "no_supported_requirements",
  "payment_timeout",
  "payer_failed",
  "payment_rejected",
] as const

export type Px402ErrorCode = (typeof PX402_ERROR_CODES)[number]

const CODE_SET: ReadonlySet<string> = new Set(PX402_ERROR_CODES)

export function isPx402ErrorCode(value: unknown): value is Px402ErrorCode {
  return typeof value === "string" && CODE_SET.has(value)
}

/** Error with a stable `code`. Codes are public API: never rename one. */
export class Px402Error extends Error {
  override readonly name = "Px402Error"
  readonly code: Px402ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: Px402ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code)
    this.code = code
    this.details = details
  }
}

/** JSON body of an HTTP error answered by the facilitator or the paywall. */
export interface ErrorBody {
  error: Px402ErrorCode
  message?: string
}

export function errorBody(error: Px402ErrorCode, message?: string): ErrorBody {
  return message === undefined ? { error } : { error, message }
}

export function isPx402Error(value: unknown): value is Px402Error {
  return value instanceof Px402Error
}
