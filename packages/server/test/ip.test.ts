import { describe, expect, test } from "bun:test"
import { clientIpKey } from "../src/ip"

describe("clientIpKey", () => {
  test("IPv4 and unknown", () => {
    expect(clientIpKey("1.2.3.4")).toBe("1.2.3.4")
    expect(clientIpKey(undefined)).toBe("unknown")
    expect(clientIpKey("")).toBe("unknown")
  })

  test("IPv6 keyed by /64", () => {
    expect(clientIpKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64")
    expect(clientIpKey("2001:0DB8:0001:0002:ffff:0:0:9")).toBe("2001:db8:1:2::/64")
    expect(clientIpKey("[2001:db8::1%eth0]")).toBe("2001:db8:0:0::/64")
    expect(clientIpKey("::1")).toBe("0:0:0:0::/64")
  })

  test("IPv4-mapped IPv6 maps to IPv4", () => {
    expect(clientIpKey("::ffff:1.2.3.4")).toBe("1.2.3.4")
    expect(clientIpKey("::ffff:102:304")).toBe("1.2.3.4")
    expect(clientIpKey("0:0:0:0:0:ffff:c0a8:0101")).toBe("192.168.1.1")
  })

  test("a port is dropped from the key", () => {
    expect(clientIpKey("1.2.3.4:5678")).toBe("1.2.3.4")
    expect(clientIpKey("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64")
    expect(clientIpKey("[::ffff:1.2.3.4]:80")).toBe("1.2.3.4")
    expect(clientIpKey("[2001:db8::1]")).toBe("2001:db8:0:0::/64")
  })

  test("an unparseable IPv6 string is its own key", () => {
    expect(clientIpKey("1::2::3")).toBe("1::2::3")
  })
})
