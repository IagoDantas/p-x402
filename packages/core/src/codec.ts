import type { z } from "zod"
import { bytesToBase64 } from "./crypto"
import { Px402Error } from "./errors"
import {
  type PaymentPayload,
  PaymentPayloadSchema,
  type PaymentRequired,
  PaymentRequiredSchema,
  type SettlementResponse,
  SettlementResponseSchema,
} from "./schemas"

/** Header values above this size are rejected before decoding. */
export const MAX_HEADER_BYTES = 16 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Standard base64 of the UTF-8 bytes of `JSON.stringify(value)`. */
export function encodeJsonHeader(value: unknown): string {
  return bytesToBase64(encoder.encode(JSON.stringify(value)))
}

/** Inverse of {@link encodeJsonHeader}. Throws `Px402Error("invalid_header")`. */
export function decodeJsonHeader(header: string): unknown {
  const value = header.trim()
  if (value.length === 0 || value.length > MAX_HEADER_BYTES) {
    throw new Px402Error("invalid_header", "header is empty or too large")
  }
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Px402Error("invalid_header", "header is not base64-encoded JSON")
  }
}

function decodeWith<S extends z.ZodType>(schema: S, header: string, what: string): z.infer<S> {
  const parsed = schema.safeParse(decodeJsonHeader(header))
  if (!parsed.success) {
    throw new Px402Error("invalid_header", `${what} does not match the schema`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    })
  }
  return parsed.data
}

export const encodePaymentRequired = (value: PaymentRequired): string => encodeJsonHeader(value)
export const decodePaymentRequired = (header: string): PaymentRequired =>
  decodeWith(PaymentRequiredSchema, header, "PAYMENT-REQUIRED")

export const encodePaymentPayload = (value: PaymentPayload): string => encodeJsonHeader(value)
export const decodePaymentPayload = (header: string): PaymentPayload =>
  decodeWith(PaymentPayloadSchema, header, "PAYMENT-SIGNATURE")

export const encodeSettlementResponse = (value: SettlementResponse): string =>
  encodeJsonHeader(value)
export const decodeSettlementResponse = (header: string): SettlementResponse =>
  decodeWith(SettlementResponseSchema, header, "PAYMENT-RESPONSE")
