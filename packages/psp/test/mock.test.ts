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
      id: "log_mock_0001",
      kind: "paid",
      event: "transparent.completed",
      chargeId: c.id,
    })
    expect(JSON.stringify(event)).not.toContain("Fulano")
  })

  test("webhook with a wrong secret is rejected", async () => {
    const mock = createMockPixProvider({ webhookSecret: "right" })
    await expectCode(
      mock.parseWebhook(mock.webhookRequest("paid", "pix_char_x", { secret: "wrong" })),
      "invalid_webhook_secret",
    )
  })
})
