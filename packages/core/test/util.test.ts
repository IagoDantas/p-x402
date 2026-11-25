import { describe, expect, test } from "bun:test"
import { createRateLimiter, timingSafeEqual } from "../src"

describe("createRateLimiter", () => {
  test("allows up to the limit per window, then reports Retry-After", () => {
    let t = 1_000_000
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t })
    expect(limiter.take("a")).toEqual({ ok: true })
    t += 10_000
    expect(limiter.take("a")).toEqual({ ok: true })
    expect(limiter.take("a")).toEqual({ ok: true })
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 50 })
    expect(limiter.take("b")).toEqual({ ok: true })
    t += 50_001
    expect(limiter.take("a")).toEqual({ ok: true })
  })
})

describe("timingSafeEqual", () => {
  test("compares by value", async () => {
    expect(await timingSafeEqual("secret", "secret")).toBe(true)
    expect(await timingSafeEqual("secret", "secreT")).toBe(false)
    expect(await timingSafeEqual("secret", "secret-longer")).toBe(false)
    expect(await timingSafeEqual("", "")).toBe(true)
  })
})
