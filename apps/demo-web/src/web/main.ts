// Browser side of the public demo. The buyer runs on the server (the real `wrapFetch` against
// `pixPaywall` and the facilitator); this page starts runs, streams the visitor's own events over
// SSE and draws them. Each visitor is an anonymous session: a random id kept in localStorage.
import { encode } from "uqr"

// ---------- types ----------

type Side = "agente" | "loja" | "facilitator" | "psp" | "voce"
type Tone = "neutral" | "pix" | "warn" | "ok" | "err" | "wait"

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
  sim?: boolean
  note?: string
  pill?: { text: string; fast?: boolean }
  details?: HeaderDetail[]
  charge?: { chargeId: string; amount: string; brCode: string; expiresAt: string }
}

interface Run {
  id: string
  mode: "auto" | "passos"
  startedAt: number
  status: "running" | "ok" | "err" | "expired"
  totalMs?: number
  chargeId?: string
  pixSentAt?: number
  waiting?: { action: "pagar" | "tentar"; until: number }
  steps: Step[]
}

interface FeedItem {
  chargeId: string
  amount: number
  latencyMs: number
  pushMs: number
  settled: boolean
}

type Ev = { type: string; at: number; runId?: string } & Record<string, unknown>

// ---------- constants and helpers ----------

const API = (document.querySelector<HTMLMetaElement>('meta[name="px402-api"]')?.content ?? "")
  .trim()
  .replace(/\/+$/, "")
const SESSION_KEY = "px402-demo-sessao"
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

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const brlFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
const brl = (centavos: unknown) => brlFormat.format(Number(centavos ?? 0) / 100)

function ms(value: number): string {
  if (value < 10) return `${value.toFixed(1).replace(".", ",")} ms`
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2).replace(".", ",")} s`
}

const offset = (value: number) => `+${ms(Math.max(0, value))}`

function short(value: string, keep = 10): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function countdown(untilMs: number): string {
  const left = Math.max(0, untilMs - Date.now())
  return `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`
}

/** JSON with keys, strings and numbers wrapped in spans. Text is escaped first. */
function highlightJson(value: unknown): string {
  const text = escapeHtml(JSON.stringify(value, null, 2) ?? "")
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

function sessionId(): string {
  const fresh = `s_${crypto.randomUUID().replaceAll("-", "")}`
  try {
    const kept = localStorage.getItem(SESSION_KEY)
    if (kept && /^[A-Za-z0-9_-]{16,64}$/.test(kept)) return kept
    localStorage.setItem(SESSION_KEY, fresh)
  } catch {
    // storage blocked: this tab gets its own session
  }
  return fresh
}

// ---------- state ----------

const SESSION = sessionId()
const state = {
  runs: [] as Run[],
  selected: undefined as string | undefined,
  feed: [] as FeedItem[],
  latencies: [] as number[],
  pushes: [] as number[],
  balances: { pagador: 0, recebedor: 0 },
  shown: { pagador: 0, recebedor: 0 },
  spent: 0,
  policy: { maxPerRequest: 1000, maxTotal: 5000 },
  provider: "",
  mode: "auto" as "auto" | "passos",
  /** Server clock minus browser clock, from /health. */
  skew: 0,
  nextStep: 1,
}

const toLocal = (serverAt: number) => serverAt - state.skew
const runById = (id: string | undefined) => state.runs.find((r) => r.id === id)
const stepRun = () => state.runs.find((r) => r.mode === "passos" && r.status === "running")

// ---------- API ----------

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-px402-sessao": SESSION },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function syncClock() {
  try {
    const t0 = clock()
    const response = await fetch(`${API}/health`)
    const t1 = clock()
    const { time } = (await response.json()) as { time: number }
    state.skew = time - (t0 + t1) / 2
  } catch {
    state.skew = 0
  }
}

const REFUSALS: Record<string, string> = {
  limite_simultaneas: "Espere uma compra terminar antes de começar outra.",
  limite_por_hora: "Limite de compras por hora atingido neste endereço. Tente de novo mais tarde.",
  nada_aguardando: "Esse passo não está esperando um clique agora.",
  sessoes_esgotadas: "A demo está cheia agora. Tente de novo em alguns minutos.",
  compra_em_andamento: "Espere a compra em andamento terminar.",
}

async function command(path: string, body: unknown) {
  try {
    const response = await api(path, body)
    if (response.ok) return true
    const { erro } = (await response.json().catch(() => ({}))) as { erro?: string }
    const wait = response.headers.get("retry-after")
    let text = REFUSALS[erro ?? ""] ?? `A demo recusou o pedido (${erro ?? response.status}).`
    if (erro === "limite_por_hora" && wait) {
      text = `${REFUSALS.limite_por_hora} Libera em ${Math.ceil(Number(wait) / 60)} min.`
    }
    notify(text)
  } catch {
    notify("Sem conexão com a demo. Verifique a internet e tente de novo.")
  }
  return false
}

let noticeTimer = 0
function notify(text: string, tone: "warn" | "ok" = "warn") {
  const node = $("notice")
  node.textContent = text
  node.dataset.tone = tone
  node.hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    node.hidden = true
  }, 6000)
}

// ---------- server events → steps ----------

function addStep(run: Run, input: Omit<Step, "id">) {
  const step: Step = { ...input, id: state.nextStep++ }
  run.steps.push(step)
  run.steps.sort((a, b) => a.at - b.at)
  if (state.selected === run.id) insertStepNode(run, step, true)
}

function onEvent(ev: Ev, arrived: number) {
  if (ev.type === "estado") return onSnapshot(ev)
  if (ev.type === "reiniciado") {
    clearLocal()
    notify("A demo foi reiniciada. Os saldos voltaram ao início.", "ok")
    return
  }
  if (ev.type === "saldos") {
    setBalances(ev.saldos as typeof state.balances, true)
    return
  }
  if (ev.type === "compra.inicio") {
    const run: Run = {
      id: String(ev.runId),
      mode: ev.modo === "passos" ? "passos" : "auto",
      startedAt: toLocal(ev.at),
      status: "running",
      steps: [],
    }
    state.runs.push(run)
    state.selected = run.id
    $("expired").hidden = true
    renderRuns()
    renderTimeline()
    renderStepper()
    return
  }
  const run = runById(ev.runId)
  if (!run) {
    if (ev.type === "liquidado") markSettled(String(ev.chargeId))
    return
  }
  const at = toLocal(ev.at)

  switch (ev.type) {
    case "http.pedido": {
      const signed = typeof ev.assinatura === "string"
      addStep(run, {
        at,
        side: "agente",
        tone: "neutral",
        http: `${ev.method} ${ev.path}`,
        title: signed ? "Nova tentativa com a prova de pagamento" : "Pedido sem pagamento",
        note: signed
          ? "O agente repete o pedido com o header <b>PAYMENT-SIGNATURE</b>, que aponta para a cobrança paga."
          : "O agente chama a API como qualquer cliente HTTP.",
        ...(signed
          ? {
              details: [
                {
                  label: "PAYMENT-SIGNATURE",
                  raw: String(ev.assinatura),
                  decoded: ev.assinaturaDecodificada,
                },
              ],
            }
          : {}),
      })
      break
    }
    case "http.resposta":
      onResponse(run, ev, at)
      break
    case "cobranca":
      run.chargeId = String(ev.chargeId)
      addStep(run, {
        at,
        side: "psp",
        tone: "pix",
        title: "Cobrança Pix pronta",
        note: "BR Code copia e cola com valor fixo. Vale por 5 minutos.",
        charge: {
          chargeId: String(ev.chargeId),
          amount: String(ev.amount),
          brCode: String(ev.brCode),
          expiresAt: String(ev.expiresAt),
        },
      })
      renderRuns()
      break
    case "facilitator":
      onFacilitator(run, ev)
      break
    case "aguardando": {
      const action = ev.acao === "tentar" ? "tentar" : "pagar"
      run.waiting = { action, until: Date.parse(String(ev.expiraEm)) }
      addStep(run, {
        at,
        side: "voce",
        tone: "wait",
        title:
          action === "pagar" ? "Aguardando você: pague o Pix" : "Aguardando você: tente de novo",
        note:
          action === "pagar"
            ? "Clique em <b>2. Pagar o Pix</b>. O agente está parado antes de pagar."
            : "O Pix já foi pago. Clique em <b>3. Tentar de novo</b> para o agente reenviar o pedido com a prova.",
      })
      renderStepper()
      break
    }
    case "pix.enviado": {
      run.waiting = undefined
      run.pixSentAt = Number(ev.at)
      state.spent = Number(ev.gasto ?? state.spent)
      const policy = ev.politica as typeof state.policy | undefined
      addStep(run, {
        at,
        side: "agente",
        tone: "pix",
        sim: true,
        title: `Agente paga ${brl(ev.amount)} via Pix`,
        note: `Pagamento simulado no PSP: nenhum dinheiro real se move. Política ok: ${brl(ev.amount)} ≤ ${brl(policy?.maxPerRequest)} por compra; gasto ${brl(state.spent)} de ${brl(policy?.maxTotal)}.${ev.lento ? " Banco lento: a confirmação sai em 1,5 s." : ""}`,
      })
      renderSpent()
      renderStepper()
      break
    }
    case "pix.confirmado": {
      const server = typeof ev.latenciaServidorMs === "number" ? ev.latenciaServidorMs : 0
      const pushMs = Math.max(0, arrived - toLocal(ev.at))
      const latencyMs = server + pushMs
      state.latencies.push(latencyMs)
      state.pushes.push(pushMs)
      state.feed.unshift({
        chargeId: String(ev.chargeId),
        amount: Number(ev.amount),
        latencyMs,
        pushMs,
        settled: false,
      })
      addStep(run, {
        at,
        side: "psp",
        tone: "ok",
        title: "PSP confirmou o Pix · loja avisada",
        note: `O facilitator registrou o Pix como pago (pelo webhook ou consultando o PSP) e a loja recebeu o evento por SSE. Pix enviado → loja avisada em <b>${ms(latencyMs)}</b>.`,
        pill: { text: ms(latencyMs), fast: true },
      })
      renderFeed()
      renderLatency()
      break
    }
    case "liquidado":
      markSettled(String(ev.chargeId))
      break
    case "compra.fim":
      onRunEnd(run, ev)
      break
  }
}

function onResponse(run: Run, ev: Ev, at: number) {
  const status = Number(ev.status)
  if (status === 402 && ev.requisitos) {
    const decoded = ev.requisitosDecodificados as { accepts?: { amount?: string }[] } | undefined
    addStep(run, {
      at,
      side: "loja",
      tone: "warn",
      http: "402 Payment Required",
      title: "A loja pede pagamento",
      note: `O <span class="mono">pixPaywall</span> devolve o preço (${brl(decoded?.accepts?.[0]?.amount)}) e uma cobrança Pix no header <b>PAYMENT-REQUIRED</b>.`,
      details: [{ label: "PAYMENT-REQUIRED", raw: String(ev.requisitos), decoded }],
    })
    return
  }
  const settlement = ev.liquidacaoDecodificada as
    | { success?: boolean; errorReason?: string; transaction?: string; network?: string }
    | undefined
  const details: HeaderDetail[] = ev.liquidacao
    ? [{ label: "PAYMENT-RESPONSE", raw: String(ev.liquidacao), decoded: settlement }]
    : []
  if (status === 402) {
    const pending = settlement?.errorReason === "settlement_pending"
    addStep(run, {
      at,
      side: "loja",
      tone: pending ? "warn" : "err",
      http: "402",
      title: pending ? "Pix ainda não confirmado" : "Pagamento recusado",
      note: pending
        ? `O PSP ainda não marcou a cobrança como paga (<span class="mono">settlement_pending</span>). O agente tenta de novo ${ev.retryAfter && ev.retryAfter !== "0" ? `em ${ev.retryAfter} s` : "em instantes"}.`
        : `Motivo: <span class="mono">${escapeHtml(settlement?.errorReason ?? "desconhecido")}</span>`,
      details,
    })
    return
  }
  if (status >= 200 && status < 300) {
    addStep(run, {
      at,
      side: "loja",
      tone: "ok",
      http: `${status} OK`,
      title: "Recurso entregue",
      note: `Liquidação <b>${settlement?.success ? "confirmada" : "falhou"}</b>: transação <span class="mono">${escapeHtml(short(settlement?.transaction ?? "", 12))}</span> na rede <span class="mono">${escapeHtml(settlement?.network ?? "")}</span>.`,
      details: [
        ...details,
        { label: "Corpo da resposta", hint: "application/json", decoded: ev.corpo },
      ],
    })
    return
  }
  addStep(run, {
    at,
    side: "loja",
    tone: "err",
    http: status === 429 ? "429 Too Many Requests" : String(status),
    title: status === 429 ? "A loja limitou as cobranças" : "Resposta inesperada da loja",
    ...(status === 429
      ? {
          note: 'O <span class="mono">pixPaywall</span> limita quantas cobranças cada IP abre por minuto. Espere um pouco e tente de novo.',
        }
      : {}),
  })
}

function onFacilitator(run: Run, ev: Ev) {
  const at = toLocal(Number(ev.startedAt ?? ev.at))
  const pill = { text: ms(Number(ev.durationMs ?? 0)), fast: ev.ok === true }
  const reason = `<span class="mono">${escapeHtml(String(ev.reason ?? "inválido"))}</span>`
  if (ev.path === "/pix/charges") {
    addStep(run, {
      at,
      side: "facilitator",
      tone: ev.ok ? "neutral" : "err",
      http: "POST /pix/charges",
      title: "A loja pede uma cobrança Pix ao facilitator",
      note: "O facilitator cria a cobrança no PSP e devolve os requisitos de pagamento.",
      pill,
    })
  } else if (ev.path === "/verify") {
    addStep(run, {
      at,
      side: "facilitator",
      tone: ev.ok ? "ok" : "warn",
      http: "POST /verify",
      title: ev.ok ? "Pagamento verificado" : "Verificação ainda sem Pix",
      note: ev.ok
        ? "O facilitator conferiu no PSP: cobrança paga, valor e destino certos. O handler da loja roda agora."
        : reason,
      pill,
    })
  } else {
    addStep(run, {
      at,
      side: "facilitator",
      tone: ev.ok ? "ok" : "err",
      http: "POST /settle",
      title: ev.ok ? "Liquidado" : "Liquidação falhou",
      note: ev.ok
        ? "A cobrança é consumida uma única vez; a resposta leva o PAYMENT-RESPONSE."
        : reason,
      pill,
    })
  }
}

const END_TITLES: Record<string, string> = {
  policy_exceeded: "A política do agente bloqueou o pagamento",
  payment_timeout: "A cobrança expirou antes da confirmação",
  payer_failed: "O pagamento Pix falhou",
}

function onRunEnd(run: Run, ev: Ev) {
  run.waiting = undefined
  run.totalMs = Number(ev.totalMs ?? 0)
  state.spent = Number(ev.gasto ?? state.spent)
  const error = (ev.erro ?? {}) as { code?: string; reason?: string | null }
  if (ev.status === "ok") {
    run.status = "ok"
  } else if (ev.status === "expirada") {
    run.status = "expired"
    addStep(run, {
      at: toLocal(ev.at),
      side: "voce",
      tone: "err",
      title: "Sessão expirada, comece de novo",
      note:
        error.code === "desconectada"
          ? "A página ficou fechada e a compra parada foi cancelada."
          : error.code === "reiniciada"
            ? "A demo foi reiniciada no meio da compra."
            : "A compra ficou parada sem um clique até o prazo acabar.",
    })
    if (state.selected === run.id) showExpired(error.code)
  } else {
    run.status = "err"
    const code = error.code ?? "erro"
    addStep(run, {
      at: toLocal(ev.at),
      side: "agente",
      tone: "err",
      title: END_TITLES[code] ?? `Compra falhou (${code})`,
      note:
        error.reason === "max_total"
          ? `O limite total de ${brl(state.policy.maxTotal)} desta sessão foi atingido. Nenhum Pix foi enviado. Use “Reiniciar”.`
          : `<span class="mono">${escapeHtml(code)}</span>`,
    })
  }
  renderRuns()
  renderSpent()
  renderStepper()
  if (state.selected === run.id) renderFlowSub()
}

function onSnapshot(ev: Ev) {
  state.provider = String(ev.provider ?? "")
  state.spent = Number(ev.gasto ?? 0)
  if (ev.politica) state.policy = ev.politica as typeof state.policy
  setBalances(ev.saldos as typeof state.balances, false)
  // Runs the server no longer knows about (a restart, a reset) cannot finish.
  const live = new Set(((ev.compras as { runId: string }[] | undefined) ?? []).map((c) => c.runId))
  for (const run of state.runs) {
    if (run.status === "running" && !live.has(run.id)) {
      run.status = "expired"
      run.waiting = undefined
      if (state.selected === run.id) showExpired("desconectada")
    }
  }
  renderProvider()
  renderSpent()
  renderRuns()
  renderStepper()
  startAutoBuy()
}

function markSettled(chargeId: string) {
  const item = state.feed.find((f) => f.chargeId === chargeId)
  if (item) {
    item.settled = true
    renderFeed()
  }
}

function clearLocal() {
  state.runs = []
  state.selected = undefined
  state.feed = []
  state.latencies = []
  state.pushes = []
  $("expired").hidden = true
  renderRuns()
  renderTimeline()
  renderFeed()
  renderLatency()
  renderStepper()
}

// ---------- SSE ----------

const EVENT_TYPES = [
  "estado",
  "reiniciado",
  "saldos",
  "compra.inicio",
  "compra.fim",
  "http.pedido",
  "http.resposta",
  "cobranca",
  "facilitator",
  "aguardando",
  "pix.enviado",
  "pix.confirmado",
  "liquidado",
]

function connectEvents() {
  const badge = $("sse-badge")
  const label = badge.querySelector("span:last-child") as HTMLElement
  const source = new EventSource(`${API}/api/eventos?sessao=${encodeURIComponent(SESSION)}`)
  const setState = (value: "open" | "connecting" | "error", text: string) => {
    badge.dataset.state = value
    label.textContent = text
  }
  source.addEventListener("open", () => setState("open", "SSE ao vivo"))
  source.addEventListener("error", () => {
    setState(source.readyState === EventSource.CLOSED ? "error" : "connecting", "reconectando")
  })
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      const arrived = clock()
      onEvent(JSON.parse((message as MessageEvent<string>).data) as Ev, arrived)
    })
  }
}

// ---------- rendering ----------

function renderProvider() {
  const mock = state.provider === "mock"
  $("provider-badge").textContent = mock
    ? "PSP simulado · em memória"
    : `${state.provider === "abacatepay" ? "AbacatePay" : state.provider} · modo de teste`
  $("foot-provider").textContent = mock
    ? "Modo: PSP simulado em memória"
    : "Modo: AbacatePay em modo de teste"
}

function renderSpent() {
  const max = state.policy.maxTotal
  $("spent-label").textContent = `${brl(state.spent)} de ${brl(max)}`
  const bar = $("spent-bar")
  bar.style.transform = `scaleX(${Math.min(1, state.spent / max)})`
  bar.classList.toggle("full", state.spent >= max)
  $("policy-hint").innerHTML =
    `Política do <code>wrapFetch</code>: até ${brl(state.policy.maxPerRequest)} por compra e ${brl(max)} no total.`
}

function setBalances(next: { pagador: number; recebedor: number } | undefined, animate: boolean) {
  if (!next) return
  const previous = state.balances
  state.balances = { ...next }
  if (animate) {
    showDelta("payer-delta", next.pagador - previous.pagador)
    showDelta("merchant-delta", next.recebedor - previous.recebedor)
    tweenBalances()
  } else {
    state.shown = { ...next }
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
  const from = { ...state.shown }
  const to = { ...state.balances }
  const start = performance.now()
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450
  cancelAnimationFrame(tween)
  const frame = (now: number) => {
    const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration)
    const eased = 1 - (1 - t) ** 3
    state.shown = {
      pagador: Math.round(from.pagador + (to.pagador - from.pagador) * eased),
      recebedor: Math.round(from.recebedor + (to.recebedor - from.recebedor) * eased),
    }
    paintBalances()
    if (t < 1) tween = requestAnimationFrame(frame)
  }
  tween = requestAnimationFrame(frame)
}

function paintBalances() {
  $("payer-balance").textContent = brl(state.shown.pagador)
  $("merchant-balance").textContent = brl(state.shown.recebedor)
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
  for (const node of Array.from(list.children)) {
    existing.set((node as HTMLElement).dataset.charge ?? "", node as HTMLElement)
  }
  const nodes = state.feed.slice(0, 30).map((item) => {
    const node = existing.get(item.chargeId) ?? el("li", { "data-charge": item.chargeId })
    node.replaceChildren(
      el("span", { class: "amt" }, `+${brl(item.amount)}`),
      el("span", { class: "ms", title: "Pix enviado → loja avisada" }, ms(item.latencyMs)),
      el("span", { class: "id", title: item.chargeId }, item.chargeId),
      el(
        "span",
        { class: `st${item.settled ? " done" : ""}` },
        item.settled ? "recurso entregue" : "aguardando entrega",
      ),
    )
    return node
  })
  list.replaceChildren(...nodes)
}

function renderRuns() {
  $("runs").replaceChildren(
    ...state.runs.slice(-8).map((run) => {
      const dot =
        run.status === "ok" ? " ok" : run.status === "err" || run.status === "expired" ? " err" : ""
      const button = el(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": String(run.id === state.selected),
          title: run.chargeId ?? "",
        },
        el("i", { class: `s${dot}` }),
        `#${run.id.replace(/^c/, "")}${run.mode === "passos" ? " passo a passo" : ""}${run.totalMs === undefined ? "" : ` · ${ms(run.totalMs)}`}`,
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

function renderFlowSub() {
  const run = runById(state.selected)
  const sub = $("flow-sub")
  if (!run) {
    sub.textContent = "Faça uma compra para começar."
    return
  }
  const status =
    run.status === "running"
      ? "em andamento"
      : run.status === "ok"
        ? `${ms(run.totalMs ?? 0)} do pedido ao 200`
        : run.status === "expired"
          ? "expirada"
          : "falhou"
  sub.textContent = `Compra #${run.id.replace(/^c/, "")}${run.chargeId ? ` · ${run.chargeId}` : ""} · ${status}`
}

function showExpired(code: string | undefined) {
  $("expired-why").textContent =
    code === "desconectada"
      ? "A página ficou fechada e a compra parada foi cancelada."
      : "A compra ficou parada sem um clique até o prazo acabar."
  $("expired").hidden = false
}

function renderTimeline() {
  const run = runById(state.selected)
  $("empty").hidden = run !== undefined
  $("expired").hidden = run?.status !== "expired"
  $("timeline").replaceChildren()
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
  voce: "você",
}

function stepNode(run: Run, step: Step): HTMLElement {
  const title = el("p", { class: "step-title" })
  if (step.http) title.append(el("span", { class: "http" }, step.http))
  title.append(step.title)
  if (step.sim) title.append(el("span", { class: "sim" }, "simulado"))
  if (step.pill) {
    title.append(el("span", { class: `pill${step.pill.fast ? " fast" : ""}` }, step.pill.text))
  }
  const body = el("div", { class: "step-body" }, el("span", { class: "step-dot" }), title)
  if (step.note) {
    const note = el("p", { class: "step-note" })
    note.innerHTML = step.note // built from constants; protocol values are escaped
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
    html += `${html ? "\n\n" : ""}<span class="raw-l">valor do header (base64)</span>\n<span class="raw">${escapeHtml(detail.raw)}</span>`
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
  const left = Date.parse(node.dataset.expires ?? "") - Date.now()
  node.textContent = left <= 0 ? "expirada" : `em ${countdown(Date.now() + left)}`
}

// ---------- controls ----------

function renderStepper() {
  const run = stepRun()
  const pedir = $<HTMLButtonElement>("step-pedir")
  const pagar = $<HTMLButtonElement>("step-pagar")
  const tentar = $<HTMLButtonElement>("step-tentar")
  const waiting = run?.waiting?.action
  const paid = run?.pixSentAt !== undefined
  pedir.disabled = run !== undefined
  pagar.disabled = waiting !== "pagar"
  tentar.disabled = waiting !== "tentar"
  pedir.dataset.next = String(run === undefined)
  pagar.dataset.next = String(waiting === "pagar")
  tentar.dataset.next = String(waiting === "tentar")
  pedir.dataset.done = String(run !== undefined)
  pagar.dataset.done = String(paid)
  tentar.dataset.done = "false"
  const hint = $("step-hint")
  if (run?.waiting) {
    hint.innerHTML = `Esperando o seu clique. A compra vence em <b>${countdown(run.waiting.until)}</b>.`
  } else if (run) {
    hint.textContent = "O agente está trabalhando…"
  } else {
    hint.textContent =
      "O agente para em cada passo e espera o seu clique. Os headers de cada passo aparecem na linha do tempo."
  }
}

function setMode(mode: "auto" | "passos") {
  state.mode = mode
  $("tab-auto").setAttribute("aria-selected", String(mode === "auto"))
  $("tab-steps").setAttribute("aria-selected", String(mode === "passos"))
  $("panel-auto").hidden = mode !== "auto"
  $("panel-steps").hidden = mode !== "passos"
}

async function buy(count: number) {
  const slow = $<HTMLInputElement>("slow-bank").checked
  for (let i = 0; i < count; i++) {
    if (!(await command("/api/compras", { lento: slow }))) break
  }
}

$("tab-auto").addEventListener("click", () => setMode("auto"))
$("tab-steps").addEventListener("click", () => setMode("passos"))
$("buy").addEventListener("click", () => void buy(1))
$("buy-3").addEventListener("click", () => void buy(3))
$("step-pedir").addEventListener("click", () => void command("/api/passos", { acao: "pedir" }))
$("step-pagar").addEventListener("click", () => void command("/api/passos", { acao: "pagar" }))
$("step-tentar").addEventListener("click", () => void command("/api/passos", { acao: "tentar" }))
$("expired-restart").addEventListener("click", () => {
  $("expired").hidden = true
  setMode("passos")
  renderStepper()
  void command("/api/passos", { acao: "pedir" })
})
$("reset").addEventListener("click", async () => {
  if (await command("/api/sessao/reiniciar", {})) {
    clearLocal()
    notify("Sessão reiniciada.", "ok")
  }
})

setInterval(() => {
  document.querySelectorAll<HTMLElement>("[data-expires]").forEach(updateExpiry)
  if (stepRun()?.waiting) renderStepper()
}, 1000)

// `?comprar=3` runs that many one-click purchases once the event stream is up (kiosk, screenshots).
let autoBuys = Math.min(3, Number(new URLSearchParams(location.search).get("comprar") ?? 0) || 0)
function startAutoBuy() {
  if (autoBuys <= 0) return
  const n = autoBuys
  autoBuys = 0
  void buy(n)
}

renderSpent()
renderFeed()
renderTimeline()
renderStepper()
void syncClock().then(connectEvents)
