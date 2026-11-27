import { type PaidFetch, type PixPayer, simulatePayer, wrapFetch } from "@p-x402/client"
import {
  createRateLimiter,
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  type FetchLike,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isPx402Error,
  type RateLimiter,
} from "@p-x402/core"
import { clock, type DemoHub, type HubEvent } from "./hub"

/**
 * The demo buyer runs here, on the server, with the real `wrapFetch` from @p-x402/client. Visitors
 * are anonymous sessions (a random id kept in their browser); every run, charge and event belongs
 * to exactly one session, and a session only ever sees its own events.
 */

export const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/

export type RunMode = "auto" | "passos"
export type StepAction = "pagar" | "tentar"
export type RunEnd = "ok" | "erro" | "expirada"

/** Everything a session's page receives. Plain JSON, never payer data. */
export type SessionEvent = { type: string; at: number } & Record<string, unknown>

export interface AgentPolicy {
  /** Centavos. */
  maxPerRequest: number
  /** Centavos, per session until it is reset. */
  maxTotal: number
}

export interface DemoAgentOptions {
  hub: DemoHub
  /** The seller app (GET /relatorio behind pixPaywall), called in-process. */
  sellerFetch: FetchLike
  /** The facilitator app, called in-process for simulate-payment. */
  facilitatorFetch: FetchLike
  resourceUrl: string
  initialPayerBalance?: number
  policy?: AgentPolicy
  /** Runs at the same time per session. Default 3. */
  maxRunsPerSession?: number
  /** Runs started per client IP per hour. Default 30. */
  runsPerIpPerHour?: number
  /** A step-mode run waits this long after the page's last SSE connection closes. Default 15000. */
  disconnectGraceMs?: number
  /** Caps how long a step-mode run waits for a click. Default: until its charge expires. */
  stepTimeoutMs?: number
  /** Delay of the "slow bank" option. Default 1500. */
  slowBankMs?: number
  /** Sessions kept in memory. Default 5000. */
  maxSessions?: number
  /** Retry pacing for the agent's wrapFetch. */
  retry?: { initialDelayMs: number; factor: number; maxDelayMs: number }
  now?: () => number
}

interface Gate {
  action: StepAction
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Run {
  id: string
  session: Session
  mode: RunMode
  startedAt: number
  slow: boolean
  chargeId?: string
  expiresAt?: string
  pixSentAt?: number
  gate?: Gate
  retryGatePassed: boolean
  cancelled?: RunCancelled
}

interface Session {
  id: string
  touchedAt: number
  balances: { pagador: number; recebedor: number }
  paidFetch: PaidFetch
  listeners: Set<(event: SessionEvent) => void>
  runs: Map<string, Run>
  disconnectTimer?: ReturnType<typeof setTimeout>
  nextRun: number
}

/** Ends a run that was waiting for a click. */
export class RunCancelled extends Error {
  constructor(readonly reason: "expirada" | "desconectada" | "reiniciada") {
    super(`run ${reason}`)
  }
}

export type StartResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 409 | 429 | 503; error: string; retryAfterSeconds?: number }

const IDLE_SESSION_MS = 2 * 3600_000
const ORPHAN_TTL_MS = 60_000
/** Charge → run links kept for late PSP events; the daily reset clears them all. */
const MAX_OWNED_CHARGES = 20_000

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

export function createDemoAgent(options: DemoAgentOptions) {
  const now = options.now ?? Date.now
  const initialPayerBalance = options.initialPayerBalance ?? 10_000
  const policy = options.policy ?? { maxPerRequest: 1000, maxTotal: 5000 }
  const maxRuns = options.maxRunsPerSession ?? 3
  const runsPerHour = options.runsPerIpPerHour ?? 30
  const graceMs = options.disconnectGraceMs ?? 15_000
  const slowBankMs = options.slowBankMs ?? 1500
  const maxSessions = options.maxSessions ?? 5000
  const retry = options.retry ?? { initialDelayMs: 150, factor: 1.2, maxDelayMs: 400 }
  const simulate = simulatePayer({
    facilitatorUrl: "http://facilitator.interno",
    fetch: options.facilitatorFetch,
  })

  const sessions = new Map<string, Session>()
  /** chargeId → the run that asked for it. */
  const owners = new Map<string, Run>()
  /** Hub events for charges whose 402 has not reached the agent yet. */
  let orphans = new Map<string, { at: number; events: HubEvent[] }>()
  let ipLimiter: RateLimiter = createRateLimiter({ limit: runsPerHour, windowMs: 3600_000, now })

  // ---------- sessions ----------

  function send(session: Session, event: Omit<SessionEvent, "at"> & { at?: number }) {
    const full = { at: clock(), ...event } as SessionEvent
    for (const listener of session.listeners) {
      try {
        listener(full)
      } catch (error) {
        console.error("demo-web: session listener failed", error)
      }
    }
  }

  function prune() {
    const cutoff = now() - IDLE_SESSION_MS
    for (const [id, session] of sessions) {
      if (session.listeners.size === 0 && session.runs.size === 0 && session.touchedAt < cutoff) {
        sessions.delete(id)
      }
    }
    if (sessions.size < maxSessions) return
    // Still full: drop the least recently used idle sessions.
    const idle = [...sessions.values()]
      .filter((s) => s.listeners.size === 0 && s.runs.size === 0)
      .sort((a, b) => a.touchedAt - b.touchedAt)
    for (const session of idle.slice(0, Math.ceil(maxSessions / 10))) sessions.delete(session.id)
  }

  function session(id: string): Session | undefined {
    if (!SESSION_ID.test(id)) return undefined
    let found = sessions.get(id)
    if (!found) {
      if (sessions.size >= maxSessions) prune()
      if (sessions.size >= maxSessions) return undefined
      found = {
        id,
        touchedAt: now(),
        balances: { pagador: initialPayerBalance, recebedor: 0 },
        paidFetch: undefined as unknown as PaidFetch,
        listeners: new Set(),
        runs: new Map(),
        nextRun: 1,
      }
      found.paidFetch = createPaidFetch(found)
      sessions.set(id, found)
    }
    found.touchedAt = now()
    return found
  }

  function snapshot(s: Session) {
    return {
      sessao: s.id,
      saldoInicialPagador: initialPayerBalance,
      saldos: { ...s.balances },
      gasto: s.paidFetch.spent,
      politica: { ...policy },
      limites: { comprasSimultaneas: maxRuns, comprasPorHora: runsPerHour },
      compras: [...s.runs.values()].map((run) => ({
        runId: run.id,
        modo: run.mode,
        aguardando: run.gate?.action ?? null,
      })),
    }
  }

  // ---------- step gates ----------

  function waitFor(run: Run, action: StepAction): Promise<void> {
    if (run.cancelled) return Promise.reject(run.cancelled)
    const expiresIn = run.expiresAt ? Date.parse(run.expiresAt) - Date.now() : 300_000
    const timeout = Math.max(0, Math.min(options.stepTimeoutMs ?? expiresIn, expiresIn))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => cancelRun(run, new RunCancelled("expirada")), timeout)
      run.gate = { action, resolve, reject, timer }
      send(run.session, {
        type: "aguardando",
        runId: run.id,
        acao: action,
        expiraEm: new Date(Date.now() + timeout).toISOString(),
      })
    })
  }

  function cancelRun(run: Run, reason: RunCancelled) {
    if (run.cancelled) return
    run.cancelled = reason
    const gate = run.gate
    run.gate = undefined
    if (gate) {
      clearTimeout(gate.timer)
      gate.reject(reason)
    }
  }

  // ---------- the buyer ----------

  function createPaidFetch(s: Session): PaidFetch {
    const runOf = (request: Request) => s.runs.get(request.headers.get("x-demo-run") ?? "")

    const traced: FetchLike = async (request) => {
      const run = runOf(request)
      const signature = request.headers.get(HEADER_PAYMENT_SIGNATURE)
      if (run && signature && run.mode === "passos" && !run.retryGatePassed) {
        await waitFor(run, "tentar")
        run.retryGatePassed = true
      }
      if (run) {
        send(s, {
          type: "http.pedido",
          runId: run.id,
          method: request.method,
          path: new URL(request.url).pathname,
          ...(signature
            ? {
                assinatura: signature,
                assinaturaDecodificada: safe(() => decodePaymentPayload(signature)),
              }
            : {}),
        })
      }
      const forwarded = new Request(request)
      forwarded.headers.delete("x-demo-run")
      const response = await options.sellerFetch(forwarded)
      if (!run) return response

      const required = response.headers.get(HEADER_PAYMENT_REQUIRED)
      const paymentResponse = response.headers.get(HEADER_PAYMENT_RESPONSE)
      const decodedRequired = required ? safe(() => decodePaymentRequired(required)) : undefined
      const body =
        response.ok && paymentResponse
          ? await response
              .clone()
              .json()
              .catch(() => undefined)
          : undefined
      send(s, {
        type: "http.resposta",
        runId: run.id,
        status: response.status,
        ...(required && !signature
          ? { requisitos: required, requisitosDecodificados: decodedRequired }
          : {}),
        ...(paymentResponse
          ? {
              liquidacao: paymentResponse,
              liquidacaoDecodificada: safe(() => decodeSettlementResponse(paymentResponse)),
            }
          : {}),
        ...(response.headers.get("retry-after") !== null
          ? { retryAfter: response.headers.get("retry-after") }
          : {}),
        ...(body !== undefined ? { corpo: body } : {}),
      })

      const accepted = decodedRequired?.accepts[0]
      const extra = record(accepted?.extra)
      if (response.status === 402 && !signature && typeof extra.chargeId === "string") {
        run.chargeId = extra.chargeId
        run.expiresAt = typeof extra.expiresAt === "string" ? extra.expiresAt : undefined
        owners.set(extra.chargeId, run)
        if (owners.size > MAX_OWNED_CHARGES) {
          const oldest = owners.keys().next().value
          if (oldest !== undefined) owners.delete(oldest)
        }
        send(s, {
          type: "cobranca",
          runId: run.id,
          chargeId: extra.chargeId,
          amount: accepted?.amount,
          brCode: extra.brCode,
          expiresAt: extra.expiresAt,
        })
        const pending = orphans.get(extra.chargeId)
        if (pending) {
          orphans.delete(extra.chargeId)
          for (const event of pending.events) route(event)
        }
        // Step mode: hold the 402 until the visitor clicks "pagar", so wrapFetch reserves the
        // amount against its policy only once they chose to pay.
        if (run.mode === "passos") await waitFor(run, "pagar")
      }
      return response
    }

    const payer: PixPayer = {
      paysBrCode: false,
      async pay(charge) {
        const run = owners.get(charge.chargeId)
        const sendPix = async () => {
          if (run) {
            run.pixSentAt = clock()
            send(s, {
              type: "pix.enviado",
              runId: run.id,
              chargeId: charge.chargeId,
              amount: charge.amount,
              gasto: s.paidFetch.spent,
              politica: { ...policy },
              lento: run.slow,
            })
          }
          await simulate.pay(charge)
        }
        if (!run?.slow) return sendPix()
        // A slow bank: the Pix is confirmed later, so the agent meets settlement_pending first.
        setTimeout(() => {
          sendPix().catch((error: unknown) => console.error("demo-web: simulate failed", error))
        }, slowBankMs)
      },
    }

    return wrapFetch(traced, { payer, policy, retry })
  }

  async function execute(run: Run) {
    const s = run.session
    let end: RunEnd = "erro"
    let error: Record<string, unknown> | undefined
    try {
      const response = await s.paidFetch(options.resourceUrl, { headers: { "x-demo-run": run.id } })
      end = response.ok ? "ok" : "erro"
      if (!response.ok) error = { code: `http_${response.status}` }
      await response.body?.cancel().catch(() => undefined)
    } catch (caught) {
      const cause =
        isPx402Error(caught) && caught.cause instanceof RunCancelled ? caught.cause : caught
      if (cause instanceof RunCancelled) {
        end = "expirada"
        error = { code: cause.reason }
      } else if (isPx402Error(cause)) {
        error = { code: cause.code, reason: record(cause.details).reason ?? null }
      } else {
        console.error("demo-web: run failed", cause)
        error = { code: "unexpected_error" }
      }
    } finally {
      if (run.gate) clearTimeout(run.gate.timer)
      run.gate = undefined
      s.runs.delete(run.id)
      send(s, {
        type: "compra.fim",
        runId: run.id,
        status: end,
        totalMs: clock() - run.startedAt,
        gasto: s.paidFetch.spent,
        ...(error ? { erro: error } : {}),
      })
    }
  }

  function start(sessionId: string, ip: string, mode: RunMode, slow: boolean): StartResult {
    const s = session(sessionId)
    if (!s) {
      return sessionId && SESSION_ID.test(sessionId)
        ? { ok: false, status: 503, error: "sessoes_esgotadas" }
        : { ok: false, status: 400, error: "sessao_invalida" }
    }
    if (s.runs.size >= maxRuns) return { ok: false, status: 429, error: "limite_simultaneas" }
    const take = ipLimiter.take(ip)
    if (!take.ok) {
      return {
        ok: false,
        status: 429,
        error: "limite_por_hora",
        retryAfterSeconds: take.retryAfterSeconds,
      }
    }
    const run: Run = {
      id: `c${s.nextRun++}`,
      session: s,
      mode,
      startedAt: clock(),
      slow,
      retryGatePassed: false,
    }
    s.runs.set(run.id, run)
    send(s, { type: "compra.inicio", runId: run.id, modo: mode, lento: slow, at: run.startedAt })
    void execute(run)
    return { ok: true, runId: run.id }
  }

  /** Advances the session's step-mode run that waits for `action`. */
  function step(sessionId: string, action: StepAction): StartResult {
    const s = SESSION_ID.test(sessionId) ? sessions.get(sessionId) : undefined
    const run = s && [...s.runs.values()].find((r) => r.gate?.action === action)
    if (!run?.gate) return { ok: false, status: 409, error: "nada_aguardando" }
    const gate = run.gate
    run.gate = undefined
    clearTimeout(gate.timer)
    gate.resolve()
    return { ok: true, runId: run.id }
  }

  // ---------- routing hub events to their session ----------

  function route(event: HubEvent) {
    const chargeId = event.chargeId
    if (!chargeId) return
    const run = owners.get(chargeId)
    if (!run) {
      // The facilitator reports a charge before its 402 reaches the agent: hold it briefly.
      const t = now()
      if (orphans.size > 1000) {
        for (const [id, entry] of orphans) if (t - entry.at > ORPHAN_TTL_MS) orphans.delete(id)
      }
      const entry = orphans.get(chargeId) ?? { at: t, events: [] }
      entry.events.push(event)
      orphans.set(chargeId, entry)
      return
    }
    const s = run.session
    if (event.type === "facilitator") {
      send(s, { ...event, runId: run.id })
      return
    }
    if (event.type === "pix.confirmado") {
      s.balances = {
        pagador: s.balances.pagador - event.amount,
        recebedor: s.balances.recebedor + event.amount,
      }
      send(s, {
        ...event,
        runId: run.id,
        ...(run.pixSentAt === undefined ? {} : { latenciaServidorMs: event.at - run.pixSentAt }),
      })
      send(s, { type: "saldos", saldos: { ...s.balances } })
      return
    }
    send(s, { ...event, runId: run.id })
  }

  const unsubscribeHub = options.hub.subscribe(route)

  // ---------- connections, resets ----------

  function connect(sessionId: string, listener: (event: SessionEvent) => void) {
    const s = session(sessionId)
    if (!s) return undefined
    s.listeners.add(listener)
    if (s.disconnectTimer) {
      clearTimeout(s.disconnectTimer)
      s.disconnectTimer = undefined
    }
    return {
      snapshot: snapshot(s),
      close() {
        s.listeners.delete(listener)
        s.touchedAt = now()
        if (s.listeners.size > 0 || s.disconnectTimer) return
        // Nobody is watching: paused step-mode runs give up after a grace period.
        s.disconnectTimer = setTimeout(() => {
          s.disconnectTimer = undefined
          if (s.listeners.size > 0) return
          for (const run of s.runs.values()) {
            if (run.mode === "passos") cancelRun(run, new RunCancelled("desconectada"))
          }
        }, graceMs)
      },
    }
  }

  function resetSession(s: Session) {
    for (const run of s.runs.values()) cancelRun(run, new RunCancelled("reiniciada"))
    s.balances = { pagador: initialPayerBalance, recebedor: 0 }
    s.paidFetch = createPaidFetch(s)
  }

  /** A visitor's own "start again": refused while one of their runs is still going. */
  function resetOne(sessionId: string): { ok: true } | { ok: false; status: 400 | 409 } {
    const s = SESSION_ID.test(sessionId) ? sessions.get(sessionId) : undefined
    if (!s) return SESSION_ID.test(sessionId) ? { ok: true } : { ok: false, status: 400 }
    if ([...s.runs.values()].some((run) => run.mode === "auto")) return { ok: false, status: 409 }
    resetSession(s)
    send(s, { type: "estado", ...snapshot(s) })
    return { ok: true }
  }

  /** Clears every session's demo data (admin endpoint and the daily schedule). */
  function resetAll() {
    for (const s of sessions.values()) {
      resetSession(s)
      send(s, { type: "reiniciado" })
      send(s, { type: "estado", ...snapshot(s) })
    }
    for (const [id, s] of sessions) if (s.listeners.size === 0) sessions.delete(id)
    owners.clear()
    orphans = new Map()
    ipLimiter = createRateLimiter({ limit: runsPerHour, windowMs: 3600_000, now })
    options.hub.reset()
  }

  /** The session's current state, creating the session if needed. */
  function state(sessionId: string) {
    const s = session(sessionId)
    return s ? snapshot(s) : undefined
  }

  return {
    start,
    step,
    connect,
    state,
    resetOne,
    resetAll,
    stats: () => ({
      sessions: sessions.size,
      runs: [...sessions.values()].reduce((n, s) => n + s.runs.size, 0),
      charges: owners.size,
    }),
    close: unsubscribeHub,
  }
}

export type DemoAgent = ReturnType<typeof createDemoAgent>
