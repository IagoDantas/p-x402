import { describe, expect, test } from "bun:test"
import {
  decodePaymentPayload,
  encodeEmv,
  encodePaymentPayload,
  encodeTlv,
  isPx402Error,
  type Px402Error,
} from "@p-x402/core"
import { type PaymentEvent, wrapFetch } from "../src"
import {
  brCode,
  challenge,
  chargeIdOf,
  countingPayer,
  EXPIRES_AT,
  fakeClock,
  ORIGIN,
  paymentRequired,
  pixRequirements,
  RESOURCE,
  refused,
  START,
  scriptedServer,
  simplePaywall,
} from "./helpers"

async function caught(promise: Promise<unknown>): Promise<Px402Error> {
  try {
    await promise
  } catch (error) {
    if (isPx402Error(error)) return error
    throw error
  }
  throw new Error("expected a Px402Error")
}

describe("wrapFetch", () => {
  test("non-402 responses pass through untouched", async () => {
    const server = scriptedServer(() => new Response("boom", { status: 500 }))
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, { payer })
    const response = await paid(RESOURCE)
    expect(response.status).toBe(500)
    expect(await response.text()).toBe("boom")
    expect(server.seen).toHaveLength(1)
    expect(charges).toHaveLength(0)
  })

  test("402 without PAYMENT-REQUIRED is returned as is", async () => {
    const server = scriptedServer(() => new Response("pay me", { status: 402 }))
    const { payer, charges } = countingPayer()
    const response = await wrapFetch(server.fetch, { payer })(RESOURCE)
    expect(response.status).toBe(402)
    expect(charges).toHaveLength(0)
  })

  test("a 402 reached through a cross-origin redirect is refused before paying", async () => {
    const variants: Array<{ url: string; redirected: boolean }> = [
      { url: "https://evil.example.net/relatorio", redirected: true },
      { url: "https://evil.example.net/relatorio", redirected: false },
      { url: RESOURCE, redirected: true },
    ]
    for (const variant of variants) {
      const server = scriptedServer(() => {
        const response = challenge(paymentRequired([pixRequirements()]))
        Object.defineProperty(response, "url", { value: variant.url })
        Object.defineProperty(response, "redirected", { value: variant.redirected })
        return response
      })
      const { payer, charges } = countingPayer()
      const events: PaymentEvent[] = []
      const paid = wrapFetch(server.fetch, { payer, onPayment: (e) => events.push(e) })
      const error = await caught(paid(RESOURCE))
      expect(error.code).toBe("policy_exceeded")
      expect(error.details?.reason).toBe("redirected")
      expect(charges).toHaveLength(0)
      expect(events).toHaveLength(0)
      expect(paid.spent).toBe(0)
      expect(server.seen).toHaveLength(1)
    }
  })

  test("a 402 whose url is the request origin (not redirected) is paid", async () => {
    const server = scriptedServer((_attempt, _request, seen) => {
      if (seen.signature !== null) return new Response("ok")
      const response = challenge(paymentRequired([pixRequirements()]))
      Object.defineProperty(response, "url", { value: RESOURCE })
      return response
    })
    const { payer, charges } = countingPayer()
    const response = await wrapFetch(server.fetch, { payer })(RESOURCE)
    expect(response.status).toBe(200)
    expect(charges).toHaveLength(1)
  })

  test("402 -> pay -> 200", async () => {
    const server = simplePaywall()
    const { payer, charges } = countingPayer()
    const events: PaymentEvent[] = []
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, {
      payer,
      onPayment: (event) => events.push(event),
      now: clock.now,
      sleep: clock.sleep,
    })
    const response = await paid(RESOURCE)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(charges).toEqual([
      {
        chargeId: "pix_char_mock_0001",
        amount: "500",
        brCode: brCode("5.00"),
        expiresAt: EXPIRES_AT,
        resourceUrl: RESOURCE,
      },
    ])
    expect(server.seen).toHaveLength(2)
    const signature = server.seen[1]?.signature ?? ""
    const payload = decodePaymentPayload(signature)
    expect(payload.payload).toEqual({ chargeId: "pix_char_mock_0001" })
    expect(payload.accepted.amount).toBe("500")
    expect(payload.resource?.url).toBe(RESOURCE)
    expect(events).toEqual([
      {
        chargeId: "pix_char_mock_0001",
        amount: "500",
        resourceUrl: RESOURCE,
        paymentSignature: signature,
      },
    ])
    expect(paid.spent).toBe(500)
    expect(clock.sleeps).toEqual([])
  })

  test("settlement_pending twice then 200: same signature, sleeps follow Retry-After and backoff", async () => {
    const server = scriptedServer((attempt, _request, seen) => {
      if (seen.signature === null) return challenge(paymentRequired([pixRequirements()]))
      if (attempt === 1) return refused("settlement_pending", "pix_char_mock_0001", "2")
      if (attempt === 2) return refused("settlement_pending", "pix_char_mock_0001")
      return new Response("ok")
    })
    const { payer, charges } = countingPayer()
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, {
      payer,
      now: clock.now,
      sleep: clock.sleep,
      retry: { initialDelayMs: 500, factor: 2, maxDelayMs: 5000 },
    })
    const response = await paid(RESOURCE)
    expect(response.status).toBe(200)
    expect(charges).toHaveLength(1)
    // max(Retry-After 2000, backoff 500), then max(0, backoff 1000)
    expect(clock.sleeps).toEqual([2000, 1000])
    const signatures = server.seen.slice(1).map((s) => s.signature)
    expect(signatures).toHaveLength(3)
    expect(new Set(signatures).size).toBe(1)
    expect(signatures[0]).not.toBeNull()
  })

  test("settlement_pending with an HTTP-date Retry-After sleeps until that date", async () => {
    const clock = fakeClock()
    const server = scriptedServer((attempt, _request, seen) => {
      if (seen.signature === null) return challenge(paymentRequired([pixRequirements()]))
      if (attempt === 1) {
        const at = new Date(clock.now() + 3000).toUTCString()
        return refused("settlement_pending", "pix_char_mock_0001", at)
      }
      return new Response("ok")
    })
    const { payer } = countingPayer()
    const paid = wrapFetch(server.fetch, {
      payer,
      now: clock.now,
      sleep: clock.sleep,
      retry: { initialDelayMs: 500 },
    })
    expect((await paid(RESOURCE)).status).toBe(200)
    // max(Retry-After 3000, backoff 500)
    expect(clock.sleeps).toEqual([3000])
  })

  test("pending keeps polling past expiresAt until maxWaitMs, then payment_timeout with details", async () => {
    const server = scriptedServer((_attempt, _request, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements()]))
        : refused("settlement_pending", "pix_char_mock_0001", "2"),
    )
    const { payer, charges } = countingPayer()
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, { payer, now: clock.now, sleep: clock.sleep })
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("payment_timeout")
    expect(error.details?.chargeId).toBe("pix_char_mock_0001")
    expect(error.details?.paymentSignature).toBe(server.seen[1]?.signature ?? "missing")
    expect(error.details?.reason).toBe("max_wait")
    expect(error.message).toBe("gave up waiting for settlement")
    // A paid charge stays consumable for 24 h: expiresAt (5 min) is not where the client stops.
    expect(clock.t - START).toBeGreaterThan(600_000)
    expect(clock.t - START).toBeLessThan(600_010)
    expect(charges).toHaveLength(1)
    expect(paid.spent).toBe(500)
  })

  test("a server-set expiresAt far ahead is capped by retry.maxWaitMs", async () => {
    const farAway = "2027-11-25T15:00:00.000Z"
    const server = scriptedServer((_attempt, _request, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements({ extra: { expiresAt: farAway } })]))
        : refused("settlement_pending", "pix_char_mock_0001", "3600"),
    )
    const { payer } = countingPayer()
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, {
      payer,
      now: clock.now,
      sleep: clock.sleep,
      retry: { maxWaitMs: 30_000 },
    })
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("payment_timeout")
    expect(error.details?.reason).toBe("max_wait")
    expect(error.message).toBe("gave up waiting for settlement")
    expect(clock.t - START).toBeGreaterThan(30_000)
    expect(clock.t - START).toBeLessThan(30_010)
  })

  test.each([
    [
      "followed redirect",
      () => {
        const r = new Response("ok", { status: 200 })
        Object.defineProperty(r, "redirected", { value: true })
        return r
      },
    ],
    [
      "held-back redirect",
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } }),
    ],
  ])(
    "a paid retry that is redirected is refused (%s), signature in details",
    async (_name, make) => {
      const server = scriptedServer((_attempt, request, seen) => {
        if (seen.signature === null) return challenge(paymentRequired([pixRequirements()]))
        expect(request.redirect).toBe("manual")
        return make()
      })
      const { payer, charges } = countingPayer()
      const error = await caught(wrapFetch(server.fetch, { payer })(RESOURCE))
      expect(error.code).toBe("policy_exceeded")
      expect(error.details?.reason).toBe("redirected")
      expect(error.details?.paymentSignature).toBe(server.seen[1]?.signature ?? "missing")
      expect(charges).toHaveLength(1)
    },
  )

  test("policy refuses over maxPerRequest without paying or retrying", async () => {
    const server = simplePaywall(pixRequirements({ amount: "1500" }))
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, { payer })
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("policy_exceeded")
    expect(error.details?.reason).toBe("max_per_request")
    expect(charges).toHaveLength(0)
    expect(server.seen).toHaveLength(1)
    expect(paid.spent).toBe(0)
  })

  test("policy refuses over maxTotal without paying or retrying", async () => {
    const server = simplePaywall()
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, { payer, policy: { maxTotal: 900 } })
    expect((await paid(RESOURCE)).status).toBe(200)
    const before = server.seen.length
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("policy_exceeded")
    expect(error.details?.reason).toBe("max_total")
    expect(charges).toHaveLength(1)
    expect(server.seen.length - before).toBe(1)
    expect(paid.spent).toBe(500)
  })

  test("an amount equal to the default maxPerRequest is paid", async () => {
    const server = simplePaywall(pixRequirements({ amount: "1000" }))
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, { payer })
    expect((await paid(RESOURCE)).status).toBe(200)
    expect(charges).toHaveLength(1)
    expect(paid.spent).toBe(1000)
  })

  test("maxTotal is inclusive: two 500 charges fill 1000, a third is refused", async () => {
    const server = scriptedServer((attempt, _r, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements({ chargeId: `pix_char_${attempt}` })]))
        : new Response("ok"),
    )
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, { payer, policy: { maxTotal: 1000 } })
    expect((await paid(RESOURCE)).status).toBe(200)
    expect((await paid(RESOURCE)).status).toBe(200)
    expect(paid.spent).toBe(1000)
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("policy_exceeded")
    expect(error.details?.reason).toBe("max_total")
    expect(new Set(charges.map((c) => c.chargeId)).size).toBe(2)
    expect(paid.spent).toBe(1000)
  })

  test("an onPayment hook that throws does not lose the paid request", async () => {
    const server = simplePaywall()
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, {
      payer,
      onPayment: () => {
        throw new Error("logger down")
      },
    })
    const response = await paid(RESOURCE)
    expect(response.status).toBe(200)
    expect(charges).toHaveLength(1)
    expect(paid.spent).toBe(500)
    expect(server.seen[1]?.signature).not.toBeNull()
  })

  test("origin not in allowedOrigins is refused (full origin or bare host)", async () => {
    const { payer, charges } = countingPayer()
    const blocked = wrapFetch(simplePaywall().fetch, {
      payer,
      policy: { allowedOrigins: ["https://other.example.com", "localhost:3000"] },
    })
    const error = await caught(blocked(RESOURCE))
    expect(error.code).toBe("policy_exceeded")
    expect(error.details?.reason).toBe("origin_not_allowed")
    expect(charges).toHaveLength(0)

    const byOrigin = wrapFetch(simplePaywall().fetch, {
      payer,
      policy: { allowedOrigins: [ORIGIN] },
    })
    expect((await byOrigin(RESOURCE)).status).toBe(200)
    const byHost = wrapFetch(simplePaywall().fetch, {
      payer,
      policy: { allowedOrigins: ["api.example.com"] },
    })
    expect((await byHost(RESOURCE)).status).toBe(200)
  })

  test("resource on another origin is refused", async () => {
    const evil = "https://evil.example.com/relatorio"
    const { payer, charges } = countingPayer()
    // extra.resourceUrl and resource.url agree but point elsewhere
    const server = scriptedServer(() =>
      challenge(paymentRequired([pixRequirements({ extra: { resourceUrl: evil } })], evil)),
    )
    const error = await caught(wrapFetch(server.fetch, { payer })(RESOURCE))
    expect(error.code).toBe("policy_exceeded")
    expect(error.details?.reason).toBe("resource_origin_mismatch")

    // extra.resourceUrl disagrees with resource.url
    const server2 = scriptedServer(() =>
      challenge(paymentRequired([pixRequirements({ extra: { resourceUrl: `${ORIGIN}/other` } })])),
    )
    const error2 = await caught(wrapFetch(server2.fetch, { payer })(RESOURCE))
    expect(error2.details?.reason).toBe("resource_origin_mismatch")
    expect(charges).toHaveLength(0)
  })

  test.each([
    ["brcode_amount_mismatch", brCode("9.00")],
    ["brcode_amount_missing", brCode(undefined)],
    ["brcode_invalid", `${brCode("5.00").slice(0, -4)}0000`],
    ["brcode_invalid", "not an emv payload"],
  ])("BR Code refusal: %s", async (reason, code) => {
    const server = simplePaywall(pixRequirements({ extra: { brCode: code } }))
    const { payer, charges } = countingPayer()
    const paid = wrapFetch(server.fetch, { payer })
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("invalid_payment_requirements")
    expect(error.details?.reason).toBe(reason)
    expect(charges).toHaveLength(0)
    expect(server.seen).toHaveLength(1)
    expect(paid.spent).toBe(0)
  })

  test("a dynamic BR Code is refused unless the payer checks the resolved amount", async () => {
    // Tag 54 says 5.00, but a bank pays what the location payload says.
    const dynamic = encodeEmv([
      { id: "00", value: "01" },
      {
        id: "26",
        value: encodeTlv([
          { id: "00", value: "br.gov.bcb.pix" },
          { id: "25", value: "pix.example.com/qr/v2/cob/abc" },
        ]),
      },
      { id: "53", value: "986" },
      { id: "54", value: "5.00" },
      { id: "58", value: "BR" },
    ])
    const server = simplePaywall(pixRequirements({ extra: { brCode: dynamic } }))
    const { payer, charges } = countingPayer()
    const error = await caught(wrapFetch(server.fetch, { payer })(RESOURCE))
    expect(error.code).toBe("invalid_payment_requirements")
    expect(error.details?.reason).toBe("brcode_dynamic_unverified")
    expect(charges).toHaveLength(0)

    const checking = { checksDynamicAmount: true, pay: payer.pay }
    const response = await wrapFetch(server.fetch, { payer: checking })(RESOURCE)
    expect(response.status).toBe(200)
    expect(charges).toHaveLength(1)
  })

  test("a payer that never pays the BR Code (simulate) skips the BR Code check, not the policy", async () => {
    // AbacatePay dev mode returns BR Codes with a wrong CRC and field length.
    const sandboxCode = `${brCode("5.00").slice(0, -4)}0000`
    const server = simplePaywall(pixRequirements({ extra: { brCode: sandboxCode } }))
    const { payer, charges } = countingPayer()
    const simulate = { paysBrCode: false, pay: payer.pay }
    const response = await wrapFetch(server.fetch, { payer: simulate })(RESOURCE)
    expect(response.status).toBe(200)
    expect(charges).toHaveLength(1)

    const over = simplePaywall(pixRequirements({ amount: "5000", extra: { brCode: sandboxCode } }))
    const error = await caught(wrapFetch(over.fetch, { payer: simulate })(RESOURCE))
    expect(error.code).toBe("policy_exceeded")
    expect(charges).toHaveLength(1)
  })

  test("no Pix entry -> no_supported_requirements", async () => {
    const evm = {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0xusdc",
      amount: "1000",
      payTo: "0xabc",
      maxTimeoutSeconds: 60,
    }
    const server = scriptedServer(() => challenge(paymentRequired([evm])))
    const { payer, charges } = countingPayer()
    const error = await caught(wrapFetch(server.fetch, { payer })(RESOURCE))
    expect(error.code).toBe("no_supported_requirements")
    expect(charges).toHaveLength(0)
  })

  test("picks the first entry that parses as Pix", async () => {
    const bad = pixRequirements({ amount: "700", extra: { paymentFlow: "later" } })
    const good = pixRequirements({ chargeId: "pix_char_mock_0002" })
    const server = scriptedServer((_a, _r, seen) =>
      seen.signature === null ? challenge(paymentRequired([bad, good])) : new Response("ok"),
    )
    const { payer, charges } = countingPayer()
    expect((await wrapFetch(server.fetch, { payer })(RESOURCE)).status).toBe(200)
    expect(charges[0]?.chargeId).toBe("pix_char_mock_0002")
    expect(chargeIdOf(server.seen[1]?.signature ?? null)).toBe("pix_char_mock_0002")
  })

  test("payer throws -> payer_failed, cause attached, budget stays spent", async () => {
    const server = simplePaywall()
    const boom = new Error("bank down")
    const { payer, charges } = countingPayer(async () => {
      throw boom
    })
    const paid = wrapFetch(server.fetch, { payer })
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("payer_failed")
    expect(error.cause).toBe(boom)
    expect(error.details?.chargeId).toBe("pix_char_mock_0001")
    expect(chargeIdOf(String(error.details?.paymentSignature))).toBe("pix_char_mock_0001")
    expect(charges).toHaveLength(1)
    expect(server.seen).toHaveLength(1)
    expect(paid.spent).toBe(500)
  })

  test("other known errorReason -> typed error; unknown -> payment_rejected", async () => {
    const make = (reason: string) =>
      scriptedServer((_a, _r, seen) =>
        seen.signature === null
          ? challenge(paymentRequired([pixRequirements()]))
          : refused(reason, "pix_char_mock_0001"),
      )
    const { payer } = countingPayer()
    const known = await caught(wrapFetch(make("charge_expired").fetch, { payer })(RESOURCE))
    expect(known.code).toBe("charge_expired")
    expect(known.details?.chargeId).toBe("pix_char_mock_0001")
    expect(typeof known.details?.paymentSignature).toBe("string")
    const unknown = await caught(wrapFetch(make("weird_reason").fetch, { payer })(RESOURCE))
    expect(unknown.code).toBe("payment_rejected")

    const noHeader = scriptedServer((_a, _r, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements()]))
        : new Response("", { status: 402 }),
    )
    const bare = await caught(wrapFetch(noHeader.fetch, { payer })(RESOURCE))
    expect(bare.code).toBe("payment_rejected")
  })

  test("POST body is resent intact on every attempt", async () => {
    const server = scriptedServer((attempt, _request, seen) => {
      if (seen.signature === null) return challenge(paymentRequired([pixRequirements()]))
      if (attempt < 3) return refused("settlement_pending", "pix_char_mock_0001")
      return new Response("ok")
    })
    const { payer } = countingPayer()
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, { payer, now: clock.now, sleep: clock.sleep })
    const body = JSON.stringify({ relatório: "mensal", n: 1 })
    const response = await paid(RESOURCE, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    })
    expect(response.status).toBe(200)
    expect(server.seen).toHaveLength(4)
    for (const seen of server.seen) {
      expect(seen.method).toBe("POST")
      expect(seen.body).toBe(body)
    }
  })

  test("resume with an existing PAYMENT-SIGNATURE never calls the payer", async () => {
    // obtain a real signature from a first run
    const first = simplePaywall()
    const events: PaymentEvent[] = []
    await wrapFetch(first.fetch, {
      payer: countingPayer().payer,
      onPayment: (e) => events.push(e),
    })(RESOURCE)
    const signature = events[0]?.paymentSignature ?? ""

    const server = scriptedServer((attempt) =>
      attempt === 0 ? refused("settlement_pending", "pix_char_mock_0001") : new Response("ok"),
    )
    const { payer, charges } = countingPayer()
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, {
      payer,
      now: clock.now,
      sleep: clock.sleep,
      policy: { maxPerRequest: 1 },
    })
    const response = await paid(RESOURCE, { headers: { "PAYMENT-SIGNATURE": signature } })
    expect(response.status).toBe(200)
    expect(charges).toHaveLength(0)
    expect(paid.spent).toBe(0)
    expect(server.seen.map((s) => s.signature)).toEqual([signature, signature])

    // past expiry: a paid charge is still consumable (24 h grace), so a pending answer is
    // transient and resume keeps polling
    const late = scriptedServer((attempt) =>
      attempt === 0 ? refused("settlement_pending", "pix_char_mock_0001", "2") : new Response("ok"),
    )
    const lateClock = fakeClock(Date.parse(EXPIRES_AT) + 60_000)
    const lateResponse = await wrapFetch(late.fetch, {
      payer,
      now: lateClock.now,
      sleep: lateClock.sleep,
    })(RESOURCE, { headers: { "PAYMENT-SIGNATURE": signature } })
    expect(lateResponse.status).toBe(200)
    expect(late.seen.map((s) => s.signature)).toEqual([signature, signature])
    expect(lateClock.sleeps).toEqual([2000])

    // still pending after maxWaitMs: timeout with the signature to resume later
    const stuck = scriptedServer(() => refused("settlement_pending", "pix_char_mock_0001"))
    const stuckClock = fakeClock(Date.parse(EXPIRES_AT) + 60_000)
    const error = await caught(
      wrapFetch(stuck.fetch, {
        payer,
        now: stuckClock.now,
        sleep: stuckClock.sleep,
        retry: { maxWaitMs: 5_000 },
      })(RESOURCE, { headers: { "PAYMENT-SIGNATURE": signature } }),
    )
    expect(error.code).toBe("payment_timeout")
    expect(error.details?.paymentSignature).toBe(signature)
    expect(error.details?.reason).toBe("max_wait")
    expect(charges).toHaveLength(0)

    // other refusal on resume -> typed error, still no payment
    const consumed = scriptedServer(() => refused("charge_already_consumed", "pix_char_mock_0001"))
    const error2 = await caught(
      wrapFetch(consumed.fetch, { payer, now: clock.now, sleep: clock.sleep })(RESOURCE, {
        headers: { "PAYMENT-SIGNATURE": signature },
      }),
    )
    expect(error2.code).toBe("charge_already_consumed")
    expect(charges).toHaveLength(0)
  })

  test("resume never sends a Pix signature to another origin or outside allowedOrigins", async () => {
    const first = simplePaywall()
    const events: PaymentEvent[] = []
    await wrapFetch(first.fetch, {
      payer: countingPayer().payer,
      onPayment: (e) => events.push(e),
    })(RESOURCE)
    const signature = events[0]?.paymentSignature ?? ""
    const headers = { "PAYMENT-SIGNATURE": signature }

    const server = scriptedServer(() => new Response("ok"))
    const { payer } = countingPayer()
    const elsewhere = await caught(
      wrapFetch(server.fetch, { payer })("https://evil.example.net/relatorio", { headers }),
    )
    expect(elsewhere.code).toBe("policy_exceeded")
    expect(elsewhere.details?.reason).toBe("resource_origin_mismatch")

    const blocked = await caught(
      wrapFetch(server.fetch, { payer, policy: { allowedOrigins: ["other.example.com"] } })(
        RESOURCE,
        { headers },
      ),
    )
    expect(blocked.details?.reason).toBe("origin_not_allowed")
    expect(server.seen).toHaveLength(0)

    const ok = await wrapFetch(server.fetch, { payer })(RESOURCE, { headers })
    expect(ok.status).toBe(200)
  })

  test("resume with a non-Pix PAYMENT-SIGNATURE sends it once and never pays", async () => {
    const exact = encodePaymentPayload({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "1000",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 60,
      },
      payload: { signature: "0x" },
    })
    for (const signature of ["garbage", exact]) {
      const pending = scriptedServer(() => refused("settlement_pending", "pix_char_mock_0001", "2"))
      const { payer, charges } = countingPayer()
      const clock = fakeClock()
      const options = { payer, now: clock.now, sleep: clock.sleep }
      const error = await caught(
        wrapFetch(pending.fetch, options)(RESOURCE, {
          headers: { "PAYMENT-SIGNATURE": signature },
        }),
      )
      // No Pix expiry to wait for: one attempt, then payment_timeout.
      expect(error.code).toBe("payment_timeout")
      expect(error.details?.reason).toBe("unknown_expiry")
      expect(error.details?.paymentSignature).toBe(signature)
      expect(pending.seen.map((s) => s.signature)).toEqual([signature])
      expect(clock.sleeps).toEqual([])
      expect(charges).toHaveLength(0)

      const reply = new Response("ok", { status: 200 })
      const ok = scriptedServer(() => reply)
      const response = await wrapFetch(ok.fetch, options)(RESOURCE, {
        headers: { "PAYMENT-SIGNATURE": signature },
      })
      expect(response).toBe(reply)
      expect(await response.text()).toBe("ok")
      expect(ok.seen.map((s) => s.signature)).toEqual([signature])
      expect(clock.sleeps).toEqual([])
      expect(charges).toHaveLength(0)
    }
  })

  test("backoff grows by factor and is capped at maxDelayMs", async () => {
    const server = scriptedServer((attempt, _request, seen) => {
      if (seen.signature === null) return challenge(paymentRequired([pixRequirements()]))
      if (attempt <= 4) return refused("settlement_pending", "pix_char_mock_0001")
      return new Response("ok")
    })
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, {
      payer: countingPayer().payer,
      now: clock.now,
      sleep: clock.sleep,
      retry: { initialDelayMs: 500, factor: 2, maxDelayMs: 1500 },
    })
    expect((await paid(RESOURCE)).status).toBe(200)
    expect(clock.sleeps).toEqual([500, 1000, 1500, 1500])
  })

  test("a huge Retry-After never sleeps far past maxWaitMs", async () => {
    const server = scriptedServer((_attempt, _request, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements()]))
        : refused("settlement_pending", "pix_char_mock_0001", "86400"),
    )
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, {
      payer: countingPayer().payer,
      now: clock.now,
      sleep: clock.sleep,
    })
    const error = await caught(paid(RESOURCE))
    expect(error.code).toBe("payment_timeout")
    // one capped sleep to just past the cap, one last try, then timeout
    expect(clock.sleeps).toEqual([600_000 + 1])
    expect(server.seen).toHaveLength(3)
  })

  test("non-402 after paying is returned as is, never retried", async () => {
    const server = scriptedServer((_attempt, _request, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements()]))
        : new Response("bad gateway", { status: 502 }),
    )
    const { payer, charges } = countingPayer()
    const clock = fakeClock()
    const paid = wrapFetch(server.fetch, { payer, now: clock.now, sleep: clock.sleep })
    const response = await paid(RESOURCE)
    expect(response.status).toBe(502)
    expect(await response.text()).toBe("bad gateway")
    expect(server.seen).toHaveLength(2)
    expect(charges).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  test("concurrent calls cannot overspend maxTotal", async () => {
    const server = scriptedServer((attempt, _r, seen) =>
      seen.signature === null
        ? challenge(paymentRequired([pixRequirements({ chargeId: `pix_char_${attempt}` })]))
        : new Response("ok"),
    )
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { payer, charges } = countingPayer(() => gate)
    const paid = wrapFetch(server.fetch, { payer, policy: { maxTotal: 1200 } })
    let settled = 0
    const calls = Array.from({ length: 5 }, () =>
      paid(RESOURCE)
        .then(
          (r) => r,
          (e) => e,
        )
        .finally(() => {
          settled++
        }),
    )
    // Payers are blocked on the gate: wait (bounded, macrotask turns only) until the 3 refusals land.
    for (let i = 0; i < 100 && settled < 3; i++) await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(3)
    expect(charges).toHaveLength(2)
    expect(paid.spent).toBe(1000)
    release()
    const results = await Promise.all(calls)
    expect(charges).toHaveLength(2)
    expect(paid.spent).toBe(1000)
    const refusals = results.filter((r) => isPx402Error(r) && r.code === "policy_exceeded")
    expect(refusals).toHaveLength(3)
  })
})
