import { Auth } from "../../auth"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsDev } from "@lingcode-ai/core/models"

import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "@/config/config"
import { Global } from "@lingcode-ai/core/global"
import { Plugin } from "../../plugin"
import type { Hooks } from "@lingcode-ai/plugin"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"
import { text } from "node:stream/consumers"
import crypto from "node:crypto"
import nodefs from "node:fs/promises"
import { Effect, Option } from "effect"

type PluginAuth = NonNullable<Hooks["auth"]>

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

const put = Effect.fn("Cli.providers.put")(function* (key: string, info: Auth.Info) {
  const auth = yield* Auth.Service
  yield* Effect.orDie(auth.set(key, info))
})

const cliTry = <Value>(message: string, fn: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => new CliError({ message: message + errorMessage(error) }),
  })

const handlePluginAuth = Effect.fn("Cli.providers.pluginAuth")(function* (
  plugin: { auth: PluginAuth },
  provider: string,
  methodName?: string,
) {
  const index = yield* Effect.gen(function* () {
    if (!methodName) {
      if (plugin.auth.methods.length <= 1) return 0
      return yield* promptValue(
        yield* Prompt.select({
          message: "Login method",
          options: plugin.auth.methods.map((x, index) => ({
            label: x.label,
            value: index,
          })),
        }),
      )
    }
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      return yield* fail(
        `Unknown method "${methodName}" for ${provider}. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
      )
    }
    return match
  })
  const method = plugin.auth.methods[index]

  yield* Effect.sleep("10 millis")
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        const value = yield* Prompt.select({
          message: prompt.message,
          options: prompt.options,
        })
        inputs[prompt.key] = yield* promptValue(value)
        continue
      }
      const value = yield* Prompt.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
      })
      inputs[prompt.key] = yield* promptValue(value)
    }
  }

  if (method.type === "oauth") {
    const authorize = yield* cliTry("Failed to authorize: ", () => method.authorize(inputs))

    if (authorize.url) {
      yield* Prompt.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        yield* Prompt.log.info(authorize.instructions)
      }
      const spinner = Prompt.spinner()
      yield* spinner.start("Waiting for authorization...")
      const result = yield* cliTry("Failed to authorize: ", () => authorize.callback())
      if (result.type === "failed") {
        yield* spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = yield* Prompt.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      const authorizationCode = yield* promptValue(code)
      const result = yield* cliTry("Failed to authorize: ", () => authorize.callback(authorizationCode))
      if (result.type === "failed") {
        yield* Prompt.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* Prompt.log.success("Login successful")
      }
    }

    yield* Prompt.outro("Done")
    return true
  }

  if (method.type === "api") {
    const key = yield* Prompt.password({
      message: "Enter your API key",
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    const apiKey = yield* promptValue(key)

    const metadata = Object.keys(inputs).length ? { metadata: inputs } : {}
    const authorizeApi = method.authorize
    if (!authorizeApi) {
      yield* put(provider, {
        type: "api",
        key: apiKey,
        ...metadata,
      })
      yield* Prompt.outro("Done")
      return true
    }

    const result = yield* cliTry("Failed to authorize: ", () => authorizeApi(inputs))
    if (result.type === "failed") {
      yield* Prompt.log.error("Failed to authorize")
    }
    if (result.type === "success") {
      const saveProvider = result.provider ?? provider
      const merged = { ...(metadata.metadata ?? {}), ...(result.metadata ?? {}) }
      yield* put(saveProvider, {
        type: "api",
        key: result.key ?? apiKey,
        ...(Object.keys(merged).length ? { metadata: merged } : {}),
      })
      yield* Prompt.log.success("Login successful")
    }
    yield* Prompt.outro("Done")
    return true
  }

  return false
})

export function resolvePluginProviders(input: {
  hooks: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs
      .command(ProvidersListCommand)
      .command(ProvidersLoginCommand)
      .command(ProvidersLogoutCommand)
      .command(ProvidersUseCommand)
      .command(ProvidersExportCommand)
      .command(ProvidersImportCommand)
      .demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  // Lists global credentials + provider env vars; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.list")(function* (_args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    yield* Prompt.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(yield* Effect.orDie(authSvc.all()))
    const database = yield* modelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    yield* Prompt.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      yield* Prompt.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        yield* Prompt.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      yield* Prompt.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  }),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: "opencode auth provider",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      })
      .option("account", {
        alias: ["a"],
        describe:
          "store this credential under a named account label (e.g. 'work'); switch later with `providers use <provider> --account <label>`",
        type: "string",
      }),
  handler: Effect.fn("Cli.providers.login")(function* (args) {
    const authSvc = yield* Auth.Service

    UI.empty()
    yield* Prompt.intro("Add credential")
    if (args.url) {
      const url = args.url.replace(/\/+$/, "")
      const wellknown = (yield* cliTry(`Failed to load auth provider metadata from ${url}: `, () =>
        fetch(`${url}/.well-known/opencode`).then((x) => x.json()),
      )) as {
        auth: { command: string[]; env: string }
      }
      yield* Prompt.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
      const abort = new AbortController()
      const proc = Process.spawn(wellknown.auth.command, { stdout: "pipe", stderr: "inherit", abort: abort.signal })
      if (!proc.stdout) {
        yield* Prompt.log.error("Failed")
        yield* Prompt.outro("Done")
        return
      }
      const [exit, token] = yield* cliTry("Failed to run auth provider command: ", () =>
        Promise.all([proc.exited, text(proc.stdout!)]),
      ).pipe(Effect.ensuring(Effect.sync(() => abort.abort())))
      if (exit !== 0) {
        yield* Prompt.log.error("Failed")
        yield* Prompt.outro("Done")
        return
      }
      yield* Effect.orDie(authSvc.set(url, { type: "wellknown", key: wellknown.auth.env, token: token.trim() }))
      yield* Prompt.log.success("Logged into " + url)
      yield* Prompt.outro("Done")
      return
    }

    const cfgSvc = yield* Config.Service
    const pluginSvc = yield* Plugin.Service
    const modelsDev = yield* ModelsDev.Service
    yield* Effect.ignore(modelsDev.refresh(true))

    const config = yield* cfgSvc.get()

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

    const allProviders = yield* modelsDev.get()
    const providers: Record<string, (typeof allProviders)[string]> = {}
    for (const [key, value] of Object.entries(allProviders)) {
      if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) providers[key] = value
    }
    const hooks = yield* pluginSvc.list()

    const priority: Record<string, number> = {
      opencode: 0,
      openai: 1,
      "github-copilot": 2,
      google: 3,
      anthropic: 4,
      openrouter: 5,
      vercel: 6,
    }
    const pluginProviders = resolvePluginProviders({
      hooks,
      existingProviders: providers,
      disabled,
      enabled,
      providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
    })
    const options = [
      ...pipe(
        providers,
        values(),
        sortBy(
          (x) => priority[x.id] ?? 99,
          (x) => x.name ?? x.id,
        ),
        map((x) => ({
          label: x.name,
          value: x.id,
          hint: {
            opencode: "recommended",
            openai: "ChatGPT Plus/Pro or API key",
          }[x.id],
        })),
      ),
      ...pluginProviders.map((x) => ({
        label: x.name,
        value: x.id,
        hint: "plugin",
      })),
    ]

    let provider: string
    if (args.provider) {
      const input = args.provider
      const byID = options.find((x) => x.value === input)
      const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
      const match = byID ?? byName
      if (!match) {
        return yield* fail(`Unknown provider "${input}"`)
      }
      provider = match.value
    } else {
      provider = yield* promptValue(
        yield* Prompt.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [...options, { value: "other", label: "Other" }],
        }),
      )
    }

    const plugin = hooks.findLast((x) => x.auth?.provider === provider)
    if (plugin && plugin.auth) {
      const handled = yield* handlePluginAuth({ auth: plugin.auth! }, provider, args.method)
      if (handled) return
    }

    if (provider === "other") {
      provider = (yield* promptValue(
        yield* Prompt.text({
          message: "Enter provider id",
          validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
        }),
      )).replace(/^@ai-sdk\//, "")

      const customPlugin = hooks.findLast((x) => x.auth?.provider === provider)
      if (customPlugin && customPlugin.auth) {
        const handled = yield* handlePluginAuth({ auth: customPlugin.auth! }, provider, args.method)
        if (handled) return
      }

      yield* Prompt.log.warn(
        `This only stores a credential for ${provider} - you will need configure it in opencode.json, check the docs for examples.`,
      )
    }

    if (provider === "amazon-bedrock") {
      yield* Prompt.log.info(
        "Amazon Bedrock authentication priority:\n" +
          "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
          "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
          "Configure via opencode.json options (profile, region, endpoint) or\n" +
          "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
      )
    }

    if (provider === "lingcode") {
      yield* Prompt.log.info("Create an api key at https://lingcode.dev/auth")
    }

    if (provider === "lingmodel") {
      yield* Prompt.log.info(
        "Sign in at https://lingcode.dev and grab your LingModel CLI token from\n" +
          "https://lingcode.dev/cli-token.html (token format: lcat_…).",
      )
    }

    if (provider === "vercel") {
      yield* Prompt.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
    }

    if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
      yield* Prompt.log.info(
        "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://lingcode.dev/docs/providers/#cloudflare-ai-gateway",
      )
    }

    const key = yield* Prompt.password({
      message: "Enter your API key",
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    const apiKey = yield* promptValue(key)
    yield* Effect.orDie(authSvc.set(provider, { type: "api", key: apiKey }))

    // Multi-account: keep a labeled copy alongside the active slot so the user
    // can park several keys for one provider and swap with `providers use`.
    const label = args.account?.trim()
    if (label) {
      yield* Effect.orDie(authSvc.set(`${provider}#${label}`, { type: "api", key: apiKey }))
      yield* Prompt.log.info(
        `Saved as account '${label}'. Switch later with: lingcode providers use ${provider} --account ${label}`,
      )
    }

    yield* Prompt.outro("Done")
  }),
})

export const ProvidersUseCommand = effectCmd({
  command: "use <provider>",
  describe: "activate a stored named account for a provider",
  // Swaps which credential occupies the active <provider> slot; global only.
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("provider", { describe: "provider id", type: "string", demandOption: true })
      .option("account", { alias: ["a"], describe: "account label to activate", type: "string" }),
  handler: Effect.fn("Cli.providers.use")(function* (args) {
    const authSvc = yield* Auth.Service
    const provider = args.provider!
    const all = yield* Effect.orDie(authSvc.all())
    const prefix = `${provider}#`
    const labels = Object.keys(all)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))

    UI.empty()
    yield* Prompt.intro(`Accounts for ${provider}`)
    if (labels.length === 0) {
      yield* Prompt.log.error(
        `No named accounts for '${provider}'. Create one with: lingcode providers login --provider ${provider} --account <label>`,
      )
      return
    }

    const label = args.account?.trim() ?? (yield* promptValue(yield* Prompt.select({
      message: "Select account to activate",
      options: labels.map((l) => ({ label: l, value: l })),
    })))

    const stored = all[`${prefix}${label}`]
    if (!stored) {
      yield* Prompt.log.error(`No account '${label}' for '${provider}'. Available: ${labels.join(", ")}`)
      return
    }
    yield* Effect.orDie(authSvc.set(provider, stored))
    yield* Prompt.outro(`Activated '${label}' for ${provider}`)
  }),
})

export const ProvidersLogoutCommand = effectCmd({
  command: "logout",
  describe: "log out from a configured provider",
  // Removes a global auth credential; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.logout")(function* (_args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const credentials: Array<[string, Auth.Info]> = Object.entries(yield* Effect.orDie(authSvc.all()))
    yield* Prompt.intro("Remove credential")
    if (credentials.length === 0) {
      yield* Prompt.log.error("No credentials found")
      return
    }
    const database = yield* modelsDev.get()
    const selected = yield* Prompt.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    yield* Effect.orDie(authSvc.remove(yield* promptValue(selected)))
    yield* Prompt.outro("Logout successful")
  }),
})

// ── encrypted export / import ───────────────────────────────────────────────
// Portable backup of all stored credentials, encrypted with a passphrase the
// user supplies (AES-256-GCM, scrypt-derived key). Lets a user move creds
// between machines — the gap vs the Swift CLI's `auth export/import`.

const EXPORT_MAGIC = "lingcode-auth-export"

function encryptAuth(plaintext: string, passphrase: string): string {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, 32)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    magic: EXPORT_MAGIC,
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  })
}

function decryptAuth(envelope: string, passphrase: string): string {
  const obj = JSON.parse(envelope)
  if (obj?.magic !== EXPORT_MAGIC) throw new Error("not a lingcode auth export file")
  const salt = Buffer.from(obj.salt, "base64")
  const iv = Buffer.from(obj.iv, "base64")
  const tag = Buffer.from(obj.tag, "base64")
  const key = crypto.scryptSync(passphrase, salt, 32)
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(obj.data, "base64")), decipher.final()]).toString("utf8")
}

export const ProvidersExportCommand = effectCmd({
  command: "export <file>",
  describe: "export all credentials to an encrypted file",
  instance: false,
  builder: (yargs) =>
    yargs.positional("file", { describe: "destination path for the encrypted export", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.providers.export")(function* (args) {
    const authSvc = yield* Auth.Service
    const all = yield* Effect.orDie(authSvc.all())
    UI.empty()
    yield* Prompt.intro("Export credentials")
    const count = Object.keys(all).length
    if (count === 0) {
      yield* Prompt.log.error("No credentials to export")
      return
    }
    const pass = yield* promptValue(
      yield* Prompt.password({
        message: "Passphrase to encrypt the export",
        validate: (x) => (x && x.length >= 6 ? undefined : "At least 6 characters"),
      }),
    )
    const envelope = encryptAuth(JSON.stringify(all), pass)
    yield* Effect.tryPromise({
      try: () => nodefs.writeFile(args.file!, envelope, { mode: 0o600 }),
      catch: (cause) => new CliError({ message: `Failed to write ${args.file}: ${String(cause)}` }),
    })
    yield* Prompt.outro(`Exported ${count} credential${count === 1 ? "" : "s"} to ${args.file}`)
  }),
})

export const ProvidersImportCommand = effectCmd({
  command: "import <file>",
  describe: "import credentials from an encrypted export file",
  instance: false,
  builder: (yargs) =>
    yargs.positional("file", { describe: "path to the encrypted export", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.providers.import")(function* (args) {
    const authSvc = yield* Auth.Service
    UI.empty()
    yield* Prompt.intro("Import credentials")
    const envelope = yield* Effect.tryPromise({
      try: () => nodefs.readFile(args.file!, "utf8"),
      catch: (cause) => new CliError({ message: `Failed to read ${args.file}: ${String(cause)}` }),
    })
    const pass = yield* promptValue(
      yield* Prompt.password({
        message: "Passphrase to decrypt the export",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      }),
    )
    let parsed: Record<string, Auth.Info>
    try {
      parsed = JSON.parse(decryptAuth(envelope, pass))
    } catch (cause) {
      yield* Prompt.log.error("Failed to decrypt — wrong passphrase or corrupt file")
      return
    }
    let imported = 0
    for (const [key, info] of Object.entries(parsed)) {
      yield* Effect.orDie(authSvc.set(key, info))
      imported++
    }
    yield* Prompt.outro(`Imported ${imported} credential${imported === 1 ? "" : "s"}`)
  }),
})
