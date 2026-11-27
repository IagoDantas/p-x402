/**
 * Cross-language interop check: `bun run interop`.
 *
 * Starts the TypeScript facilitator with the mock PSP, the TypeScript demo server and the Python
 * paid API (FastAPI + px402.server) on free local ports, then makes one paid request per pair:
 *
 *   1. Python client      → TypeScript paid API → TypeScript facilitator
 *   2. TypeScript client  → Python paid API     → TypeScript facilitator
 *   3. Python client      → Python paid API     → TypeScript facilitator
 *
 * Every step is printed. Exits non-zero when any pair fails. No secrets: the PSP is the in-memory
 * mock and charges are marked paid through the facilitator's dev route.
 */
import { simulatePayer, wrapFetch } from "@p-x402/client"
import { decodeSettlementResponse, defaultFetch, HEADER_PAYMENT_RESPONSE } from "@p-x402/core"
import type { Subprocess } from "bun"
import { loggingFetch } from "../../apps/demo-client/src/log"

const ROOT = new URL("../../", import.meta.url).pathname
const PY_DIR = `${ROOT}sdks/python`
const TOKEN = "tok-interop"
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("no free port")
  return port
}

const children: Subprocess[] = []
function start(name: string, cmd: string[], env: Record<string, string>): Subprocess {
  const child = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (const line of decoder.decode(value).split("\n")) {
          if (line.trim()) console.log(`   [${name}] ${line}`)
        }
      }
    })()
  }
  return child
}

async function waitFor(url: string, child: Subprocess, name: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode}`)
    try {
      await fetch(url)
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error(`${name} did not start at ${url}`)
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const code = await child.exited
  for (const line of `${out}${err}`.split("\n")) if (line.trim()) console.log(`   ${line}`)
  return { code, out }
}

/** Ensures sdks/python/.venv exists with the SDK and FastAPI installed; returns its python. */
async function pythonBin(): Promise<string> {
  const child = Bun.spawn(["sh", `${PY_DIR}/scripts/venv.sh`], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const out = (await new Response(child.stdout).text()).trim()
  if ((await child.exited) !== 0 || !out) throw new Error("could not prepare the Python venv")
  return out
}

async function pythonClient(python: string, url: string, facilitator: string): Promise<boolean> {
  const { code, out } = await run([
    python,
    `${PY_DIR}/examples/buy_report.py`,
    "--url",
    url,
    "--facilitator",
    facilitator,
    "--verbose",
  ])
  return code === 0 && out.includes("HTTP 200") && out.includes("receipt: success=True")
}

async function typescriptClient(url: string, facilitator: string): Promise<boolean> {
  const fetchPaid = wrapFetch(loggingFetch(defaultFetch), {
    payer: simulatePayer({ facilitatorUrl: facilitator }),
    policy: { maxPerRequest: 1000, maxTotal: 5000, allowedOrigins: [new URL(url).origin] },
    onPayment: (event) =>
      console.log(`   paid ${event.amount} centavos (charge ${event.chargeId})`),
  })
  const response = await fetchPaid(url)
  const body = (await response.json()) as { servidor?: string; pagoCom?: string }
  const header = response.headers.get(HEADER_PAYMENT_RESPONSE)
  const receipt = header === null ? undefined : decodeSettlementResponse(header)
  console.log(`   HTTP ${response.status} servidor=${body.servidor} pagoCom=${body.pagoCom}`)
  return response.status === 200 && receipt?.success === true && body.servidor === "python"
}

async function main(): Promise<number> {
  console.log(
    bold("p-x402 interop: Python and TypeScript, against the TypeScript facilitator (mock PSP)"),
  )
  const python = await pythonBin()
  const ports = { facilitator: freePort(), ts: freePort(), py: freePort() }
  const facilitator = `http://localhost:${ports.facilitator}`
  const tsApi = `http://localhost:${ports.ts}/relatorio`
  const pyApi = `http://localhost:${ports.py}/relatorio`

  console.log(bold("\nstarting services"))
  const fac = start("facilitator", ["bun", "apps/facilitator/src/index.ts"], {
    PORT: String(ports.facilitator),
    PX402_PROVIDER: "mock",
    PX402_MERCHANT_TOKEN: TOKEN,
    PX402_DEV_SIMULATE: "1",
    PX402_DB_PATH: "",
  })
  await waitFor(`${facilitator}/supported`, fac, "facilitator")
  const ts = start("ts-api", ["bun", "apps/demo-server/src/index.ts"], {
    DEMO_SERVER_PORT: String(ports.ts),
    PX402_MERCHANT_TOKEN: TOKEN,
    PX402_FACILITATOR_URL: facilitator,
  })
  const py = start(
    "py-api",
    [python, `${PY_DIR}/examples/paid_api.py`, "--port", String(ports.py)],
    {
      PX402_MERCHANT_TOKEN: TOKEN,
      PX402_FACILITATOR_URL: facilitator,
    },
  )
  await waitFor(`http://localhost:${ports.ts}/`, ts, "ts-api")
  await waitFor(`http://localhost:${ports.py}/`, py, "py-api")

  const pairs: [string, () => Promise<boolean>][] = [
    ["1. Python client → TypeScript paid API", () => pythonClient(python, tsApi, facilitator)],
    ["2. TypeScript client → Python paid API", () => typescriptClient(pyApi, facilitator)],
    ["3. Python client → Python paid API", () => pythonClient(python, pyApi, facilitator)],
  ]
  const results: [string, boolean][] = []
  for (const [label, fn] of pairs) {
    console.log(bold(`\n${label} (facilitator: TypeScript)`))
    let ok = false
    try {
      ok = await fn()
    } catch (error) {
      console.log(`   ${red(String(error))}`)
    }
    results.push([label, ok])
    console.log(`   ${ok ? green("OK") : red("FAILED")}`)
  }

  console.log(bold("\nsummary"))
  for (const [label, ok] of results)
    console.log(`   ${ok ? green("OK    ") : red("FAILED")} ${label}`)
  return results.every(([, ok]) => ok) ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(red(String(error)))
} finally {
  for (const child of children) child.kill()
  await Promise.all(children.map((child) => child.exited))
}
process.exit(code)
