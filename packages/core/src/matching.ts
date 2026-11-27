import { PIX_ASSET_TRANSFER_METHOD } from "./constants"
import type { Px402ErrorCode } from "./errors"
import { type PaymentRequirements, PIX_DYNAMIC_EXTRA_KEYS } from "./schemas"

export type MatchResult = { ok: true } | { ok: false; reason: Px402ErrorCode; field: string }

const DYNAMIC: ReadonlySet<string> = new Set(PIX_DYNAMIC_EXTRA_KEYS)

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function withDefaults(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  return { assetTransferMethod: PIX_ASSET_TRANSFER_METHOD, ...(extra ?? {}) }
}

/**
 * Compares what the client accepted against what the server requires now.
 * Core fields and every server-declared, non-dynamic `extra` key must be equal; dynamic keys
 * (chargeId, brCode, brCodeBase64, expiresAt) are not compared here; extra keys present only in
 * `accepted` are ignored. A missing `assetTransferMethod` resolves to "pix-charge" on both sides.
 */
export function matchPixRequirements(
  accepted: PaymentRequirements,
  required: PaymentRequirements,
): MatchResult {
  if (accepted.amount !== required.amount) {
    return { ok: false, reason: "amount_mismatch", field: "amount" }
  }
  if (accepted.payTo !== required.payTo) {
    return { ok: false, reason: "pay_to_mismatch", field: "payTo" }
  }
  for (const key of ["scheme", "network", "asset", "maxTimeoutSeconds"] as const) {
    if (accepted[key] !== required[key]) {
      return { ok: false, reason: "requirements_mismatch", field: key }
    }
  }
  const a = withDefaults(accepted.extra)
  const r = withDefaults(required.extra)
  if (!sameJson(a.resourceUrl, r.resourceUrl)) {
    return { ok: false, reason: "resource_mismatch", field: "extra.resourceUrl" }
  }
  for (const [key, value] of Object.entries(r)) {
    if (DYNAMIC.has(key)) continue
    if (!sameJson(a[key], value)) {
      return { ok: false, reason: "requirements_mismatch", field: `extra.${key}` }
    }
  }
  return { ok: true }
}
