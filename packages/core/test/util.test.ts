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

describe("createRateLimiter sweep", () => {
  test("the periodic sweep keeps live keys and drops only fully expired ones", () => {
    let t = 1_000_000
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t })
    expect(limiter.take("a")).toEqual({ ok: true })
    expect(limiter.take("a")).toEqual({ ok: true })
    // Reach the 1000th call (the sweep) while "a" is still inside its window.
    for (let i = 0; i < 997; i++) limiter.take(`k${i}`)
    t += 30_000
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 30 })
    // Past the window: the next sweep drops the old keys and "a" is allowed again.
    t += 30_001
    for (let i = 0; i < 999; i++) limiter.take(`m${i}`)
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
