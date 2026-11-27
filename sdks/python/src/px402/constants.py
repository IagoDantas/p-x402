X402_VERSION = 2
PIX_SCHEME = "exact"
PIX_NETWORK = "pix:br"
PIX_ASSET = "BRL"
PIX_PAYMENT_FLOW = "upfront"
PIX_ASSET_TRANSFER_METHOD = "pix-charge"

HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED"
HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE"
HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE"

#: Header values longer than this (characters, after trimming) are refused before decoding.
MAX_HEADER_LENGTH = 16 * 1024

#: ``extra`` keys that change with every charge; every other key must match on the retry.
PIX_DYNAMIC_EXTRA_KEYS = ("chargeId", "brCode", "brCodeBase64", "expiresAt")
