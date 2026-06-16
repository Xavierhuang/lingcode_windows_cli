// Startup login guard.
//
// Before any AI command actually runs (TUI, `run`, `serve`, `acp`), make sure
// the user has *some* usable credential. If they don't, print a friendly
// "sign in on the website" message and exit, instead of dropping them into a
// broken session that fails on the first prompt with an opaque provider error.
//
// "Logged in" here means any of:
//   - a credential saved in auth.json (covers `lingcode providers login` for
//     every provider, including the LingModel `lcat_` token / account)
//   - the OPENCODE_AUTH_CONTENT env override (used by automation/CI)
//   - any provider API-key env var is set (LINGCODE_CLI_TOKEN, ANTHROPIC_API_KEY, …)
//
// Bypass entirely with LINGCODE_SKIP_LOGIN_CHECK=1 (escape hatch for exotic
// setups, e.g. a custom provider whose credentials we can't detect here).
import path from "path"
import { EOL } from "os"
import { existsSync, readFileSync } from "fs"
import { Global } from "@lingcode-ai/core/global"
import { UI } from "./ui"

const LOGIN_URL = "https://lingcode.dev/cli-token.html"

// Curated fallback list of provider API-key env vars. We also union in every
// `env` entry from the on-disk models.dev catalog cache (see envVarNames), so
// this only needs to cover the case where the catalog cache isn't present yet.
const FALLBACK_ENV_VARS = [
  "LINGCODE_CLI_TOKEN", // LingModel
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPINFRA_API_KEY",
  "COHERE_API_KEY",
  "FIREWORKS_API_KEY",
  "AZURE_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "MOONSHOT_API_KEY",
  "ZHIPUAI_API_KEY",
  "GLM_API_KEY",
]

function hasJsonCredentials(raw: string | undefined): boolean {
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw)
    return Boolean(parsed) && typeof parsed === "object" && Object.keys(parsed).length > 0
  } catch {
    return false
  }
}

function hasAuthFileCredentials(): boolean {
  const file = path.join(Global.Path.data, "auth.json")
  if (!existsSync(file)) return false
  try {
    return hasJsonCredentials(readFileSync(file, "utf-8"))
  } catch {
    return false
  }
}

// All provider env-var names: curated fallback ∪ catalog cache `env` arrays.
function envVarNames(): Set<string> {
  const names = new Set(FALLBACK_ENV_VARS)
  const cache = path.join(Global.Path.cache, "models.json")
  if (existsSync(cache)) {
    try {
      const catalog = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, { env?: string[] }>
      for (const provider of Object.values(catalog)) {
        for (const name of provider?.env ?? []) names.add(name)
      }
    } catch {
      // Ignore a malformed cache; the fallback list still applies.
    }
  }
  return names
}

function hasProviderEnvVar(): boolean {
  for (const name of envVarNames()) {
    if (process.env[name]?.trim()) return true
  }
  return false
}

export function isAuthenticated(): boolean {
  if (hasJsonCredentials(process.env.OPENCODE_AUTH_CONTENT)) return true
  if (hasAuthFileCredentials()) return true
  if (hasProviderEnvVar()) return true
  return false
}

// Returns true if the caller should continue. When not authenticated, prints
// the sign-in message and exits the process (matching the user-chosen
// "message + URL, then exit" behavior).
export function requireLoginOrExit(): void {
  if (process.env.LINGCODE_SKIP_LOGIN_CHECK === "1") return
  if (isAuthenticated()) return

  const b = UI.Style.TEXT_NORMAL_BOLD
  const dim = UI.Style.TEXT_DIM
  const reset = UI.Style.TEXT_NORMAL

  UI.empty()
  UI.println(`${b}You're not signed in to LingCode.${reset}`)
  UI.empty()
  UI.println(`Sign in on the website to get your LingModel token ${dim}(free + Pro tiers)${reset}:`)
  UI.println(`  ${UI.Style.TEXT_INFO}${LOGIN_URL}${reset}`)
  UI.empty()
  UI.println(`Then connect the CLI with:`)
  UI.println(`  ${b}lingcode providers login${reset}`)
  UI.empty()
  UI.println(
    `${dim}Already have an API key for another provider? Run ${reset}${b}lingcode providers login${reset}${dim}` +
      ` or set its API key env var.${reset}`,
  )
  process.stderr.write(EOL)
  process.exit(1)
}

export const AuthGuard = { isAuthenticated, requireLoginOrExit }
