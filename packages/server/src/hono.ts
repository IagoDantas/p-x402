import type { Context, MiddlewareHandler } from "hono"
import { createMiddleware } from "hono/factory"
import { createPaywall, type PaywallConfig, type PaywallRoute, validateRoute } from "./index"

export type Px402Variables = { px402: { chargeId: string; amount: string } }

export interface HonoPaywallConfig extends PaywallConfig {
  /**
   * Overrides the default client IP lookup, which is the TCP peer from Bun.serve `requestIP`.
   * Set it when the default cannot see the buyer: outside Bun (it returns undefined there), or
   * behind a reverse proxy, where every buyer would share the proxy's rate-limit bucket. Read only
   * a header your own proxy sets (e.g. `cf-connecting-ip`, or the right-most X-Forwarded-For hop
   * your proxy appended); a header the client controls lets it dodge the per-IP cap.
   */
  getClientIp?: (c: Context) => string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Bun.serve passes the server as `env`; its `requestIP(request)` returns `{ address }`. */
export function defaultClientIp(c: Context): string | undefined {
  const env: unknown = c.env
  if (!isRecord(env) || typeof env.requestIP !== "function") return undefined
  try {
    const info: unknown = env.requestIP(c.req.raw)
    return isRecord(info) && typeof info.address === "string" ? info.address : undefined
  } catch {
    return undefined
  }
}

/**
 * Hono middleware factory. Settle happens when the handler returns its Response: a streamed body
 * that fails later is still settled. Multi-instance deployments need sticky routing per chargeId
 * or idempotent handlers (see `PaywallConfig`).
 */
export function pixPaywall(
  config: HonoPaywallConfig,
): (route: PaywallRoute) => MiddlewareHandler<{ Variables: Px402Variables }> {
  const paywall = createPaywall(config)
  const getClientIp = config.getClientIp ?? defaultClientIp
  return (route) => {
    // A bad route fails when the app is wired, not when the first buyer arrives.
    validateRoute(route)
    return createMiddleware<{ Variables: Px402Variables }>(async (c, next) => {
      const clientIp = getClientIp(c)
      const result = await paywall.handle(c.req.raw, route, clientIp ? { clientIp } : {})
      if (result.type === "response") return result.response
      c.set("px402", { chargeId: result.chargeId, amount: result.amount })
      try {
        await next()
      } catch (error) {
        result.release()
        throw error
      }
      // The handler threw (Hono already set an error response): never settle.
      if (c.error !== undefined) {
        result.release()
        return
      }
      // finalize releases the chargeId lock itself, including when it skips settle (non-2xx).
      const out = await result.finalize(c.res)
      if (out !== c.res) {
        c.res = undefined
        c.res = out
      }
    })
  }
}

export type { PaywallConfig, PaywallRoute } from "./index"
