import { describe, expect, test } from "bun:test"
import {
  decodePaymentPayload,
  decodePaymentRequired,
  decodeSettlementResponse,
  encodeJsonHeader,
  encodePaymentPayload,
  encodePaymentRequired,
  encodeSettlementResponse,
  isPx402Error,
  MAX_HEADER_BYTES,
  type PaymentPayload,
  type PaymentRequired,
  type PixPaymentRequirements,
  PixPaymentRequirementsSchema,
  type SettlementResponse,
} from "../src"

const requirements: PixPaymentRequirements = {
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
    resourceUrl: "https://api.loja.com.br/relatorio",
    chargeId: "pix_char_mock_0001",
    brCode: "00020126580014br.gov.bcb.pix",
    expiresAt: "2026-11-25T15:10:00.000Z",
  },
}

const paymentRequired: PaymentRequired = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: { url: "https://api.loja.com.br/relatorio", description: "Relatório PDF — ação" },
  accepts: [requirements],
}

function expectInvalidHeader(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    expect(isPx402Error(error)).toBe(true)
    expect((error as { code: string }).code).toBe("invalid_header")
    return
  }
  throw new Error("expected invalid_header")
}

describe("header codec", () => {
  test("PAYMENT-REQUIRED round trip keeps non-ASCII text", () => {
    const header = encodePaymentRequired(paymentRequired)
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const decoded = decodePaymentRequired(header)
    expect(decoded).toEqual(paymentRequired)
    expect(PixPaymentRequirementsSchema.parse(decoded.accepts[0])).toEqual(requirements)
  })

  test("PAYMENT-SIGNATURE round trip", () => {
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { chargeId: "pix_char_mock_0001" },
    }
    expect(decodePaymentPayload(encodePaymentPayload(payload))).toEqual(payload)
  })

  test("PAYMENT-RESPONSE round trip, success and settlement_pending", () => {
    const ok: SettlementResponse = {
      success: true,
      transaction: "pix_char_mock_0001",
      network: "pix:br",
      amount: "500",
    }
    expect(decodeSettlementResponse(encodeSettlementResponse(ok))).toEqual(ok)
    const pending: SettlementResponse = {
      success: false,
      errorReason: "settlement_pending",
      transaction: "pix_char_mock_0001",
      network: "pix:br",
    }
    expect(decodeSettlementResponse(encodeSettlementResponse(pending))).toEqual(pending)
  })

  test("decodes a header produced by plain base64 of JSON", () => {
    const json = JSON.stringify({ success: true, transaction: "x", network: "pix:br" })
    expect(decodeSettlementResponse(Buffer.from(json).toString("base64")).transaction).toBe("x")
  })

  test("rejects garbage, wrong shapes, wrong version and oversized headers", () => {
    expectInvalidHeader(() => decodePaymentRequired("not base64 !!"))
    expectInvalidHeader(() => decodePaymentRequired(btoa("{not json")))
    expectInvalidHeader(() => decodePaymentRequired(encodeJsonHeader({ x402Version: 2 })))
    expectInvalidHeader(() =>
      decodePaymentRequired(encodeJsonHeader({ ...paymentRequired, x402Version: 1 })),
    )
    expectInvalidHeader(() => decodePaymentPayload(""))
    expectInvalidHeader(() => decodePaymentPayload("A".repeat(MAX_HEADER_BYTES + 4)))
  })

  test("Pix requirements reject non-integer amounts and other networks", () => {
    for (const amount of ["0", "-5", "5.00", "1e3", "05", ""]) {
      expect(PixPaymentRequirementsSchema.safeParse({ ...requirements, amount }).success).toBe(
        false,
      )
    }
    expect(
      PixPaymentRequirementsSchema.safeParse({ ...requirements, network: "eip155:8453" }).success,
    ).toBe(false)
  })
})
