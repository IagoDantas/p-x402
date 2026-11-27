/**
 * Minimal reader for Pix BR Codes (EMV QR Code merchant-presented payload, BCB "Manual do BR Code").
 * Used by the client to check that the code it is about to pay asks for the advertised amount.
 */

export interface EmvField {
  id: string
  value: string
}

export interface BrCodeInfo {
  /** Tag 54 converted to centavos, when present. */
  amount?: string
  /** CRC16 in tag 63 matches the payload. */
  crcValid: boolean
  /** The Pix template carries a location URL (dynamic COB code); its amount lives behind that URL. */
  hasLocation: boolean
  fields: EmvField[]
}

/** CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as uppercase hex. */
export function crc16(text: string): string {
  let crc = 0xffff
  for (let i = 0; i < text.length; i++) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0")
}

/** Encodes TLV fields (id, two-digit length, value) without a CRC; used for nested templates. */
export function encodeTlv(fields: EmvField[]): string {
  return fields.map((f) => `${f.id}${String(f.value.length).padStart(2, "0")}${f.value}`).join("")
}

/** Encodes TLV fields and appends tag 63 with the CRC. */
export function encodeEmv(fields: EmvField[]): string {
  const withoutCrc = `${encodeTlv(fields)}6304`
  return `${withoutCrc}${crc16(withoutCrc)}`
}

export function parseEmv(text: string): EmvField[] | null {
  const fields: EmvField[] = []
  let i = 0
  while (i < text.length) {
    if (i + 4 > text.length) return null
    const id = text.slice(i, i + 2)
    const length = Number(text.slice(i + 2, i + 4))
    if (
      !/^\d{2}$/.test(id) ||
      !Number.isInteger(length) ||
      !/^\d{2}$/.test(text.slice(i + 2, i + 4))
    ) {
      return null
    }
    const value = text.slice(i + 4, i + 4 + length)
    if (value.length !== length) return null
    fields.push({ id, value })
    i += 4 + length
  }
  return fields
}

/** Converts "5.00" to "500". Returns undefined for anything that is not a plain decimal with up to 2 places. */
export function brlToCentavos(value: string): string | undefined {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return undefined
  const [, units = "0", cents = ""] = match
  const total = BigInt(units) * 100n + BigInt(cents.padEnd(2, "0"))
  return total.toString()
}

/** BR Codes are printable ASCII; outside it, field lengths and the CRC depend on the decoder's encoding. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/
/** GUI (sub-tag 00) of the Pix merchant account template. */
const PIX_GUI = "br.gov.bcb.pix"

function hasDuplicateIds(fields: EmvField[]): boolean {
  return new Set(fields.map((f) => f.id)).size !== fields.length
}

/**
 * Returns null when the text is not a well-formed Pix BR Code. Ambiguous codes are refused, since
 * decoders disagree on how to read them and an amount check on one reading proves nothing: a
 * non-ASCII character, a repeated tag, a merchant account template (tags 26-51) whose nested
 * fields do not parse, or anything other than exactly one Pix template.
 */
export function parseBrCode(text: string): BrCodeInfo | null {
  if (!PRINTABLE_ASCII.test(text)) return null
  const fields = parseEmv(text)
  if (!fields || fields.length === 0 || hasDuplicateIds(fields)) return null
  let pix: EmvField[] | undefined
  for (const field of fields) {
    const id = Number(field.id)
    if (id < 26 || id > 51) continue
    const sub = parseEmv(field.value)
    if (!sub || hasDuplicateIds(sub)) return null
    if (sub.find((f) => f.id === "00")?.value.toLowerCase() !== PIX_GUI) continue
    if (pix) return null
    pix = sub
  }
  if (!pix) return null
  const last = fields[fields.length - 1]
  const crcValid =
    last !== undefined &&
    last.id === "63" &&
    last.value.length === 4 &&
    crc16(text.slice(0, -4)) === last.value.toUpperCase()
  const hasLocation = pix.some((f) => f.id === "25")
  const rawAmount = fields.find((f) => f.id === "54")?.value
  const amount = rawAmount === undefined ? undefined : brlToCentavos(rawAmount)
  const info: BrCodeInfo = { crcValid, hasLocation, fields }
  if (amount !== undefined) info.amount = amount
  return info
}
