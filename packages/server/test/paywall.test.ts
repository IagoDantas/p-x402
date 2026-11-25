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

  test("other verify reason → 402 with PAYMENT-RESPONSE only", async () => {
    const { stub, paywall } = setup()
    stub.reply("/verify", stub.json({ isValid: false, invalidReason: "charge_expired" }))
    const res = response(await paywall.handle(paidRequest(), route))
    expect(res.status).toBe(402)
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull()
    expect(await res.json()).toEqual({})
    const settlement = decodeSettlementResponse(res.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.errorReason).toBe("charge_expired")
    expect(stub.callsTo("/pix/charges")).toHaveLength(0)
  })

  test("handler 500 → no /settle, response passed through", async () => {
    const { stub, paywall } = setup()
    const result = paid(await paywall.handle(paidRequest(), route))
    const failed = new Response("boom", { status: 500 })
    const out = await result.finalize(failed)
    expect(out).toBe(failed)
    expect(stub.callsTo("/settle")).toHaveLength(0)
  })

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
    expect(await out.text()).toBe("{}")
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

  test("only payTo, provider and dynamic keys are copied from accepted", async () => {
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
      maxTimeoutSeconds: 300,
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
