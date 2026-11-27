import { describe, expect, test } from "bun:test"
import { isPx402Error } from "@p-x402/core"
import { simulatePayer } from "../src"
import { brCode, EXPIRES_AT, RESOURCE } from "./helpers"

const charge = {
  chargeId: "pix_char/mock 1",
  amount: "500",
  brCode: brCode("5.00"),
  expiresAt: EXPIRES_AT,
  resourceUrl: RESOURCE,
}

describe("simulatePayer", () => {
  test("facilitator variant POSTs the dev simulate endpoint", async () => {
    const seen: { method: string; url: string }[] = []
    const payer = simulatePayer({
      facilitatorUrl: "http://facilitator.test/",
      fetch: async (request) => {
        seen.push({ method: request.method, url: request.url })
        return new Response("{}", { status: 200 })
      },
    })
    await payer.pay(charge)
    expect(seen).toEqual([
      {
        method: "POST",
        url: "http://facilitator.test/dev/charges/pix_char%2Fmock%201/simulate-payment",
      },
    ])
  })

  test("both variants declare that they never pay the BR Code", () => {
    expect(simulatePayer({ facilitatorUrl: "http://f.test" }).paysBrCode).toBe(false)
    expect(simulatePayer({ simulate: async () => {} }).paysBrCode).toBe(false)
  })

  test("facilitator variant throws on non-2xx", async () => {
    const payer = simulatePayer({
      facilitatorUrl: "http://facilitator.test",
      fetch: async () => new Response("not found", { status: 404 }),
    })
    let error: unknown
    try {
      await payer.pay(charge)
    } catch (e) {
      error = e
    }
    expect(isPx402Error(error)).toBe(true)
    if (isPx402Error(error)) {
      expect(error.code).toBe("payer_failed")
      expect(error.details).toEqual({ chargeId: "pix_char/mock 1", status: 404 })
    }
  })

  test("function variant forwards the charge id", async () => {
    const ids: string[] = []
    const payer = simulatePayer({
      simulate: async (id) => {
        ids.push(id)
      },
    })
    await payer.pay(charge)
    expect(ids).toEqual(["pix_char/mock 1"])
  })
})
