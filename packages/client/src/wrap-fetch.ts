import {
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  encodePaymentPayload,
  type FetchLike,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isPx402ErrorCode,
  type PaymentRequired,
  type PaymentRequirements,
  PixPaymentPayloadSchema,
  type PixPaymentRequirements,
  PixPaymentRequirementsSchema,
  Px402Error,
  parseBrCode,
  X402_VERSION,
} from "@p-x402/core"
import type { PaidFetch, WrapFetchOptions } from "./types"

const DEFAULT_MAX_PER_REQUEST = 1000
const DEFAULT_MAX_TOTAL = 5000
/** Longest a paid request keeps polling settlement_pending, whatever expiresAt says. */
const DEFAULT_MAX_WAIT_MS = 10 * 60_000

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Wraps a fetch so Pix 402 responses are paid (within policy) and the request is retried with
 * PAYMENT-SIGNATURE until the server accepts it. The returned function has a `spent` getter
 * (centavos reserved or paid so far; never decreases).
 */
export function wrapFetch(fetchImpl: FetchLike, options: WrapFetchOptions): PaidFetch {
  const { payer, onPayment } = options
  const maxPerRequest = options.policy?.maxPerRequest ?? DEFAULT_MAX_PER_REQUEST
  const maxTotal = options.policy?.maxTotal ?? DEFAULT_MAX_TOTAL
  const allowedOrigins = options.policy?.allowedOrigins
  const initialDelayMs = options.retry?.initialDelayMs ?? 500
  const maxDelayMs = options.retry?.maxDelayMs ?? 5000
  const factor = options.retry?.factor ?? 2
  const maxWaitMs = options.retry?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const sleep = options.sleep ?? realSleep
  const now = options.now ?? Date.now
  let spent = 0

  async function retryLoop(
    request: Request,
    paymentSignature: string,
    chargeId: string,
    deadline: number,
  ): Promise<Response> {
    const details = { chargeId, paymentSignature }
    // The server sets expiresAt and Retry-After; never wait on them longer than maxWaitMs.
    const expiry = Number.isNaN(deadline) ? Number.NEGATIVE_INFINITY : deadline
    const cap = now() + maxWaitMs
    const until = Math.min(expiry, cap)
    // What ends the wait: the charge's expiry, our own cap, or not knowing the expiry at all.
    const timeoutReason =
      expiry === Number.NEGATIVE_INFINITY
        ? "unknown_expiry"
        : expiry <= cap
          ? "expired"
          : "max_wait"
    let backoff = initialDelayMs
    for (;;) {
      // The signature is a bearer proof for a paid charge: never let a redirect carry it elsewhere.
      const attempt = new Request(request.clone(), { redirect: "manual" })
      attempt.headers.set(HEADER_PAYMENT_SIGNATURE, paymentSignature)
      const response = await fetchImpl(attempt)
      if (isRedirect(response, new URL(request.url))) {
        discardBody(response)
        throw new Px402Error("policy_exceeded", "paid request was redirected", {
          ...details,
          reason: "redirected",
          responseUrl: response.url,
        })
      }
      if (response.status !== 402) return response
      discardBody(response)

      const header = response.headers.get(HEADER_PAYMENT_RESPONSE)
      const reason = header === null ? undefined : readErrorReason(header)
      if (reason === "settlement_pending") {
        if (now() > until) {
          const message =
            timeoutReason === "expired"
              ? "charge expired before settlement"
              : "gave up waiting for settlement"
          throw new Px402Error("payment_timeout", message, { ...details, reason: timeoutReason })
        }
        const wait = Math.max(retryAfterMs(response, now()), backoff)
        backoff = Math.min(backoff * factor, maxDelayMs)
        // Never sleep much past the deadline: one last attempt right after it.
        await sleep(Math.min(wait, Math.max(0, until - now()) + 1))
        continue
      }
      if (reason !== undefined && isPx402ErrorCode(reason)) {
        throw new Px402Error(reason, `payment refused: ${reason}`, details)
      }
      throw new Px402Error("payment_rejected", "payment refused by the server", {
        ...details,
        errorReason: reason,
      })
    }
  }

  async function resume(request: Request, paymentSignature: string): Promise<Response> {
    let chargeId = ""
    let deadline = Number.NEGATIVE_INFINITY // unknown expiry: try once
    try {
      const parsed = PixPaymentPayloadSchema.safeParse(decodePaymentPayload(paymentSignature))
      if (parsed.success) {
        chargeId = parsed.data.payload.chargeId
        deadline = Date.parse(parsed.data.accepted.extra.expiresAt)
      }
    } catch {
      // not a p-x402 Pix signature: send it once and interpret the answer
    }
    return retryLoop(request, paymentSignature, chargeId, deadline)
  }

  async function paidFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const existing = request.headers.get(HEADER_PAYMENT_SIGNATURE)
    if (existing !== null) return resume(request, existing)

    const response = await fetchImpl(request.clone())
    if (response.status !== 402) return response
    const header = response.headers.get(HEADER_PAYMENT_REQUIRED)
    if (header === null) return response
    discardBody(response)
    const requestUrl = new URL(request.url)
    checkNotRedirected(response, requestUrl)

    const required = decodePaymentRequired(header)
    const picked = pickPix(required.accepts)
    if (!picked) {
      throw new Px402Error("no_supported_requirements", "no Pix payment option offered", {
        accepts: required.accepts.map((a) => ({ scheme: a.scheme, network: a.network })),
      })
    }
    const { raw, requirements } = picked
    const { extra, amount } = requirements

    // Everything below up to payer.pay is synchronous so concurrent calls cannot overspend.
    checkResource(required, requirements, requestUrl)
    if (allowedOrigins && !originAllowed(requestUrl, allowedOrigins)) {
      throw new Px402Error("policy_exceeded", "origin not allowed", {
        reason: "origin_not_allowed",
        origin: requestUrl.origin,
      })
    }
    if (payer.paysBrCode !== false) {
      checkBrCode(extra.brCode, amount, payer.checksDynamicAmount === true)
    }
    const value = Number(amount)
    if (value > maxPerRequest) {
      throw new Px402Error("policy_exceeded", "amount above maxPerRequest", {
        reason: "max_per_request",
        amount,
        maxPerRequest,
      })
    }
    if (spent + value > maxTotal) {
      throw new Px402Error("policy_exceeded", "amount would exceed maxTotal", {
        reason: "max_total",
        amount,
        spent,
        maxTotal,
      })
    }
    const paymentSignature = encodePaymentPayload({
      x402Version: X402_VERSION,
      resource: required.resource,
      accepted: raw,
      payload: { chargeId: extra.chargeId },
    })
    spent += value // stays spent once the payer is called

    try {
      await payer.pay({
        chargeId: extra.chargeId,
        amount,
        brCode: extra.brCode,
        ...(extra.brCodeBase64 !== undefined ? { brCodeBase64: extra.brCodeBase64 } : {}),
        expiresAt: extra.expiresAt,
        resourceUrl: extra.resourceUrl,
      })
    } catch (cause) {
      // paymentSignature lets the caller resume if the payer failed after money moved
      const error = new Px402Error("payer_failed", "payer failed", {
        chargeId: extra.chargeId,
        paymentSignature,
      })
      error.cause = cause
      throw error
    }

    try {
      onPayment?.({
        chargeId: extra.chargeId,
        amount,
        resourceUrl: extra.resourceUrl,
        paymentSignature,
      })
    } catch {
      // a logging hook must not lose a paid request
    }

    return retryLoop(request, paymentSignature, extra.chargeId, Date.parse(extra.expiresAt))
  }

  Object.defineProperty(paidFetch, "spent", { get: () => spent, enumerable: true })
  return paidFetch as PaidFetch
}

function pickPix(
  accepts: PaymentRequirements[],
): { raw: PaymentRequirements; requirements: PixPaymentRequirements } | undefined {
  for (const raw of accepts) {
    const parsed = PixPaymentRequirementsSchema.safeParse(raw)
    if (parsed.success) return { raw, requirements: parsed.data }
  }
  return undefined
}

function checkResource(
  required: PaymentRequired,
  requirements: PixPaymentRequirements,
  requestUrl: URL,
): void {
  const resourceUrl = requirements.extra.resourceUrl
  if (resourceUrl !== required.resource.url || new URL(resourceUrl).origin !== requestUrl.origin) {
    throw new Px402Error("policy_exceeded", "payment resource does not match the request", {
      reason: "resource_origin_mismatch",
      resourceUrl,
      resource: required.resource.url,
      origin: requestUrl.origin,
    })
  }
}

/**
 * A 402 that arrived after a redirect was issued by a server the caller did not address: refuse
 * to pay it, since its resource checks would run against the wrong origin.
 */
function checkNotRedirected(response: Response, requestUrl: URL): void {
  if (isRedirect(response, requestUrl)) {
    throw new Px402Error("policy_exceeded", "402 came from a redirected response", {
      reason: "redirected",
      origin: requestUrl.origin,
      responseUrl: response.url,
    })
  }
}

/** A redirect (followed, or held back by redirect: "manual") or an answer from another origin. */
function isRedirect(response: Response, requestUrl: URL): boolean {
  if (response.redirected || response.type === "opaqueredirect") return true
  if (response.status >= 300 && response.status < 400) return true
  if (response.url === "") return false
  return !URL.canParse(response.url) || new URL(response.url).origin !== requestUrl.origin
}

function originAllowed(url: URL, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (entry.includes("://")) return URL.canParse(entry) && new URL(entry).origin === url.origin
    return entry.toLowerCase() === url.host
  })
}

function checkBrCode(brCode: string, amount: string, payerChecksDynamic: boolean): void {
  const info = parseBrCode(brCode)
  const fail = (reason: string, message: string) =>
    new Px402Error("invalid_payment_requirements", message, { reason, amount })
  if (!info?.crcValid) throw fail("brcode_invalid", "BR Code is malformed or has a bad CRC")
  // Tag 54 of a dynamic code is not what the bank charges: only a payer that checks the resolved
  // amount may pay one.
  if (info.hasLocation && !payerChecksDynamic) {
    throw fail("brcode_dynamic_unverified", "BR Code is dynamic; its amount cannot be checked here")
  }
  if (info.amount === undefined) throw fail("brcode_amount_missing", "BR Code has no amount")
  if (info.amount !== amount) {
    throw fail(
      "brcode_amount_mismatch",
      `BR Code asks for ${info.amount}, requirements say ${amount}`,
    )
  }
}

function readErrorReason(header: string): string | undefined {
  try {
    return decodeSettlementResponse(header).errorReason
  } catch {
    return undefined
  }
}

/** Retry-After in ms: delta-seconds or an HTTP date. 0 when absent or unreadable. */
function retryAfterMs(response: Response, nowMs: number): number {
  const value = response.headers.get("Retry-After")?.trim()
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? 0 : Math.max(0, at - nowMs)
}

function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}
