import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  decodePaymentRequired,
  decodeSettlementResponse,
  encodeJsonHeader,
  isPx402Error,
  PixPaymentRequirementsSchema,
} from "@p-x402/core"
import { createPaywall, type PaywallConfig, type PaywallResult } from "../src/index"
import {
  FACILITATOR,
  fakeClock,
  gate,
  paymentSignature,
  pixRequirements,
  stubFacilitator,
  TOKEN,
} from "./helpers"

const URL_RELATORIO = "http://shop.test/relatorio"
const route = { amount: 500, description: "Relatório", mimeType: "application/json" }

let warn: ReturnType<typeof spyOn>
let error: ReturnType<typeof spyOn>
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {})
  error = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
})

function setup(extra: Partial<PaywallConfig> = {}) {
  const clock = fakeClock()
  const stub = stubFacilitator()
  const paywall = createPaywall({
    facilitatorUrl: FACILITATOR,
    token: TOKEN,
    fetch: stub.fetch,
    now: clock.now,
    ...extra,
  })
  return { clock, stub, paywall }
}

function response(result: PaywallResult): Response {
  if (result.type !== "response") throw new Error(`expected a response, got ${result.type}`)
  return result.response
}

function chargeUrl(body: unknown): string | undefined {
  return (body as { resource?: { url?: string } } | undefined)?.resource?.url
}

function paid(result: PaywallResult) {
  if (result.type !== "paid") throw new Error("expected paid")
  return result
}

function paidRequest(accepted: unknown = pixRequirements(), url = URL_RELATORIO) {
  return new Request(url, {
    headers: { "PAYMENT-SIGNATURE": paymentSignature(accepted as Record<string, unknown>) },
  })
}

describe("first request", () => {
  test("402 with a decodable PAYMENT-REQUIRED and the /pix/charges call", async () => {
    const { stub, paywall } = setup()
    const res = response(
      await paywall.handle(new Request(`${URL_RELATORIO}?x=1#frag`), route, {
        clientIp: "1.2.3.4",
      }),
    )
    expect(res.status).toBe(402)
    const header = res.headers.get("PAYMENT-REQUIRED")
    expect(header).not.toBeNull()
    const required = decodePaymentRequired(header ?? "")
    expect(required.x402Version).toBe(2)
    expect(required.resource).toEqual({
      url: `${URL_RELATORIO}?x=1`,
      description: "Relatório",
      mimeType: "application/json",
    })
    const req = PixPaymentRequirementsSchema.parse(required.accepts[0])
    expect(req.network).toBe("pix:br")
    expect(req.amount).toBe("500")
    expect(req.extra.resourceUrl).toBe(`${URL_RELATORIO}?x=1`)
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(required)))

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toEqual({
      path: "/pix/charges",
      auth: `Bearer ${TOKEN}`,
      body: {
        resource: {
          url: `${URL_RELATORIO}?x=1`,
          description: "Relatório",
          mimeType: "application/json",
        },
        amount: "500",
        description: "Relatório",
      },
    })
  })

  test("invalid route amount throws invalid_request without calling the facilitator", async () => {
    const { stub, paywall } = setup()
    for (const amount of [0, -1, 1.5, "0", "05", "abc", "", Number.NaN]) {
      const err = await paywall
        .handle(new Request(URL_RELATORIO), { amount }, { clientIp: "1.2.3.4" })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      expect(isPx402Error(err) && err.code).toBe("invalid_request")
    }
    expect(stub.calls).toHaveLength(0)
  })

  test("invalid route description, mimeType or resource throws invalid_request without calling the facilitator", async () => {
    const { stub, paywall } = setup()
    for (const bad of [
      { description: "a".repeat(141) },
      { mimeType: "a".repeat(201) },
      { resource: "ftp://x" },
    ]) {
      const err = await paywall
        .handle(new Request(URL_RELATORIO), { ...route, ...bad }, { clientIp: "1.2.3.4" })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      expect(isPx402Error(err) && err.code).toBe("invalid_request")
    }
    expect(stub.calls).toHaveLength(0)
  })

  test("resourceUrl strips fragment and userinfo", async () => {
    const { stub, paywall } = setup()
    await paywall.handle(new Request("http://user:pw@shop.test/a?b=1#c"), route, {
      clientIp: "1.2.3.4",
    })
    expect(chargeUrl(stub.calls[0]?.body)).toBe("http://shop.test/a?b=1")
  })

  test("route.resource overrides the request URL", async () => {
    const { stub, paywall } = setup()
    await paywall.handle(
      new Request("http://127.0.0.1:3000/relatorio"),
      { ...route, resource: "https://api.shop.test/relatorio" },
      { clientIp: "1.2.3.4" },
    )
    expect(chargeUrl(stub.calls[0]?.body)).toBe("https://api.shop.test/relatorio")
  })

  test("publicOrigin is used for resourceUrl", async () => {
    const { stub, paywall } = setup({ publicOrigin: "https://api.shop.test" })
    const res = response(
      await paywall.handle(new Request("http://127.0.0.1:3000/relatorio?q=2"), route, {
        clientIp: "1.2.3.4",
      }),
    )
    const required = decodePaymentRequired(res.headers.get("PAYMENT-REQUIRED") ?? "")
    expect(required.resource.url).toBe("https://api.shop.test/relatorio?q=2")
    expect(chargeUrl(stub.calls[0]?.body)).toBe("https://api.shop.test/relatorio?q=2")
  })

  test("publicOrigin wins over route.resource", async () => {
    const { stub, paywall } = setup({ publicOrigin: "https://api.shop.test" })
    await paywall.handle(
      new Request("http://127.0.0.1:3000/relatorio?q=2"),
      { ...route, resource: "https://other.test/x" },
      { clientIp: "1.2.3.4" },
    )
    expect(chargeUrl(stub.calls[0]?.body)).toBe("https://api.shop.test/relatorio?q=2")
  })

  test("publicOrigin with a path is rejected at creation", () => {
    expect(() =>
      createPaywall({
        facilitatorUrl: FACILITATOR,
        token: TOKEN,
        publicOrigin: "https://a.test/x",
      }),
    ).toThrow()
  })
})

describe("rate limits", () => {
  test("per-IP cap: 11th request is 429 with no charge; other IPs unaffected", async () => {
    const { stub, clock, paywall } = setup()
    for (let i = 0; i < 10; i++) {
      const res = response(
        await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
      )
      expect(res.status).toBe(402)
    }
    const capped = response(
      await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
    )
    expect(capped.status).toBe(429)
    expect(capped.headers.get("Retry-After")).toBe("60")
    expect(stub.callsTo("/pix/charges")).toHaveLength(10)

    const other = response(
      await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "5.6.7.8" }),
    )
    expect(other.status).toBe(402)

    clock.advance(60_001)
    const later = response(
      await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
    )
    expect(later.status).toBe(402)
  })

  test("unknown IPs share one bucket and warn once", async () => {
    const { stub, paywall } = setup({ ipRateLimit: { limit: 2, windowMs: 60_000 } })
    expect(response(await paywall.handle(new Request(URL_RELATORIO), route)).status).toBe(402)
    expect(response(await paywall.handle(new Request(URL_RELATORIO), route, {})).status).toBe(402)
    expect(response(await paywall.handle(new Request(URL_RELATORIO), route)).status).toBe(429)
    expect(stub.callsTo("/pix/charges")).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test("IPv6 clients in the same /64 share a bucket", async () => {
    const { paywall } = setup({ ipRateLimit: { limit: 1, windowMs: 60_000 } })
    const a = await paywall.handle(new Request(URL_RELATORIO), route, {
      clientIp: "2001:db8:1:2::1",
    })
    const b = await paywall.handle(new Request(URL_RELATORIO), route, {
      clientIp: "2001:db8:1:2:ffff::9",
    })
    const c = await paywall.handle(new Request(URL_RELATORIO), route, {
      clientIp: "2001:db8:1:3::1",
    })
    expect(response(a).status).toBe(402)
    expect(response(b).status).toBe(429)
    expect(response(c).status).toBe(402)
  })

  test("facilitator 429 on /pix/charges passes through with Retry-After", async () => {
    const { stub, paywall } = setup()
    stub.reply(
      "/pix/charges",
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    )
    const res = response(
      await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("7")
  })
})

describe("facilitator errors on /pix/charges", () => {
  test("401 → 500 unauthorized", async () => {
    const { stub, paywall } = setup()
    stub.reply("/pix/charges", stub.json({ error: "unauthorized" }, 401))
    const res = response(
      await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  test("400 → 500 invalid_request", async () => {
    const { stub, paywall } = setup()
    stub.reply("/pix/charges", stub.json({ error: "invalid_request" }, 400))
    const res = response(
      await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "invalid_request" })
  })

  test("5xx and unparseable answers → 502 facilitator_error", async () => {
    const { stub, paywall } = setup()
    for (const reply of [
      stub.json({ error: "psp_error" }, 502),
      stub.json({ paymentRequirements: { nope: true } }),
      new Response("not json", { status: 200 }),
    ]) {
      stub.reply("/pix/charges", reply)
      const res = response(
        await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
      )
      expect(res.status).toBe(502)
      const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
      expect(settlement.errorReason).toBe("facilitator_error")
    }
  })

  test("requirements for another amount or resource → 502 facilitator_error", async () => {
    const { stub, paywall } = setup()
    for (const overrides of [{ amount: "600" }, { resourceUrl: "https://other.test/x" }]) {
      stub.reply("/pix/charges", stub.json({ paymentRequirements: pixRequirements(overrides) }))
      const res = response(
        await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
      )
      expect(res.status).toBe(502)
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull()
      const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
      expect(settlement.errorReason).toBe("facilitator_error")
    }
  })
})

describe("paid retry", () => {
  test("verify → handler → settle, 200 with PAYMENT-RESPONSE success", async () => {
    const { stub, paywall } = setup()
    const result = paid(await paywall.handle(paidRequest(), route))
    expect(result.chargeId).toBe("pix_char_mock_0001")
    expect(result.amount).toBe("500")
    stub.events.push("handler")
    const out = await result.finalize(
      new Response("relatorio", { status: 200, headers: { "x-handler": "1" } }),
    )
    expect(stub.events).toEqual(["/verify", "handler", "/settle"])
    expect(out.status).toBe(200)
    expect(out.headers.get("x-handler")).toBe("1")
    expect(await out.text()).toBe("relatorio")
    const settlement = decodeSettlementResponse(out.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement).toMatchObject({ success: true, transaction: "pix_char_mock_0001" })
    expect(stub.callsTo("/pix/charges")).toHaveLength(0)
    expect(stub.callsTo("/settle")[0]?.body).toEqual(stub.callsTo("/verify")[0]?.body)
  })

  test("early retry: settlement_pending → 402 with the same charge and Retry-After 2", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ isValid: false, invalidReason: "settlement_pending" }))
    const res = response(await paywall.handle(paidRequest(), route))
    expect(res.status).toBe(402)
    expect(res.headers.get("Retry-After")).toBe("2")
    const required = decodePaymentRequired(res.headers.get("PAYMENT-REQUIRED") ?? "")
    expect(required.accepts[0]?.extra?.chargeId).toBe("pix_char_mock_0001")
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: "pix_char_mock_0001",
      network: "pix:br",
    })
    expect(stub.callsTo("/pix/charges")).toHaveLength(0)
  })

  test("other verify reason → 402 with the reason in the body and PAYMENT-RESPONSE, no PAYMENT-REQUIRED", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ isValid: false, invalidReason: "charge_expired" }))
    const res = response(await paywall.handle(paidRequest(), route))
    expect(res.status).toBe(402)
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull()
    expect(await res.json()).toEqual({ error: "charge_expired" })
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.errorReason).toBe("charge_expired")
    expect(stub.callsTo("/pix/charges")).toHaveLength(0)
  })

  test.each([500, 404, 302, 303])(
    "handler %i → no /settle, response passed through",
    async (status) => {
      const { stub, paywall } = setup()
      const result = paid(await paywall.handle(paidRequest(), route))
      const failed = new Response(null, { status, headers: { location: "/elsewhere" } })
      const out = await result.finalize(failed)
      expect(out).toBe(failed)
      expect(stub.callsTo("/settle")).toHaveLength(0)
    },
  )

  test("settle says charge_already_consumed → 402, handler body discarded", async () => {
    const { stub, paywall } = setup()
    stub.reply(
      "/settle",
      stub.json({
        success: false,
        errorReason: "charge_already_consumed",
        transaction: "pix_char_mock_0001",
        network: "pix:br",
      }),
    )
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("secret report", { status: 200 }))
    expect(out.status).toBe(402)
    expect(await out.text()).toBe(JSON.stringify({ error: "charge_already_consumed" }))
    const settlement = decodeSettlementResponse(out.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.errorReason).toBe("charge_already_consumed")
  })

  test("settle says settlement_pending → 402 with PAYMENT-REQUIRED and Retry-After", async () => {
    const { stub, paywall } = setup()
    stub.reply(
      "/settle",
      stub.json({
        success: false,
        errorReason: "settlement_pending",
        transaction: "pix_char_mock_0001",
        network: "pix:br",
      }),
    )
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("report"))
    expect(out.status).toBe(402)
    expect(out.headers.get("Retry-After")).toBe("2")
    expect(out.headers.get("PAYMENT-REQUIRED")).not.toBeNull()
  })

  test("facilitator unreachable at verify → 502 facilitator_error", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", () => {
      throw new TypeError("connection refused")
    })
    const res = response(await paywall.handle(paidRequest(), route))
    expect(res.status).toBe(502)
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement).toMatchObject({
      success: false,
      errorReason: "facilitator_error",
      transaction: "pix_char_mock_0001",
    })
  })

  test("facilitator unreachable at settle → 502 facilitator_error, body discarded", async () => {
    const { stub, paywall } = setup()
    const result = paid(await paywall.handle(paidRequest(), route))
    stub.reply("/settle", () => {
      throw new TypeError("connection refused")
    })
    const out = await result.finalize(new Response("secret report"))
    expect(out.status).toBe(502)
    expect(await out.text()).not.toContain("secret")
    const settlement = decodeSettlementResponse(out.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.errorReason).toBe("facilitator_error")
  })

  test("facilitator timeout → 502", async () => {
    const { stub, paywall } = setup({ facilitatorTimeoutMs: 5 })
    stub.reply("/verify", () => new Promise<Response>(() => {}))
    const res = response(await paywall.handle(paidRequest(), route))
    expect(res.status).toBe(502)
  })

  test("facilitator 5xx at verify → 502, 401 → 500", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ error: "unexpected_error" }, 500))
    expect(response(await paywall.handle(paidRequest(), route)).status).toBe(502)
    stub.reply("/verify", stub.json({ error: "unauthorized" }, 401))
    expect(response(await paywall.handle(paidRequest(), route)).status).toBe(500)
  })

  test("malformed PAYMENT-SIGNATURE → 400 invalid_header", async () => {
    const { stub, paywall } = setup()
    const res = response(
      await paywall.handle(
        new Request(URL_RELATORIO, { headers: { "PAYMENT-SIGNATURE": "%%%not-base64" } }),
        route,
      ),
    )
    expect(res.status).toBe(400)
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement).toEqual({
      success: false,
      errorReason: "invalid_header",
      transaction: "",
      network: "pix:br",
    })
    expect(stub.calls).toHaveLength(0)
  })

  test("decodable but non-Pix payload → 400 invalid_payload", async () => {
    const { stub, paywall } = setup()
    const header = encodeJsonHeader({
      x402Version: 2,
      accepted: { ...pixRequirements(), scheme: "exact", network: "eip155:8453", asset: "USDC" },
      payload: { signature: "0x" },
    })
    const res = response(
      await paywall.handle(
        new Request(URL_RELATORIO, { headers: { "PAYMENT-SIGNATURE": header } }),
        route,
      ),
    )
    expect(res.status).toBe(400)
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.errorReason).toBe("invalid_payload")
    expect(stub.calls).toHaveLength(0)
  })

  test("only payTo, provider, maxTimeoutSeconds and dynamic keys are copied from accepted", async () => {
    const { stub, paywall } = setup()
    const base = pixRequirements()
    const accepted = {
      ...base,
      amount: "1",
      payTo: "loja2",
      maxTimeoutSeconds: 99_999,
      extra: {
        ...base.extra,
        provider: "abacatepay",
        resourceUrl: "http://evil.test/other",
        brCodeBase64: "data:image/png;base64,AAAA",
        injected: "client value",
      },
    }
    await paywall.handle(paidRequest(accepted), route)
    const body = stub.callsTo("/verify")[0]?.body as {
      x402Version: number
      paymentRequirements: unknown
      paymentPayload: { accepted: { amount: string } }
    }
    expect(body.x402Version).toBe(2)
    expect(body.paymentRequirements).toEqual({
      scheme: "exact",
      network: "pix:br",
      asset: "BRL",
      amount: "500",
      payTo: "loja2",
      maxTimeoutSeconds: 99_999,
      extra: {
        paymentFlow: "upfront",
        assetTransferMethod: "pix-charge",
        provider: "abacatepay",
        resourceUrl: URL_RELATORIO,
        chargeId: base.extra.chargeId,
        brCode: base.extra.brCode,
        brCodeBase64: "data:image/png;base64,AAAA",
        expiresAt: base.extra.expiresAt,
      },
    })
    // The payload is forwarded as sent so the facilitator can compare accepted vs requirements.
    expect(body.paymentPayload.accepted.amount).toBe("1")
  })
  test("settle PAYMENT-RESPONSE drops payer and foreign fields; bearer token on verify and settle", async () => {
    const { stub, paywall } = setup()
    stub.reply(
      "/settle",
      stub.json({
        success: true,
        transaction: "pix_char_mock_0001",
        network: "pix:br",
        amount: "500",
        payer: "123.456.789-00",
        extensions: { leak: true },
      }),
    )
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("report"))
    expect(out.status).toBe(200)
    expect(decodeSettlementResponse(out.headers.get("PAYMENT-RESPONSE") ?? "")).toEqual({
      success: true,
      transaction: "pix_char_mock_0001",
      network: "pix:br",
      amount: "500",
    })
    expect(stub.calls.map((call) => [call.path, call.auth])).toEqual([
      ["/verify", `Bearer ${TOKEN}`],
      ["/settle", `Bearer ${TOKEN}`],
    ])
  })

  test("success claimed with a non-200 status is a facilitator_error", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ isValid: true }, 400))
    const verify = response(await paywall.handle(paidRequest(), route))
    expect(verify.status).toBe(502)

    stub.reply("/verify", undefined)
    stub.reply(
      "/settle",
      stub.json({ success: true, transaction: "pix_char_mock_0001", network: "pix:br" }, 400),
    )
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("secret report"))
    expect(out.status).toBe(502)
    expect(await out.text()).not.toContain("secret")
  })

  test("facilitator 400 with a failure reason at verify → 402 with that reason", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ isValid: false, invalidReason: "invalid_payload" }, 400))
    const res = response(await paywall.handle(paidRequest(), route))
    expect(res.status).toBe(402)
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.errorReason).toBe("invalid_payload")
  })
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("maxTimeoutSeconds", () => {
  test("maxTimeoutSeconds is copied from accepted into the /verify and /settle requirements", async () => {
    const { stub, paywall } = setup()
    const accepted = { ...pixRequirements(), maxTimeoutSeconds: 600 }
    const result = paid(await paywall.handle(paidRequest(accepted), route))
    expect(result.requirements.maxTimeoutSeconds).toBe(600)
    await result.finalize(new Response("report"))
    for (const path of ["/verify", "/settle"]) {
      const body = stub.callsTo(path)[0]?.body as {
        paymentRequirements: { maxTimeoutSeconds: number }
      }
      expect(body.paymentRequirements.maxTimeoutSeconds).toBe(600)
    }
  })
})

describe("settle idempotency and retries", () => {
  test("settle carries a UUID Idempotency-Key; /verify and /pix/charges do not", async () => {
    const { stub, paywall } = setup()
    response(await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }))
    const result = paid(await paywall.handle(paidRequest(), route))
    expect((await result.finalize(new Response("report"))).status).toBe(200)
    expect(stub.idempotencyKeys("/pix/charges")).toEqual([null])
    expect(stub.idempotencyKeys("/verify")).toEqual([null])
    const [key] = stub.idempotencyKeys("/settle")
    expect(key).toMatch(UUID)
  })

  test("each finalize uses a fresh Idempotency-Key", async () => {
    const { stub, paywall } = setup()
    const first = paid(await paywall.handle(paidRequest(), route))
    await first.finalize(new Response("report"))
    const second = paid(
      await paywall.handle(paidRequest(pixRequirements({ chargeId: "pix_char_mock_0002" })), route),
    )
    await second.finalize(new Response("report"))
    const keys = stub.idempotencyKeys("/settle")
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  test("settle 5xx is retried with the same Idempotency-Key; success on the 2nd attempt → 200", async () => {
    const { stub, paywall } = setup()
    let attempts = 0
    stub.reply("/settle", () => {
      attempts += 1
      if (attempts === 1) return stub.json({ error: "unexpected_error" }, 503)
      return stub.json({
        success: true,
        transaction: "pix_char_mock_0001",
        network: "pix:br",
        amount: "500",
      })
    })
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("report"))
    expect(out.status).toBe(200)
    expect(await out.text()).toBe("report")
    expect(decodeSettlementResponse(out.headers.get("PAYMENT-RESPONSE") ?? "").success).toBe(true)
    const keys = stub.idempotencyKeys("/settle")
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(UUID)
    expect(keys[1]).toBe(keys[0] ?? "")
  })

  test("settle timeout is retried with the same Idempotency-Key; success on the 2nd attempt → 200", async () => {
    const { stub, paywall } = setup({ facilitatorTimeoutMs: 5 })
    let attempts = 0
    stub.reply("/settle", () => {
      attempts += 1
      if (attempts === 1) return new Promise<Response>(() => {})
      return stub.json({ success: true, transaction: "pix_char_mock_0001", network: "pix:br" })
    })
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("report"))
    expect(out.status).toBe(200)
    const keys = stub.idempotencyKeys("/settle")
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0] ?? "")
  })

  test("transport errors: 3 attempts in total with one key, then 502", async () => {
    const { stub, paywall } = setup()
    stub.reply("/settle", () => {
      throw new TypeError("connection refused")
    })
    const result = paid(await paywall.handle(paidRequest(), route))
    const out = await result.finalize(new Response("secret report"))
    expect(out.status).toBe(502)
    expect(await out.text()).not.toContain("secret")
    const keys = stub.idempotencyKeys("/settle")
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(1)
  })

  test("no retry on a 200 with success:false, nor on a 400 or 401", async () => {
    const { stub, paywall } = setup()
    const failure = {
      success: false,
      errorReason: "charge_already_consumed",
      transaction: "pix_char_mock_0001",
      network: "pix:br",
    }
    for (const reply of [stub.json(failure), stub.json(failure, 400), stub.json({}, 401)]) {
      stub.reply("/settle", reply)
      const before = stub.callsTo("/settle").length
      const result = paid(await paywall.handle(paidRequest(), route))
      const out = await result.finalize(new Response("report"))
      expect(out.status).not.toBe(200)
      expect(stub.callsTo("/settle").length - before).toBe(1)
    }
  })

  test("default facilitator timeout is 15000 ms per attempt", async () => {
    const timers = spyOn(globalThis, "setTimeout")
    try {
      const { paywall } = setup()
      const result = paid(await paywall.handle(paidRequest(), route))
      await result.finalize(new Response("report"))
      const delays = timers.mock.calls.map((call) => call[1])
      // One timer for /verify and one for /settle, each 15000 ms.
      expect(delays).toEqual([15_000, 15_000])
    } finally {
      timers.mockRestore()
    }
  })

  test("/verify is never retried", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ error: "unexpected_error" }, 500))
    expect(response(await paywall.handle(paidRequest(), route)).status).toBe(502)
    expect(stub.callsTo("/verify")).toHaveLength(1)
  })
})

describe("chargeId lock", () => {
  test("concurrent requests for one charge: handler runs once, the second gets settlement_pending without /verify", async () => {
    const { stub, paywall } = setup()
    const verifyGate = gate()
    stub.reply("/verify", () => verifyGate.opened.then(() => stub.json({ isValid: true })))
    let handlerRuns = 0
    const run = async () => {
      const result = await paywall.handle(paidRequest(), route)
      if (result.type === "response") return result.response
      handlerRuns += 1
      return result.finalize(new Response("report"))
    }

    const first = run()
    const second = await run()
    expect(second.status).toBe(402)
    expect(second.headers.get("Retry-After")).toBe("2")
    const required = decodePaymentRequired(second.headers.get("PAYMENT-REQUIRED") ?? "")
    expect(PixPaymentRequirementsSchema.parse(required.accepts[0]).extra.chargeId).toBe(
      "pix_char_mock_0001",
    )
    expect(decodeSettlementResponse(second.headers.get("PAYMENT-RESPONSE") ?? "")).toEqual({
      success: false,
      errorReason: "settlement_pending",
      transaction: "pix_char_mock_0001",
      network: "pix:br",
    })
    expect(stub.callsTo("/verify")).toHaveLength(1)

    verifyGate.open()
    expect((await first).status).toBe(200)
    expect(handlerRuns).toBe(1)
    expect(stub.callsTo("/settle")).toHaveLength(1)

    // Settled: the lock is gone, a later request verifies again.
    stub.reply("/verify", undefined)
    paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(2)
  })

  test("a different chargeId is not blocked", async () => {
    const { stub, paywall } = setup()
    paid(await paywall.handle(paidRequest(), route))
    paid(
      await paywall.handle(paidRequest(pixRequirements({ chargeId: "pix_char_mock_0002" })), route),
    )
    expect(stub.callsTo("/verify")).toHaveLength(2)
  })

  test("lock released after a handler 500: a later retry verifies again", async () => {
    const { stub, paywall } = setup()
    const first = paid(await paywall.handle(paidRequest(), route))
    blockedWithoutVerify(await paywall.handle(paidRequest(), route))
    const out = await first.finalize(new Response("boom", { status: 500 }))
    expect(out.status).toBe(500)
    expect(stub.callsTo("/settle")).toHaveLength(0)
    paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(2)
  })

  test("release() frees the lock when the handler threw", async () => {
    const { stub, paywall } = setup()
    const first = paid(await paywall.handle(paidRequest(), route))
    first.release()
    first.release()
    paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(2)
  })

  test("lock released when settle fails", async () => {
    const { stub, paywall } = setup()
    stub.reply("/settle", stub.json({}, 401))
    const first = paid(await paywall.handle(paidRequest(), route))
    expect((await first.finalize(new Response("report"))).status).toBe(500)
    paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(2)
  })

  test("lock released when /verify does not pass", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ isValid: false, invalidReason: "settlement_pending" }))
    response(await paywall.handle(paidRequest(), route))
    stub.reply("/verify", stub.json({ error: "unexpected_error" }, 500))
    response(await paywall.handle(paidRequest(), route))
    stub.reply("/verify", undefined)
    paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(3)
  })

  test("a stale lock is ignored; the old holder does not release the new lock", async () => {
    // Stale after 60 s of handler time + 1 s timeout x (verify + 3 settle attempts) = 64 s.
    const { clock, stub, paywall } = setup({ facilitatorTimeoutMs: 1_000 })
    const first = paid(await paywall.handle(paidRequest(), route))
    clock.advance(63_999)
    blockedWithoutVerify(await paywall.handle(paidRequest(), route))
    clock.advance(1)
    const second = paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(2)

    await first.finalize(new Response("report"))
    blockedWithoutVerify(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(2)

    await second.finalize(new Response("report"))
    paid(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(3)
  })

  test("with default timeouts a slow verify plus a slow handler keeps the lock", async () => {
    const { clock, stub, paywall } = setup()
    const first = paid(await paywall.handle(paidRequest(), route))
    // 15 s /verify + 59 s handler: past the old fixed 60 s, still well inside 60 s + 4 x 15 s.
    clock.advance(74_000)
    blockedWithoutVerify(await paywall.handle(paidRequest(), route))
    expect(stub.callsTo("/verify")).toHaveLength(1)
    await first.finalize(new Response("report"))
  })

  test("finalize restarts the stale clock so slow settle retries keep the lock", async () => {
    const { clock, stub, paywall } = setup({ facilitatorTimeoutMs: 1_000 })
    const settleGate = gate()
    stub.reply("/settle", () =>
      settleGate.opened.then(() =>
        stub.json({
          success: true,
          transaction: "pix_char_mock_0001",
          network: "pix:br",
          amount: "500",
        }),
      ),
    )
    const first = paid(await paywall.handle(paidRequest(), route))
    clock.advance(63_000)
    const finalizing = first.finalize(new Response("report"))
    clock.advance(63_000)
    blockedWithoutVerify(await paywall.handle(paidRequest(), route))
    settleGate.open()
    expect((await finalizing).status).toBe(200)
  })
})

function blockedWithoutVerify(result: PaywallResult) {
  const res = response(result)
  expect(res.status).toBe(402)
  expect(res.headers.get("Retry-After")).toBe("2")
  expect(decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "").errorReason).toBe(
    "settlement_pending",
  )
}

describe("unpayable methods", () => {
  for (const method of ["HEAD", "OPTIONS"]) {
    test(`${method} → 402 method_not_payable, no facilitator call, IP cap untouched`, async () => {
      const { stub, paywall } = setup({ ipRateLimit: { limit: 1, windowMs: 60_000 } })
      const variants: Record<string, string>[] = [
        {},
        { "PAYMENT-SIGNATURE": paymentSignature(pixRequirements()) },
      ]
      for (const headers of variants) {
        for (let i = 0; i < 3; i++) {
          const res = response(
            await paywall.handle(new Request(URL_RELATORIO, { method, headers }), route, {
              clientIp: "1.2.3.4",
            }),
          )
          expect(res.status).toBe(402)
          expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull()
          expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull()
          expect(await res.json()).toEqual({ error: "method_not_payable" })
        }
      }
      expect(stub.calls).toHaveLength(0)
      const get = response(
        await paywall.handle(new Request(URL_RELATORIO), route, { clientIp: "1.2.3.4" }),
      )
      expect(get.status).toBe(402)
      expect(get.headers.get("PAYMENT-REQUIRED")).not.toBeNull()
    })
  }
})
