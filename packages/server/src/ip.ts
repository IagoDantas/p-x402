/** Shared rate-limit bucket for requests whose client IP is unknown. */
export const UNKNOWN_IP_KEY = "unknown"

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HEXTET = /^[0-9a-f]{1,4}$/

function expandIpv6(ip: string): string[] | undefined {
  const halves = ip.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves[1] ? halves[1].split(":") : []
  // An embedded IPv4 tail counts as two hextets.
  const last = tail.length > 0 ? tail[tail.length - 1] : head[head.length - 1]
  const v4Groups = last !== undefined && IPV4.test(last) ? 1 : 0
  const missing = 8 - head.length - tail.length - v4Groups
  if (halves.length === 1 && missing !== 0) return undefined
  if (halves.length === 2 && missing < 1) return undefined
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  return groups.map((group) =>
    HEXTET.test(group) ? Number.parseInt(group, 16).toString(16) : group,
  )
}

/**
 * Rate-limit key for a client IP: IPv4 as is, IPv4-mapped IPv6 as the IPv4 address,
 * other IPv6 addresses by their /64 prefix. A port ("1.2.3.4:5678", "[2001:db8::1]:443", as some
 * proxies send it) is dropped, so a new connection is not a new bucket. Missing or empty → the
 * shared "unknown" bucket.
 */
export function clientIpKey(ip: string | undefined): string {
  const raw = ip?.trim().toLowerCase()
  if (!raw) return UNKNOWN_IP_KEY
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw)
  if (v4WithPort?.[1]) return v4WithPort[1]
  if (!raw.includes(":")) return raw
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw)
  const bare = (bracketed?.[1] ?? raw).replace(/%.*$/, "")
  const mapped = /^[0:]*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)
  if (mapped?.[1]) return mapped[1]
  const groups = expandIpv6(bare)
  if (!groups) return bare
  // IPv4-mapped in hex form (::ffff:102:304) is the same client as ::ffff:1.2.3.4.
  const [hi, lo] = [groups[6], groups[7]]
  if (
    groups.length === 8 &&
    groups.slice(0, 5).every((g) => g === "0") &&
    groups[5] === "ffff" &&
    hi !== undefined &&
    lo !== undefined &&
    HEXTET.test(hi) &&
    HEXTET.test(lo)
  ) {
    const a = Number.parseInt(hi, 16)
    const b = Number.parseInt(lo, 16)
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
  }
  return `${groups.slice(0, 4).join(":")}::/64`
}
