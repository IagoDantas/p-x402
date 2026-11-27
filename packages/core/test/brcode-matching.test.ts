import { describe, expect, test } from "bun:test"
import {
  brlToCentavos,
  crc16,
  encodeEmv,
  matchPixRequirements,
  type PixPaymentRequirements,
  parseBrCode,
} from "../src"

describe("BR Code", () => {
  test("CRC16/CCITT-FALSE check value", () => {
    expect(crc16("123456789")).toBe("29B1")
  })

  test("reads tag 54 and validates the CRC", () => {
    const code = encodeEmv([
      { id: "00", value: "01" },
      { id: "26", value: "0014br.gov.bcb.pix0105abcde" },
      { id: "53", value: "986" },
      { id: "54", value: "5.00" },
      { id: "58", value: "BR" },
    ])
    const info = parseBrCode(code)
    expect(info?.amount).toBe("500")
    expect(info?.crcValid).toBe(true)
    expect(info?.hasLocation).toBe(false)
    const tampered = code.replace("5.00", "9.00")
    expect(parseBrCode(tampered)?.crcValid).toBe(false)
    expect(parseBrCode("garbage")).toBeNull()
  })

  test("brlToCentavos", () => {
    expect(brlToCentavos("5.00")).toBe("500")
    expect(brlToCentavos("5.5")).toBe("550")
    expect(brlToCentavos("12")).toBe("1200")
    expect(brlToCentavos("1,00")).toBeUndefined()
    expect(brlToCentavos("-1.00")).toBeUndefined()
  })
})

describe("matchPixRequirements", () => {
  const base: PixPaymentRequirements = {
    scheme: "exact",
    network: "pix:br",
    asset: "BRL",
    amount: "500",
    payTo: "loja1",
    maxTimeoutSeconds: 300,
    extra: {
      paymentFlow: "upfront",
      assetTransferMethod: "pix-charge",
      provider: "mock",
      resourceUrl: "https://api.test/relatorio",
      chargeId: "c1",
      brCode: "x",
      expiresAt: "2026-11-25T12:05:00.000Z",
    },
  }

  test("ignores dynamic keys and client-added keys", () => {
    const accepted = {
      ...base,
      extra: { ...base.extra, chargeId: "c2", brCode: "y", note: "client" },
    }
    expect(matchPixRequirements(accepted, base)).toEqual({ ok: true })
  })

  test("maps amount, payee and resource to specific reasons", () => {
    expect(matchPixRequirements({ ...base, amount: "100" }, base)).toMatchObject({
      ok: false,
      reason: "amount_mismatch",
    })
    expect(matchPixRequirements({ ...base, payTo: "evil" }, base)).toMatchObject({
      reason: "pay_to_mismatch",
    })
    expect(
      matchPixRequirements(
        { ...base, extra: { ...base.extra, resourceUrl: "https://api.test/outro" } },
        base,
      ),
    ).toMatchObject({ reason: "resource_mismatch" })
    expect(
      matchPixRequirements({ ...base, extra: { ...base.extra, provider: "other" } }, base),
    ).toMatchObject({ reason: "requirements_mismatch", field: "extra.provider" })
  })

  test("missing assetTransferMethod resolves to pix-charge", () => {
    const { assetTransferMethod: _, ...rest } = base.extra
    expect(matchPixRequirements({ ...base, extra: rest }, base)).toEqual({ ok: true })
  })
})
