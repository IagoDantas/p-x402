import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { decodePaymentRequired, decodeSettlementResponse } from "@p-x402/core"
import { Hono } from "hono"
import { type HonoPaywallConfig, type Px402Variables, pixPaywall } from "../src/hono"
import {
  FACILITATOR,
  fakeClock,
  gate,
  paymentSignature,
  pixRequirements,
  stubFacilitator,
  TOKEN,
} from "./helpers"

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

function setup(extra: Partial<HonoPaywallConfig> = {}) {
  const stub = stubFacilitator()
  const paid = pixPaywall({
    facilitatorUrl: FACILITATOR,
    token: TOKEN,
    fetch: stub.fetch,
    now: fakeClock().now,
    ipRateLimit: { limit: 1, windowMs: 60_000 },
    ...extra,
  })
  const app = new Hono<{ Variables: Px402Variables }>()
  app.get("/relatorio", paid({ amount: "500", description: "Relatório" }), (c) => {
    stub.events.push("handler")
    return c.json({ ok: true, charge: c.get("px402") })
  })
  app.get("/boom", paid({ amount: 500 }), () => {
    stub.events.push("handler")
    throw new Error("handler exploded")
  })
  app.get("/missing", paid({ amount: 500 }), (c) => c.json({ error: "nope" }, 404))
  // A non-Error throw skips Hono's onError, so next() itself rejects in the middleware.
  app.get("/raw-throw", paid({ amount: 500 }), () => {
    stub.events.push("handler")
    throw "not an Error"
  })
  return { app, stub }
}

const bunEnv = (address: string) => ({
  requestIP: (_request: Request) => ({ address, family: "IPv4", port: 1234 }),
})

describe("pixPaywall (Hono)", () => {
  test("end to end: 402, then paid retry → 200 with PAYMENT-RESPONSE", async () => {
    const { app, stub } = setup()
    const first = await app.request("http://shop.test/relatorio", {}, bunEnv("1.2.3.4"))
    expect(first.status).toBe(402)
    const required = decodePaymentRequired(first.headers.get("PAYMENT-REQUIRED") ?? "")
    expect(required.resource.url).toBe("http://shop.test/relatorio")
    const accepted = required.accepts[0]
    if (!accepted) throw new Error("no accepts")

    const second = await app.request(
      "http://shop.test/relatorio",
      { headers: { "PAYMENT-SIGNATURE": paymentSignature(accepted) } },
      bunEnv("1.2.3.4"),
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({
      ok: true,
      charge: { chargeId: "pix_char_mock_0001", amount: "500" },
    })
    const settlement = decodeSettlementResponse(second.headers.get("PAYMENT-RESPONSE") ?? "")
    expect(settlement.success).toBe(true)
    expect(stub.events).toEqual(["/pix/charges", "/verify", "handler", "/settle"])
  })

  test("env requestIP feeds the per-IP cap", async () => {
    const { app } = setup()
    expect((await app.request("http://shop.test/relatorio", {}, bunEnv("1.2.3.4"))).status).toBe(
      402,
    )
    expect((await app.request("http://shop.test/relatorio", {}, bunEnv("1.2.3.4"))).status).toBe(
      429,
    )
    expect((await app.request("http://shop.test/relatorio", {}, bunEnv("5.6.7.8"))).status).toBe(
      402,
    )
    expect(warn).not.toHaveBeenCalled()
  })

  test("without env: shared unknown bucket", async () => {
    const { app } = setup()
    expect((await app.request("http://shop.test/relatorio")).status).toBe(402)
    expect((await app.request("http://shop.test/relatorio")).status).toBe(429)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test("getClientIp overrides the default", async () => {
    const { app } = setup({ getClientIp: (c) => c.req.header("x-test-ip") })
    const req = (ip: string) =>
      app.request("http://shop.test/relatorio", { headers: { "x-test-ip": ip } }, bunEnv("9.9.9.9"))
    expect((await req("1.1.1.1")).status).toBe(402)
    expect((await req("2.2.2.2")).status).toBe(402)
    expect((await req("1.1.1.1")).status).toBe(429)
  })

  test("handler exception becomes 500 before finalize: no settle", async () => {
    const { app, stub } = setup()
    const res = await app.request(
      "http://shop.test/boom",
      {
        headers: {
          "PAYMENT-SIGNATURE": paymentSignature(
            pixRequirements({ resourceUrl: "http://shop.test/boom" }),
          ),
        },
      },
      bunEnv("1.2.3.4"),
    )
    expect(res.status).toBe(500)
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull()
    expect(stub.events).toEqual(["/verify", "handler"])
    expect(stub.callsTo("/settle")).toHaveLength(0)
  })

  test("handler 404 passes through without settle", async () => {
    const { app, stub } = setup()
    const res = await app.request("http://shop.test/missing", {
      headers: {
        "PAYMENT-SIGNATURE": paymentSignature(
          pixRequirements({ resourceUrl: "http://shop.test/missing" }),
        ),
      },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "nope" })
    expect(stub.callsTo("/settle")).toHaveLength(0)
  })

  test("settle failure replaces the handler response", async () => {
    const { app, stub } = setup()
    stub.reply(
      "/settle",
      stub.json({
        success: false,
        errorReason: "charge_already_consumed",
        transaction: "pix_char_mock_0001",
        network: "pix:br",
      }),
    )
    const res = await app.request("http://shop.test/relatorio", {
      headers: { "PAYMENT-SIGNATURE": paymentSignature(pixRequirements()) },
    })
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({})
  })
  test("handler exception with an onError that answers 200: still no settle", async () => {
    const { app, stub } = setup()
    app.onError((_err, c) => c.text("recovered", 200))
    const res = await app.request("http://shop.test/boom", {
      headers: {
        "PAYMENT-SIGNATURE": paymentSignature(
          pixRequirements({ resourceUrl: "http://shop.test/boom" }),
        ),
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull()
    expect(stub.callsTo("/settle")).toHaveLength(0)
  })

  test("concurrent paid requests for one charge: handler runs once, the other gets settlement_pending", async () => {
    const { app, stub } = setup()
    const verifyGate = gate()
    stub.reply("/verify", () => verifyGate.opened.then(() => stub.json({ isValid: true })))
    const init = { headers: { "PAYMENT-SIGNATURE": paymentSignature(pixRequirements()) } }
    const first = app.request("http://shop.test/relatorio", init)
    const second = await app.request("http://shop.test/relatorio", init)
    expect(second.status).toBe(402)
    expect(second.headers.get("Retry-After")).toBe("2")
    expect(second.headers.get("PAYMENT-REQUIRED")).not.toBeNull()
    expect(decodeSettlementResponse(second.headers.get("PAYMENT-RESPONSE") ?? "").errorReason).toBe(
      "settlement_pending",
    )
    verifyGate.open()
    expect((await first).status).toBe(200)
    expect(stub.events).toEqual(["/verify", "handler", "/settle"])
  })

  test("handler exception releases the lock: a retry verifies and runs the handler again", async () => {
    const { app, stub } = setup()
    const init = {
      headers: {
        "PAYMENT-SIGNATURE": paymentSignature(
          pixRequirements({ resourceUrl: "http://shop.test/boom" }),
        ),
      },
    }
    expect((await app.request("http://shop.test/boom", init)).status).toBe(500)
    expect((await app.request("http://shop.test/boom", init)).status).toBe(500)
    expect(stub.events).toEqual(["/verify", "handler", "/verify", "handler"])
  })

  test("next() rejecting releases the lock: a retry verifies and runs the handler again", async () => {
    const { app, stub } = setup()
    const init = {
      headers: {
        "PAYMENT-SIGNATURE": paymentSignature(
          pixRequirements({ resourceUrl: "http://shop.test/raw-throw" }),
        ),
      },
    }
    const attempt = async () => {
      try {
        await app.request("http://shop.test/raw-throw", init)
        return "resolved"
      } catch (thrown) {
        return thrown
      }
    }
    expect(await attempt()).toBe("not an Error")
    expect(await attempt()).toBe("not an Error")
    expect(stub.events).toEqual(["/verify", "handler", "/verify", "handler"])
  })

  test("handler 404 releases the lock", async () => {
    const { app, stub } = setup()
    const init = {
      headers: {
        "PAYMENT-SIGNATURE": paymentSignature(
          pixRequirements({ resourceUrl: "http://shop.test/missing" }),
        ),
      },
    }
    expect((await app.request("http://shop.test/missing", init)).status).toBe(404)
    expect((await app.request("http://shop.test/missing", init)).status).toBe(404)
    expect(stub.callsTo("/verify")).toHaveLength(2)
  })

  test("HEAD on a paid GET route → 402, no facilitator call, handler not run", async () => {
    const { app, stub } = setup()
    const res = await app.request(
      "http://shop.test/relatorio",
      { method: "HEAD" },
      bunEnv("1.2.3.4"),
    )
    expect(res.status).toBe(402)
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull()
    expect(stub.events).toEqual([])
    // The IP cap (limit 1) was not consumed.
    expect((await app.request("http://shop.test/relatorio", {}, bunEnv("1.2.3.4"))).status).toBe(
      402,
    )
    expect(stub.callsTo("/pix/charges")).toHaveLength(1)
  })
})
