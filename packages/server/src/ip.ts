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
 * other IPv6 addresses by their /64 prefix. Missing or empty → the shared "unknown" bucket.
 */
export function clientIpKey(ip: string | undefined): string {
  const raw = ip?.trim().toLowerCase()
  if (!raw) return UNKNOWN_IP_KEY
  if (!raw.includes(":")) return raw
  const bare = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "")
  const mapped = /^[0:]*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)
  if (mapped?.[1]) return mapped[1]
  const groups = expandIpv6(bare)
  if (!groups) return bare
  return `${groups.slice(0, 4).join(":")}::/64`
}
