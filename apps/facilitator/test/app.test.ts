import { describe, expect, test } from "bun:test"
import {
  type PixPaymentRequirements,
  Px402Error,
  type SettlementResponse,
  SupportedResponseSchema,
  type VerifyResponse,
} from "@p-x402/core"
import { createMockPixProvider, type PixProvider } from "@p-x402/psp"
import { createFacilitator, type FacilitatorOptions } from "../src/app"
import type { ChargeStore } from "../src/store"
import { bunSqliteStore } from "../src/stores/bun-sqlite"
import { memoryStore } from "../src/stores/memory"

const T0 = Date.parse("2026-11-25T15:00:00.000Z")
const RESOURCE = "https://api.example/relatorio"
const MERCHANTS = [
  { id: "loja1", token: "tok-loja1", payTo: "loja1" },
  { id: "loja2", token: "tok-loja2", payTo: "loja2" },
]

type Body = {
  x402Version: number
  paymentPayload: {
    x402Version: number
    accepted: PixPaymentRequirements
    payload: { chargeId: string }
  }
  paymentRequirements: PixPaymentRequirements
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function setup(
  makeStore: () => ChargeStore,
  overrides: Partial<FacilitatorOptions> & { provider?: PixProvider } = {},
) {
  let t = T0
  const now = () => t
  const mock = createMockPixProvider({ now })
  const store = makeStore()
  const app = createFacilitator({
    provider: mock,
    store,
    merchants: MERCHANTS,
    now,
    ...overrides,
  })
  const fetch = async (request: Request) => app.fetch(request)

  async function post(path: string, body: unknown, token: string | null = "tok-loja1") {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token !== null) headers.authorization = `Bearer ${token}`
    return app.request(path, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  }

  async function charge(token = "tok-loja1", amount = "500"): Promise<PixPaymentRequirements> {
    const res = await post("/pix/charges", { resource: { url: RESOURCE }, amount }, token)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { paymentRequirements: PixPaymentRequirements }
    return json.paymentRequirements
  }

  function body(req: PixPaymentRequirements): Body {
    return {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted: clone(req),
        payload: { chargeId: req.extra.chargeId },
      },
      paymentRequirements: clone(req),
    }
  }

  async function verify(b: unknown, token = "tok-loja1") {
    const res = await post("/verify", b, token)
    return { status: res.status, json: (await res.json()) as VerifyResponse }
  }

  async function settle(b: unknown, token = "tok-loja1") {
    const res = await post("/settle", b, token)
    return { status: res.status, json: (await res.json()) as SettlementResponse }
  }

  return {
    app,
    mock,
    store,
    fetch,
    post,
    charge,
    body,
    verify,
    settle,
    advance: (ms: number) => {
      t += ms
    },
    now,
  }
}

const backends: [string, () => ChargeStore][] = [
  ["memoryStore", memoryStore],
  ["bunSqliteStore", () => bunSqliteStore(":memory:")],
]

for (const [storeName, makeStore] of backends) {
  describe(`facilitator (${storeName})`, () => {
    test("GET /supported advertises exact/pix:br with the provider", async () => {
      const f = setup(makeStore)
      const res = await f.app.request("/supported")
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(SupportedResponseSchema.parse(json)).toEqual({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "pix:br",
            extra: { paymentFlow: "upfront", assetTransferMethod: "pix-charge", provider: "mock" },
          },
        ],
        extensions: [],
        signers: {},
      })
    })

    test("auth: missing, empty and wrong tokens get 401 on every merchant route", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      for (const path of ["/pix/charges", "/verify", "/settle"]) {
        for (const token of [null, "", "tok-loja1x", "tok-loja"]) {
          const res = await f.post(path, f.body(req), token)
          expect(res.status).toBe(401)
          expect(await res.json()).toEqual({ error: "unauthorized" })
        }
      }
      const raw = await f.app.request("/verify", {
        method: "POST",
        headers: { authorization: "tok-loja1" },
        body: JSON.stringify(f.body(req)),
      })
      expect(raw.status).toBe(401)
    })

    test("POST /pix/charges returns full Pix requirements", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      expect(req).toEqual({
        scheme: "exact",
        network: "pix:br",
        asset: "BRL",
        amount: "500",
        payTo: "loja1",
        maxTimeoutSeconds: 300,
        extra: {
          paymentFlow: "upfront",
          assetTransferMethod: "pix-charge",
          provider: "mock",
          resourceUrl: RESOURCE,
          chargeId: "pix_char_mock_0001",
          brCode: req.extra.brCode,
          expiresAt: "2026-11-25T15:05:00.000Z",
        },
      })
      const record = await f.store.get("pix_char_mock_0001")
      expect(record?.merchantId).toBe("loja1")
      expect(record?.paidAt).toBeNull()
    })

    test("charge TTL is raised to the provider minimum", async () => {
      const f = setup(makeStore, { chargeTtlSeconds: 60 })
      const req = await f.charge()
      expect(req.maxTimeoutSeconds).toBe(300)
      const g = setup(makeStore, { chargeTtlSeconds: 600 })
      expect((await g.charge()).maxTimeoutSeconds).toBe(600)
    })

    test("POST /pix/charges validation errors are 400 and never reach the PSP", async () => {
      const f = setup(makeStore)
      const bad: unknown[] = [
        { resource: { url: "ftp://x.example/a" }, amount: "500" },
        { resource: { url: "/relative" }, amount: "500" },
        { resource: { url: "https://x.example/a#frag" }, amount: "500" },
        { resource: { url: RESOURCE }, amount: "99" },
        { resource: { url: RESOURCE }, amount: "5.5" },
        { resource: { url: RESOURCE }, amount: 500 },
        { resource: { url: RESOURCE }, amount: "100001" },
        { amount: "500" },
        "{not json",
      ]
      for (const b of bad) {
        const res = await f.post("/pix/charges", b)
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe("invalid_request")
      }
      expect(f.mock.calls.createCharge).toBe(0)
    })

    test("oversized bodies are refused with 413", async () => {
      const f = setup(makeStore)
      const big = JSON.stringify({
        resource: { url: RESOURCE },
        amount: "500",
        pad: "x".repeat(70_000),
      })
      const res = await f.post("/pix/charges", big)
      expect(res.status).toBe(413)
      expect(f.mock.calls.createCharge).toBe(0)
    })

    test("per-merchant cap returns 429 + Retry-After and stops PSP calls", async () => {
      const f = setup(makeStore, { merchantRateLimit: { limit: 2, windowMs: 60_000 } })
      await f.charge()
      await f.charge()
      const res = await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "500" })
      expect(res.status).toBe(429)
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
      expect(await res.json()).toEqual({ error: "rate_limited" })
      expect(f.mock.calls.createCharge).toBe(2)
      // invalid requests are rejected before the cap
      expect(
        (await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "1" })).status,
      ).toBe(400)
      // other merchants keep their own budget
      await f.charge("tok-loja2")
      expect(f.mock.calls.createCharge).toBe(3)
      f.advance(60_001)
      await f.charge()
    })

    test("createCharge failure → 502 psp_error and no record", async () => {
      const mock = createMockPixProvider()
      const failing: PixProvider = {
        name: "mock",
        minAmount: 100,
        minExpiresIn: 300,
        createCharge: async () => {
          throw new Px402Error("psp_error", "down")
        },
        getCharge: mock.getCharge,
      }
      const f = setup(makeStore, { provider: failing })
      const res = await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "500" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "psp_error" })
    })

    test("happy path: verify then settle", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      expect(await f.verify(f.body(req))).toEqual({ status: 200, json: { isValid: true } })
      expect(await f.settle(f.body(req))).toEqual({
        status: 200,
        json: { success: true, transaction: req.extra.chargeId, network: "pix:br", amount: "500" },
      })
      const record = await f.store.get(req.extra.chargeId)
      expect(record?.paidAt).toBe(T0)
      expect(record?.consumedAt).toBe(T0)
    })

    test("/verify writes nothing; settle still works afterwards", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      const before = await f.store.get(req.extra.chargeId)
      for (let i = 0; i < 3; i++) expect((await f.verify(f.body(req))).json.isValid).toBe(true)
      expect(await f.store.get(req.extra.chargeId)).toEqual(before)
      expect(before?.paidAt).toBeNull()
      expect((await f.settle(f.body(req))).json.success).toBe(true)
    })

    test("settlement_pending before payment, with transaction = chargeId", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      expect((await f.verify(f.body(req))).json).toEqual({
        isValid: false,
        invalidReason: "settlement_pending",
      })
      expect((await f.settle(f.body(req))).json).toEqual({
        success: false,
        errorReason: "settlement_pending",
        transaction: req.extra.chargeId,
        network: "pix:br",
      })
    })

    test("a cached pending answer from /verify does not block /settle", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      expect((await f.verify(f.body(req))).json.invalidReason).toBe("settlement_pending")
      await f.mock.simulatePayment(req.extra.chargeId)
      expect((await f.settle(f.body(req))).json.success).toBe(true)
    })

    test("PSP outage → settlement_pending, never success", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      f.mock.failNextGetCharge(2)
      expect((await f.verify(f.body(req))).json.invalidReason).toBe("settlement_pending")
      const res = await f.settle(f.body(req))
      expect(res.json).toEqual({
        success: false,
        errorReason: "settlement_pending",
        transaction: req.extra.chargeId,
        network: "pix:br",
      })
      expect((await f.store.get(req.extra.chargeId))?.consumedAt).toBeNull()
      expect((await f.settle(f.body(req))).json.success).toBe(true)
    })

    test("replay of a consumed charge → charge_already_consumed", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      expect((await f.settle(f.body(req))).json.success).toBe(true)
      const calls = f.mock.calls.getCharge
      expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_already_consumed")
      const again = await f.settle(f.body(req))
      expect(again.json).toEqual({
        success: false,
        errorReason: "charge_already_consumed",
        transaction: req.extra.chargeId,
        network: "pix:br",
      })
      expect(f.mock.calls.getCharge).toBe(calls)
    })

    test("two concurrent /settle on one paid charge → exactly one success", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      const results = await Promise.all([f.settle(f.body(req)), f.settle(f.body(req))])
      const reasons = results.map((r) => r.json.errorReason ?? "ok").sort()
      expect(reasons).toEqual(["charge_already_consumed", "ok"])
    })

    describe("mismatches", () => {
      type Case = [string, (b: Body) => void, string]
      const cases: Case[] = [
        [
          "accepted amount",
          (b) => {
            b.paymentPayload.accepted.amount = "600"
          },
          "amount_mismatch",
        ],
        [
          "amount vs record",
          (b) => {
            b.paymentPayload.accepted.amount = "600"
            b.paymentRequirements.amount = "600"
          },
          "amount_mismatch",
        ],
        [
          "accepted payTo",
          (b) => {
            b.paymentPayload.accepted.payTo = "evil"
          },
          "pay_to_mismatch",
        ],
        [
          "payTo vs record",
          (b) => {
            b.paymentPayload.accepted.payTo = "evil"
            b.paymentRequirements.payTo = "evil"
          },
          "pay_to_mismatch",
        ],
        [
          "accepted resource",
          (b) => {
            b.paymentPayload.accepted.extra.resourceUrl = "https://api.example/other"
          },
          "resource_mismatch",
        ],
        [
          "resource vs record",
          (b) => {
            b.paymentPayload.accepted.extra.resourceUrl = "https://api.example/other"
            b.paymentRequirements.extra.resourceUrl = "https://api.example/other"
          },
          "resource_mismatch",
        ],
        [
          "provider tampered",
          (b) => {
            b.paymentPayload.accepted.extra.provider = "abacatepay"
            b.paymentRequirements.extra.provider = "abacatepay"
          },
          "requirements_mismatch",
        ],
        [
          "accepted provider only",
          (b) => {
            b.paymentPayload.accepted.extra.provider = "abacatepay"
          },
          "requirements_mismatch",
        ],
        [
          "brCode tampered",
          (b) => {
            b.paymentPayload.accepted.extra.brCode = "000201evil"
            b.paymentRequirements.extra.brCode = "000201evil"
          },
          "requirements_mismatch",
        ],
        [
          "expiresAt tampered",
          (b) => {
            b.paymentPayload.accepted.extra.expiresAt = "2030-01-01T00:00:00.000Z"
            b.paymentRequirements.extra.expiresAt = "2030-01-01T00:00:00.000Z"
          },
          "requirements_mismatch",
        ],
        [
          "maxTimeoutSeconds",
          (b) => {
            b.paymentPayload.accepted.maxTimeoutSeconds = 9999
          },
          "requirements_mismatch",
        ],
        [
          "payload names another charge",
          (b) => {
            b.paymentPayload.payload.chargeId = "pix_char_mock_0002"
          },
          "requirements_mismatch",
        ],
        [
          "unknown charge",
          (b) => {
            b.paymentPayload.accepted.extra.chargeId = "pix_char_mock_9999"
            b.paymentRequirements.extra.chargeId = "pix_char_mock_9999"
            b.paymentPayload.payload.chargeId = "pix_char_mock_9999"
          },
          "charge_not_found",
        ],
        [
          "wrong network",
          (b) => {
            b.paymentRequirements.network = "eip155:8453" as "pix:br"
          },
          "unsupported_network",
        ],
        [
          "wrong version",
          (b) => {
            b.x402Version = 1
          },
          "invalid_x402_version",
        ],
      ]
      for (const [name, mutate, reason] of cases) {
        test(`${name} → ${reason}`, async () => {
          const f = setup(makeStore)
          const req = await f.charge()
          await f.mock.simulatePayment(req.extra.chargeId)
          const b = f.body(req)
          mutate(b)
          expect((await f.verify(b)).json).toEqual({ isValid: false, invalidReason: reason })
          const s = await f.settle(b)
          expect(s.json.success).toBe(false)
          expect(s.json.errorReason).toBe(reason)
          expect(s.json.payer).toBeUndefined()
          // the untampered proof still settles: nothing was consumed
          expect((await f.settle(f.body(req))).json.success).toBe(true)
        })
      }
    })

    test("another merchant's token → merchant_mismatch", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      expect((await f.verify(f.body(req), "tok-loja2")).json.invalidReason).toBe(
        "merchant_mismatch",
      )
      expect((await f.settle(f.body(req), "tok-loja2")).json.errorReason).toBe("merchant_mismatch")
    })

    test("malformed bodies → 400 invalid_payload", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      const v = await f.verify("{nope")
      expect(v).toEqual({ status: 400, json: { isValid: false, invalidReason: "invalid_payload" } })
      const s = await f.settle({ x402Version: 2 })
      expect(s).toEqual({
        status: 400,
        json: {
          success: false,
          errorReason: "invalid_payload",
          transaction: "",
          network: "pix:br",
        },
      })
      const b = f.body(req) as unknown as { paymentPayload: { payload: unknown } }
      b.paymentPayload.payload = { other: 1 }
      expect((await f.settle(b)).json.errorReason).toBe("invalid_payload")
    })

    test("expired unpaid charge → charge_expired", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      f.advance(301_000)
      expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_expired")
      expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_expired")
    })

    test("paid charge is consumable after expiry within the 24 h grace, not after", async () => {
      const f = setup(makeStore)
      const a = await f.charge()
      const b = await f.charge()
      f.advance(10_000)
      await f.mock.simulatePayment(a.extra.chargeId)
      await f.mock.simulatePayment(b.extra.chargeId)
      f.advance(2 * 3600_000)
      expect((await f.settle(f.body(a))).json.success).toBe(true)
      f.advance(22 * 3600_000 + 1)
      expect((await f.verify(f.body(b))).json.invalidReason).toBe("charge_expired")
      expect((await f.settle(f.body(b))).json.errorReason).toBe("charge_expired")
      // the observed payment is still recorded, with the PSP's time
      expect((await f.store.get(b.extra.chargeId))?.paidAt).toBe(T0 + 10_000)
    })

    test("disputed via webhook + PSP state → charge_disputed (sticky)", async () => {
      const f = setup(makeStore)
      f.mock.setWebhookSink(f.fetch)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      await f.mock.simulateDispute(req.extra.chargeId)
      const record = await f.store.get(req.extra.chargeId)
      expect(record?.paidAt).toBe(T0)
      expect(record?.disputedAt).toBe(T0)
      const calls = f.mock.calls.getCharge
      expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_disputed")
      expect(f.mock.calls.getCharge).toBe(calls)
    })

    test("refunded at the PSP → charge_refunded and recorded by settle", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      await f.mock.simulateRefund(req.extra.chargeId)
      expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_refunded")
      expect((await f.store.get(req.extra.chargeId))?.refundedAt).toBeNull()
      expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_refunded")
      expect((await f.store.get(req.extra.chargeId))?.refundedAt).toBe(T0)
      expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_refunded")
    })

    describe("webhooks", () => {
      test("paid webhook marks paid only when the PSP says PAID", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const id = req.extra.chargeId
        await f.mock.simulatePayment(id)
        f.advance(5_000)
        const res = await f.fetch(f.mock.webhookRequest("paid", id))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, applied: true })
        expect((await f.store.get(id))?.paidAt).toBe(T0)
      })

      test("forged completed webhook while the PSP says PENDING sets no paidAt", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const res = await f.fetch(f.mock.webhookRequest("paid", req.extra.chargeId))
        expect(res.status).toBe(200)
        expect((await f.store.get(req.extra.chargeId))?.paidAt).toBeNull()
        expect((await f.settle(f.body(req))).json.errorReason).toBe("settlement_pending")
      })

      test("duplicate envelope id is ignored and not re-applied", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const id = req.extra.chargeId
        await f.fetch(f.mock.webhookRequest("paid", id, { envelopeId: "log_dup" }))
        await f.mock.simulatePayment(id)
        const calls = f.mock.calls.getCharge
        const res = await f.fetch(f.mock.webhookRequest("paid", id, { envelopeId: "log_dup" }))
        expect(await res.json()).toEqual({ ok: true, duplicate: true })
        expect(f.mock.calls.getCharge).toBe(calls)
        expect((await f.store.get(id))?.paidAt).toBeNull()
      })

      test("unknown charge is ignored with 200", async () => {
        const f = setup(makeStore)
        await f.charge()
        const res = await f.fetch(f.mock.webhookRequest("paid", "pix_char_other"))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, ignored: true })
      })

      test("PSP error during a webhook applies nothing and returns 200", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        f.mock.failNextGetCharge(1)
        const res = await f.fetch(f.mock.webhookRequest("paid", req.extra.chargeId))
        expect(await res.json()).toEqual({ ok: true, applied: false })
        expect((await f.store.get(req.extra.chargeId))?.paidAt).toBeNull()
      })

      test("wrong or empty secret → 401", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        for (const secret of ["wrong", ""]) {
          const res = await f.fetch(f.mock.webhookRequest("paid", req.extra.chargeId, { secret }))
          expect(res.status).toBe(401)
          expect(await res.json()).toEqual({ error: "invalid_webhook_secret" })
        }
        expect((await f.store.get(req.extra.chargeId))?.paidAt).toBeNull()
      })

      test("bad payload → 400", async () => {
        const f = setup(makeStore)
        const res = await f.app.request("/webhooks/pix", {
          method: "POST",
          headers: { "X-Webhook-Secret": "mock-webhook-secret" },
          body: "{",
        })
        expect(res.status).toBe(400)
      })

      test("provider without parseWebhook → 404", async () => {
        const mock = createMockPixProvider()
        const bare: PixProvider = {
          name: mock.name,
          minAmount: mock.minAmount,
          minExpiresIn: mock.minExpiresIn,
          createCharge: mock.createCharge,
          getCharge: mock.getCharge,
        }
        const f = setup(makeStore, { provider: bare })
        const res = await f.fetch(mock.webhookRequest("paid", "x"))
        expect(res.status).toBe(404)
      })

      test("refunded webhook + PSP REFUNDED → sticky charge_refunded", async () => {
        const f = setup(makeStore)
        f.mock.setWebhookSink(f.fetch)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        await f.mock.simulateRefund(req.extra.chargeId)
        expect((await f.store.get(req.extra.chargeId))?.refundedAt).toBe(T0)
        const calls = f.mock.calls.getCharge
        expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_refunded")
        expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_refunded")
        expect(f.mock.calls.getCharge).toBe(calls)
      })

      test("disputed webhook while the PSP still says PAID sets no flag", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        const res = await f.fetch(f.mock.webhookRequest("disputed", req.extra.chargeId))
        expect(res.status).toBe(200)
        const record = await f.store.get(req.extra.chargeId)
        expect(record?.disputedAt).toBeNull()
        expect(record?.paidAt).toBe(T0)
        expect((await f.settle(f.body(req))).json.success).toBe(true)
      })

      test("oversized webhook body → 413", async () => {
        const f = setup(makeStore)
        const res = await f.app.request("/webhooks/pix", {
          method: "POST",
          headers: { "X-Webhook-Secret": "mock-webhook-secret" },
          body: JSON.stringify({ id: "log_big", event: "x", pad: "x".repeat(70_000) }),
        })
        expect(res.status).toBe(413)
        // the envelope id was never recorded
        expect(await f.store.recordWebhookEvent("log_big", T0)).toBe(true)
      })

      test("webhook does its own PSP call, not a stale in-flight one", async () => {
        const mock = createMockPixProvider({ now: () => T0 })
        let release: () => void = () => {}
        const gate = new Promise<void>((r) => {
          release = r
        })
        let started: () => void = () => {}
        const startedP = new Promise<void>((r) => {
          started = r
        })
        let first = true
        const slow: PixProvider = {
          name: mock.name,
          minAmount: mock.minAmount,
          minExpiresIn: mock.minExpiresIn,
          createCharge: mock.createCharge,
          parseWebhook: mock.parseWebhook,
          async getCharge(id) {
            const state = await mock.getCharge(id)
            if (first) {
              first = false
              started()
              await gate
            }
            return state
          },
        }
        const f = setup(makeStore, { provider: slow })
        const req = await f.charge()
        const id = req.extra.chargeId
        // verify reads PENDING, then stalls
        const pendingVerify = f.verify(f.body(req))
        await startedP
        await mock.simulatePayment(id)
        const res = await f.fetch(mock.webhookRequest("paid", id))
        expect(await res.json()).toEqual({ ok: true, applied: true })
        expect((await f.store.get(id))?.paidAt).toBe(T0)
        release()
        expect((await pendingVerify).json.invalidReason).toBe("settlement_pending")
        // the stale PENDING answer was not cached
        expect((await f.verify(f.body(req))).json.isValid).toBe(true)
        expect((await f.settle(f.body(req))).json.success).toBe(true)
      })
    })

    test("coalescing: concurrent verifies on one pending charge share one PSP call", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      const results = await Promise.all(Array.from({ length: 8 }, () => f.verify(f.body(req))))
      for (const r of results) expect(r.json.invalidReason).toBe("settlement_pending")
      expect(f.mock.calls.getCharge).toBe(1)
      // the pending answer is reused for pspCacheMs, then asked again
      await f.verify(f.body(req))
      expect(f.mock.calls.getCharge).toBe(1)
      f.advance(1_000)
      await f.verify(f.body(req))
      expect(f.mock.calls.getCharge).toBe(2)
    })

    test("pspCacheMs = 0 disables reuse", async () => {
      const f = setup(makeStore, { pspCacheMs: 0 })
      const req = await f.charge()
      await f.verify(f.body(req))
      await f.verify(f.body(req))
      expect(f.mock.calls.getCharge).toBe(2)
    })

    test("dev simulate route is 404 unless enabled", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      const path = `/dev/charges/${req.extra.chargeId}/simulate-payment`
      expect((await f.post(path, {}, null)).status).toBe(404)

      const g = setup(makeStore, { devSimulate: true })
      g.mock.setWebhookSink(g.fetch)
      const r2 = await g.charge()
      const ok = await g.post(`/dev/charges/${r2.extra.chargeId}/simulate-payment`, {}, null)
      expect(ok.status).toBe(200)
      expect((await g.store.get(r2.extra.chargeId))?.paidAt).toBe(T0)
      expect((await g.settle(g.body(r2))).json.success).toBe(true)
      expect((await g.post("/dev/charges/unknown/simulate-payment", {}, null)).status).toBe(404)

      // enabled, but the provider cannot simulate
      const mock = createMockPixProvider({ now: () => T0 })
      const noSim: PixProvider = {
        name: mock.name,
        minAmount: mock.minAmount,
        minExpiresIn: mock.minExpiresIn,
        createCharge: mock.createCharge,
        getCharge: mock.getCharge,
      }
      const h = setup(makeStore, { devSimulate: true, provider: noSim })
      const r3 = await h.charge()
      const res = await h.post(`/dev/charges/${r3.extra.chargeId}/simulate-payment`, {}, null)
      expect(res.status).toBe(404)
      expect(mock.peek(r3.extra.chargeId)?.status).toBe("PENDING")
    })
  })
}
