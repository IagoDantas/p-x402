import { describe, expect, test } from "bun:test"
import { isPx402Error, type Px402ErrorCode } from "@p-x402/core"
import { createMockPixProvider } from "../src"

async function expectCode(promise: Promise<unknown>, code: Px402ErrorCode) {
  try {
    await promise
  } catch (error) {
    expect(isPx402Error(error) && error.code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe("mock PixProvider", () => {
  test("creates deterministic charges and walks the status lifecycle", async () => {
    let t = Date.parse("2026-11-25T12:00:00Z")
    const mock = createMockPixProvider({ now: () => t })
    const a = await mock.createCharge({ amount: 500, expiresIn: 300, externalId: "e1" })
    const b = await mock.createCharge({ amount: 500, expiresIn: 300, externalId: "e2" })
    expect(a.id).toBe("pix_char_mock_0001")
    expect(b.id).toBe("pix_char_mock_0002")
    expect(a.expiresAt).toBe("2026-11-25T12:05:00.000Z")
    expect((await mock.getCharge(a.id)).status).toBe("PENDING")
    await mock.simulatePayment(a.id)
    expect((await mock.getCharge(a.id)).status).toBe("PAID")
    await mock.simulateDispute(a.id)
    expect((await mock.getCharge(a.id)).status).toBe("UNDER_DISPUTE")
    await mock.simulateRefund(a.id)
    expect((await mock.getCharge(a.id)).status).toBe("REFUNDED")
    t += 301_000
    expect((await mock.getCharge(b.id)).status).toBe("EXPIRED")
    await expectCode(mock.simulatePayment(b.id), "psp_error")
  })

  test("rejects amounts and lifetimes below the PSP minimum", async () => {
    const mock = createMockPixProvider()
    await expectCode(
      mock.createCharge({ amount: 99, expiresIn: 300, externalId: "e" }),
      "psp_error",
    )
    await expectCode(
      mock.createCharge({ amount: 500, expiresIn: 60, externalId: "e" }),
      "psp_error",
    )
  })

  test("simulated outage makes getCharge throw psp_error", async () => {
    const mock = createMockPixProvider()
    const c = await mock.createCharge({ amount: 500, expiresIn: 300, externalId: "e" })
    mock.failNextGetCharge(1)
    await expectCode(mock.getCharge(c.id), "psp_error")
    expect((await mock.getCharge(c.id)).status).toBe("PENDING")
  })

  test("emits webhook-shaped events that parse without payer data", async () => {
    const seen: Request[] = []
    const mock = createMockPixProvider({
      onWebhook: async (r) => {
        seen.push(r)
      },
    })
    const c = await mock.createCharge({ amount: 500, expiresIn: 300, externalId: "e" })
    await mock.simulatePayment(c.id)
    expect(seen).toHaveLength(1)
    const [first] = seen
    if (!first) throw new Error("no webhook")
    const event = await mock.parseWebhook(first)
    expect(event).toEqual({
      id: "log_pix_char_mock_0001",
      kind: "paid",
      event: "transparent.completed",
      chargeId: c.id,
    })
    expect(JSON.stringify(event)).not.toContain("Fulano")
  })

  test("webhook envelope ids derive from idPrefix so two mocks never share them", async () => {
    const a = createMockPixProvider({ idPrefix: "pix_char_a_" })
    const b = createMockPixProvider({ idPrefix: "pix_char_b_" })
    const ca = await a.createCharge({ amount: 500, expiresIn: 300, externalId: "e" })
    const cb = await b.createCharge({ amount: 500, expiresIn: 300, externalId: "e" })
    const ea = await a.parseWebhook(await a.webhookRequest("paid", ca.id))
    const eb = await b.parseWebhook(await b.webhookRequest("paid", cb.id))
    expect(ea.id).toBe("log_pix_char_a_0001")
    expect(eb.id).toBe("log_pix_char_b_0001")
    expect((await a.parseWebhook(await a.webhookRequest("paid", ca.id))).id).toBe(
      "log_pix_char_a_0002",
    )
  })

  test("webhooks are signed like AbacatePay's; a tampered signature is rejected", async () => {
    const mock = createMockPixProvider()
    const c = await mock.createCharge({ amount: 500, expiresIn: 300, externalId: "e" })
    const request = await mock.webhookRequest("paid", c.id)
    expect(request.headers.get("X-Webhook-Signature")).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect((await mock.parseWebhook(request)).kind).toBe("paid")
    await expectCode(
      mock.parseWebhook(await mock.webhookRequest("paid", c.id, { signature: "AAAA" })),
      "invalid_webhook_payload",
    )
  })

  test("webhook with a wrong secret is rejected", async () => {
    const mock = createMockPixProvider({ webhookSecret: "right" })
    await expectCode(
      mock.parseWebhook(await mock.webhookRequest("paid", "pix_char_x", { secret: "wrong" })),
      "invalid_webhook_secret",
    )
  })
})

describe("mock BR Code", () => {
  test("is well formed and carries the amount", async () => {
    const { parseBrCode } = await import("@p-x402/core")
    const mock = createMockPixProvider()
    const c = await mock.createCharge({ amount: 500, expiresIn: 300, externalId: "e" })
    const info = parseBrCode(c.brCode)
    expect(info?.crcValid).toBe(true)
    expect(info?.amount).toBe("500")
  })
})
