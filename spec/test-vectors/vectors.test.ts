import { describe, expect, test } from "bun:test"
import { matchPixRequirements, type PaymentRequirements, PX402_ERROR_CODES } from "@p-x402/core"
import { buildVectorFiles, VECTOR_FILES, type VectorFile } from "./generate"
import { codecFor, type HeaderName, tryDecode } from "./generator/codec"
import {
  runScenario,
  type Scenario,
  type WireRequest,
  type WireResponse,
} from "./generator/transcripts"
import { expectedFor, type ValidatedType } from "./generator/validation"

async function committed(name: VectorFile): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text()
}

async function load<T>(name: VectorFile): Promise<T> {
  return JSON.parse(await committed(name)) as T
}

/** Key order matters for byte-exact headers, so compare JSON text, not structure. */
const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b))

describe("committed vectors", () => {
  test("match what the generator produces (run `bun run vectors` after changing the protocol)", async () => {
    const files = await buildVectorFiles()
    for (const name of VECTOR_FILES) {
      expect(await committed(name), name).toBe(files[name])
    }
  })
})

interface CodecCase {
  id: string
  header: HeaderName
  direction: "both" | "decode"
  decoded?: unknown
  json?: string
  encoded?: string
  encodedRepeat?: { char: string; count: number }
  expected: { ok: true; decoded?: unknown } | { ok: false; errorCode: string }
}

describe("header-codec.json", async () => {
  const { cases } = await load<{ cases: CodecCase[] }>("header-codec.json")
  test.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const encoded = c.encoded ?? c.encodedRepeat?.char.repeat(c.encodedRepeat.count) ?? ""
    if (c.direction === "both") {
      expect(codecFor[c.header].encode(c.decoded)).toBe(encoded)
      expect(JSON.stringify(c.decoded)).toBe(c.json as string)
      const bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0))
      expect(new TextDecoder().decode(bytes)).toBe(c.json as string)
      const back = tryDecode(c.header, encoded)
      expect(back.ok).toBe(true)
      if (back.ok) same(back.decoded, c.decoded)
      return
    }
    const result = tryDecode(c.header, encoded)
    if (c.expected.ok) {
      expect(result.ok).toBe(true)
      if (result.ok) same(result.decoded, c.expected.decoded)
    } else {
      expect(result).toEqual({ ok: false, errorCode: c.expected.errorCode })
    }
  })
})

describe("validation.json", async () => {
  const { cases } = await load<{
    cases: { id: string; type: ValidatedType; value: unknown; expected: unknown }[]
  }>("validation.json")
  test.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    expect(await expectedFor(c.type, c.value)).toEqual(c.expected as never)
  })
})

describe("requirement-matching.json", async () => {
  const { cases } = await load<{
    cases: {
      id: string
      accepted: PaymentRequirements
      required: PaymentRequirements
      expected: unknown
    }[]
  }>("requirement-matching.json")
  test.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(matchPixRequirements(c.accepted, c.required)).toEqual(c.expected as never)
  })
})

interface TranscriptCall {
  request: WireRequest
  exchanges: { request: WireRequest; response: WireResponse }[]
}

describe("client-transcripts.json (replayed against wrapFetch)", async () => {
  const { cases } = await load<{
    cases: {
      id: string
      description: string
      client: { policy: Scenario["policy"] }
      calls: TranscriptCall[]
    }[]
  }>("client-transcripts.json")
  test.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const scenario: Scenario = {
      id: c.id,
      description: c.description,
      policy: c.client.policy,
      calls: c.calls.map((call) => ({
        request: call.request,
        responses: call.exchanges.map((e) => e.response),
      })),
    }
    // Serve the recorded responses; every request the client sends must be the recorded one.
    const replayed = await runScenario(scenario, (call, attempt, request) => {
      const exchange = c.calls[call]?.exchanges[attempt]
      if (!exchange) throw new Error(`call ${call}: unexpected request ${attempt}`)
      expect(request).toEqual(exchange.request)
      return exchange.response
    })
    same(replayed, c.calls)
  })
})

describe("error-codes.json", () => {
  test("lists exactly the codes of PX402_ERROR_CODES, in order", async () => {
    const { codes } = await load<{ codes: { code: string }[] }>("error-codes.json")
    expect(codes.map((c) => c.code)).toEqual([...PX402_ERROR_CODES])
  })
})
