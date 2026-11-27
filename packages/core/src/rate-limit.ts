export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number
  windowMs: number
  now?: () => number
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }

export interface RateLimiter {
  /** Counts one hit for `key` if allowed; a refused hit is not counted. */
  take(key: string): RateLimitResult
}

/** Sliding-window limiter kept in memory. One instance per process. */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? Date.now
  const hits = new Map<string, number[]>()
  let calls = 0

  return {
    take(key) {
      const t = now()
      const windowStart = t - options.windowMs
      const recent = (hits.get(key) ?? []).filter((at) => at > windowStart)
      if (++calls % 1000 === 0) {
        for (const [k, list] of hits) {
          if (list.every((at) => at <= windowStart)) hits.delete(k)
        }
      }
      if (recent.length >= options.limit) {
        hits.set(key, recent)
        const oldest = recent[0] ?? t
        const retryAfterMs = oldest + options.windowMs - t
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
      }
      recent.push(t)
      hits.set(key, recent)
      return { ok: true }
    },
  }
}
