import { describe, expect, test } from "bun:test"
import {
  type PixPaymentRequirements,
  Px402Error,
  type SettlementResponse,
  SupportedResponseSchema,
  type VerifyResponse,
} from "@p-x402/core"
import {
  createMockPixProvider,
  type MockPixProvider,
  type PixCharge,
  type PixChargeStatus,
  type PixProvider,
  signAbacatePayWebhook,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "@p-x402/psp"
import { createFacilitator, type FacilitatorMerchant, type FacilitatorOptions } from "../src/app"
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

  async function post(
    path: string,
    body: unknown,
    token: string | null = "tok-loja1",
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders }
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

  async function settle(b: unknown, token = "tok-loja1", idempotencyKey?: string) {
    const headers: Record<string, string> =
      idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }
    const res = await post("/settle", b, token, headers)
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

/** A provider that delegates to `mock` except for the given overrides. */
function wrapProvider(mock: MockPixProvider, overrides: Partial<PixProvider>): PixProvider {
  return {
    name: mock.name,
    minAmount: mock.minAmount,
    minExpiresIn: mock.minExpiresIn,
    createCharge: mock.createCharge,
    getCharge: mock.getCharge,
    parseWebhook: mock.parseWebhook,
    ...overrides,
  }
}

/** A provider whose getCharge reports `paidAt` (or none at all) for a PAID charge. */
function withPaidAt(mock: MockPixProvider, paidAt: string | undefined): PixProvider {
  return wrapProvider(mock, {
    async getCharge(id) {
      const state = await mock.getCharge(id)
      if (paidAt === undefined) delete state.paidAt
      else if (state.status === "PAID") state.paidAt = paidAt
      return state
    },
  })
}

/** Signed webhook request carrying `raw` as its body. */
async function signedWebhook(raw: string): Promise<Request> {
  return new Request("http://facilitator.local/webhooks/pix", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WEBHOOK_SECRET_HEADER]: "mock-webhook-secret",
      [WEBHOOK_SIGNATURE_HEADER]: await signAbacatePayWebhook(raw),
    },
    body: raw,
  })
}

const backends: [string, () => ChargeStore][] = [
  ["memoryStore", memoryStore],
  ["bunSqliteStore", () => bunSqliteStore(":memory:")],
]

describe("createFacilitator merchant validation", () => {
  const ok = { id: "a", token: "tok-a", payTo: "a" }
  const cases: [string, FacilitatorMerchant[]][] = [
    ["no merchants", []],
    ["empty id", [{ ...ok, id: "" }]],
    ["empty token", [{ ...ok, token: "" }]],
    ["empty payTo", [{ ...ok, payTo: "" }]],
    ["duplicate ids", [ok, { id: "a", token: "tok-b", payTo: "b" }]],
    ["duplicate tokens", [ok, { id: "b", token: "tok-a", payTo: "b" }]],
  ]
  for (const [name, merchants] of cases) {
    test(`${name} → throws`, () => {
      const make = () =>
        createFacilitator({ provider: createMockPixProvider(), store: memoryStore(), merchants })
      expect(make).toThrow(/^facilitator: /)
    })
  }

  test("distinct, non-empty merchants are accepted", () => {
    const merchants = [ok, { id: "b", token: "tok-b", payTo: "b" }]
    expect(() =>
      createFacilitator({ provider: createMockPixProvider(), store: memoryStore(), merchants }),
    ).not.toThrow()
  })
})

for (const [storeName, makeStore] of backends) {
  describe(`facilitator (${storeName})`, () => {
    /** A fresh store that counts insert calls. */
    function countingStore() {
      const inner = makeStore()
      const counts = { insert: 0 }
      const store: ChargeStore = {
        ...inner,
        async insert(record) {
          counts.insert++
          return inner.insert(record)
        },
      }
      return { store, counts }
    }

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

    test("chargeTtlSeconds 600: requirements carrying 600 verify and settle", async () => {
      const f = setup(makeStore, { chargeTtlSeconds: 600 })
      const req = await f.charge()
      expect(req.maxTimeoutSeconds).toBe(600)
      await f.mock.simulatePayment(req.extra.chargeId)
      expect((await f.verify(f.body(req))).json).toEqual({ isValid: true })
      expect((await f.settle(f.body(req))).json.success).toBe(true)
    })

    test("maxTimeoutSeconds other than the charge TTL → requirements_mismatch", async () => {
      const f = setup(makeStore, { chargeTtlSeconds: 600 })
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      const b = f.body(req)
      b.paymentPayload.accepted.maxTimeoutSeconds = 300
      b.paymentRequirements.maxTimeoutSeconds = 300
      expect((await f.verify(b)).json.invalidReason).toBe("requirements_mismatch")
      expect((await f.settle(b)).json.errorReason).toBe("requirements_mismatch")
      expect((await f.store.get(req.extra.chargeId))?.consumedAt).toBeNull()
    })

    test("POST /pix/charges leaves brCodeBase64 out of the requirements", async () => {
      const mock = createMockPixProvider({ now: () => T0 })
      const withQr = wrapProvider(mock, {
        async createCharge(input) {
          return { ...(await mock.createCharge(input)), brCodeBase64: "data:image/png;base64,AAAA" }
        },
      })
      const f = setup(makeStore, { provider: withQr })
      const res = await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "500" })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { paymentRequirements: PixPaymentRequirements }
      expect(json.paymentRequirements.extra).not.toHaveProperty("brCodeBase64")
      expect(JSON.stringify(json)).not.toContain("base64")
    })

    test("store.insert failure after the PSP charge → 500 unexpected_error (our fault, not the PSP's)", async () => {
      const inner = makeStore()
      const store: ChargeStore = {
        ...inner,
        async insert() {
          throw new Error("disk full")
        },
      }
      const f = setup(() => store)
      const res = await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "500" })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "unexpected_error" })
      expect(f.mock.calls.createCharge).toBe(1)
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
      const { store, counts } = countingStore()
      const f = setup(() => store, { provider: failing })
      const res = await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "500" })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "psp_error" })
      expect(counts.insert).toBe(0)
    })

    describe("PSP returned an unusable charge → 502 psp_error and no record", () => {
      const cases: [string, (c: PixCharge) => PixCharge][] = [
        ["amount differs", (c) => ({ ...c, amount: c.amount + 1 })],
        ["empty brCode", (c) => ({ ...c, brCode: "" })],
        ["expiresAt not a date", (c) => ({ ...c, expiresAt: "not-a-date" })],
      ]
      for (const [name, tamper] of cases) {
        test(name, async () => {
          const mock = createMockPixProvider({ now: () => T0 })
          const bad = wrapProvider(mock, {
            async createCharge(input) {
              return tamper(await mock.createCharge(input))
            },
          })
          const { store, counts } = countingStore()
          const f = setup(() => store, { provider: bad })
          const res = await f.post("/pix/charges", { resource: { url: RESOURCE }, amount: "500" })
          expect(res.status).toBe(502)
          expect(await res.json()).toEqual({ error: "psp_error" })
          expect(mock.calls.createCharge).toBe(1)
          expect(counts.insert).toBe(0)
          expect(await store.get("pix_char_mock_0001")).toBeUndefined()
        })
      }
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

    /**
     * Every request reads the unconsumed record before any PSP answer is released, so all of them
     * reach consume(). The PSP call is coalesced, so the gate opens once all N have read the record
     * (and getCharge was entered), not after N getCharge calls.
     */
    function racingSetup(n: number) {
      const mock = createMockPixProvider({ now: () => T0 })
      const inner = makeStore()
      let armed = false
      let reads = 0
      let entered = 0
      let open: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      const store: ChargeStore = {
        ...inner,
        async get(id) {
          const record = await inner.get(id)
          if (armed && ++reads === n) open()
          return record
        },
      }
      const provider = wrapProvider(mock, {
        async getCharge(id) {
          const state = await mock.getCharge(id)
          if (armed) {
            entered++
            await gate
          }
          return state
        },
      })
      const f = setup(() => store, { provider })
      return {
        f,
        mock,
        arm: () => {
          armed = true
        },
        stats: () => ({ reads, entered }),
      }
    }

    test("N concurrent /settle racing past the checks → exactly one success", async () => {
      const n = 5
      const { f, mock, arm, stats } = racingSetup(n)
      const req = await f.charge()
      await mock.simulatePayment(req.extra.chargeId)
      arm()
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => f.settle(f.body(req), "tok-loja1", `key-${i}`)),
      )
      expect(stats().reads).toBeGreaterThanOrEqual(n)
      expect(stats().entered).toBeGreaterThanOrEqual(1)
      const reasons = results.map((r) => r.json.errorReason ?? "ok").sort()
      expect(reasons).toEqual([...Array(n - 1).fill("charge_already_consumed"), "ok"])
      const winner = results.findIndex((r) => r.json.success)
      expect((await f.store.get(req.extra.chargeId))?.consumedKey).toBe(`key-${winner}`)
    })

    test("concurrent /settle retries with one Idempotency-Key all get the same success", async () => {
      const n = 3
      const { f, mock, arm } = racingSetup(n)
      const req = await f.charge()
      await mock.simulatePayment(req.extra.chargeId)
      arm()
      const results = await Promise.all(
        Array.from({ length: n }, () => f.settle(f.body(req), "tok-loja1", "same-key")),
      )
      for (const r of results) {
        expect(r.json).toEqual({
          success: true,
          transaction: req.extra.chargeId,
          network: "pix:br",
          amount: "500",
        })
      }
    })

    describe("settle idempotency", () => {
      test("same key replays the same success; other key or no key → consumed", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        const first = await f.settle(f.body(req), "tok-loja1", "abc-123_XYZ")
        const expected = {
          success: true,
          transaction: req.extra.chargeId,
          network: "pix:br",
          amount: "500",
        }
        expect(first).toEqual({ status: 200, json: expected })
        expect((await f.store.get(req.extra.chargeId))?.consumedKey).toBe("abc-123_XYZ")
        const calls = f.mock.calls.getCharge
        f.advance(60_000)
        expect(await f.settle(f.body(req), "tok-loja1", "abc-123_XYZ")).toEqual({
          status: 200,
          json: expected,
        })
        // the replay does not ask the PSP or move consumedAt
        expect(f.mock.calls.getCharge).toBe(calls)
        expect((await f.store.get(req.extra.chargeId))?.consumedAt).toBe(T0)

        const consumed = {
          success: false,
          errorReason: "charge_already_consumed",
          transaction: req.extra.chargeId,
          network: "pix:br",
        }
        expect((await f.settle(f.body(req), "tok-loja1", "other-key")).json).toEqual(consumed)
        expect((await f.settle(f.body(req))).json).toEqual(consumed)
        // /verify is unaffected
        expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_already_consumed")
      })

      test("same key from another merchant or with other requirements is not a replay", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        expect((await f.settle(f.body(req), "tok-loja1", "k1")).json.success).toBe(true)
        expect((await f.settle(f.body(req), "tok-loja2", "k1")).json.errorReason).toBe(
          "merchant_mismatch",
        )
        const b = f.body(req)
        b.paymentPayload.accepted.extra.resourceUrl = "https://api.example/other"
        b.paymentRequirements.extra.resourceUrl = "https://api.example/other"
        expect((await f.settle(b, "tok-loja1", "k1")).json.errorReason).toBe("resource_mismatch")
      })

      test("a key cannot claim a charge consumed without one", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        expect((await f.settle(f.body(req))).json.success).toBe(true)
        expect((await f.store.get(req.extra.chargeId))?.consumedKey).toBeNull()
        expect((await f.settle(f.body(req), "tok-loja1", "late-key")).json.errorReason).toBe(
          "charge_already_consumed",
        )
      })

      test("malformed Idempotency-Key → 400 invalid_request, nothing consumed", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        for (const key of ["", "has space", "a/b", "a.b", "x".repeat(129)]) {
          expect(await f.settle(f.body(req), "tok-loja1", key)).toEqual({
            status: 400,
            json: {
              success: false,
              errorReason: "invalid_request",
              transaction: "",
              network: "pix:br",
            },
          })
        }
        expect((await f.store.get(req.extra.chargeId))?.consumedAt).toBeNull()
        const longest = "k".repeat(128)
        expect((await f.settle(f.body(req), "tok-loja1", longest)).json.success).toBe(true)
        expect((await f.store.get(req.extra.chargeId))?.consumedKey).toBe(longest)
      })
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
        [
          "wrong payload version",
          (b) => {
            b.paymentPayload.x402Version = 1
          },
          "invalid_x402_version",
        ],
        [
          // FacilitatorRequestSchema takes any scheme string (spec-level requirements), so this is
          // not a 400 invalid_payload: pixKindCheck refuses it as unsupported_scheme.
          "scheme upto",
          (b) => {
            b.paymentRequirements.scheme = "upto" as "exact"
          },
          "unsupported_scheme",
        ],
        [
          "wrong accepted network",
          (b) => {
            b.paymentPayload.accepted.network = "eip155:8453" as "pix:br"
          },
          "unsupported_network",
        ],
        [
          "paymentFlow missing on both sides",
          (b) => {
            delete (b.paymentPayload.accepted.extra as { paymentFlow?: string }).paymentFlow
            delete (b.paymentRequirements.extra as { paymentFlow?: string }).paymentFlow
          },
          "invalid_payment_requirements",
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

    test("PSP UNDER_DISPUTE with no webhook → charge_disputed and recorded by settle", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      await f.mock.simulateDispute(req.extra.chargeId)
      expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_disputed")
      expect((await f.store.get(req.extra.chargeId))?.disputedAt).toBeNull()
      f.advance(1_000)
      expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_disputed")
      const record = await f.store.get(req.extra.chargeId)
      expect(record?.disputedAt).toBe(T0 + 1_000)
      expect(record?.consumedAt).toBeNull()
      expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_disputed")
    })

    for (const status of ["PENDING", "UNKNOWN"] as const) {
      test(`PSP stuck at ${status} past expiresAt → charge_expired`, async () => {
        const mock = createMockPixProvider({ now: () => T0 })
        const stuck = wrapProvider(mock, {
          async getCharge(id) {
            return { ...(await mock.getCharge(id)), status }
          },
        })
        const f = setup(makeStore, { provider: stuck })
        const req = await f.charge()
        await mock.simulatePayment(req.extra.chargeId)
        expect((await f.verify(f.body(req))).json.invalidReason).toBe("settlement_pending")
        f.advance(300_001)
        expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_expired")
        expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_expired")
        expect((await f.store.get(req.extra.chargeId))?.consumedAt).toBeNull()
      })
    }

    for (const status of ["CANCELLED", "FAILED"] as const) {
      test(`PSP ${status} → charge_failed, nothing consumed`, async () => {
        const mock = createMockPixProvider({ now: () => T0 })
        const dead = wrapProvider(mock, {
          async getCharge(id) {
            return { ...(await mock.getCharge(id)), status: status as PixChargeStatus }
          },
        })
        const f = setup(makeStore, { provider: dead })
        const req = await f.charge()
        expect((await f.verify(f.body(req))).json).toEqual({
          isValid: false,
          invalidReason: "charge_failed",
        })
        expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_failed")
        const record = await f.store.get(req.extra.chargeId)
        expect(record?.consumedAt).toBeNull()
        expect(record?.paidAt).toBeNull()
      })
    }

    test("PSP PAID without paidAt: verify writes nothing, settle records now()", async () => {
      // The AbacatePay path: getCharge never reports paidAt.
      const mock = createMockPixProvider({ now: () => T0 })
      const f = setup(makeStore, { provider: withPaidAt(mock, undefined) })
      const req = await f.charge()
      await mock.simulatePayment(req.extra.chargeId)
      f.advance(1_000)
      expect((await f.verify(f.body(req))).json).toEqual({ isValid: true })
      expect((await f.store.get(req.extra.chargeId))?.paidAt).toBeNull()
      expect((await f.settle(f.body(req))).json.success).toBe(true)
      const record = await f.store.get(req.extra.chargeId)
      expect(record?.paidAt).toBe(f.now())
      expect(record?.consumedAt).toBe(f.now())
    })

    test("PSP PAID without paidAt: the grace runs from expiresAt", async () => {
      const mock = createMockPixProvider({ now: () => T0 })
      const f = setup(makeStore, { provider: withPaidAt(mock, undefined) })
      const inGrace = await f.charge()
      const late = await f.charge()
      await mock.simulatePayment(inGrace.extra.chargeId)
      await mock.simulatePayment(late.extra.chargeId)
      const expiresAt = Date.parse(inGrace.extra.expiresAt)
      f.advance(expiresAt + 86_400_000 - 1 - T0)
      expect((await f.settle(f.body(inGrace))).json.success).toBe(true)
      expect((await f.store.get(inGrace.extra.chargeId))?.paidAt).toBe(f.now())
      f.advance(2)
      // runChecks refuses past expiresAt + grace without asking the PSP
      const calls = mock.calls.getCharge
      expect((await f.verify(f.body(late))).json.invalidReason).toBe("charge_expired")
      expect((await f.settle(f.body(late))).json.errorReason).toBe("charge_expired")
      expect(mock.calls.getCharge).toBe(calls)
      const record = await f.store.get(late.extra.chargeId)
      expect(record?.paidAt).toBeNull()
      expect(record?.consumedAt).toBeNull()
    })

    describe("applyState clamps a PSP paidAt in the future to now()", () => {
      const future = new Date(T0 + 86_400_000).toISOString()
      const past = new Date(T0 - 5_000).toISOString()
      for (const [label, paidAt, expected] of [
        ["future", future, "now"],
        ["past", past, T0 - 5_000],
      ] as const) {
        for (const via of ["settle", "webhook"] as const) {
          test(`${label} paidAt via ${via}`, async () => {
            const mock = createMockPixProvider({ now: () => T0 })
            const f = setup(makeStore, { provider: withPaidAt(mock, paidAt) })
            const req = await f.charge()
            const id = req.extra.chargeId
            await mock.simulatePayment(id)
            f.advance(1_000)
            if (via === "settle") {
              expect((await f.settle(f.body(req))).json.success).toBe(true)
            } else {
              const res = await f.fetch(await mock.webhookRequest("paid", id))
              expect(await res.json()).toEqual({ ok: true, applied: true })
            }
            expect((await f.store.get(id))?.paidAt).toBe(expected === "now" ? f.now() : expected)
          })
        }
      }
    })

    test("past expiresAt + grace the PSP is not asked at all", async () => {
      const f = setup(makeStore)
      const req = await f.charge()
      await f.mock.simulatePayment(req.extra.chargeId)
      f.advance(300_000 + 86_400_000 + 1)
      const calls = f.mock.calls.getCharge
      for (let i = 0; i < 5; i++) {
        expect((await f.verify(f.body(req))).json.invalidReason).toBe("charge_expired")
        expect((await f.settle(f.body(req))).json.errorReason).toBe("charge_expired")
      }
      expect(f.mock.calls.getCharge).toBe(calls)
    })

    for (const kind of ["dispute", "refund"] as const) {
      test(`a ${kind} recorded while settle waits on the PSP stops the consume`, async () => {
        const mock = createMockPixProvider({ now: () => T0 })
        let store: ChargeStore | undefined
        const racing = wrapProvider(mock, {
          async getCharge(id) {
            const state = await mock.getCharge(id)
            // A webhook lands between runChecks' flag check and consume.
            if (kind === "dispute") await store?.markDisputed(id, T0)
            else await store?.markRefunded(id, T0)
            return state
          },
        })
        const f = setup(makeStore, { provider: racing })
        store = f.store
        const req = await f.charge()
        await mock.simulatePayment(req.extra.chargeId)
        const result = await f.settle(f.body(req))
        expect(result.json.success).toBe(false)
        expect(result.json.errorReason).toBe(
          kind === "dispute" ? "charge_disputed" : "charge_refunded",
        )
        expect((await f.store.get(req.extra.chargeId))?.consumedAt).toBeNull()
      })
    }

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
        const res = await f.fetch(await f.mock.webhookRequest("paid", id))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, applied: true })
        expect((await f.store.get(id))?.paidAt).toBe(T0)
      })

      test("forged completed webhook while the PSP says PENDING sets no paidAt", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const res = await f.fetch(await f.mock.webhookRequest("paid", req.extra.chargeId))
        expect(res.status).toBe(200)
        expect((await f.store.get(req.extra.chargeId))?.paidAt).toBeNull()
        expect((await f.settle(f.body(req))).json.errorReason).toBe("settlement_pending")
      })

      test("duplicate envelope id is ignored and not re-applied", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const id = req.extra.chargeId
        await f.fetch(await f.mock.webhookRequest("paid", id, { envelopeId: "log_dup" }))
        await f.mock.simulatePayment(id)
        const calls = f.mock.calls.getCharge
        const res = await f.fetch(
          await f.mock.webhookRequest("paid", id, { envelopeId: "log_dup" }),
        )
        expect(await res.json()).toEqual({ ok: true, duplicate: true })
        expect(f.mock.calls.getCharge).toBe(calls)
        expect((await f.store.get(id))?.paidAt).toBeNull()
      })

      test("unknown charge is ignored with 200", async () => {
        const f = setup(makeStore)
        await f.charge()
        const res = await f.fetch(await f.mock.webhookRequest("paid", "pix_char_other"))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, ignored: true })
      })

      test("PSP error during a webhook → 503, and the redelivery is processed", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const id = req.extra.chargeId
        await f.mock.simulatePayment(id)
        f.mock.failNextGetCharge(1)
        const res = await f.fetch(
          await f.mock.webhookRequest("paid", id, { envelopeId: "log_retry" }),
        )
        expect(res.status).toBe(503)
        expect((await f.store.get(id))?.paidAt).toBeNull()
        f.advance(2_000)
        const again = await f.fetch(
          await f.mock.webhookRequest("paid", id, { envelopeId: "log_retry" }),
        )
        expect(again.status).toBe(200)
        expect(await again.json()).toEqual({ ok: true, applied: true })
        expect((await f.store.get(id))?.paidAt).toBe(T0)
        // and now it is a duplicate
        const third = await f.fetch(
          await f.mock.webhookRequest("paid", id, { envelopeId: "log_retry" }),
        )
        expect(await third.json()).toEqual({ ok: true, duplicate: true })
      })

      test("store failure during a webhook → 503, and the redelivery is processed", async () => {
        const inner = makeStore()
        let failGet = false
        const store: ChargeStore = {
          ...inner,
          async get(id) {
            if (failGet) {
              failGet = false
              throw new Error("db locked")
            }
            return inner.get(id)
          },
        }
        const f = setup(() => store)
        const req = await f.charge()
        const id = req.extra.chargeId
        await f.mock.simulatePayment(id)
        failGet = true
        const res = await f.fetch(await f.mock.webhookRequest("paid", id, { envelopeId: "log_db" }))
        expect(res.status).toBe(503)
        const again = await f.fetch(
          await f.mock.webhookRequest("paid", id, { envelopeId: "log_db" }),
        )
        expect(await again.json()).toEqual({ ok: true, applied: true })
        expect((await f.store.get(id))?.paidAt).toBe(T0)
      })

      test("wrong or empty secret → 401", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        await f.mock.simulatePayment(req.extra.chargeId)
        for (const secret of ["wrong", ""]) {
          const res = await f.fetch(
            await f.mock.webhookRequest("paid", req.extra.chargeId, { secret }),
          )
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

      test("correctly signed body that is not JSON → 400", async () => {
        const f = setup(makeStore)
        const res = await f.fetch(await signedWebhook("{"))
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: "invalid_webhook_payload" })
      })

      test("right secret, wrong signature → 400 and the envelope id is not recorded", async () => {
        const f = setup(makeStore)
        const req = await f.charge()
        const id = req.extra.chargeId
        await f.mock.simulatePayment(id)
        const forged = await f.mock.webhookRequest("paid", id, {
          envelopeId: "log_sig",
          signature: "AAAA",
        })
        const res = await f.fetch(forged)
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: "invalid_webhook_payload" })
        expect((await f.store.get(id))?.paidAt).toBeNull()
        // a valid delivery with the same envelope id is processed, not a duplicate
        const valid = await f.fetch(
          await f.mock.webhookRequest("paid", id, { envelopeId: "log_sig" }),
        )
        expect(await valid.json()).toEqual({ ok: true, applied: true })
        expect((await f.store.get(id))?.paidAt).toBe(T0)
      })

      test("an event of another kind without a charge is ignored with 200", async () => {
        const f = setup(makeStore)
        const raw = JSON.stringify({ id: "log_other", event: "billing.paid" })
        const res = await f.fetch(await signedWebhook(raw))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true, ignored: true })
        expect(f.mock.calls.getCharge).toBe(0)
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
        const res = await f.fetch(await mock.webhookRequest("paid", "x"))
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
        const res = await f.fetch(await f.mock.webhookRequest("disputed", req.extra.chargeId))
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
        const res = await f.fetch(await mock.webhookRequest("paid", id))
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

    test("dev simulate: provider simulatePayment failure → 502 psp_error", async () => {
      const mock = createMockPixProvider({ now: () => T0 })
      const broken = wrapProvider(mock, {
        async simulatePayment() {
          throw new Px402Error("psp_error", "sandbox down")
        },
      })
      const f = setup(makeStore, { devSimulate: true, provider: broken })
      const req = await f.charge()
      const res = await f.post(`/dev/charges/${req.extra.chargeId}/simulate-payment`, {}, null)
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: "psp_error" })
      expect(mock.peek(req.extra.chargeId)?.status).toBe("PENDING")
    })
  })
}
