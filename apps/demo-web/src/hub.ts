/** Wall-clock milliseconds with sub-millisecond precision. */
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
export interface PaidSignal {
  type: "pix.confirmado"
  chargeId: string
  amount: number
  at: number
}

/** /settle consumed the charge: the resource was delivered. */
export interface SettledSignal {
  type: "liquidado"
  chargeId: string
  amount: number
  at: number
}

export type HubEvent = FacilitatorCallEvent | PaidSignal | SettledSignal

export interface DemoHub {
  publish(event: HubEvent): void
  subscribe(listener: (event: HubEvent) => void): () => void
  /** Announces a PAID charge once. */
  paid(chargeId: string, amount: number): void
  /** Announces a consumed charge once. */
  settled(chargeId: string, amount: number): void
  /** Forgets which charges were announced. */
  reset(): void
  readonly listenerCount: number
}

/** In-process bus for what the facilitator and the seller do. Carries charge ids only, no payer data. */
export function createHub(): DemoHub {
  const listeners = new Set<(event: HubEvent) => void>()
  let announcedPaid = new Set<string>()
  let announcedSettled = new Set<string>()

  function publish(event: HubEvent) {
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
      publish({ type: "pix.confirmado", chargeId, amount, at: clock() })
    },
    settled(chargeId, amount) {
      if (announcedSettled.has(chargeId)) return
      announcedSettled.add(chargeId)
      publish({ type: "liquidado", chargeId, amount, at: clock() })
    },
    reset() {
      announcedPaid = new Set()
      announcedSettled = new Set()
    },
    get listenerCount() {
      return listeners.size
    },
  }
}
