import { Effect, Schema } from "effect"
import { Auth } from "@/auth"

/**
 * LingCode Cloud client primitives shared by the `lingcode cloud` subcommands.
 *
 * All of LingCode Cloud is plain HTTPS to `lingcode.dev` with a Bearer token —
 * the macOS app's CloudDeployService / LingCodeCloudMCPSetup are just GUI drivers
 * over these endpoints. This module reproduces the token resolution + endpoint
 * contract so the cross-platform CLI (and the Zed fork that drives it) reach
 * parity with the Mac experience.
 */

/** Auth-store key under which the Cloud access token is persisted (auth.json). */
export const AUTH_KEY = "lingcode-cloud"

export class CloudError extends Schema.TaggedErrorClass<CloudError>()("CloudError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

/** API base; override with LINGCODE_CLOUD_API for staging/self-host. */
export const apiBase = () => (process.env.LINGCODE_CLOUD_API ?? "https://lingcode.dev").replace(/\/+$/, "")

/** Token paste page opened by `cloud login` (mirrors the LingModel cli-token flow). */
export const tokenPageUrl = () => `${apiBase()}/cli-token.html`

/** Remote MCP endpoint the managed backend speaks (streamable HTTP, JSON-RPC). */
export const mcpUrl = () => `${apiBase()}/api/cloud/account/mcp`

/**
 * Resolve the Cloud access token: LINGCODE_CLOUD_TOKEN env wins, else the value
 * stored by `cloud login` in the CLI auth store. Returns undefined when absent.
 */
export const resolveToken = Effect.fn("Cloud.resolveToken")(function* () {
  const env = process.env.LINGCODE_CLOUD_TOKEN?.trim()
  if (env) return env
  const auth = yield* Auth.Service
  const info = yield* auth.get(AUTH_KEY).pipe(Effect.orElseSucceed(() => undefined))
  if (info && info.type === "api") return info.key
  return undefined
})

/** Like resolveToken but fails with CloudError when no token is configured. */
export const requireToken = Effect.fn("Cloud.requireToken")(function* () {
  const token = yield* resolveToken()
  if (!token) return yield* Effect.fail(new CloudError({ message: "Not signed in. Run `lingcode cloud login` first." }))
  return token
})

export interface CloudAccount {
  email?: string
  tier?: string
}

/** GET /api/account/me — used to verify a token and read plan/tier. */
export const fetchAccount = (token: string) =>
  Effect.tryPromise({
    try: async (): Promise<CloudAccount> => {
      const res = await fetch(`${apiBase()}/api/account/me`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      })
      if (res.status === 401 || res.status === 403)
        throw new CloudError({ message: "Token rejected by server (unauthorized).", status: res.status })
      if (!res.ok) throw new CloudError({ message: `Unexpected response: HTTP ${res.status}`, status: res.status })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { email: typeof body.email === "string" ? body.email : undefined, tier: typeof body.tier === "string" ? body.tier : undefined }
    },
    catch: (e) => (e instanceof CloudError ? e : new CloudError({ message: errMsg(e) })),
  })

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export * as Cloud from "./cloud"
