export const X402_VERSION = 2
export const PIX_SCHEME = "exact"
export const PIX_NETWORK = "pix:br"
export const PIX_ASSET = "BRL"
export const PIX_PAYMENT_FLOW = "upfront"
export const PIX_ASSET_TRANSFER_METHOD = "pix-charge"

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE"
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"

/** Charges live this long. AbacatePay's minimum `expiresIn`. */
export const CHARGE_TTL_SECONDS = 300
/** A paid charge can still be consumed this long after payment, even past its expiry. */
export const PAID_GRACE_SECONDS = 86_400
/** Retry-After sent with `settlement_pending`. */
export const SETTLEMENT_PENDING_RETRY_AFTER_SECONDS = 2
