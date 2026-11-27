import { bytesToBase64, Px402Error, timingSafeEqual } from "@p-x402/core"
import { z } from "zod"
import type { PixWebhookEvent, PixWebhookKind } from "./types"

export const WEBHOOK_SECRET_HEADER = "X-Webhook-Secret"
export const WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature"
/**
 * AbacatePay's fixed, public HMAC key (same for every account, published in their docs). The signature
 * proves the body was not altered; the secret proves who sent it. Checked against a real sandbox delivery.
 */
export const ABACATEPAY_WEBHOOK_PUBLIC_KEY =
  "t9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9"

const textEncoder = new TextEncoder()

/** Base64 HMAC-SHA256 of the raw body with AbacatePay's public key, as sent in `X-Webhook-Signature`. */
export async function signAbacatePayWebhook(rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(ABACATEPAY_WEBHOOK_PUBLIC_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(rawBody))),
  )
}

/** Webhook bodies above this size (in UTF-8 bytes) are refused. */
export const MAX_WEBHOOK_BYTES = 64 * 1024

const EVENT_KINDS: Record<string, PixWebhookKind> = {
  "transparent.completed": "paid",
  "transparent.disputed": "disputed",
  "transparent.refunded": "refunded",
}

/**
 * AbacatePay v2 envelope. Only the fields p-x402 reads are declared; zod strips the rest
 * (customer, payerInformation), so payer data never leaves this function.
 */
const EnvelopeSchema = z.object({
  id: z.string().min(1).max(256),
  event: z.string().min(1).max(128),
  data: z
    .object({
      transparent: z.object({ id: z.string().min(1).max(128) }).optional(),
    })
    .optional(),
})

/**
 * Parses an AbacatePay-shaped webhook. The secret in `X-Webhook-Secret` proves origin and is compared in
 * constant time. `X-Webhook-Signature` (HMAC with AbacatePay's public key) must match the raw body.
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
  if (textEncoder.encode(text).byteLength > MAX_WEBHOOK_BYTES) {
    throw new Px402Error("invalid_webhook_payload", "webhook body is too large")
  }
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? ""
  if (!(await timingSafeEqual(signature, await signAbacatePayWebhook(text)))) {
    throw new Px402Error("invalid_webhook_payload", "webhook signature does not match the body")
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
  // hasOwn: an event named "constructor" or "toString" must not resolve to a prototype member.
  const kind = Object.hasOwn(EVENT_KINDS, envelope.event)
    ? (EVENT_KINDS[envelope.event] ?? "other")
    : "other"
  const chargeId = envelope.data?.transparent?.id
  if (kind !== "other" && chargeId === undefined) {
    throw new Px402Error("invalid_webhook_payload", `${envelope.event} without data.transparent.id`)
  }
  return chargeId === undefined
    ? { id: envelope.id, kind, event: envelope.event }
    : { id: envelope.id, kind, event: envelope.event, chargeId }
}
