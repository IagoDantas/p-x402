import type { FetchLike } from "@p-x402/core"
import type { ChargeStore } from "@p-x402/facilitator"
import { clock, type DemoHub, type FacilitatorCallEvent } from "./hub"

/**
 * Wraps the facilitator's store so the demo hears about PSP confirmations and settlements no matter
 * how they arrive (webhook, /verify or /settle observing the PSP). Behaviour is unchanged.
 */
export function observedStore(inner: ChargeStore, hub: DemoHub): ChargeStore {
  return {
    insert: (record) => inner.insert(record),
    get: (id) => inner.get(id),
    async markPaid(id, at) {
      await inner.markPaid(id, at)
      const record = await inner.get(id)
      if (record?.paidAt != null) hub.paid(id, Number(record.amount))
    },
    markDisputed: (id, at) => inner.markDisputed(id, at),
    markRefunded: (id, at) => inner.markRefunded(id, at),
    async consume(id, at, key) {
      const consumed = await inner.consume(id, at, key)
      if (consumed) {
        const record = await inner.get(id)
        if (record) hub.settled(id, Number(record.amount))
      }
      return consumed
    },
    recordWebhookEvent: (eventId, at) => inner.recordWebhookEvent(eventId, at),
    forgetWebhookEvent: (eventId) => inner.forgetWebhookEvent(eventId),
  }
}

const OBSERVED_PATHS = new Set(["/pix/charges", "/verify", "/settle"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function pick(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * Wraps the seller's fetch to the facilitator and publishes one event per /pix/charges, /verify and
 * /settle call, with its outcome and duration. Requests and responses pass through untouched.
 */
export function observedFetch(inner: FetchLike, hub: DemoHub): FetchLike {
  return async (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "")
    if (!OBSERVED_PATHS.has(path)) return inner(request)
    const requestBody: unknown = await request
      .clone()
      .json()
      .catch(() => undefined)
    const startedAt = clock()
    const response = await inner(request)
    const durationMs = clock() - startedAt
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => undefined)

    let chargeId = str(pick(requestBody, "paymentPayload", "payload", "chargeId"))
    let ok = false
    let reason: string | undefined
    if (path === "/pix/charges") {
      chargeId = str(pick(body, "paymentRequirements", "extra", "chargeId"))
      ok = chargeId !== undefined
      reason = str(pick(body, "error"))
    } else if (path === "/verify") {
      ok = pick(body, "isValid") === true
      reason = str(pick(body, "invalidReason"))
    } else {
      ok = pick(body, "success") === true
      reason = str(pick(body, "errorReason"))
    }

    const event: FacilitatorCallEvent = {
      type: "facilitator",
      path: path as FacilitatorCallEvent["path"],
      status: response.status,
      ok,
      startedAt,
      durationMs,
      at: clock(),
    }
    if (chargeId !== undefined) event.chargeId = chargeId
    if (reason !== undefined) event.reason = reason
    hub.publish(event)
    return response
  }
}
