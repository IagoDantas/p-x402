/** Charge status as p-x402 understands it. Anything the PSP reports that is not clearly one of these is `UNKNOWN`. */
export type PixChargeStatus =
  | "PENDING"
  | "PAID"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED"
  | "UNDER_DISPUTE"
  | "REFUNDED"
  | "UNKNOWN"

export interface CreatePixChargeInput {
  /** Centavos. */
  amount: number
  /** Seconds until the charge expires. */
  expiresIn: number
  description?: string
  /** Facilitator-side id, echoed back by the PSP. */
  externalId: string
  metadata?: Record<string, string>
}

export interface PixCharge {
  id: string
  status: PixChargeStatus
  amount: number
  /** Pix copy-and-paste code (EMV). */
  brCode: string
  /** QR code image as a data URL, when the PSP provides one. */
  brCodeBase64?: string
  /** ISO 8601. */
  expiresAt: string
}

export interface PixChargeState {
  id: string
  status: PixChargeStatus
  expiresAt?: string
  /** ISO 8601 payment time, only when the PSP reports one. */
  paidAt?: string
}

export type PixWebhookKind = "paid" | "disputed" | "refunded" | "other"

/** A parsed webhook. Payer data (name, tax id) is never part of it. */
export interface PixWebhookEvent {
  /** Envelope id; repeats on automatic retries, used for de-duplication. */
  id: string
  kind: PixWebhookKind
  /** Raw event name, e.g. `transparent.completed`. */
  event: string
  chargeId?: string
}

export interface PixProvider {
  readonly name: string
  /** Smallest amount the PSP accepts, in centavos. */
  readonly minAmount: number
  /** Smallest `expiresIn` the PSP accepts, in seconds. */
  readonly minExpiresIn: number
  /** Throws `Px402Error("psp_error")` on failure. */
  createCharge(input: CreatePixChargeInput): Promise<PixCharge>
  /** Asks the PSP for the current status. Throws `Px402Error("psp_error")` on any failure. */
  getCharge(id: string): Promise<PixChargeState>
  /** Test mode only. */
  simulatePayment?(id: string): Promise<void>
  /**
   * Authenticates and parses a webhook request.
   * Throws `Px402Error("invalid_webhook_secret")` or `Px402Error("invalid_webhook_payload")`.
   */
  parseWebhook?(request: Request): Promise<PixWebhookEvent>
}
