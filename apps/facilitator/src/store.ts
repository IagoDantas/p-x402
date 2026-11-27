/** One Pix charge issued by the facilitator. Times are ms epoch; `expiresAt` is the PSP's ISO string. */
export interface ChargeRecord {
  id: string
  merchantId: string
  payTo: string
  /** Centavos, decimal string. */
  amount: string
  resourceUrl: string
  description?: string
  provider: string
  brCode: string
  brCodeBase64?: string
  expiresAt: string
  createdAt: number
  paidAt: number | null
  disputedAt: number | null
  refundedAt: number | null
  consumedAt: number | null
  /** Idempotency-Key of the settle that consumed the charge, if it sent one. */
  consumedKey: string | null
}

/** Webhook envelope ids older than this are pruned by recordWebhookEvent. */
export const WEBHOOK_EVENT_RETENTION_MS = 7 * 24 * 3600 * 1000

/** Persistence for charges and webhook de-duplication. Async so remote backends fit. */
export interface ChargeStore {
  /** Throws if the id already exists. */
  insert(record: ChargeRecord): Promise<void>
  get(id: string): Promise<ChargeRecord | undefined>
  /** Sets paidAt only when it is unset. */
  markPaid(id: string, at: number): Promise<void>
  /** Sets disputedAt only when it is unset. */
  markDisputed(id: string, at: number): Promise<void>
  /** Sets refundedAt only when it is unset. */
  markRefunded(id: string, at: number): Promise<void>
  /**
   * Atomically sets consumedAt and consumedKey (key or null) together; true only for the single
   * caller that set them. A disputed or refunded charge is never consumed (false).
   */
  consume(id: string, at: number, key?: string): Promise<boolean>
  /**
   * Insert-if-absent; false when the event id was already recorded. Also prunes events received
   * more than WEBHOOK_EVENT_RETENTION_MS before `at`.
   */
  recordWebhookEvent(eventId: string, at: number): Promise<boolean>
  /** Removes a recorded event id so a redelivery is processed again. No-op when absent. */
  forgetWebhookEvent(eventId: string): Promise<void>
}
