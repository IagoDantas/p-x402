// Browser side of the demo. The payer is this page: it runs the real `wrapFetch` from
// @p-x402/client against the seller mounted at /loja, and pays with `simulatePayer`. The merchant
// panel listens to /api/eventos (Server-Sent Events) and measures how fast each Pix lands.
import { type PaidFetch, type PixPayer, simulatePayer, wrapFetch } from "@p-x402/client"
import {
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isPx402Error,
} from "@p-x402/core"
import { encode } from "uqr"

// ---------- types ----------

type Side = "agente" | "loja" | "facilitator" | "psp"
type Tone = "neutral" | "pix" | "warn" | "ok" | "err"

interface HeaderDetail {
  label: string
  hint?: string
  raw?: string
  decoded?: unknown
}

interface Step {
  id: number
  at: number
  side: Side
  tone: Tone
  http?: string
  title: string
  note?: string
  pill?: { text: string; fast?: boolean }
  details?: HeaderDetail[]
  charge?: { chargeId: string; amount: string; brCode: string; expiresAt: string }
}

interface Run {
  id: number
  startedAt: number
  status: "running" | "ok" | "err"
  totalMs?: number
  chargeId?: string
  steps: Step[]
}

interface FeedItem {
  chargeId: string
  amount: number
  latencyMs: number | undefined
  pushMs: number
  settled: boolean
}

interface Snapshot {
  provider: string
  merchant: string
  resource: { path: string; amount: number }
  saldoInicialPagador: number
  saldos: { pagador: number; recebedor: number }
}

type ServerEvent =
  | {
      type: "facilitator"
      path: "/pix/charges" | "/verify" | "/settle"
      chargeId?: string
      status: number
      ok: boolean
      reason?: string
      startedAt: number
      durationMs: number
      at: number
    }
  | { type: "pix.confirmado"; chargeId: string; amount: number; at: number }
  | { type: "liquidado"; chargeId: string; amount: number; at: number }
  | { type: "saldos"; saldos: { pagador: number; recebedor: number }; at: number }

// ---------- constants and helpers ----------

const RUN_HEADER = "x-demo-compra"
const POLICY = { maxPerRequest: 1000, maxTotal: 5000 }
const SLOW_BANK_MS = 1500
const clock = () => performance.timeOrigin + performance.now()

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === undefined || child === false) continue
    node.append(child)
  }
  return node
}

const brlFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
const brl = (centavos: number | string) => brlFormat.format(Number(centavos) / 100)

function ms(value: number): string {
  if (value < 10) return `${value.toFixed(1).replace(".", ",")} ms`
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2).replace(".", ",")} s`
}

function offset(value: number): string {
  return `+${ms(Math.max(0, value))}`
}

function short(value: string, keep = 10): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** JSON with keys, strings and numbers wrapped in spans. Text is escaped first. */
function highlightJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
  return text.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?|true|false|null)\b/g,
    (match, str: string | undefined, colon: string | undefined, literal: string | undefined) => {
      if (str !== undefined && colon !== undefined) return `<span class="k">${str}</span>${colon}`
      if (str !== undefined) return `<span class="s">${str}</span>`
      if (literal !== undefined) return `<span class="n">${literal}</span>`
      return match
    },
  )
}

/** QR code as an SVG path (one square per dark module). */
function qrSvg(text: string): string {
  const { data, size } = encode(text, { ecc: "M", border: 2 })
  let path = ""
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`
    })
  })
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR Code Pix" shape-rendering="crispEdges"><path d="${path}" fill="#08090a"/></svg>`
}

// ---------- state ----------

const state = {
  snapshot: undefined as Snapshot | undefined,
  runs: [] as Run[],
  selected: undefined as number | undefined,
  runByCharge: new Map<string, Run>(),
  orphanSteps: new Map<string, Step[]>(),
  /** Browser time when the Pix for a charge was sent (the payer called simulate-payment). */
  pixSentAt: new Map<string, number>(),
  feed: [] as FeedItem[],
  latencies: [] as number[],
  pushes: [] as number[],
  balances: { pagador: 0, recebedor: 0 },
  shownBalances: { pagador: 0, recebedor: 0 },
  nextRun: 1,
  nextStep: 1,
}

let paidFetch: PaidFetch = createPaidFetch()

// ---------- payer: wrapFetch with a traced inner fetch ----------

function runOf(request: Request): Run | undefined {
  const id = Number(request.headers.get(RUN_HEADER))
  return state.runs.find((r) => r.id === id)
}

function linkCharge(run: Run, chargeId: string) {
  run.chargeId = chargeId
  state.runByCharge.set(chargeId, run)
  const orphans = state.orphanSteps.get(chargeId)
  if (orphans) {
    state.orphanSteps.delete(chargeId)
    for (const step of orphans) addStep(run, step)
  }
  renderRuns()
}

/** Wraps window.fetch: every request wrapFetch sends, and every response it reads, becomes a step. */
async function tracedFetch(request: Request): Promise<Response> {
  const run = runOf(request)
  const url = new URL(request.url)
  const signature = request.headers.get(HEADER_PAYMENT_SIGNATURE)
  if (run) {
    if (signature) {
      let decoded: unknown
      try {
        decoded = decodePaymentPayload(signature)
      } catch {
        decoded = undefined
      }
      addStep(run, {
        side: "agente",
        tone: "neutral",
        http: `${request.method} ${url.pathname}`,
        title: "Nova tentativa com a prova de pagamento",
        note: "O agente repete o pedido com o header <b>PAYMENT-SIGNATURE</b>, que aponta para a cobrança paga.",
        details: [{ label: "PAYMENT-SIGNATURE", raw: signature, decoded }],
      })
    } else {
      addStep(run, {
        side: "agente",
        tone: "neutral",
        http: `${request.method} ${url.pathname}`,
        title: "Pedido sem pagamento",
        note: "O agente chama a API como qualquer cliente HTTP.",
      })
    }
  }

  const response = await fetch(request)
  if (!run) return response

  const required = response.headers.get(HEADER_PAYMENT_REQUIRED)
  const paymentResponse = response.headers.get(HEADER_PAYMENT_RESPONSE)
  const settlement = paymentResponse
    ? safe(() => decodeSettlementResponse(paymentResponse))
    : undefined

  if (response.status === 402 && required && !signature) {
    const decoded = safe(() => decodePaymentRequired(required))
    const accepted = decoded?.accepts[0]
    const extra = (accepted?.extra ?? {}) as Record<string, unknown>
    const chargeId = typeof extra.chargeId === "string" ? extra.chargeId : undefined
    addStep(run, {
      side: "loja",
      tone: "warn",
      http: "402 Payment Required",
      title: "A loja pede pagamento",
      note: `O <span class="mono">pixPaywall</span> devolve o preço (${brl(accepted?.amount ?? 0)}) e uma cobrança Pix no header <b>PAYMENT-REQUIRED</b>.`,
      details: [{ label: "PAYMENT-REQUIRED", raw: required, decoded }],
    })
    if (chargeId && typeof extra.brCode === "string" && typeof extra.expiresAt === "string") {
      addStep(run, {
        side: "psp",
        tone: "pix",
        title: "Cobrança Pix pronta",
        note: "BR Code copia e cola com valor fixo. Vale por 5 minutos.",
        charge: {
          chargeId,
          amount: accepted?.amount ?? "0",
          brCode: extra.brCode,
          expiresAt: extra.expiresAt,
        },
      })
      linkCharge(run, chargeId)
    }
  } else if (response.status === 402 && signature) {
    const reason = settlement?.errorReason ?? "desconhecido"
    const pending = reason === "settlement_pending"
    const retryAfter = response.headers.get("retry-after")
    addStep(run, {
      side: "loja",
      tone: pending ? "warn" : "err",
      http: "402",
      title: pending ? "Pix ainda não confirmado" : "Pagamento recusado",
      note: pending
        ? `O PSP ainda não marcou a cobrança como paga (<span class="mono">settlement_pending</span>). O agente tenta de novo${retryAfter ? ` em ${retryAfter} s` : ""}.`
        : `Motivo: <span class="mono">${reason}</span>`,
      ...(paymentResponse
        ? { details: [{ label: "PAYMENT-RESPONSE", raw: paymentResponse, decoded: settlement }] }
        : {}),
    })
  } else if (response.ok && settlement) {
    const body = await response
      .clone()
      .json()
      .catch(() => undefined)
    addStep(run, {
      side: "loja",
      tone: "ok",
      http: `${response.status} OK`,
      title: "Recurso entregue",
      note: `Liquidação <b>${settlement.success ? "confirmada" : "falhou"}</b>: transação <span class="mono">${short(settlement.transaction, 12)}</span> na rede <span class="mono">${settlement.network}</span>.`,
      details: [
        { label: "PAYMENT-RESPONSE", raw: paymentResponse ?? "", decoded: settlement },
        { label: "Corpo da resposta", hint: "application/json", decoded: body },
      ],
    })
  } else if (response.status === 429) {
    addStep(run, {
      side: "loja",
      tone: "err",
      http: "429 Too Many Requests",
      title: "A loja limitou as cobranças",
      note: 'O <span class="mono">pixPaywall</span> limita quantas cobranças cada IP abre por minuto. Espere um pouco e tente de novo.',
    })
  } else if (!response.ok) {
    addStep(run, {
      side: "loja",
      tone: "err",
      http: String(response.status),
      title: "Resposta inesperada da loja",
    })
  }
  return response
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function createPaidFetch(): PaidFetch {
  const simulate = simulatePayer({ facilitatorUrl: `${location.origin}/facilitator` })
  const payer: PixPayer = {
    paysBrCode: false,
    async pay(charge) {
      const run = state.runByCharge.get(charge.chargeId)
      const slow = $<HTMLInputElement>("slow-bank").checked
      const spent = paidFetch.spent
      if (run) {
        addStep(run, {
          side: "agente",
          tone: "pix",
          title: `Agente paga ${brl(charge.amount)} via Pix`,
          note: `Política ok: ${brl(charge.amount)} ≤ ${brl(POLICY.maxPerRequest)} por compra; gasto total ${brl(spent)} de ${brl(POLICY.maxTotal)}.${slow ? " Banco lento: a confirmação sai em 1,5 s." : ""}`,
        })
      }
      renderSpent()
      const send = async () => {
        state.pixSentAt.set(charge.chargeId, clock())
        await simulate.pay(charge)
      }
      if (!slow) return send()
      // A slow bank: the Pix is sent and confirmed later, so the agent sees settlement_pending first.
      setTimeout(() => {
        send().catch((error: unknown) => console.error("simulate-payment falhou", error))
      }, SLOW_BANK_MS)
    },
  }
  return wrapFetch(tracedFetch, {
    payer,
    policy: { ...POLICY, allowedOrigins: [location.origin] },
  })
}

// ---------- runs and steps ----------

function newRun(): Run {
  const run: Run = { id: state.nextRun++, startedAt: clock(), status: "running", steps: [] }
  state.runs.push(run)
  state.selected = run.id
  renderRuns()
  renderTimeline()
  return run
}

function addStep(run: Run, input: Omit<Step, "id" | "at"> & { at?: number }) {
  const step: Step = { ...input, id: state.nextStep++, at: input.at ?? clock() }
  run.steps.push(step)
  run.steps.sort((a, b) => a.at - b.at)
  if (state.selected === run.id) insertStepNode(run, step, true)
}

async function buy(): Promise<void> {
  const run = newRun()
  try {
    const response = await paidFetch(
      `${location.origin}${state.snapshot?.resource.path ?? "/loja/relatorio"}`,
      {
        headers: { [RUN_HEADER]: String(run.id) },
      },
    )
    run.status = response.ok ? "ok" : "err"
  } catch (error) {
    run.status = "err"
    addStep(run, {
      side: "agente",
      tone: "err",
      title: errorTitle(error),
      note: errorNote(error),
    })
  } finally {
    run.totalMs = clock() - run.startedAt
    renderRuns()
    renderSpent()
    if (state.selected === run.id) renderFlowSub()
  }
}

function errorTitle(error: unknown): string {
  if (!isPx402Error(error)) return "Falha de rede"
  if (error.code === "policy_exceeded") return "A política do agente bloqueou o pagamento"
  if (error.code === "payment_timeout") return "A cobrança expirou antes da confirmação"
  if (error.code === "payer_failed") return "O pagamento Pix falhou"
  return `Pagamento recusado (${error.code})`
}

function errorNote(error: unknown): string {
  if (!isPx402Error(error)) return "Não foi possível falar com a loja."
  const reason = (error.details as Record<string, unknown> | undefined)?.reason
  if (reason === "max_total") {
    return `O limite total de ${brl(POLICY.maxTotal)} foi atingido. Nenhum Pix foi enviado. Use “Reiniciar demo”.`
  }
  if (reason === "max_per_request") return "O valor passa do limite por compra."
  return `<span class="mono">${error.code}</span>: ${error.message}`
}

// ---------- server events (SSE) ----------

function connectEvents() {
  const badge = $("sse-badge")
  const label = badge.querySelector("span:last-child") as HTMLElement
  const source = new EventSource("/api/eventos")
  const setState = (value: "open" | "connecting" | "error", text: string) => {
    badge.dataset.state = value
    label.textContent = text
  }
  source.addEventListener("open", () => setState("open", "SSE ao vivo"))
  source.addEventListener("error", () => {
    setState(source.readyState === EventSource.CLOSED ? "error" : "connecting", "reconectando")
  })
  source.addEventListener("estado", (message) => {
    const snapshot = JSON.parse((message as MessageEvent<string>).data) as Snapshot
    state.snapshot = snapshot
    setBalances(snapshot.saldos, false)
    renderProvider()
    startAutoBuy()
  })
  for (const type of ["facilitator", "pix.confirmado", "liquidado", "saldos"] as const) {
    source.addEventListener(type, (message) => {
      const arrived = clock()
      onServerEvent(JSON.parse((message as MessageEvent<string>).data) as ServerEvent, arrived)
    })
  }
}

function attach(chargeId: string | undefined, step: Omit<Step, "id">) {
  if (!chargeId) return
  const run = state.runByCharge.get(chargeId)
  if (run) {
    addStep(run, step)
    return
  }
  // The server can report a charge before the 402 that carries it reaches the browser.
  const pending = state.orphanSteps.get(chargeId) ?? []
  pending.push({ ...step, id: state.nextStep++ })
  state.orphanSteps.set(chargeId, pending)
}

function onServerEvent(event: ServerEvent, arrived: number) {
  if (event.type === "saldos") {
    setBalances(event.saldos, true)
    return
  }
  if (event.type === "facilitator") {
    const pill = { text: ms(event.durationMs), fast: event.ok }
    if (event.path === "/pix/charges") {
      attach(event.chargeId, {
        at: event.startedAt,
        side: "facilitator",
        tone: event.ok ? "neutral" : "err",
        http: "POST /pix/charges",
        title: "A loja pede uma cobrança Pix ao facilitator",
        note: "O facilitator cria a cobrança no PSP e devolve os requisitos de pagamento.",
        pill,
      })
    } else if (event.path === "/verify") {
      attach(event.chargeId, {
        at: event.startedAt,
        side: "facilitator",
        tone: event.ok ? "ok" : "warn",
        http: "POST /verify",
        title: event.ok ? "Pagamento verificado" : "Verificação ainda sem Pix",
        note: event.ok
          ? "O facilitator conferiu no PSP: cobrança paga, valor e destino certos. O handler da loja roda agora."
          : `<span class="mono">${event.reason ?? "inválido"}</span>`,
        pill,
      })
    } else {
      attach(event.chargeId, {
        at: event.startedAt,
        side: "facilitator",
        tone: event.ok ? "ok" : "err",
        http: "POST /settle",
        title: event.ok ? "Liquidado" : "Liquidação falhou",
        note: event.ok
          ? "A cobrança é consumida uma única vez; a resposta leva o PAYMENT-RESPONSE."
          : `<span class="mono">${event.reason ?? "erro"}</span>`,
        pill,
      })
    }
    return
  }
  if (event.type === "pix.confirmado") {
    const sentAt = state.pixSentAt.get(event.chargeId)
    const latencyMs = sentAt === undefined ? undefined : arrived - sentAt
    const pushMs = Math.max(0, arrived - event.at)
    if (latencyMs !== undefined) state.latencies.push(latencyMs)
    state.pushes.push(pushMs)
    state.feed.unshift({
      chargeId: event.chargeId,
      amount: event.amount,
      latencyMs,
      pushMs,
      settled: false,
    })
    attach(event.chargeId, {
      at: event.at,
      side: "psp",
      tone: "ok",
      title: "PSP confirmou o Pix · loja avisada",
      note: `Webhook do PSP → facilitator → evento SSE para a loja. Pix enviado → loja avisada em <b>${latencyMs === undefined ? "–" : ms(latencyMs)}</b>.`,
      pill: { text: latencyMs === undefined ? ms(pushMs) : ms(latencyMs), fast: true },
    })
    renderFeed()
    renderLatency()
    return
  }
  // liquidado
  const item = state.feed.find((f) => f.chargeId === event.chargeId)
  if (item) {
    item.settled = true
    renderFeed()
  }
}

// ---------- rendering ----------

function renderProvider() {
  const provider = state.snapshot?.provider ?? "…"
  const label = provider === "mock" ? "PSP mock · simulação" : `PSP ${provider} · sandbox`
  $("provider-badge").textContent = label
  $("merchant-id").textContent = state.snapshot?.merchant ?? ""
  $("foot-provider").textContent =
    provider === "mock"
      ? "Sem dinheiro real: PSP em memória."
      : "AbacatePay em modo dev: sem dinheiro real."
}

function renderSpent() {
  const spent = paidFetch.spent
  $("spent-label").textContent = `${brl(spent)} de ${brl(POLICY.maxTotal)}`
  const bar = $("spent-bar")
  bar.style.transform = `scaleX(${Math.min(1, spent / POLICY.maxTotal)})`
  bar.classList.toggle("full", spent >= POLICY.maxTotal)
}

function setBalances(next: { pagador: number; recebedor: number }, animate: boolean) {
  const previous = state.balances
  state.balances = { ...next }
  if (animate) {
    showDelta("payer-delta", next.pagador - previous.pagador)
    showDelta("merchant-delta", next.recebedor - previous.recebedor)
    tweenBalances()
  } else {
    state.shownBalances = { ...next }
    paintBalances()
  }
}

function showDelta(id: string, delta: number) {
  if (delta === 0) return
  const node = $(id)
  node.textContent = `${delta > 0 ? "+" : "−"}${brl(Math.abs(delta))}`
  node.className = `delta ${delta > 0 ? "up" : "down"}`
  void node.offsetWidth // restart the animation
  node.classList.add("show")
}

let tween = 0
function tweenBalances() {
  const from = { ...state.shownBalances }
  const to = { ...state.balances }
  const start = performance.now()
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450
  cancelAnimationFrame(tween)
  const frame = (now: number) => {
    const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration)
    const eased = 1 - (1 - t) ** 3
    state.shownBalances = {
      pagador: Math.round(from.pagador + (to.pagador - from.pagador) * eased),
      recebedor: Math.round(from.recebedor + (to.recebedor - from.recebedor) * eased),
    }
    paintBalances()
    if (t < 1) tween = requestAnimationFrame(frame)
  }
  tween = requestAnimationFrame(frame)
}

function paintBalances() {
  $("payer-balance").textContent = brl(state.shownBalances.pagador)
  $("merchant-balance").textContent = brl(state.shownBalances.recebedor)
}

function renderLatency() {
  const last = state.latencies.at(-1)
  const med = median(state.latencies)
  const push = median(state.pushes)
  $("lat-last").textContent = last === undefined ? "–" : ms(last)
  $("lat-median").textContent = med === undefined ? "–" : ms(med)
  $("lat-push").textContent = push === undefined ? "–" : ms(push)
  $("lat-count").textContent = String(state.feed.length)
}

function renderFeed() {
  const list = $("feed")
  $("feed-empty").hidden = state.feed.length > 0
  const existing = new Map<string, HTMLElement>()
  for (const node of Array.from(list.children))
    existing.set((node as HTMLElement).dataset.charge ?? "", node as HTMLElement)
  const nodes = state.feed.slice(0, 30).map((item) => {
    const status = item.settled ? "recurso entregue" : "aguardando entrega"
    const node = existing.get(item.chargeId) ?? el("li", { "data-charge": item.chargeId })
    node.replaceChildren(
      el("span", { class: "amt" }, `+${brl(item.amount)}`),
      el(
        "span",
        { class: "ms", title: "Pix enviado → loja avisada" },
        item.latencyMs === undefined ? ms(item.pushMs) : ms(item.latencyMs),
      ),
      el("span", { class: "id", title: item.chargeId }, item.chargeId),
      el("span", { class: `st${item.settled ? " done" : ""}` }, status),
    )
    return node
  })
  list.replaceChildren(...nodes)
}

function renderRuns() {
  const container = $("runs")
  container.replaceChildren(
    ...state.runs.slice(-8).map((run) => {
      const button = el(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": String(run.id === state.selected),
          title: run.chargeId ?? "",
        },
        el("i", { class: `s${run.status === "ok" ? " ok" : run.status === "err" ? " err" : ""}` }),
        `#${run.id}${run.totalMs === undefined ? "" : ` · ${ms(run.totalMs)}`}`,
      )
      button.addEventListener("click", () => {
        state.selected = run.id
        renderRuns()
        renderTimeline()
      })
      return button
    }),
  )
}

function selectedRun(): Run | undefined {
  return state.runs.find((r) => r.id === state.selected)
}

function renderFlowSub() {
  const run = selectedRun()
  const sub = $("flow-sub")
  if (!run) {
    sub.textContent = "Clique em “Comprar com Pix” para começar."
    return
  }
  const total = run.totalMs === undefined ? "em andamento" : `${ms(run.totalMs)} do pedido ao 200`
  sub.textContent = `Compra #${run.id}${run.chargeId ? ` · ${run.chargeId}` : ""} · ${run.status === "err" ? "falhou" : total}`
}

function renderTimeline() {
  const run = selectedRun()
  $("empty").hidden = run !== undefined
  const list = $("timeline")
  list.replaceChildren()
  renderFlowSub()
  if (!run) return
  for (const step of run.steps) insertStepNode(run, step, false)
}

function insertStepNode(run: Run, step: Step, animate: boolean) {
  const list = $("timeline")
  const node = stepNode(run, step)
  if (animate) node.classList.add("enter")
  const after = Array.from(list.children).find(
    (child) => Number((child as HTMLElement).dataset.at) > step.at,
  )
  list.insertBefore(node, after ?? null)
  renderFlowSub()
}

const SIDE_LABEL: Record<Side, string> = {
  agente: "agente",
  loja: "loja",
  facilitator: "facilitator",
  psp: "psp",
}

function stepNode(run: Run, step: Step): HTMLElement {
  const title = el("p", { class: "step-title" })
  if (step.http) title.append(el("span", { class: "http" }, step.http))
  title.append(step.title)
  if (step.pill)
    title.append(el("span", { class: `pill${step.pill.fast ? " fast" : ""}` }, step.pill.text))

  const body = el("div", { class: "step-body" }, el("span", { class: "step-dot" }), title)
  if (step.note) {
    const note = el("p", { class: "step-note" })
    note.innerHTML = step.note // notes are built from constants and decoded protocol fields
    body.append(note)
  }
  if (step.charge) body.append(chargeNode(step.charge))
  for (const detail of step.details ?? []) body.append(detailNode(detail))

  return el(
    "li",
    { class: "step", "data-tone": step.tone, "data-at": String(step.at) },
    el(
      "div",
      { class: "step-meta" },
      el("span", { class: "step-t" }, offset(step.at - run.startedAt)),
      el("span", { class: "step-side" }, SIDE_LABEL[step.side]),
    ),
    body,
  )
}

function detailNode(detail: HeaderDetail): HTMLElement {
  const pre = el("pre", { class: "code" })
  let html = detail.decoded === undefined ? "" : highlightJson(detail.decoded)
  if (detail.raw) {
    const raw = detail.raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    html += `${html ? "\n\n" : ""}<span class="raw-l">valor do header (base64)</span>\n<span class="raw">${raw}</span>`
  }
  pre.innerHTML = html
  return el(
    "details",
    { class: "hdr" },
    el(
      "summary",
      {},
      detail.label,
      el("span", {}, detail.hint ?? (detail.raw ? "base64 · decodificado" : "")),
    ),
    pre,
  )
}

function chargeNode(charge: NonNullable<Step["charge"]>): HTMLElement {
  const qr = el("div", { class: "qr" })
  qr.innerHTML = qrSvg(charge.brCode)
  const copy = el("button", { class: "copy", type: "button" }, "Copiar")
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(charge.brCode).then(
      () => {
        copy.textContent = "Copiado"
        setTimeout(() => {
          copy.textContent = "Copiar"
        }, 1400)
      },
      () => undefined,
    )
  })
  const expires = el("dd", { "data-expires": charge.expiresAt, "data-charge": charge.chargeId })
  updateExpiry(expires)
  return el(
    "div",
    { class: "charge" },
    qr,
    el(
      "dl",
      {},
      el("dt", {}, "Cobrança"),
      el("dd", { title: charge.chargeId }, charge.chargeId),
      el("dt", {}, "Valor"),
      el("dd", {}, brl(charge.amount)),
      el("dt", {}, "Expira"),
      expires,
      el("div", { class: "brcode" }, el("code", { title: charge.brCode }, charge.brCode), copy),
    ),
  )
}

function updateExpiry(node: HTMLElement) {
  const chargeId = node.dataset.charge ?? ""
  if (state.feed.some((f) => f.chargeId === chargeId)) {
    node.textContent = "paga"
    return
  }
  const left = Math.max(0, Date.parse(node.dataset.expires ?? "") - Date.now())
  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1000)
  node.textContent = left === 0 ? "expirada" : `em ${minutes}:${String(seconds).padStart(2, "0")}`
}

// ---------- wiring ----------

function setBusy(busy: boolean) {
  $<HTMLButtonElement>("buy").disabled = busy
  $<HTMLButtonElement>("buy-3").disabled = busy
}

let inFlight = 0
async function track(work: Promise<unknown>) {
  inFlight++
  setBusy(true)
  try {
    await work
  } finally {
    inFlight--
    if (inFlight === 0) setBusy(false)
  }
}

$("buy").addEventListener("click", () => {
  void track(buy())
})
$("buy-3").addEventListener("click", () => {
  void track(Promise.all([buy(), buy(), buy()]))
})
$("reset").addEventListener("click", async () => {
  if (inFlight > 0) return
  const response = await fetch("/api/reiniciar", { method: "POST" })
  const snapshot = (await response.json()) as Snapshot
  state.snapshot = snapshot
  state.runs = []
  state.selected = undefined
  state.runByCharge.clear()
  state.orphanSteps.clear()
  state.pixSentAt.clear()
  state.feed = []
  state.latencies = []
  state.pushes = []
  paidFetch = createPaidFetch()
  setBalances(snapshot.saldos, false)
  renderRuns()
  renderTimeline()
  renderFeed()
  renderLatency()
  renderSpent()
})

setInterval(() => {
  document.querySelectorAll<HTMLElement>("[data-expires]").forEach(updateExpiry)
}, 1000)

renderSpent()
renderFeed()
renderTimeline()
connectEvents()

// `?comprar=3` runs that many purchases once the event stream is up (kiosk mode, screenshots).
let autoBuys = Math.min(10, Number(new URLSearchParams(location.search).get("comprar") ?? 0) || 0)
function startAutoBuy() {
  if (autoBuys <= 0) return
  const count = autoBuys
  autoBuys = 0
  void track(
    (async () => {
      for (let i = 0; i < count; i++) await buy()
    })(),
  )
}
