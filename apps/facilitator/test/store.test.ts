import { describe, expect, test } from "bun:test"
import { type ChargeRecord, type ChargeStore, WEBHOOK_EVENT_RETENTION_MS } from "../src/store"
import { bunSqliteStore } from "../src/stores/bun-sqlite"
import { memoryStore } from "../src/stores/memory"

function record(id: string): ChargeRecord {
  return {
    id,
    merchantId: "loja1",
    payTo: "loja1",
    amount: "500",
    resourceUrl: "https://api.example/relatorio",
    description: "Relatório",
    provider: "mock",
    brCode: "000201",
    expiresAt: "2026-11-25T15:05:00.000Z",
    createdAt: 1000,
    paidAt: null,
    disputedAt: null,
    refundedAt: null,
    consumedAt: null,
    consumedKey: null,
  }
}

const backends: [string, () => ChargeStore][] = [
  ["memoryStore", memoryStore],
  ["bunSqliteStore(:memory:)", () => bunSqliteStore(":memory:")],
]

for (const [name, make] of backends) {
  describe(`ChargeStore contract: ${name}`, () => {
    test("insert and get round-trip; unknown id is undefined", async () => {
      const store = make()
      await store.insert(record("c1"))
      expect(await store.get("c1")).toEqual(record("c1"))
      expect(await store.get("nope")).toBeUndefined()
      const bare = record("c2")
      delete bare.description
      await store.insert(bare)
      expect(await store.get("c2")).toEqual(bare)
    })

    test("insert rejects a duplicate id", async () => {
      const store = make()
      await store.insert(record("c1"))
      await expect(store.insert(record("c1"))).rejects.toThrow()
    })

    test("get returns a copy", async () => {
      const store = make()
      await store.insert(record("c1"))
      const got = await store.get("c1")
      if (got) got.paidAt = 5
      expect((await store.get("c1"))?.paidAt).toBeNull()
    })

    test("markPaid, markDisputed, markRefunded never overwrite", async () => {
      const store = make()
      await store.insert(record("c1"))
      await store.markPaid("c1", 2000)
      await store.markPaid("c1", 3000)
      await store.markDisputed("c1", 4000)
      await store.markDisputed("c1", 5000)
      await store.markRefunded("c1", 6000)
      await store.markRefunded("c1", 7000)
      const got = await store.get("c1")
      expect(got?.paidAt).toBe(2000)
      expect(got?.disputedAt).toBe(4000)
      expect(got?.refundedAt).toBe(6000)
    })

    test("consume succeeds exactly once, including two concurrent calls", async () => {
      const store = make()
      await store.insert(record("c1"))
      await store.insert(record("c2"))
      expect(await store.consume("c1", 10)).toBe(true)
      expect(await store.consume("c1", 11)).toBe(false)
      expect((await store.get("c1"))?.consumedAt).toBe(10)
      const results = await Promise.all([store.consume("c2", 20), store.consume("c2", 21)])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await store.consume("missing", 1)).toBe(false)
    })

    test("consume stores the idempotency key atomically with consumedAt", async () => {
      const store = make()
      await store.insert(record("c1"))
      await store.insert(record("c2"))
      expect(await store.consume("c1", 10, "key-A_1")).toBe(true)
      // a losing call never overwrites the stored key
      expect(await store.consume("c1", 11, "key-B")).toBe(false)
      const got = await store.get("c1")
      expect(got?.consumedAt).toBe(10)
      expect(got?.consumedKey).toBe("key-A_1")
      // no key → null
      expect(await store.consume("c2", 12)).toBe(true)
      expect((await store.get("c2"))?.consumedKey).toBeNull()
      // concurrent consumers with different keys: the winner's key is stored
      await store.insert(record("c3"))
      const [a, b] = await Promise.all([
        store.consume("c3", 20, "k1"),
        store.consume("c3", 21, "k2"),
      ])
      expect([a, b].filter(Boolean)).toHaveLength(1)
      expect((await store.get("c3"))?.consumedKey).toBe(a ? "k1" : "k2")
    })

    test("recordWebhookEvent de-duplicates by event id", async () => {
      const store = make()
      expect(await store.recordWebhookEvent("log_1", 1)).toBe(true)
      expect(await store.recordWebhookEvent("log_1", 2)).toBe(false)
      expect(await store.recordWebhookEvent("log_2", 3)).toBe(true)
    })

    test("forgetWebhookEvent lets the same id be recorded again", async () => {
      const store = make()
      expect(await store.recordWebhookEvent("log_1", 1)).toBe(true)
      await store.forgetWebhookEvent("log_1")
      expect(await store.recordWebhookEvent("log_1", 2)).toBe(true)
      expect(await store.recordWebhookEvent("log_1", 3)).toBe(false)
      await store.forgetWebhookEvent("never-seen")
    })

    test("recordWebhookEvent prunes events older than 7 days (within 1000 inserts)", async () => {
      const store = make()
      const t0 = 1_000_000
      expect(await store.recordWebhookEvent("log_old", t0)).toBe(true)
      expect(await store.recordWebhookEvent("log_recent", t0 + 1000)).toBe(true)
      const later = t0 + WEBHOOK_EVENT_RETENTION_MS + 1
      for (let i = 0; i < 1000; i++) {
        expect(await store.recordWebhookEvent(`log_${i}`, later)).toBe(true)
      }
      // log_old is past retention and was swept; log_recent is exactly at the edge and kept
      expect(await store.recordWebhookEvent("log_old", later)).toBe(true)
      expect(await store.recordWebhookEvent("log_recent", later)).toBe(false)
      expect(await store.recordWebhookEvent("log_5", later)).toBe(false)
    })

    test("an event id past retention is recorded as new right away", async () => {
      const store = make()
      const t0 = 1_000_000
      expect(await store.recordWebhookEvent("log_a", t0)).toBe(true)
      expect(await store.recordWebhookEvent("log_a", t0 + WEBHOOK_EVENT_RETENTION_MS)).toBe(false)
      const later = t0 + WEBHOOK_EVENT_RETENTION_MS + 1
      expect(await store.recordWebhookEvent("log_a", later)).toBe(true)
      expect(await store.recordWebhookEvent("log_a", later + 1)).toBe(false)
    })
  })
}
