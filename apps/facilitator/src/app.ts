import {
  CHARGE_TTL_SECONDS,
  CreateChargeRequestSchema,
  createRateLimiter,
  isPx402Error,
  PAID_GRACE_SECONDS,
  PIX_ASSET,
  PIX_ASSET_TRANSFER_METHOD,
  PIX_NETWORK,
  PIX_PAYMENT_FLOW,
  PIX_SCHEME,
  PixPaymentRequirementsSchema,
  type Px402ErrorCode,
  type SettlementResponse,
  type SupportedResponse,
  timingSafeEqual,
  type VerifyResponse,
  X402_VERSION,
} from "@p-x402/core"
import type { PixChargeState, PixProvider } from "@p-x402/psp"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { type CheckContext, type FacilitatorMerchant, runChecks } from "./checks"
import type { ChargeRecord, ChargeStore } from "./store"

export type { FacilitatorMerchant } from "./checks"
export type { ChargeRecord, ChargeStore } from "./store"

/** JSON bodies above this size are refused with 413. */
export const MAX_BODY_BYTES = 64 * 1024

export interface FacilitatorOptions {
  provider: PixProvider
  store: ChargeStore
  merchants: FacilitatorMerchant[]
  now?: () => number
  /** Charge lifetime; raised to provider.minExpiresIn. Default 300. */
  chargeTtlSeconds?: number
  /** A paid charge stays consumable this long. Default 86400. */
  paidGraceSeconds?: number
  /** Per-merchant cap on POST /pix/charges. Default 60 per minute. */
  merchantRateLimit?: { limit: number; windowMs: number }
  /** Largest amount in centavos. Default 100000 (R$ 1.000,00). */
  maxAmount?: number
  /** Enables POST /dev/charges/:id/simulate-payment. Default false. */
  devSimulate?: boolean
  /** How long a non-PAID PSP answer is reused by /verify. 0 disables. Default 1000. */
  pspCacheMs?: number
}

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i

function validateMerchants(merchants: FacilitatorMerchant[]) {
  if (merchants.length === 0) throw new Error("facilitator: at least one merchant is required")
  const ids = new Set<string>()
  const tokens = new Set<string>()
  for (const m of merchants) {
    if (!m.id || !m.token || !m.payTo) {
      throw new Error("facilitator: merchant id, token and payTo must be non-empty")
    }
    if (ids.has(m.id) || tokens.has(m.token)) {
      throw new Error("facilitator: merchant ids and tokens must be unique")
    }
    ids.add(m.id)
    tokens.add(m.token)
  }
}

export function createFacilitator(options: FacilitatorOptions): Hono {
  const { provider, store } = options
  const merchants = options.merchants.map((m) => ({ ...m }))
  validateMerchants(merchants)
  const now = options.now ?? Date.now
  const chargeTtl = Math.max(options.chargeTtlSeconds ?? CHARGE_TTL_SECONDS, provider.minExpiresIn)
  const paidGraceMs = (options.paidGraceSeconds ?? PAID_GRACE_SECONDS) * 1000
  const maxAmount = options.maxAmount ?? 100_000
  const pspCacheMs = options.pspCacheMs ?? 1000
  const limiter = createRateLimiter({
    ...(options.merchantRateLimit ?? { limit: 60, windowMs: 60_000 }),
    now,
  })

  // PSP-call coalescing per chargeId.
  const inflight = new Map<string, Promise<PixChargeState>>()
  const cache = new Map<string, { state: PixChargeState; at: number }>()

  function observe(id: string, useCache: boolean): Promise<PixChargeState> {
    const pending = inflight.get(id)
    if (pending) return pending
    if (useCache && pspCacheMs > 0) {
      const hit = cache.get(id)
      if (hit && now() - hit.at < pspCacheMs) return Promise.resolve(hit.state)
    }
    const call: Promise<PixChargeState> = provider
      .getCharge(id)
      .then((state) => {
        // A call detached by forget() must not cache its (possibly stale) answer.
        if (inflight.get(id) !== call) return state
        if (state.status !== "PAID" && pspCacheMs > 0) {
          if (cache.size > 10_000) cache.clear()
          cache.set(id, { state, at: now() })
        } else {
          cache.delete(id)
        }
        return state
      })
      .finally(() => {
        if (inflight.get(id) === call) inflight.delete(id)
      })
    inflight.set(id, call)
    return call
  }

  // The charge may have changed at the PSP: drop the cached answer and stop sharing older in-flight calls.
  function forget(id: string) {
    cache.delete(id)
    inflight.delete(id)
  }

  // Writes what the PSP reported. markPaid never overwrites; flags are sticky.
  async function applyState(id: string, state: PixChargeState) {
    const t = now()
    if (state.status === "PAID") {
      const pspPaidAt = state.paidAt === undefined ? Number.NaN : Date.parse(state.paidAt)
      await store.markPaid(id, Number.isFinite(pspPaidAt) ? Math.min(pspPaidAt, t) : t)
    } else if (state.status === "UNDER_DISPUTE") {
      await store.markDisputed(id, t)
    } else if (state.status === "REFUNDED") {
      await store.markRefunded(id, t)
    }
  }

  // Compares against every merchant so timing does not reveal which one matched.
  async function authenticate(c: Context): Promise<FacilitatorMerchant | undefined> {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? ""
    const results = await Promise.all(merchants.map((m) => timingSafeEqual(token, m.token)))
    let found: FacilitatorMerchant | undefined
    results.forEach((ok, i) => {
      if (ok && token !== "") found = merchants[i]
    })
    return found
  }

  async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
    try {
      return { ok: true, value: JSON.parse(await c.req.text()) }
    } catch {
      return { ok: false }
    }
  }

  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "invalid_request", message: "body too large" }, 413),
  })
  const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401)

  function checkContext(merchant: FacilitatorMerchant, useCache: boolean): CheckContext {
    return {
      provider,
      store,
      merchant,
      now,
      paidGraceMs,
      observe: (id) => observe(id, useCache),
    }
  }

  const app = new Hono()

  app.onError((error, c) => {
    console.error("facilitator: unexpected error", error)
    return c.json({ error: "unexpected_error" }, 500)
  })

  app.get("/supported", (c) => {
    const body: SupportedResponse = {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: PIX_SCHEME,
          network: PIX_NETWORK,
          extra: {
            paymentFlow: PIX_PAYMENT_FLOW,
            assetTransferMethod: PIX_ASSET_TRANSFER_METHOD,
            provider: provider.name,
          },
        },
      ],
      extensions: [],
      signers: {},
    }
    return c.json(body)
  })

  app.post("/pix/charges", limit, async (c) => {
    const merchant = await authenticate(c)
    if (!merchant) return unauthorized(c)
    const invalid = (message: string) => c.json({ error: "invalid_request", message }, 400)

    // Validate before touching the cap or the PSP.
    const json = await readJson(c)
    if (!json.ok) return invalid("body is not JSON")
    const parsed = CreateChargeRequestSchema.safeParse(json.value)
    if (!parsed.success) return invalid("invalid charge request")
    const request = parsed.data
    const amount = Number(request.amount)
    if (!Number.isSafeInteger(amount) || amount < provider.minAmount || amount > maxAmount) {
      return invalid(`amount must be an integer between ${provider.minAmount} and ${maxAmount}`)
    }

    const take = limiter.take(merchant.id)
    if (!take.ok) {
      c.header("Retry-After", String(take.retryAfterSeconds))
      return c.json({ error: "rate_limited" }, 429)
    }

    const description = request.description ?? request.resource.description
    let charge: Awaited<ReturnType<PixProvider["createCharge"]>>
    try {
      charge = await provider.createCharge({
        amount,
        expiresIn: chargeTtl,
        externalId: crypto.randomUUID(),
        metadata: { merchantId: merchant.id },
        ...(description === undefined ? {} : { description }),
      })
    } catch (error) {
      console.error("facilitator: createCharge failed", isPx402Error(error) ? error.code : error)
      return c.json({ error: "psp_error" }, 502)
    }

    const built = PixPaymentRequirementsSchema.safeParse({
      scheme: PIX_SCHEME,
      network: PIX_NETWORK,
      amount: request.amount,
      asset: PIX_ASSET,
      payTo: merchant.payTo,
      maxTimeoutSeconds: chargeTtl,
      extra: {
        paymentFlow: PIX_PAYMENT_FLOW,
        assetTransferMethod: PIX_ASSET_TRANSFER_METHOD,
        provider: provider.name,
        resourceUrl: request.resource.url,
        chargeId: charge.id,
        brCode: charge.brCode,
        ...(charge.brCodeBase64 === undefined ? {} : { brCodeBase64: charge.brCodeBase64 }),
        expiresAt: charge.expiresAt,
      },
    })
    if (!built.success || charge.amount !== amount) {
      console.error("facilitator: PSP returned an unusable charge", charge.id)
      return c.json({ error: "psp_error" }, 502)
    }

    const record: ChargeRecord = {
      id: charge.id,
      merchantId: merchant.id,
      payTo: merchant.payTo,
      amount: request.amount,
      resourceUrl: request.resource.url,
      provider: provider.name,
      brCode: charge.brCode,
      expiresAt: charge.expiresAt,
      createdAt: now(),
      paidAt: null,
      disputedAt: null,
      refundedAt: null,
      consumedAt: null,
    }
    if (description !== undefined) record.description = description
    if (charge.brCodeBase64 !== undefined) record.brCodeBase64 = charge.brCodeBase64
    await store.insert(record)
    return c.json({ paymentRequirements: built.data })
  })

  // No state changes here, not even paidAt.
  app.post("/verify", limit, async (c) => {
    const merchant = await authenticate(c)
    if (!merchant) return unauthorized(c)
    const json = await readJson(c)
    if (!json.ok) {
      const body: VerifyResponse = { isValid: false, invalidReason: "invalid_payload" }
      return c.json(body, 400)
    }
    const result = await runChecks(checkContext(merchant, true), json.value)
    if (result.ok) return c.json({ isValid: true } satisfies VerifyResponse)
    const body: VerifyResponse = { isValid: false, invalidReason: result.reason }
    return c.json(body, result.status)
  })

  app.post("/settle", limit, async (c) => {
    const merchant = await authenticate(c)
    if (!merchant) return unauthorized(c)
    const failure = (reason: Px402ErrorCode, transaction: string, status: 200 | 400 = 200) => {
      const body: SettlementResponse = {
        success: false,
        errorReason: reason,
        transaction,
        network: PIX_NETWORK,
      }
      return c.json(body, status)
    }
    const json = await readJson(c)
    if (!json.ok) return failure("invalid_payload", "", 400)

    const result = await runChecks(checkContext(merchant, false), json.value)

    // Record what the PSP said, whatever the verdict.
    const observation = result.observation
    if (observation && "state" in observation && result.record) {
      await applyState(result.record.id, observation.state)
    }

    if (!result.ok) return failure(result.reason, result.chargeId, result.status)
    if (!(await store.consume(result.chargeId, now()))) {
      return failure("charge_already_consumed", result.chargeId)
    }
    const body: SettlementResponse = {
      success: true,
      transaction: result.chargeId,
      network: PIX_NETWORK,
      amount: result.record.amount,
    }
    return c.json(body)
  })

  app.post("/webhooks/pix", limit, async (c) => {
    if (!provider.parseWebhook) return c.notFound()
    let event: Awaited<ReturnType<NonNullable<PixProvider["parseWebhook"]>>>
    try {
      event = await provider.parseWebhook(c.req.raw)
    } catch (error) {
      if (isPx402Error(error) && error.code === "invalid_webhook_secret") {
        return c.json({ error: "invalid_webhook_secret" }, 401)
      }
      return c.json({ error: "invalid_webhook_payload" }, 400)
    }
    if (!(await store.recordWebhookEvent(event.id, now()))) {
      return c.json({ ok: true, duplicate: true })
    }
    if (event.chargeId === undefined) return c.json({ ok: true, ignored: true })
    const record = await store.get(event.chargeId)
    if (!record) return c.json({ ok: true, ignored: true })

    // The event is only a hint: ask the PSP with a fresh call.
    forget(record.id)
    let state: PixChargeState
    try {
      state = await observe(record.id, false)
    } catch {
      return c.json({ ok: true, applied: false })
    }
    await applyState(record.id, state)
    return c.json({ ok: true, applied: true })
  })

  app.post("/dev/charges/:id/simulate-payment", async (c) => {
    if (!options.devSimulate || !provider.simulatePayment) return c.notFound()
    const id = c.req.param("id")
    const record = await store.get(id)
    if (!record) return c.notFound()
    try {
      await provider.simulatePayment(id)
    } catch (error) {
      console.error("facilitator: simulatePayment failed", isPx402Error(error) ? error.code : error)
      return c.json({ error: "psp_error" }, 502)
    }
    forget(id)
    return c.json({ ok: true, chargeId: id })
  })

  return app
}
