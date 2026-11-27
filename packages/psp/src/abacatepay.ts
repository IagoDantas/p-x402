import { defaultFetch, type FetchLike, Px402Error } from "@p-x402/core"
import { z } from "zod"
import type {
  CreatePixChargeInput,
  PixCharge,
  PixChargeState,
  PixChargeStatus,
  PixProvider,
} from "./types"
import { parseAbacatePayWebhook } from "./webhook"

export interface AbacatePayProviderOptions {
  apiKey: string
  /** Secret AbacatePay sends in `X-Webhook-Secret`. Without it the provider has no `parseWebhook`. */
  webhookSecret?: string
  /** Default `https://api.abacatepay.com/v2`. */
  baseUrl?: string
  fetch?: FetchLike
  /** Per-request timeout. Default 5000. */
  timeoutMs?: number
}

export const ABACATEPAY_DEFAULT_BASE_URL = "https://api.abacatepay.com/v2"

// Only PAID means paid. APPROVED and REDEEMED are not documented well enough to trust.
const STATUS_MAP: Record<string, PixChargeStatus> = {
  PENDING: "PENDING",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  PAID: "PAID",
  UNDER_DISPUTE: "UNDER_DISPUTE",
  REFUNDED: "REFUNDED",
  FAILED: "FAILED",
}

export function mapAbacatePayStatus(status: string): PixChargeStatus {
  return Object.hasOwn(STATUS_MAP, status) ? (STATUS_MAP[status] ?? "UNKNOWN") : "UNKNOWN"
}

const isoDate = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)))

const CreateDataSchema = z.object({
  id: z.string().min(1).max(128),
  status: z.string(),
  brCode: z.string().min(1),
  brCodeBase64: z.string().nullish(),
  expiresAt: isoDate,
  amount: z.number().nullish(),
})

const CheckDataSchema = z.object({
  id: z.string().min(1).max(128),
  status: z.string(),
  expiresAt: isoDate.nullish(),
})

const EnvelopeSchema = z.object({ data: z.unknown(), error: z.unknown().optional() })

export function createAbacatePayProvider(options: AbacatePayProviderOptions): PixProvider {
  const apiKey = options.apiKey
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Px402Error("invalid_request", "abacatepay: apiKey is required")
  }
  const baseUrl = (options.baseUrl ?? ABACATEPAY_DEFAULT_BASE_URL).replace(/\/+$/, "")
  const fetchFn = options.fetch ?? defaultFetch
  const timeoutMs = options.timeoutMs ?? 5_000

  // Calls the API and returns the unwrapped `data`. Every failure is psp_error; the key never appears in errors.
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    }
    if (body !== undefined) headers["content-type"] = "application/json"
    const signal = AbortSignal.timeout(timeoutMs)
    // Enforce the deadline even when the injected fetch ignores the signal.
    const deadline = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    deadline.catch(() => {})
    const request = new Request(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // Never follow a redirect with the bearer key.
      redirect: "error",
    })
    let response: Response
    try {
      response = await Promise.race([fetchFn(request), deadline])
    } catch {
      throw new Px402Error(
        "psp_error",
        signal.aborted ? "abacatepay: request timed out" : "abacatepay: network error",
        { status: 0 },
      )
    }
    const status = response.status
    let json: unknown
    try {
      json = await Promise.race([response.json(), deadline])
    } catch {
      const reason = signal.aborted ? "timed out reading the body" : "invalid JSON"
      throw new Px402Error("psp_error", `abacatepay: HTTP ${status} ${reason}`, { status })
    }
    if (status < 200 || status > 299) {
      throw new Px402Error("psp_error", `abacatepay: HTTP ${status}`, { status })
    }
    const envelope = EnvelopeSchema.safeParse(json)
    if (!envelope.success) {
      throw new Px402Error("psp_error", "abacatepay: unexpected response shape", { status })
    }
    if (envelope.data.error !== undefined && envelope.data.error !== null) {
      throw new Px402Error("psp_error", "abacatepay: API returned an error", { status })
    }
    return envelope.data.data
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new Px402Error("psp_error", "abacatepay: unexpected response shape", { status: 200 })
    }
    return parsed.data
  }

  const provider: PixProvider = {
    name: "abacatepay",
    minAmount: 100,
    minExpiresIn: 300,

    async createCharge(input: CreatePixChargeInput): Promise<PixCharge> {
      const data = parse(
        CreateDataSchema,
        await call("POST", "/transparents/create", {
          method: "PIX",
          data: {
            amount: input.amount,
            expiresIn: input.expiresIn,
            description: input.description,
            externalId: input.externalId,
            metadata: input.metadata,
          },
        }),
      )
      if (data.amount !== undefined && data.amount !== null && data.amount !== input.amount) {
        throw new Px402Error("psp_error", "abacatepay: charge amount differs from the request", {
          status: 200,
        })
      }
      const charge: PixCharge = {
        id: data.id,
        status: mapAbacatePayStatus(data.status),
        amount: input.amount,
        brCode: data.brCode,
        expiresAt: data.expiresAt,
      }
      if (data.brCodeBase64) charge.brCodeBase64 = data.brCodeBase64
      return charge
    },

    async getCharge(id: string): Promise<PixChargeState> {
      const data = parse(
        CheckDataSchema,
        await call("GET", `/transparents/check?id=${encodeURIComponent(id)}`),
      )
      if (data.id !== id) {
        throw new Px402Error("psp_error", "abacatepay: check returned another charge", {
          status: 200,
        })
      }
      // TODO: map paidAt once the check response documents a payment time field.
      const state: PixChargeState = { id: data.id, status: mapAbacatePayStatus(data.status) }
      if (data.expiresAt) state.expiresAt = data.expiresAt
      return state
    },

    async simulatePayment(id: string): Promise<void> {
      await call("POST", `/transparents/simulate-payment?id=${encodeURIComponent(id)}`, {})
    },
  }

  const secret = options.webhookSecret
  if (secret !== undefined && secret.trim().length > 0) {
    provider.parseWebhook = (request) => parseAbacatePayWebhook(request, secret)
  }
  return provider
}
