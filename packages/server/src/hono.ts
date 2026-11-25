import type { Context, MiddlewareHandler } from "hono"
import { createMiddleware } from "hono/factory"
import { createPaywall, type PaywallConfig, type PaywallRoute } from "./index"

export type Px402Variables = { px402: { chargeId: string; amount: string } }

export interface HonoPaywallConfig extends PaywallConfig {
  /** Overrides the default client IP lookup (Bun.serve `requestIP`). */
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
  return (route) =>
    createMiddleware<{ Variables: Px402Variables }>(async (c, next) => {
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
      // finalize releases the chargeId lock itself, including when it skips settle (status >= 400).
      const out = await result.finalize(c.res)
      if (out !== c.res) {
        c.res = undefined
        c.res = out
      }
    })
}

export type { PaywallConfig, PaywallRoute } from "./index"
