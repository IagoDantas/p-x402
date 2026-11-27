/** Every environment variable the demo service reads. Documented in apps/demo-web/README.md. */
export interface DemoConfig {
  port: number
  provider: "mock" | "abacatepay"
  abacatepayApiKey?: string
  abacatepayWebhookSecret?: string
  dbPath?: string
  merchantToken?: string
  allowedOrigins: string[]
  adminSecret?: string
  clientIpHeader?: string
  runsPerIpPerHour: number
  chargesPerIpPerMinute: number
  merchantChargesPerMinute: number
  /** Caps how long a step-mode run waits for a click; default: until its charge expires. */
  stepTimeoutSeconds?: number
  /** UTC hour of the daily reset; undefined disables it. */
  resetUtcHour?: number
}

type Env = Record<string, string | undefined>

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** Reads and validates the environment. Throws with the variable's name on a bad value. */
export function readConfig(env: Env): DemoConfig {
  const abacatepayApiKey = text(env, "ABACATEPAY_API_KEY")
  const forced = text(env, "PX402_PROVIDER")
  if (forced !== undefined && forced !== "mock" && forced !== "abacatepay") {
    throw new Error("PX402_PROVIDER must be mock or abacatepay")
  }
  // AbacatePay test mode when a key is set, the in-memory mock otherwise; PX402_PROVIDER overrides.
  const provider = forced ?? (abacatepayApiKey ? "abacatepay" : "mock")
  if (provider === "abacatepay" && !abacatepayApiKey) {
    throw new Error("ABACATEPAY_API_KEY is required with PX402_PROVIDER=abacatepay")
  }

  const allowedOrigins = (text(env, "DEMO_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  for (const origin of allowedOrigins) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new Error(
        `DEMO_ALLOWED_ORIGINS: ${origin} is not an origin like https://demo.p-x402.com`,
      )
    }
  }

  const adminSecret = text(env, "DEMO_ADMIN_SECRET")
  if (adminSecret !== undefined && adminSecret.length < 32) {
    throw new Error("DEMO_ADMIN_SECRET must have at least 32 characters")
  }

  const resetRaw = text(env, "DEMO_RESET_UTC_HOUR")
  const config: DemoConfig = {
    port: integer(env, "DEMO_WEB_PORT", 4030, 1, 65_535),
    provider,
    allowedOrigins,
    runsPerIpPerHour: integer(env, "DEMO_RUNS_PER_IP_PER_HOUR", 30, 1, 10_000),
    chargesPerIpPerMinute: integer(env, "DEMO_CHARGES_PER_IP_PER_MINUTE", 20, 1, 10_000),
    merchantChargesPerMinute: integer(env, "DEMO_MERCHANT_CHARGES_PER_MINUTE", 60, 1, 100_000),
  }
  // 07:00 UTC is 04:00 in Brasília. "off" disables the daily reset.
  if (resetRaw !== "off") config.resetUtcHour = integer(env, "DEMO_RESET_UTC_HOUR", 7, 0, 23)
  if (text(env, "DEMO_STEP_TIMEOUT_SECONDS") !== undefined) {
    config.stepTimeoutSeconds = integer(env, "DEMO_STEP_TIMEOUT_SECONDS", 300, 1, 300)
  }
  if (abacatepayApiKey) config.abacatepayApiKey = abacatepayApiKey
  const webhookSecret = text(env, "ABACATEPAY_WEBHOOK_SECRET")
  if (webhookSecret) config.abacatepayWebhookSecret = webhookSecret
  const dbPath = text(env, "PX402_DB_PATH")
  if (dbPath) config.dbPath = dbPath
  const token = text(env, "PX402_MERCHANT_TOKEN")
  if (token) config.merchantToken = token
  if (adminSecret) config.adminSecret = adminSecret
  const ipHeader = text(env, "DEMO_CLIENT_IP_HEADER")
  if (ipHeader) config.clientIpHeader = ipHeader.toLowerCase()
  return config
}
