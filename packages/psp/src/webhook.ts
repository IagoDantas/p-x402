import { Px402Error, timingSafeEqual } from "@p-x402/core"
import { z } from "zod"
import type { PixWebhookEvent, PixWebhookKind } from "./types"

export const WEBHOOK_SECRET_HEADER = "X-Webhook-Secret"
/** Webhook bodies above this size are refused unread. */
export const MAX_WEBHOOK_BYTES = 64 * 1024

const EVENT_KINDS: Record<string, PixWebhookKind> = {
  "transparent.completed": "paid",
  "transparent.disputed": "disputed",
  "transparent.refunded": "refunded",
}

/** AbacatePay v2 envelope. Only the fields p-x402 reads are declared; the rest (customer, payerInformation) is dropped. */
const EnvelopeSchema = z.object({
  id: z.string().min(1).max(256),
  event: z.string().min(1).max(128),
  apiVersion: z.union([z.number(), z.string()]).optional(),
  devMode: z.boolean().optional(),
  data: z
    .object({
      transparent: z.object({ id: z.string().min(1).max(128) }).optional(),
    })
    .optional(),
})

/**
 * Parses an AbacatePay-shaped webhook. The secret in `X-Webhook-Secret` proves origin and is compared in
 * constant time. `X-Webhook-Signature` only proves integrity with a public key, so it is not checked here.
 */
export async function parseAbacatePayWebhook(
  request: Request,
  secret: string,
): Promise<PixWebhookEvent> {
  if (secret.length === 0) {
    throw new Px402Error("invalid_webhook_secret", "webhook secret is not configured")
  }
  const given = request.headers.get(WEBHOOK_SECRET_HEADER) ?? ""
  if (!(await timingSafeEqual(given, secret))) {
    throw new Px402Error("invalid_webhook_secret", "webhook secret does not match")
  }
  const length = Number(request.headers.get("content-length") ?? "0")
  if (length > MAX_WEBHOOK_BYTES) {
    throw new Px402Error("invalid_webhook_payload", "webhook body is too large")
  }
  const text = await request.text()
  if (text.length > MAX_WEBHOOK_BYTES) {
    throw new Px402Error("invalid_webhook_payload", "webhook body is too large")
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Px402Error("invalid_webhook_payload", "webhook body is not JSON")
  }
  const parsed = EnvelopeSchema.safeParse(json)
  if (!parsed.success) {
    throw new Px402Error("invalid_webhook_payload", "webhook envelope has an unexpected shape")
  }
  const envelope = parsed.data
  const kind = EVENT_KINDS[envelope.event] ?? "other"
  const chargeId = envelope.data?.transparent?.id
  if (kind !== "other" && chargeId === undefined) {
    throw new Px402Error("invalid_webhook_payload", `${envelope.event} without data.transparent.id`)
  }
  return chargeId === undefined
    ? { id: envelope.id, kind, event: envelope.event }
    : { id: envelope.id, kind, event: envelope.event, chargeId }
}
