import { describe, expect, test } from "bun:test"
import { type FetchLike, isPx402Error, type Px402ErrorCode } from "@p-x402/core"
import { createAbacatePayProvider, type PixProvider } from "../src"

const KEY = "abc_test_SECRETKEY123"
const BASE = "https://api.abacatepay.test/v2"

interface Recorded {
  method: string
  url: string
  headers: Headers
  body: string
}

function stub(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Recorded[] = []
  const fetch: FetchLike = async (request) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.clone().text(),
    })
    return respond(request)
  }
  return { fetch, requests }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function provider(fetch: FetchLike, extra: { webhookSecret?: string; timeoutMs?: number } = {}) {
  return createAbacatePayProvider({ apiKey: KEY, baseUrl: BASE, fetch, ...extra })
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected a rejection")
}

async function expectCode(promise: Promise<unknown>, code: Px402ErrorCode) {
  const error = await catchError(promise)
  expect(isPx402Error(error) && error.code).toBe(code)
  return error
}

const created = {
  id: "pix_char_abc123",
  status: "PENDING",
  brCode: "00020101021226...6304ABCD",
  brCodeBase64: "data:image/png;base64,iVBORw0KGgo=",
  expiresAt: "2026-11-25T12:05:00.000Z",
  amount: 500,
}

describe("AbacatePay provider", () => {
  test("throws at creation without an apiKey", () => {
    expect(() => createAbacatePayProvider({ apiKey: "" })).toThrow()
    expect(() => createAbacatePayProvider({ apiKey: "  " })).toThrow()
  })

  test("exposes name and minimums", () => {
    const p = provider(stub(() => json({})).fetch)
    expect(p.name).toBe("abacatepay")
    expect(p.minAmount).toBe(100)
    expect(p.minExpiresIn).toBe(300)
  })

  test("createCharge sends method, URL, bearer and exact body, and maps the response", async () => {
    const s = stub(() => json({ data: created, error: null }))
    const charge = await provider(s.fetch).createCharge({
      amount: 500,
      expiresIn: 300,
      description: "Relatório",
      externalId: "ext-1",
      metadata: { merchantId: "loja1" },
    })
    expect(s.requests).toHaveLength(1)
    const [r] = s.requests
    expect(r?.method).toBe("POST")
    expect(r?.url).toBe(`${BASE}/transparents/create`)
    expect(r?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(r?.headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(r?.body ?? "")).toEqual({
      method: "PIX",
      data: {
        amount: 500,
        expiresIn: 300,
        description: "Relatório",
        externalId: "ext-1",
        metadata: { merchantId: "loja1" },
      },
    })
    expect(charge).toEqual({
      id: "pix_char_abc123",
      status: "PENDING",
      amount: 500,
      brCode: created.brCode,
      brCodeBase64: created.brCodeBase64,
      expiresAt: created.expiresAt,
    })
  })

  test("createCharge accepts a response without amount, brCodeBase64 or error field", async () => {
    const { amount: _a, brCodeBase64: _b, ...rest } = created
    const s = stub(() => json({ data: rest }))
    const charge = await provider(s.fetch).createCharge({
      amount: 700,
      expiresIn: 300,
      externalId: "e",
    })
    expect(charge.amount).toBe(700)
    expect("brCodeBase64" in charge).toBe(false)
  })

  test("createCharge refuses a response whose amount differs", async () => {
    const s = stub(() => json({ data: { ...created, amount: 1 }, error: null }))
    await expectCode(
      provider(s.fetch).createCharge({ amount: 500, expiresIn: 300, externalId: "e" }),
      "psp_error",
    )
  })

  test("getCharge maps every status", async () => {
    const cases: [string, string][] = [
      ["PENDING", "PENDING"],
      ["EXPIRED", "EXPIRED"],
      ["CANCELLED", "CANCELLED"],
      ["PAID", "PAID"],
      ["UNDER_DISPUTE", "UNDER_DISPUTE"],
      ["REFUNDED", "REFUNDED"],
      ["FAILED", "FAILED"],
      ["APPROVED", "UNKNOWN"],
      ["REDEEMED", "UNKNOWN"],
      ["SOMETHING_NEW", "UNKNOWN"],
      ["toString", "UNKNOWN"],
    ]
    for (const [psp, ours] of cases) {
      const s = stub(() =>
        json({ data: { id: "pix_char_1", status: psp, expiresAt: created.expiresAt } }),
      )
      const state = await provider(s.fetch).getCharge("pix_char_1")
      expect(state).toEqual({
        id: "pix_char_1",
        status: ours as never,
        expiresAt: created.expiresAt,
      })
    }
  })

  test("getCharge sends GET with a URL-encoded id and the bearer", async () => {
    const id = "pix_char_a&b=c/d e"
    const s = stub(() => json({ data: { id, status: "PAID" }, error: null }))
    const state = await provider(s.fetch).getCharge(id)
    const [r] = s.requests
    expect(r?.method).toBe("GET")
    expect(r?.url).toBe(`${BASE}/transparents/check?id=${encodeURIComponent(id)}`)
    expect(new URL(r?.url ?? "").searchParams.get("id")).toBe(id)
    expect(r?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(state).toEqual({ id, status: "PAID" })
  })

  test("getCharge refuses an answer about another charge", async () => {
    const s = stub(() => json({ data: { id: "pix_char_other", status: "PAID" } }))
    await expectCode(provider(s.fetch).getCharge("pix_char_1"), "psp_error")
  })

  test("simulatePayment posts to the simulate URL", async () => {
    const s = stub(() => json({ data: { id: "pix_char_1", status: "PAID" }, error: null }))
    await provider(s.fetch).simulatePayment?.("pix_char_1")
    const [r] = s.requests
    expect(r?.method).toBe("POST")
    expect(r?.url).toBe(`${BASE}/transparents/simulate-payment?id=pix_char_1`)
    expect(r?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("simulatePayment URL-encodes the id", async () => {
    const id = "pix_char_a&b=c"
    const s = stub(() => json({ data: {}, error: null }))
    await provider(s.fetch).simulatePayment?.(id)
    expect(s.requests).toHaveLength(1)
    expect(new URL(s.requests[0]?.url ?? "").searchParams.get("id")).toBe(id)
  })

  test("requests refuse redirects so the bearer key is never forwarded", async () => {
    const modes: string[] = []
    const s = stub((request) => {
      modes.push(request.redirect)
      return json({ data: { id: "x", status: "PENDING" } })
    })
    await provider(s.fetch).getCharge("x")
    expect(modes).toEqual(["error"])
  })

  test("trailing slash in baseUrl is tolerated", async () => {
    const s = stub(() => json({ data: { id: "x", status: "PENDING" } }))
    await createAbacatePayProvider({ apiKey: KEY, baseUrl: `${BASE}/`, fetch: s.fetch }).getCharge(
      "x",
    )
    expect(s.requests[0]?.url).toBe(`${BASE}/transparents/check?id=x`)
  })

  describe("failures map to psp_error without leaking the key", () => {
    const failures: [string, FetchLike, number][] = [
      ["429", async () => json({ data: null, error: "Too many requests" }, 429), 429],
      ["500", async () => json({ data: null, error: `bad key ${KEY}` }, 500), 500],
      ["503 non-JSON", async () => new Response("<html>down</html>", { status: 503 }), 503],
      [
        "network throw",
        async () => {
          throw new TypeError(`connect failed with Bearer ${KEY}`)
        },
        0,
      ],
      ["bad JSON", async () => new Response("{not json", { status: 200 }), 200],
      ["wrong shape", async () => json({ data: { id: 1 } }), 200],
      ["no data", async () => json({ hello: "world" }), 200],
      ["array body", async () => json([1, 2]), 200],
      ["error field", async () => json({ data: null, error: "Invalid amount" }), 200],
      ["error field with data", async () => json({ data: created, error: "oops" }), 200],
    ]
    for (const [name, fetch, status] of failures) {
      test(name, async () => {
        const p = provider(fetch)
        for (const run of [
          () => p.getCharge("pix_char_abc123"),
          () => p.createCharge({ amount: 500, expiresIn: 300, externalId: "e" }),
        ]) {
          const error = await expectCode(run(), "psp_error")
          if (!isPx402Error(error)) throw new Error("unreachable")
          expect(error.details).toEqual({ status })
          expect(error.message).not.toContain(KEY)
          expect(JSON.stringify(error.details)).not.toContain(KEY)
          expect(String(error.stack)).not.toContain(KEY)
        }
      })
    }

    test("timeout", async () => {
      const hang: FetchLike = (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason))
        })
      const error = await expectCode(
        provider(hang, { timeoutMs: 5 }).getCharge("pix_char_1"),
        "psp_error",
      )
      if (!isPx402Error(error)) throw new Error("unreachable")
      expect(error.message).toContain("timed out")
      expect(error.message).not.toContain(KEY)
      expect(error.details).toEqual({ status: 0 })
    })

    test("timeout is enforced even when fetch ignores the signal", async () => {
      const hang: FetchLike = () => new Promise(() => {})
      const p = provider(hang, { timeoutMs: 5 })
      for (const run of [
        () => p.getCharge("pix_char_1"),
        () => p.createCharge({ amount: 500, expiresIn: 300, externalId: "e" }),
      ]) {
        const error = await expectCode(run(), "psp_error")
        if (!isPx402Error(error)) throw new Error("unreachable")
        expect(error.message).toContain("timed out")
        expect(error.details).toEqual({ status: 0 })
      }
    })

    test("simulatePayment failure is psp_error", async () => {
      const p = provider(async () => json({ data: null, error: "test mode only" }, 403))
      const error = await expectCode(
        p.simulatePayment?.("pix_char_1") ?? Promise.resolve(),
        "psp_error",
      )
      if (!isPx402Error(error)) throw new Error("unreachable")
      expect(error.details).toEqual({ status: 403 })
    })
  })

  describe("webhooks", () => {
    const SECRET = "whsec_test"

    function hook(body: unknown, secret: string | null = SECRET): Request {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (secret !== null) headers["X-Webhook-Secret"] = secret
      return new Request("http://facilitator.local/webhooks/pix", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    }

    function envelope(event: string) {
      return {
        id: "log_123",
        event,
        apiVersion: 2,
        devMode: true,
        data: {
          transparent: { id: "pix_char_abc123", amount: 500, status: "PAID" },
          customer: { name: "Fulano de Tal", taxId: "123.***.***-00" },
          payerInformation: { name: "Fulano de Tal", taxId: "123.***.***-00" },
        },
      }
    }

    function withSecret(): PixProvider {
      return provider(stub(() => json({})).fetch, { webhookSecret: SECRET })
    }

    test("no parseWebhook without a secret", () => {
      const f = stub(() => json({})).fetch
      for (const webhookSecret of [undefined, "", "   "]) {
        const p =
          webhookSecret === undefined ? provider(f) : provider(f, { webhookSecret: webhookSecret })
        expect("parseWebhook" in p).toBe(false)
      }
    })

    test("transparent.completed parses and drops payer data", async () => {
      const event = await withSecret().parseWebhook?.(hook(envelope("transparent.completed")))
      expect(event).toEqual({
        id: "log_123",
        kind: "paid",
        event: "transparent.completed",
        chargeId: "pix_char_abc123",
      })
      expect(JSON.stringify(event)).not.toContain("Fulano")
    })

    test("disputed, refunded and other kinds", async () => {
      const p = withSecret()
      for (const [event, kind] of [
        ["transparent.disputed", "disputed"],
        ["transparent.refunded", "refunded"],
        ["billing.paid", "other"],
      ] as const) {
        const parsed = await p.parseWebhook?.(hook(envelope(event)))
        expect(parsed).toEqual({ id: "log_123", kind, event, chargeId: "pix_char_abc123" })
        expect(JSON.stringify(parsed)).not.toContain("Fulano")
      }
    })

    test("wrong or empty secret header is rejected", async () => {
      const p = withSecret()
      const parse = p.parseWebhook
      if (!parse) throw new Error("parseWebhook missing")
      const body = envelope("transparent.completed")
      await expectCode(parse(hook(body, "wrong")), "invalid_webhook_secret")
      await expectCode(parse(hook(body, "")), "invalid_webhook_secret")
      await expectCode(parse(hook(body, null)), "invalid_webhook_secret")
    })

    test("malformed body is rejected", async () => {
      const parse = withSecret().parseWebhook
      if (!parse) throw new Error("parseWebhook missing")
      await expectCode(parse(hook("{nope")), "invalid_webhook_payload")
      await expectCode(parse(hook({ event: "x" })), "invalid_webhook_payload")
    })
  })
})
