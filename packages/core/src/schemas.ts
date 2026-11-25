import { z } from "zod"
import {
  PIX_ASSET,
  PIX_ASSET_TRANSFER_METHOD,
  PIX_NETWORK,
  PIX_PAYMENT_FLOW,
  PIX_SCHEME,
  X402_VERSION,
} from "./constants"

/** Positive integer amount in atomic units (centavos for BRL), as a decimal string. */
export const AtomicAmountSchema = z.string().regex(/^[1-9][0-9]{0,15}$/, "positive integer string")

export const HttpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.hash === ""
  }, "absolute http(s) URL without fragment")

export const ResourceInfoSchema = z.object({
  url: HttpUrlSchema,
  description: z.string().max(500).optional(),
  mimeType: z.string().max(200).optional(),
})
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>

/** Spec-level requirements: any scheme or network. */
export const PaymentRequirementsSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  amount: z.string().min(1),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
})
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>

export const PixExtraSchema = z.object({
  paymentFlow: z.literal(PIX_PAYMENT_FLOW),
  assetTransferMethod: z.literal(PIX_ASSET_TRANSFER_METHOD),
  provider: z.string().min(1).max(64),
  resourceUrl: HttpUrlSchema,
  chargeId: z.string().min(1).max(128),
  brCode: z.string().min(1).max(1024),
  brCodeBase64: z.string().max(65_536).optional(),
  expiresAt: z.iso.datetime({ offset: true }),
})
export type PixExtra = z.infer<typeof PixExtraSchema>

/** `extra` keys that change with every charge. Every other key must match between accepted and requirements. */
export const PIX_DYNAMIC_EXTRA_KEYS = ["chargeId", "brCode", "brCodeBase64", "expiresAt"] as const

export const PixPaymentRequirementsSchema = z.object({
  scheme: z.literal(PIX_SCHEME),
  network: z.literal(PIX_NETWORK),
  amount: AtomicAmountSchema,
  asset: z.literal(PIX_ASSET),
  payTo: z.string().min(1).max(128),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: PixExtraSchema,
})
export type PixPaymentRequirements = z.infer<typeof PixPaymentRequirementsSchema>

export const ExtensionsSchema = z.record(z.string(), z.unknown())

export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: ExtensionsSchema.optional(),
})
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: z.record(z.string(), z.unknown()),
  extensions: ExtensionsSchema.optional(),
})
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>

export const PixPayloadSchema = z.object({ chargeId: z.string().min(1).max(128) })
export type PixPayload = z.infer<typeof PixPayloadSchema>

export const PixPaymentPayloadSchema = PaymentPayloadSchema.extend({
  accepted: PixPaymentRequirementsSchema,
  payload: PixPayloadSchema,
})
export type PixPaymentPayload = z.infer<typeof PixPaymentPayloadSchema>

export const SettlementResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string(),
  network: z.string(),
  amount: z.string().optional(),
  extensions: ExtensionsSchema.optional(),
})
export type SettlementResponse = z.infer<typeof SettlementResponseSchema>

export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
  extensions: ExtensionsSchema.optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
})
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>

export const SupportedKindSchema = z.object({
  x402Version: z.number().int(),
  scheme: z.string(),
  network: z.string(),
  extra: z.record(z.string(), z.unknown()).optional(),
})
export const SupportedResponseSchema = z.object({
  kinds: z.array(SupportedKindSchema),
  extensions: z.array(z.string()),
  signers: z.record(z.string(), z.array(z.string())),
})
export type SupportedResponse = z.infer<typeof SupportedResponseSchema>

/** Body of facilitator `POST /verify` and `POST /settle`. */
export const FacilitatorRequestSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
})
export type FacilitatorRequest = z.infer<typeof FacilitatorRequestSchema>

/** Body of facilitator `POST /pix/charges`. */
export const CreateChargeRequestSchema = z.object({
  resource: ResourceInfoSchema,
  amount: AtomicAmountSchema,
  description: z.string().max(140).optional(),
})
export type CreateChargeRequest = z.infer<typeof CreateChargeRequestSchema>

export const CreateChargeResponseSchema = z.object({
  paymentRequirements: PixPaymentRequirementsSchema,
})
export type CreateChargeResponse = z.infer<typeof CreateChargeResponseSchema>
