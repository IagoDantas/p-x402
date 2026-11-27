import {
  AtomicAmountSchema,
  CreateChargeResponseSchema,
  createRateLimiter,
  decodePaymentPayload,
  defaultFetch,
  encodePaymentRequired,
  encodeSettlementResponse,
  errorBody,
  type FetchLike,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HttpUrlSchema,
  isPx402Error,
  type PaymentPayload,
  type PaymentRequired,
  PIX_ASSET,
  PIX_ASSET_TRANSFER_METHOD,
  PIX_NETWORK,
  PIX_PAYMENT_FLOW,
  PIX_SCHEME,
  PixPaymentPayloadSchema,
  type PixPaymentRequirements,
  Px402Error,
  type Px402ErrorCode,
  type ResourceInfo,
  SETTLEMENT_PENDING_RETRY_AFTER_SECONDS,
  type SettlementResponse,
  SettlementResponseSchema,
  VerifyResponseSchema,
  X402_VERSION,
} from "@p-x402/core"
import { clientIpKey, UNKNOWN_IP_KEY } from "./ip"

export { clientIpKey, UNKNOWN_IP_KEY } from "./ip"

/**
 * Paywall configuration.
 *
 * Concurrency: a paid request takes an in-process lock on its chargeId from just before /verify
 * until finalize settles (or release() is called). While it is held, a second request for the same
 * chargeId gets settlement_pending without /verify and without running the handler. The lock goes
 * stale after 60 s of handler time plus the worst case of the facilitator calls. It lives in this
 * process only: multi-instance deployments need sticky routing per chargeId, or handlers that are
 * safe to run twice for one charge.
 */
export interface PaywallConfig {
  /** Base URL of the p-x402 facilitator. */
  facilitatorUrl: string
  /** Merchant bearer token for the facilitator. */
  token: string
  fetch?: FetchLike
  now?: () => number
  /** Per-client-IP cap on charge creation. Default 10 per 60 s. */
  ipRateLimit?: { limit: number; windowMs: number }
  /** Public origin (e.g. "https://api.example.com") used to build resource URLs behind a proxy. */
  publicOrigin?: string
  /**
   * Per-attempt timeout for facilitator calls. Default 15000. A failed /settle (transport error,
   * timeout or 5xx) is retried up to 2 more times with the same Idempotency-Key.
   */
  facilitatorTimeoutMs?: number
}

export interface PaywallRoute {
  /** Price in centavos. */
  amount: string | number
  description?: string
  mimeType?: string
  /** Absolute resource URL; overrides the request URL (but not `publicOrigin`). */
  resource?: string
}

export interface PaywallContext {
  clientIp?: string
}

export type PaywallResult =
  | { type: "response"; response: Response }
  | {
      type: "paid"
      chargeId: string
      amount: string
      requirements: PixPaymentRequirements
      /**
       * Settles after the handler ran. Returns the response to send. Settle happens when the
       * handler returns its Response: a streamed body that fails later is still settled.
       * Always releases the chargeId lock.
       */
      finalize(response: Response): Promise<Response>
      /**
       * Releases the chargeId lock without settling. Call it when the handler threw and
       * finalize will not run. Idempotent; finalize calls it too.
       */
      release(): void
    }

export interface Paywall {
  handle(request: Request, route: PaywallRoute, ctx?: PaywallContext): Promise<PaywallResult>
}

const DEFAULT_IP_RATE_LIMIT = { limit: 10, windowMs: 60_000 }
const DEFAULT_FACILITATOR_TIMEOUT_MS = 15_000
/** Extra /settle attempts after a transport error, timeout or 5xx. */
const SETTLE_RETRIES = 2
/**
 * Time a handler may take while holding a chargeId lock. The lock goes stale (the request that
 * took it is presumed gone) after this plus the worst case of /verify and every /settle attempt.
 */
const LOCK_HANDLER_HEADROOM_MS = 60_000
const LOCK_SWEEP_SIZE = 1024
const UNPAYABLE_METHODS = new Set(["HEAD", "OPTIONS"])

type FacilitatorAnswer =
  | { ok: true; status: number; headers: Headers; body: unknown }
  | { ok: false }

type Outcome<T> =
  | { kind: "value"; value: T }
  | { kind: "failed"; reason: string }
  | { kind: "response"; response: Response }

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function failureSettlement(reason: string, chargeId: string): SettlementResponse {
  return { success: false, errorReason: reason, transaction: chargeId, network: PIX_NETWORK }
}

function parseOrigin(value: string): string {
  if (!URL.canParse(value)) throw new Px402Error("invalid_request", "publicOrigin is not a URL")
  const url = new URL(value)
  const ok =
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "" &&
    !value.endsWith("/")
  if (!ok) throw new Px402Error("invalid_request", "publicOrigin must be an http(s) origin")
  return url.origin
}

function routeAmount(amount: string | number): string {
  const text = typeof amount === "number" ? String(amount) : amount
  if (typeof amount === "number" && !Number.isSafeInteger(amount)) {
    throw new Px402Error("invalid_request", "route amount must be a positive integer")
  }
  if (!AtomicAmountSchema.safeParse(text).success) {
    throw new Px402Error("invalid_request", "route amount must be a positive integer")
  }
  return text
}

function validateRoute(route: PaywallRoute): string {
  const amount = routeAmount(route.amount)
  if (route.description !== undefined && route.description.length > 140) {
    throw new Px402Error("invalid_request", "route description is longer than 140 characters")
  }
  if (route.mimeType !== undefined && route.mimeType.length > 200) {
    throw new Px402Error("invalid_request", "route mimeType is too long")
  }
  if (route.resource !== undefined && !HttpUrlSchema.safeParse(route.resource).success) {
    throw new Px402Error("invalid_request", "route resource must be an absolute http(s) URL")
  }
  return amount
}

export function createPaywall(config: PaywallConfig): Paywall {
  if (!URL.canParse(config.facilitatorUrl)) {
    throw new Px402Error("invalid_request", "facilitatorUrl is not a URL")
  }
  const facilitatorBase = config.facilitatorUrl.replace(/\/+$/, "")
  const publicOrigin =
    config.publicOrigin === undefined ? undefined : parseOrigin(config.publicOrigin)
  const fetchFn = config.fetch ?? defaultFetch
  const timeoutMs = config.facilitatorTimeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS
  const now = config.now ?? Date.now
  const limiter = createRateLimiter({
    ...(config.ipRateLimit ?? DEFAULT_IP_RATE_LIMIT),
    now,
  })
  let warnedUnknownIp = false
  /** chargeId → lock held by one in-flight paid request (see the PaywallConfig note). */
  const locks = new Map<string, { at: number }>()
  const lockStaleMs = LOCK_HANDLER_HEADROOM_MS + timeoutMs * (2 + SETTLE_RETRIES)

  interface Lock {
    /** Restarts the stale clock; called before settling so slow settle retries keep the lock. */
    touch(): void
    release(): void
  }

  /** Takes the lock for chargeId, or returns undefined when a fresh lock is held. */
  function acquireLock(chargeId: string): Lock | undefined {
    const at = now()
    const held = locks.get(chargeId)
    if (held !== undefined && at - held.at < lockStaleMs) return undefined
    if (locks.size >= LOCK_SWEEP_SIZE) {
      for (const [id, lock] of locks) if (at - lock.at >= lockStaleMs) locks.delete(id)
    }
    const token = { at }
    locks.set(chargeId, token)
    return {
      touch() {
        if (locks.get(chargeId) === token) token.at = now()
      },
      release() {
        // A stale lock may have been taken over: release only our own.
        if (locks.get(chargeId) === token) locks.delete(chargeId)
      },
    }
  }

  function resourceUrlFor(request: Request, route: PaywallRoute): string {
    const url = new URL(request.url)
    if (publicOrigin !== undefined) return `${publicOrigin}${url.pathname}${url.search}`
    if (route.resource !== undefined) return route.resource
    url.hash = ""
    url.username = ""
    url.password = ""
    return url.href
  }

  /** POST JSON to the facilitator. Transport errors, timeouts and non-JSON bodies → `{ok:false}`. */
  async function post(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<FacilitatorAnswer> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<FacilitatorAnswer>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ ok: false })
      }, timeoutMs)
    })
    const call = (async (): Promise<FacilitatorAnswer> => {
      const response = await fetchFn(
        new Request(`${facilitatorBase}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
            ...extraHeaders,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
      )
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text === "" ? undefined : JSON.parse(text)
      } catch {
        parsed = undefined
      }
      return { ok: true, status: response.status, headers: response.headers, body: parsed }
    })().catch((): FacilitatorAnswer => ({ ok: false }))
    try {
      return await Promise.race([call, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  function facilitatorError(chargeId: string): Response {
    return jsonResponse(502, errorBody("facilitator_error"), {
      [HEADER_PAYMENT_RESPONSE]: encodeSettlementResponse(
        failureSettlement("facilitator_error", chargeId),
      ),
    })
  }

  function unauthorized(path: string): Response {
    console.error(`p-x402: facilitator rejected the merchant token (401 on ${path})`)
    return jsonResponse(500, errorBody("unauthorized"))
  }

  /** Shared answer handling for /verify and /settle. */
  async function verifyOrSettle(
    path: "/verify" | "/settle",
    body: unknown,
    chargeId: string,
    idempotencyKey?: string,
  ): Promise<Outcome<SettlementResponse | undefined>> {
    // Only /settle carries a key. Retry transport errors, timeouts and 5xx with the same key so
    // the facilitator can answer a replay of an already-consumed charge with the same success.
    const headers: Record<string, string> =
      idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }
    let answer = await post(path, body, headers)
    if (idempotencyKey !== undefined) {
      for (let retry = 0; retry < SETTLE_RETRIES && (!answer.ok || answer.status >= 500); retry++) {
        answer = await post(path, body, headers)
      }
    }
    if (!answer.ok || answer.status >= 500) {
      return { kind: "response", response: facilitatorError(chargeId) }
    }
    if (answer.status === 401) return { kind: "response", response: unauthorized(path) }
    if (answer.status !== 200 && answer.status !== 400) {
      return { kind: "response", response: facilitatorError(chargeId) }
    }
    // Success counts only on a 200; a 400 may carry a failure reason, never a success.
    if (path === "/verify") {
      const parsed = VerifyResponseSchema.safeParse(answer.body)
      if (!parsed.success) return { kind: "response", response: facilitatorError(chargeId) }
      if (parsed.data.isValid) {
        if (answer.status !== 200) return { kind: "response", response: facilitatorError(chargeId) }
        return { kind: "value", value: undefined }
      }
      return { kind: "failed", reason: parsed.data.invalidReason ?? "unexpected_error" }
    }
    const parsed = SettlementResponseSchema.safeParse(answer.body)
    if (!parsed.success) return { kind: "response", response: facilitatorError(chargeId) }
    if (parsed.data.success) {
      if (answer.status !== 200) return { kind: "response", response: facilitatorError(chargeId) }
      // Rebuild instead of forwarding: never pass payer data (LGPD) or foreign fields on.
      const settlement: SettlementResponse = {
        success: true,
        transaction: chargeId,
        network: PIX_NETWORK,
        ...(parsed.data.amount !== undefined ? { amount: parsed.data.amount } : {}),
      }
      return { kind: "value", value: settlement }
    }
    return { kind: "failed", reason: parsed.data.errorReason ?? "unexpected_error" }
  }

  /** The one failure mapping for verify and settle reasons. */
  function failureResponse(
    reason: string,
    chargeId: string,
    paymentRequired: PaymentRequired,
  ): Response {
    const settlement = encodeSettlementResponse(failureSettlement(reason, chargeId))
    if (reason === "settlement_pending") {
      const body: PaymentRequired = { ...paymentRequired, error: "settlement_pending" }
      return jsonResponse(402, body, {
        [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(body),
        [HEADER_PAYMENT_RESPONSE]: settlement,
        "retry-after": String(SETTLEMENT_PENDING_RETRY_AFTER_SECONDS),
      })
    }
    // A refused charge is not offered again (no PAYMENT-REQUIRED); the body names the reason.
    return jsonResponse(402, { error: reason }, { [HEADER_PAYMENT_RESPONSE]: settlement })
  }

  function badHeader(reason: Px402ErrorCode): Response {
    return jsonResponse(400, errorBody(reason), {
      [HEADER_PAYMENT_RESPONSE]: encodeSettlementResponse(failureSettlement(reason, "")),
    })
  }

  async function createCharge(
    resource: ResourceInfo,
    amount: string,
    route: PaywallRoute,
    clientIp: string | undefined,
  ): Promise<Response> {
    const key = clientIpKey(clientIp)
    if (key === UNKNOWN_IP_KEY && !warnedUnknownIp) {
      warnedUnknownIp = true
      console.warn(
        "p-x402: client IP unknown; all such requests share one rate-limit bucket (pass the client IP, or getClientIp in the Hono middleware)",
      )
    }
    const cap = limiter.take(key)
    if (!cap.ok) {
      return jsonResponse(429, errorBody("rate_limited"), {
        "retry-after": String(cap.retryAfterSeconds),
      })
    }

    const answer = await post("/pix/charges", {
      resource,
      amount,
      ...(route.description !== undefined ? { description: route.description } : {}),
    })
    if (!answer.ok || answer.status >= 500) return facilitatorError("")
    if (answer.status === 401) return unauthorized("/pix/charges")
    if (answer.status === 400) {
      console.error("p-x402: facilitator refused the charge request (400)")
      return jsonResponse(500, errorBody("invalid_request"))
    }
    if (answer.status === 429) {
      const retryAfter = answer.headers.get("retry-after")
      return jsonResponse(429, errorBody("rate_limited"), {
        "retry-after": retryAfter && /^\d+$/.test(retryAfter) ? retryAfter : "1",
      })
    }
    const parsed = CreateChargeResponseSchema.safeParse(answer.body)
    if (answer.status !== 200 || !parsed.success) return facilitatorError("")
    const requirements = parsed.data.paymentRequirements
    // The charge must be for this route and this resource.
    if (requirements.amount !== amount || requirements.extra.resourceUrl !== resource.url) {
      return facilitatorError(requirements.extra.chargeId)
    }
    const paymentRequired: PaymentRequired = {
      x402Version: X402_VERSION,
      error: "payment_required",
      resource,
      accepts: [requirements],
    }
    return jsonResponse(402, paymentRequired, {
      [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(paymentRequired),
    })
  }

  async function handle(
    request: Request,
    route: PaywallRoute,
    ctx: PaywallContext = {},
  ): Promise<PaywallResult> {
    const amount = validateRoute(route)
    // HEAD/OPTIONS never create, verify or settle a charge (and never touch the IP cap).
    if (UNPAYABLE_METHODS.has(request.method.toUpperCase())) {
      return { type: "response", response: jsonResponse(402, errorBody("method_not_payable")) }
    }
    const resourceUrl = resourceUrlFor(request, route)
    const resource: ResourceInfo = {
      url: resourceUrl,
      ...(route.description !== undefined ? { description: route.description } : {}),
      ...(route.mimeType !== undefined ? { mimeType: route.mimeType } : {}),
    }

    const header = request.headers.get(HEADER_PAYMENT_SIGNATURE)
    if (header === null) {
      return {
        type: "response",
        response: await createCharge(resource, amount, route, ctx.clientIp),
      }
    }

    let payload: PaymentPayload
    try {
      payload = decodePaymentPayload(header)
    } catch (error) {
      if (isPx402Error(error)) return { type: "response", response: badHeader("invalid_header") }
      throw error
    }
    const pix = PixPaymentPayloadSchema.safeParse(payload)
    if (!pix.success) return { type: "response", response: badHeader("invalid_payload") }

    // Server-owned fields from config; only payTo, provider, maxTimeoutSeconds and per-charge keys
    // come from the client (the facilitator checks them against its charge record and config).
    const accepted = pix.data.accepted
    const chargeId = accepted.extra.chargeId
    const requirements: PixPaymentRequirements = {
      scheme: PIX_SCHEME,
      network: PIX_NETWORK,
      asset: PIX_ASSET,
      amount,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      extra: {
        paymentFlow: PIX_PAYMENT_FLOW,
        assetTransferMethod: PIX_ASSET_TRANSFER_METHOD,
        provider: accepted.extra.provider,
        resourceUrl,
        chargeId,
        brCode: accepted.extra.brCode,
        ...(accepted.extra.brCodeBase64 !== undefined
          ? { brCodeBase64: accepted.extra.brCodeBase64 }
          : {}),
        expiresAt: accepted.extra.expiresAt,
      },
    }
    const paymentRequired: PaymentRequired = {
      x402Version: X402_VERSION,
      resource,
      accepts: [requirements],
    }
    const facilitatorBody = {
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    }

    // Another request for this charge is between /verify and settle: do not verify, do not run
    // the handler; the client retries after Retry-After.
    const lock = acquireLock(chargeId)
    if (lock === undefined) {
      return {
        type: "response",
        response: failureResponse("settlement_pending", chargeId, paymentRequired),
      }
    }

    let verified: Outcome<SettlementResponse | undefined>
    try {
      verified = await verifyOrSettle("/verify", facilitatorBody, chargeId)
    } catch (error) {
      lock.release()
      throw error
    }
    if (verified.kind !== "value") {
      lock.release()
      if (verified.kind === "response") return { type: "response", response: verified.response }
      return {
        type: "response",
        response: failureResponse(verified.reason, chargeId, paymentRequired),
      }
    }

    return {
      type: "paid",
      chargeId,
      amount,
      requirements,
      release: lock.release,
      async finalize(response) {
        try {
          // Handler failed: no settle, the paid charge stays unused.
          if (response.status >= 400) return response
          lock.touch()
          const settled = await verifyOrSettle(
            "/settle",
            facilitatorBody,
            chargeId,
            crypto.randomUUID(),
          )
          if (settled.kind === "value" && settled.value) {
            const headers = new Headers(response.headers)
            headers.set(HEADER_PAYMENT_RESPONSE, encodeSettlementResponse(settled.value))
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            })
          }
          // Handler output is discarded.
          await response.body?.cancel().catch(() => undefined)
          if (settled.kind === "response") return settled.response
          const reason = settled.kind === "failed" ? settled.reason : "unexpected_error"
          return failureResponse(reason, chargeId, paymentRequired)
        } finally {
          lock.release()
        }
      },
    }
  }

  return { handle }
}
