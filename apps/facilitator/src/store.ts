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
}

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
  /** Atomically sets consumedAt; true only for the single caller that set it. */
  consume(id: string, at: number): Promise<boolean>
  /** Insert-if-absent; false when the event id was already recorded. */
  recordWebhookEvent(eventId: string, at: number): Promise<boolean>
}
