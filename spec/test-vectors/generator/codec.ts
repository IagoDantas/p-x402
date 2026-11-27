import {
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  encodePaymentPayload,
  encodePaymentRequired,
  encodeSettlementResponse,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  isPx402Error,
  MAX_HEADER_BYTES,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "@p-x402/core"
import {
  CHARGE_ID,
  ORIGIN,
  paymentRequired,
  pixPayload,
  pixRequirements,
  RESOURCE,
} from "../fixtures"

export type HeaderName =
  | typeof HEADER_PAYMENT_REQUIRED
  | typeof HEADER_PAYMENT_SIGNATURE
  | typeof HEADER_PAYMENT_RESPONSE

export const codecFor = {
  [HEADER_PAYMENT_REQUIRED]: {
    encode: (v: unknown) => encodePaymentRequired(v as PaymentRequired),
    decode: decodePaymentRequired,
  },
  [HEADER_PAYMENT_SIGNATURE]: {
    encode: (v: unknown) => encodePaymentPayload(v as PaymentPayload),
    decode: decodePaymentPayload,
  },
  [HEADER_PAYMENT_RESPONSE]: {
    encode: (v: unknown) => encodeSettlementResponse(v as SettlementResponse),
    decode: decodeSettlementResponse,
  },
} as const

/** Runs the real decoder; returns the decoded value or the error code it threw. */
export function tryDecode(
  header: HeaderName,
  value: string,
): { ok: true; decoded: unknown } | { ok: false; errorCode: string } {
  try {
    return { ok: true, decoded: codecFor[header].decode(value) }
  } catch (error) {
    if (isPx402Error(error)) return { ok: false, errorCode: error.code }
    throw error
  }
}

function padding(encoded: string): number {
  return encoded.length - encoded.replace(/=+$/, "").length
}

interface RoundTrip {
  id: string
  description: string
  header: HeaderName
  decoded: unknown
}

interface DecodeOnly {
  id: string
  description: string
  header: HeaderName
  encoded: string
}

const relatorio = paymentRequired([pixRequirements()], {
  url: RESOURCE,
  description: "Relatório PDF — ação, São Paulo",
  mimeType: "application/pdf",
})

const roundTrips: RoundTrip[] = [
  {
    id: "payment-required/basic",
    description: "402 challenge with one Pix option, ASCII only",
    header: HEADER_PAYMENT_REQUIRED,
    decoded: paymentRequired([pixRequirements()]),
  },
  {
    id: "payment-required/non-ascii",
    description:
      "resource description with non-ASCII text, encoded as raw UTF-8 bytes (no \\u escapes)",
    header: HEADER_PAYMENT_REQUIRED,
    decoded: relatorio,
  },
  {
    id: "payment-required/settlement-pending",
    description: "the challenge resent with error settlement_pending, as the paywall sends it",
    header: HEADER_PAYMENT_REQUIRED,
    decoded: {
      x402Version: 2,
      error: "settlement_pending",
      resource: { url: RESOURCE },
      accepts: [pixRequirements()],
    },
  },
  {
    id: "payment-required/two-options",
    description: "two options, the first one not Pix; extensions object carried through",
    header: HEADER_PAYMENT_REQUIRED,
    decoded: {
      x402Version: 2,
      resource: { url: `${ORIGIN}/dados?formato=csv&página=2` },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "10000",
          asset: "0x0000000000000000000000000000000000000001",
          payTo: "0x0000000000000000000000000000000000000002",
          maxTimeoutSeconds: 60,
        },
        pixRequirements({ amount: "1250", resourceUrl: `${ORIGIN}/dados?formato=csv&página=2` }),
      ],
      extensions: { "example.note": { texto: "olá" } },
    },
  },
  {
    id: "payment-signature/basic",
    description: "retry payload naming the paid charge",
    header: HEADER_PAYMENT_SIGNATURE,
    decoded: pixPayload(),
  },
  {
    id: "payment-signature/non-ascii",
    description: "retry payload whose resource has a non-ASCII description",
    header: HEADER_PAYMENT_SIGNATURE,
    decoded: { ...pixPayload(), resource: relatorio.resource },
  },
  {
    id: "payment-signature/no-resource",
    description: "resource is optional in the payload",
    header: HEADER_PAYMENT_SIGNATURE,
    decoded: {
      x402Version: 2,
      accepted: pixRequirements({ amount: "1" }),
      payload: { chargeId: CHARGE_ID },
    },
  },
  {
    id: "payment-response/success",
    description: "settled: transaction is the charge id, amount in centavos",
    header: HEADER_PAYMENT_RESPONSE,
    decoded: { success: true, transaction: CHARGE_ID, network: "pix:br", amount: "500" },
  },
  {
    id: "payment-response/settlement-pending",
    description: "refusal sent with a 402 while the Pix payment is not confirmed yet",
    header: HEADER_PAYMENT_RESPONSE,
    decoded: {
      success: false,
      errorReason: "settlement_pending",
      transaction: CHARGE_ID,
      network: "pix:br",
    },
  },
  {
    id: "payment-response/invalid-header",
    description: "refusal of an unreadable PAYMENT-SIGNATURE: no charge id, empty transaction",
    header: HEADER_PAYMENT_RESPONSE,
    decoded: { success: false, errorReason: "invalid_header", transaction: "", network: "pix:br" },
  },
]

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

const settledJson = JSON.stringify({
  success: true,
  transaction: CHARGE_ID,
  network: "pix:br",
})

const decodeOnly: DecodeOnly[] = [
  {
    id: "decode/unpadded",
    description: "the decoder accepts base64 without trailing '=' (encoders must still pad)",
    header: HEADER_PAYMENT_RESPONSE,
    encoded: b64(settledJson).replace(/=+$/, ""),
  },
  {
    id: "decode/surrounding-whitespace",
    description: "leading and trailing whitespace is trimmed before decoding",
    header: HEADER_PAYMENT_RESPONSE,
    encoded: `  ${b64(settledJson)}\t`,
  },
  {
    id: "decode/key-order-and-unknown-keys",
    description:
      "decoded objects follow the schema's key order and drop unknown keys; keys inside extra and extensions keep their order",
    header: HEADER_PAYMENT_REQUIRED,
    encoded: b64(
      JSON.stringify({
        accepts: [
          {
            maxTimeoutSeconds: 300,
            payTo: "loja-exemplo",
            asset: "BRL",
            amount: "500",
            network: "pix:br",
            scheme: "exact",
            extra: { zeta: 1, alpha: 2 },
            unknownInRequirements: true,
          },
        ],
        resource: { mimeType: "text/plain", url: RESOURCE },
        x402Version: 2,
        unknownTopLevel: "dropped",
      }),
    ),
  },
  {
    id: "decode/empty",
    description: "an empty (or all-whitespace) header is refused",
    header: HEADER_PAYMENT_SIGNATURE,
    encoded: "   ",
  },
  {
    id: "decode/not-base64",
    description: "characters outside the standard alphabet are refused",
    header: HEADER_PAYMENT_SIGNATURE,
    encoded: "not base64!",
  },
  {
    id: "decode/url-safe-alphabet",
    description: "the URL-safe alphabet ('-' and '_') is not accepted",
    header: HEADER_PAYMENT_RESPONSE,
    // ">>>" and "???" encode to "Pj4+" and "Pz8/", so the standard encoding has '+' and '/'
    encoded: b64(JSON.stringify({ ...JSON.parse(settledJson), extensions: { k: ">>>???" } }))
      .replaceAll("+", "-")
      .replaceAll("/", "_"),
  },
  {
    id: "decode/base64-not-json",
    description: "valid base64 of something that is not JSON",
    header: HEADER_PAYMENT_RESPONSE,
    encoded: b64("success=true"),
  },
  {
    id: "decode/not-utf8",
    description: "bytes that are not valid UTF-8 (Latin-1 'ó') are refused, not replaced",
    header: HEADER_PAYMENT_RESPONSE,
    encoded: btoa('{"success":true,"transaction":"Relat\xf3rio","network":"pix:br"}'),
  },
  {
    id: "decode/schema-mismatch",
    description: "well-formed JSON that fails the schema (x402Version 1) is refused",
    header: HEADER_PAYMENT_REQUIRED,
    encoded: b64(JSON.stringify({ ...paymentRequired([pixRequirements()]), x402Version: 1 })),
  },
  {
    id: "decode/json-not-object",
    description: "a JSON array is refused",
    header: HEADER_PAYMENT_SIGNATURE,
    encoded: b64("[]"),
  },
  {
    id: "decode/too-long",
    description: `header longer than ${MAX_HEADER_BYTES} characters (after trimming) is refused before decoding; encoded is "A" repeated encodedRepeat times`,
    header: HEADER_PAYMENT_SIGNATURE,
    encoded: "A".repeat(MAX_HEADER_BYTES + 4),
  },
]

export function buildCodecVectors() {
  const cases: unknown[] = []
  for (const c of roundTrips) {
    const encoded = codecFor[c.header].encode(c.decoded)
    const back = tryDecode(c.header, encoded)
    if (!back.ok || JSON.stringify(back.decoded) !== JSON.stringify(c.decoded)) {
      throw new Error(`${c.id}: round trip changes the value; fix the fixture key order`)
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`${c.id}: unexpected alphabet`)
    cases.push({
      id: c.id,
      description: c.description,
      header: c.header,
      direction: "both",
      decoded: c.decoded,
      json: JSON.stringify(c.decoded),
      encoded,
      padding: padding(encoded),
      expected: { ok: true },
    })
  }
  for (const c of decodeOnly) {
    if (c.id === "decode/url-safe-alphabet" && !/[-_]/.test(c.encoded)) {
      throw new Error(`${c.id}: the fixture must contain '-' or '_'`)
    }
    const result = tryDecode(c.header, c.encoded)
    const tooLong = c.encoded.length > 1000
    cases.push({
      id: c.id,
      description: c.description,
      header: c.header,
      direction: "decode",
      ...(tooLong
        ? { encodedRepeat: { char: c.encoded[0], count: c.encoded.length } }
        : { encoded: c.encoded }),
      expected: result.ok
        ? { ok: true, decoded: result.decoded }
        : { ok: false, errorCode: result.errorCode },
    })
  }
  const paddings = new Set(
    cases.flatMap((c) =>
      ((c as { padding?: number }).padding ?? -1) >= 0 ? [(c as { padding: number }).padding] : [],
    ),
  )
  for (const p of [0, 1, 2]) {
    if (!paddings.has(p)) throw new Error(`no round-trip case with ${p} padding characters`)
  }
  return {
    area: "header-codec",
    format: {
      headers: [HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE, HEADER_PAYMENT_RESPONSE],
      json: "JSON.stringify output: no whitespace, keys in the order given in `decoded`, non-ASCII characters written as raw UTF-8 (not \\uXXXX), '/' not escaped",
      bytes: "UTF-8",
      base64:
        "standard alphabet (RFC 4648 section 4, '+' and '/'), always padded with '=' when encoding",
      decoderLeniency:
        "the reference decoder trims surrounding whitespace and accepts missing padding; it refuses the URL-safe alphabet and invalid UTF-8",
      maxHeaderLength: MAX_HEADER_BYTES,
      decodeErrorCode: "invalid_header",
    },
    cases,
  }
}
