import type { ChargeRecord, ChargeStore } from "../store"

/** In-process store. Every mutation is synchronous inside the call, so check-and-set is atomic. */
export function memoryStore(): ChargeStore {
  const charges = new Map<string, ChargeRecord>()
  const events = new Map<string, number>()

  function setOnce(
    id: string,
    field: "paidAt" | "disputedAt" | "refundedAt" | "consumedAt",
    at: number,
  ): boolean {
    const record = charges.get(id)
    if (!record || record[field] !== null) return false
    record[field] = at
    return true
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
    async consume(id, at) {
      return setOnce(id, "consumedAt", at)
    },
    async recordWebhookEvent(eventId, at) {
      if (events.has(eventId)) return false
      events.set(eventId, at)
      return true
    },
  }
}
