import { type ChargeRecord, type ChargeStore, WEBHOOK_EVENT_RETENTION_MS } from "../store"

/** Old webhook event ids are swept at most once per this many inserts. */
const SWEEP_EVERY = 1000

/** In-process store. Every mutation is synchronous inside the call, so check-and-set is atomic. */
export function memoryStore(): ChargeStore {
  const charges = new Map<string, ChargeRecord>()
  const events = new Map<string, number>()
  let insertsSinceSweep = 0

  function setOnce(
    id: string,
    field: "paidAt" | "disputedAt" | "refundedAt" | "consumedAt",
    at: number,
  ): ChargeRecord | undefined {
    const record = charges.get(id)
    if (!record || record[field] !== null) return undefined
    record[field] = at
    return record
  }

  function sweep(at: number) {
    const cutoff = at - WEBHOOK_EVENT_RETENTION_MS
    for (const [id, receivedAt] of events) {
      if (receivedAt < cutoff) events.delete(id)
    }
  }

  return {
    async insert(record) {
      if (charges.has(record.id)) throw new Error(`charge ${record.id} already exists`)
      charges.set(record.id, { ...record })
    },
    async get(id) {
      const record = charges.get(id)
      return record ? { ...record } : undefined
    },
    async markPaid(id, at) {
      setOnce(id, "paidAt", at)
    },
    async markDisputed(id, at) {
      setOnce(id, "disputedAt", at)
    },
    async markRefunded(id, at) {
      setOnce(id, "refundedAt", at)
    },
    async consume(id, at, key) {
      const record = setOnce(id, "consumedAt", at)
      if (!record) return false
      record.consumedKey = key ?? null
      return true
    },
    async recordWebhookEvent(eventId, at) {
      const seenAt = events.get(eventId)
      // An id past retention counts as new even before the next sweep removes it.
      if (seenAt !== undefined && seenAt >= at - WEBHOOK_EVENT_RETENTION_MS) return false
      events.set(eventId, at)
      if (++insertsSinceSweep >= SWEEP_EVERY) {
        insertsSinceSweep = 0
        sweep(at)
      }
      return true
    },
    async forgetWebhookEvent(eventId) {
      events.delete(eventId)
    },
  }
}
