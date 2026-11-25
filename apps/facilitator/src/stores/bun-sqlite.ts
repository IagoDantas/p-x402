import { Database } from "bun:sqlite"
import type { ChargeRecord, ChargeStore } from "../store"

interface Row {
  id: string
  merchant_id: string
  pay_to: string
  amount: string
  resource_url: string
  description: string | null
  provider: string
  br_code: string
  br_code_base64: string | null
  expires_at: string
  created_at: number
  paid_at: number | null
  disputed_at: number | null
  refunded_at: number | null
  consumed_at: number | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  description TEXT,
  provider TEXT NOT NULL,
  br_code TEXT NOT NULL,
  br_code_base64 TEXT,
  expires_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  disputed_at INTEGER,
  refunded_at INTEGER,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
`

function toRecord(row: Row): ChargeRecord {
  const record: ChargeRecord = {
    id: row.id,
    merchantId: row.merchant_id,
    payTo: row.pay_to,
    amount: row.amount,
    resourceUrl: row.resource_url,
    provider: row.provider,
    brCode: row.br_code,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    disputedAt: row.disputed_at,
    refundedAt: row.refunded_at,
    consumedAt: row.consumed_at,
  }
  if (row.description !== null) record.description = row.description
  if (row.br_code_base64 !== null) record.brCodeBase64 = row.br_code_base64
  return record
}

/** SQLite store (bun:sqlite). Pass ":memory:" for tests. */
export function bunSqliteStore(path: string): ChargeStore {
  const db = new Database(path, { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run(SCHEMA)

  const insert = db.query(
    `INSERT INTO charges (id, merchant_id, pay_to, amount, resource_url, description, provider, br_code,
       br_code_base64, expires_at, created_at, paid_at, disputed_at, refunded_at, consumed_at)
     VALUES ($id, $merchantId, $payTo, $amount, $resourceUrl, $description, $provider, $brCode,
       $brCodeBase64, $expiresAt, $createdAt, $paidAt, $disputedAt, $refundedAt, $consumedAt)`,
  )
  const select = db.query<Row, { id: string }>("SELECT * FROM charges WHERE id = $id")
  const setOnce = (column: string) =>
    db.query(`UPDATE charges SET ${column} = $at WHERE id = $id AND ${column} IS NULL`)
  const paid = setOnce("paid_at")
  const disputed = setOnce("disputed_at")
  const refunded = setOnce("refunded_at")
  const consumed = setOnce("consumed_at")
  const event = db.query("INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES ($id, $at)")

  return {
    async insert(r) {
      insert.run({
        id: r.id,
        merchantId: r.merchantId,
        payTo: r.payTo,
        amount: r.amount,
        resourceUrl: r.resourceUrl,
        description: r.description ?? null,
        provider: r.provider,
        brCode: r.brCode,
        brCodeBase64: r.brCodeBase64 ?? null,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        disputedAt: r.disputedAt,
        refundedAt: r.refundedAt,
        consumedAt: r.consumedAt,
      })
    },
    async get(id) {
      const row = select.get({ id })
      return row ? toRecord(row) : undefined
    },
    async markPaid(id, at) {
      paid.run({ id, at })
    },
    async markDisputed(id, at) {
      disputed.run({ id, at })
    },
    async markRefunded(id, at) {
      refunded.run({ id, at })
    },
    async consume(id, at) {
      return consumed.run({ id, at }).changes === 1
    },
    async recordWebhookEvent(eventId, at) {
      return event.run({ id: eventId, at }).changes === 1
    },
  }
}
