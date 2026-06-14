export interface OpenAICompatibleProfile {
  readonly provider: string
  readonly baseURL: string
}

export const profiles = {
  baseten: { provider: "baseten", baseURL: "https://inference.baseten.co/v1" },
  cerebras: { provider: "cerebras", baseURL: "https://api.cerebras.ai/v1" },
  deepinfra: { provider: "deepinfra", baseURL: "https://api.deepinfra.com/v1/openai" },
  deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1" },
  fireworks: { provider: "fireworks", baseURL: "https://api.fireworks.ai/inference/v1" },
  groq: { provider: "groq", baseURL: "https://api.groq.com/openai/v1" },
  openrouter: { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1" },
  togetherai: { provider: "togetherai", baseURL: "https://api.together.xyz/v1" },
  xai: { provider: "xai", baseURL: "https://api.x.ai/v1" },
  // lingcode additions (OpenAI-compat only — Anthropic-protocol providers
  // live in their own files; see `lingmodel.ts` and re-use `anthropic.ts`):
  // z.ai / GLM — two endpoints: general default + coding-plan opt-in
  zai: { provider: "zai", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  "zai-coding": { provider: "zai-coding", baseURL: "https://api.z.ai/api/coding/paas/v4" },
  // Moonshot / Kimi
  moonshot: { provider: "moonshot", baseURL: "https://api.moonshot.ai/v1" },
  // NOTE: `lingmodel` and `deepseek-anthropic` are NOT openai-compat — they
  // serve the Anthropic Messages API. See providers/lingmodel.ts. The
  // DeepSeek /anthropic endpoint is also Anthropic-protocol; configure it
  // by passing baseURL="https://api.deepseek.com/anthropic" to the Anthropic
  // provider, not by adding here.
} as const satisfies Record<string, OpenAICompatibleProfile>

export const byProvider: Record<string, OpenAICompatibleProfile> = Object.fromEntries(
  Object.values(profiles).map((profile) => [profile.provider, profile]),
)
