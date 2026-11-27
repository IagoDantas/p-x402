/** Wall-clock milliseconds with sub-millisecond precision; the browser uses the same formula. */
export const clock = () => performance.timeOrigin + performance.now()

/** Seller → facilitator call, observed from the seller side. */
export interface FacilitatorCallEvent {
  type: "facilitator"
  path: "/pix/charges" | "/verify" | "/settle"
  chargeId?: string
  status: number
  /** isValid for /verify, success for /settle, a charge for /pix/charges. */
  ok: boolean
  /** invalidReason / errorReason, when the facilitator gave one. */
  reason?: string
  startedAt: number
  durationMs: number
  at: number
}

/** The PSP reported the charge PAID and the facilitator recorded it. */
export interface PaidEvent {
  type: "pix.confirmado"
  chargeId: string
  amount: number
  at: number
}

/** /settle consumed the charge: the resource was delivered. */
export interface SettledEvent {
  type: "liquidado"
  chargeId: string
  amount: number
  at: number
}

export interface Balances {
  pagador: number
  recebedor: number
}

export interface BalancesEvent {
  type: "saldos"
  saldos: Balances
  at: number
}

export type DemoEvent = FacilitatorCallEvent | PaidEvent | SettledEvent | BalancesEvent

export interface PaymentSummary {
  chargeId: string
  amount: number
  paidAt: number
  settledAt: number | null
}

export interface DemoHub {
  publish(event: DemoEvent): void
  subscribe(listener: (event: DemoEvent) => void): () => void
  /** Records a PAID charge once; moves the simulated balances and announces both. */
  paid(chargeId: string, amount: number): void
  /** Records a consumed charge once. */
  settled(chargeId: string, amount: number): void
  balances(): Balances
  initialPayerBalance: number
  /** Most recent first. */
  payments(): PaymentSummary[]
  /** Puts both balances back to their starting values and forgets the payment list. */
  reset(): void
  readonly listenerCount: number
}

const MAX_PAYMENTS = 50

/**
 * In-memory pub/sub for the demo plus a simulated ledger: the payer's bank balance and the
 * merchant's balance. Balances move only when the PSP confirms a charge (the PSP's status is the truth).
 */
export function createHub(options: { initialPayerBalance?: number } = {}): DemoHub {
  const initialPayerBalance = options.initialPayerBalance ?? 10_000
  const listeners = new Set<(event: DemoEvent) => void>()
  const announcedPaid = new Set<string>()
  const announcedSettled = new Set<string>()
  let payments: PaymentSummary[] = []
  let balances: Balances = { pagador: initialPayerBalance, recebedor: 0 }

  function publish(event: DemoEvent) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error("demo-web: listener failed", error)
      }
    }
  }

  return {
    publish,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    paid(chargeId, amount) {
      if (announcedPaid.has(chargeId)) return
      announcedPaid.add(chargeId)
      const at = clock()
      balances = { pagador: balances.pagador - amount, recebedor: balances.recebedor + amount }
      payments = [{ chargeId, amount, paidAt: at, settledAt: null }, ...payments].slice(
        0,
        MAX_PAYMENTS,
      )
      publish({ type: "pix.confirmado", chargeId, amount, at })
      publish({ type: "saldos", saldos: { ...balances }, at })
    },
    settled(chargeId, amount) {
      if (announcedSettled.has(chargeId)) return
      announcedSettled.add(chargeId)
      const at = clock()
      const payment = payments.find((p) => p.chargeId === chargeId)
      if (payment) payment.settledAt = at
      publish({ type: "liquidado", chargeId, amount, at })
    },
    balances: () => ({ ...balances }),
    initialPayerBalance,
    payments: () => payments.map((p) => ({ ...p })),
    reset() {
      balances = { pagador: initialPayerBalance, recebedor: 0 }
      payments = []
      publish({ type: "saldos", saldos: { ...balances }, at: clock() })
    },
    get listenerCount() {
      return listeners.size
    },
  }
}
