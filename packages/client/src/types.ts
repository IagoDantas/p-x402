import type { FetchLike } from "@p-x402/core"

/** What a payer receives. Contract: never pay more than `amount` (centavos). */
export interface PixChargeToPay {
  chargeId: string
  /** Centavos, positive integer string. */
  amount: string
  brCode: string
  brCodeBase64?: string
  expiresAt: string
  resourceUrl: string
}

export interface PixPayer {
  pay(charge: PixChargeToPay): Promise<void>
  /**
   * False only for payers that never pay the BR Code itself (such as `simulatePayer`, which marks the
   * charge paid by id). The client then skips the BR Code amount check, which exists to stop a payer
   * from paying a code whose amount differs from the advertised one. Default true.
   */
  readonly paysBrCode?: boolean
  /**
   * A dynamic BR Code (its Pix merchant-account template carries a location URL) carries its real amount in the payload behind
   * that URL; the bank pays that amount, not tag 54. The client cannot check it offline, so it
   * refuses dynamic codes unless the payer sets this to true and itself refuses to pay a resolved
   * amount above `amount`. Default false.
   */
  readonly checksDynamicAmount?: boolean
}

export interface PaymentEvent {
  chargeId: string
  amount: string
  resourceUrl: string
  /** The PAYMENT-SIGNATURE header value; lets a caller resume after a crash. */
  paymentSignature: string
}

export interface PaymentPolicy {
  /** Centavos. Default 1000 (R$ 10,00). */
  maxPerRequest?: number
  /** Centavos, over the lifetime of the wrapped fetch. Default 5000 (R$ 50,00). */
  maxTotal?: number
  /** Full origins ("https://api.x.com") or hosts ("api.x.com", "localhost:3000"). Unset = any origin. */
  allowedOrigins?: string[]
}

export interface RetryOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  factor?: number
  /**
   * Cap on how long a paid request keeps retrying settlement_pending, on top of the charge's
   * expiresAt (which the server sets). Default 600000 (10 min).
   */
  maxWaitMs?: number
}

export interface WrapFetchOptions {
  payer: PixPayer
  policy?: PaymentPolicy
  onPayment?: (event: PaymentEvent) => void
  retry?: RetryOptions
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** A fetch that pays Pix 402s. `spent` is the total reserved or paid so far, in centavos. */
export type PaidFetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  readonly spent: number
}

export type { FetchLike }
