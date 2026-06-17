// LingModel — the managed-provider offering hosted by lingcode.dev.
//
// Wire format: Anthropic Messages API at /api/inference/anthropic/v1/messages.
// The proxy validates the caller's `Authorization: Bearer lcat_*` (or
// `x-api-key: lcat_*`) token against the lingcode.dev account database,
// enforces the tier-based prompt/token caps, then forwards to whatever
// Anthropic-compatible upstream operators have configured (default: DeepSeek's
// /anthropic endpoint; admins can swap via DB-backed app_config).
//
// Users get a token at https://lingcode.dev/cli-token.html (after signup).
// Free-tier users get a daily LingModel cap; Pro/Max Pro tiers get higher
// caps. The exact limits are admin-tunable and live server-side — the CLI
// doesn't need to know them, just attach the token and let the proxy decide.
//
// Per project branding policy: never name the upstream vendor in
// user-visible strings. "LingModel" or generic "your API key" only.

import type { RouteModelInput } from "../route/client"
import { Provider } from "../provider"
import { ProviderID, type ModelID } from "../schema"
import * as AnthropicMessages from "../protocols/anthropic-messages"

export const id = ProviderID.make("lingmodel")

export const routes = [AnthropicMessages.route]

const DEFAULT_BASE_URL = "https://lingcode.dev/api/inference/anthropic/v1"

export const model = (
  id: string | ModelID,
  options: Omit<RouteModelInput, "id" | "baseURL"> & { readonly baseURL?: string } = {},
) => AnthropicMessages.model({ ...options, baseURL: options.baseURL ?? DEFAULT_BASE_URL, id })

export const provider = Provider.make({
  id,
  model,
})
