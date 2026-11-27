/** The only fetch shape p-x402 libraries call: always with a ready `Request`. `globalThis.fetch` and Hono's `app.fetch` both fit. */
export type FetchLike = (request: Request) => Promise<Response>

export const defaultFetch: FetchLike = (request) => globalThis.fetch(request)
