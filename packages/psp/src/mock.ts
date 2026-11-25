import { encodeEmv, Px402Error } from "@p-x402/core"
import type {
  CreatePixChargeInput,
  PixCharge,
  PixChargeState,
  PixChargeStatus,
  PixProvider,
  PixWebhookEvent,
  PixWebhookKind,
} from "./types"
import { parseAbacatePayWebhook, WEBHOOK_SECRET_HEADER } from "./webhook"

export interface MockPixProviderOptions {
  now?: () => number
  /** Secret the mock expects in `X-Webhook-Secret`. Default `mock-webhook-secret`. */
  webhookSecret?: string
  /** Id prefix. Default `pix_char_mock_`. */
  idPrefix?: string
  /** Receives every webhook the mock emits after a simulate* call. */
  onWebhook?: (request: Request) => Promise<unknown>
}

interface MockCharge {
  id: string
  amount: number
  status: PixChargeStatus
  expiresAt: number
  externalId: string
  description: string | undefined
  paidAt: number | undefined
}

const EVENT_NAMES: Record<Exclude<PixWebhookKind, "other">, string> = {
  paid: "transparent.completed",
  disputed: "transparent.disputed",
  refunded: "transparent.refunded",
}

export interface MockPixProvider extends PixProvider {
  simulatePayment(id: string): Promise<void>
  simulateDispute(id: string): Promise<void>
  simulateRefund(id: string): Promise<void>
  parseWebhook(request: Request): Promise<PixWebhookEvent>
  /** The next `n` calls to `getCharge` throw `psp_error`. */
  failNextGetCharge(n?: number): void
  /** Builds an AbacatePay-shaped webhook request for `chargeId`. */
  webhookRequest(
    kind: PixWebhookKind,
    chargeId: string,
    options?: { secret?: string; envelopeId?: string },
  ): Request
  setWebhookSink(sink: ((request: Request) => Promise<unknown>) | undefined): void
  /** Inspect internal state in tests. */
  peek(id: string): Readonly<MockCharge> | undefined
  readonly calls: { createCharge: number; getCharge: number }
}

/** Deterministic in-memory PSP for tests and the local demo. */
export function createMockPixProvider(options: MockPixProviderOptions = {}): MockPixProvider {
  const now = options.now ?? Date.now
  const secret = options.webhookSecret ?? "mock-webhook-secret"
  if (secret.trim().length === 0) throw new Error("mock: webhookSecret must not be empty")
  const prefix = options.idPrefix ?? "pix_char_mock_"
  const charges = new Map<string, MockCharge>()
  let sink = options.onWebhook
  let sequence = 0
  let eventSequence = 0
  let failures = 0
  const calls = { createCharge: 0, getCharge: 0 }

  function load(id: string): MockCharge {
    const charge = charges.get(id)
    if (!charge) throw new Px402Error("psp_error", `mock: unknown charge ${id}`)
    if (charge.status === "PENDING" && now() > charge.expiresAt) charge.status = "EXPIRED"
    return charge
  }

  function webhookRequest(
    kind: PixWebhookKind,
    chargeId: string,
    opts: { secret?: string; envelopeId?: string } = {},
  ): Request {
    const charge = charges.get(chargeId)
    const envelopeId = opts.envelopeId ?? `log_mock_${String(++eventSequence).padStart(4, "0")}`
    const body = {
      id: envelopeId,
      event: kind === "other" ? "transparent.created" : EVENT_NAMES[kind],
      apiVersion: 2,
      devMode: true,
      data: {
        transparent: {
          id: chargeId,
          externalId: charge?.externalId ?? "unknown",
          amount: charge?.amount ?? 0,
          status: charge?.status ?? "PENDING",
          metadata: {},
        },
        customer: { name: "Fulano de Tal", taxId: "123.***.***-00" },
        payerInformation: { name: "Fulano de Tal", taxId: "123.***.***-00" },
      },
    }
    return new Request("http://facilitator.local/webhooks/pix", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SECRET_HEADER]: opts.secret ?? secret,
      },
      body: JSON.stringify(body),
    })
  }

  async function transition(
    id: string,
    from: PixChargeStatus[],
    to: PixChargeStatus,
    kind: PixWebhookKind,
  ) {
    const charge = load(id)
    if (!from.includes(charge.status)) {
      throw new Px402Error("psp_error", `mock: cannot move ${id} from ${charge.status} to ${to}`)
    }
    charge.status = to
    if (to === "PAID") charge.paidAt = now()
    if (sink) await sink(webhookRequest(kind, id))
  }

  return {
    name: "mock",
    minAmount: 100,
    minExpiresIn: 300,
    calls,

    async createCharge(input: CreatePixChargeInput): Promise<PixCharge> {
      calls.createCharge++
      if (!Number.isInteger(input.amount) || input.amount < 100) {
        throw new Px402Error("psp_error", "mock: amount must be an integer >= 100")
      }
      if (!Number.isInteger(input.expiresIn) || input.expiresIn < 300) {
        throw new Px402Error("psp_error", "mock: expiresIn must be an integer >= 300")
      }
      const id = `${prefix}${String(++sequence).padStart(4, "0")}`
      const charge: MockCharge = {
        id,
        amount: input.amount,
        status: "PENDING",
        expiresAt: now() + input.expiresIn * 1000,
        externalId: input.externalId,
        description: input.description,
        paidAt: undefined,
      }
      charges.set(id, charge)
      return {
        id,
        status: "PENDING",
        amount: input.amount,
        brCode: mockBrCode(id, input.amount),
        expiresAt: new Date(charge.expiresAt).toISOString(),
      }
    },

    async getCharge(id: string): Promise<PixChargeState> {
      calls.getCharge++
      if (failures > 0) {
        failures--
        throw new Px402Error("psp_error", "mock: simulated PSP outage")
      }
      const charge = load(id)
      const state: PixChargeState = {
        id,
        status: charge.status,
        expiresAt: new Date(charge.expiresAt).toISOString(),
      }
      if (charge.paidAt !== undefined) state.paidAt = new Date(charge.paidAt).toISOString()
      return state
    },

    simulatePayment: (id) => transition(id, ["PENDING"], "PAID", "paid"),
    simulateDispute: (id) => transition(id, ["PAID"], "UNDER_DISPUTE", "disputed"),
    simulateRefund: (id) => transition(id, ["PAID", "UNDER_DISPUTE"], "REFUNDED", "refunded"),

    failNextGetCharge(n = 1) {
      failures = n
    },

    parseWebhook: (request) => parseAbacatePayWebhook(request, secret),
    webhookRequest,
    setWebhookSink(next) {
      sink = next
    },
    peek: (id) => charges.get(id),
  }
}

/** A well-formed dynamic-style BR Code (EMV, tag 54 amount, valid CRC) that no bank will accept. */
export function mockBrCode(chargeId: string, amountCentavos: number): string {
  const merchantAccount = encodeEmvValue([
    { id: "00", value: "br.gov.bcb.pix" },
    { id: "01", value: `mock-${chargeId}`.slice(0, 77) },
  ])
  return encodeEmv([
    { id: "00", value: "01" },
    { id: "01", value: "12" },
    { id: "26", value: merchantAccount },
    { id: "52", value: "0000" },
    { id: "53", value: "986" },
    { id: "54", value: (amountCentavos / 100).toFixed(2) },
    { id: "58", value: "BR" },
    { id: "59", value: "P-X402 MOCK" },
    { id: "60", value: "SAO PAULO" },
    { id: "62", value: encodeEmvValue([{ id: "05", value: chargeId.slice(-25) }]) },
  ])
}

function encodeEmvValue(fields: { id: string; value: string }[]): string {
  return fields.map((f) => `${f.id}${String(f.value.length).padStart(2, "0")}${f.value}`).join("")
}
