import { cmd } from "./cmd"
import { Effect, Option } from "effect"
import { UI } from "../ui"
import { effectCmd, fail, CliError } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import { Auth } from "@/auth"
import { Cloud } from "@/cloud/cloud"
import { deploy as runDeploy, type DeployEvent } from "@/cloud/deploy"
import { connect as runConnect, disconnect as runDisconnect } from "@/cloud/connect"
import open from "open"

const println = (msg: string) => Effect.sync(() => UI.println(msg))
const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

// ── login ──────────────────────────────────────────────────────────────────

const loginEffect = Effect.fn("cloud.login")(function* () {
  const auth = yield* Auth.Service
  yield* Prompt.intro("Sign in to LingCode Cloud")

  const url = Cloud.tokenPageUrl()
  yield* Prompt.log.info("Opening " + url)
  yield* openBrowser(url)

  const pasted = yield* Prompt.password({ message: "Paste your LingCode Cloud access token" })
  if (Option.isNone(pasted) || pasted.value.trim().length === 0) return yield* fail("No token entered")
  const token = pasted.value.trim()

  const s = Prompt.spinner()
  yield* s.start("Verifying token...")
  const account = yield* Cloud.fetchAccount(token).pipe(
    Effect.catchTag("CloudError", (e) =>
      Effect.gen(function* () {
        yield* s.stop("Could not verify token", 1)
        return yield* fail(e.message)
      }),
    ),
  )

  yield* auth
    .set(
      Cloud.AUTH_KEY,
      new Auth.Api({
        type: "api",
        key: token,
        metadata: { url: Cloud.apiBase(), email: account.email ?? "", tier: account.tier ?? "" },
      }),
    )
    .pipe(Effect.mapError((e) => new CliError({ message: e.message })))
  yield* s.stop("Signed in" + (account.email ? " as " + account.email : ""))
  yield* Prompt.outro("Done")
})

export const CloudLoginCommand = effectCmd({
  command: "login",
  describe: "sign in to LingCode Cloud",
  instance: false,
  handler: Effect.fn("Cli.cloud.login")(function* () {
    UI.empty()
    yield* loginEffect()
  }),
})

// ── logout ─────────────────────────────────────────────────────────────────

export const CloudLogoutCommand = effectCmd({
  command: "logout",
  describe: "sign out of LingCode Cloud",
  instance: false,
  handler: Effect.fn("Cli.cloud.logout")(function* () {
    const auth = yield* Auth.Service
    yield* auth.remove(Cloud.AUTH_KEY).pipe(Effect.orElseSucceed(() => undefined))
    yield* println("Signed out of LingCode Cloud")
  }),
})

// ── whoami ─────────────────────────────────────────────────────────────────

export const CloudWhoamiCommand = effectCmd({
  command: "whoami",
  describe: "show the signed-in LingCode Cloud account",
  instance: false,
  builder: (yargs) => yargs.option("json", { describe: "output JSON", type: "boolean" }),
  handler: Effect.fn("Cli.cloud.whoami")(function* (args) {
    const token = yield* Cloud.requireToken().pipe(Effect.mapError((e) => new CliError({ message: e.message })))
    const account = yield* Cloud.fetchAccount(token).pipe(Effect.mapError((e) => new CliError({ message: e.message })))
    if (args.json) {
      yield* println(JSON.stringify(account))
      return
    }
    yield* println(`${account.email ?? "(unknown)"}  ${account.tier ?? ""}`.trim())
  }),
})

// ── deploy ─────────────────────────────────────────────────────────────────

export const CloudDeployCommand = effectCmd({
  command: "deploy [dir]",
  describe: "deploy this project to LingCode Cloud",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("dir", { describe: "project directory", type: "string" })
      .option("title", { describe: "app title", type: "string" })
      .option("worker", { describe: "deploy as a Worker/SSR app", type: "boolean" })
      .option("ndjson", { describe: "emit machine-readable NDJSON progress", type: "boolean" }),
  handler: Effect.fn("Cli.cloud.deploy")(function* (args) {
    const cwd = args.dir ?? process.cwd()

    // NDJSON mode (driven by the Zed GPUI panel): pure machine output, no spinner.
    if (args.ndjson) {
      const emit = (e: DeployEvent) => process.stdout.write(JSON.stringify(e) + "\n")
      const token = yield* Cloud.resolveToken()
      if (!token) {
        emit({ phase: "error", message: "Not signed in. Run `lingcode cloud login` first." })
        process.exitCode = 1
        return
      }
      yield* Effect.tryPromise({
        try: () => runDeploy(token, { cwd, title: args.title, worker: args.worker, emit }),
        catch: (e) => new CliError({ message: Cloud.errMsg(e) }),
      }).pipe(
        Effect.catchTag("CliError", (e) =>
          Effect.sync(() => {
            emit({ phase: "error", message: e.message })
            process.exitCode = 1
          }),
        ),
      )
      return
    }

    const token = yield* Cloud.requireToken().pipe(Effect.mapError((e) => new CliError({ message: e.message })))

    // Human mode: spinner + readable log.
    UI.empty()
    const s = Prompt.spinner()
    yield* s.start("Deploying to LingCode Cloud...")
    const result = yield* Effect.tryPromise({
      try: () =>
        runDeploy(token, {
          cwd,
          title: args.title,
          worker: args.worker,
          emit: (e) => {
            if (e.phase === "detect") process.stderr.write(`  detected ${e.pm} → ${e.outDir}\n`)
            else if (e.phase === "upload" && e.status === "start") process.stderr.write(`  uploading (${e.mode})...\n`)
            else if (e.phase === "poll") process.stderr.write(`  building on cloud...\n`)
          },
        }),
      catch: (e) => new CliError({ message: Cloud.errMsg(e) }),
    }).pipe(
      Effect.catchTag("CliError", (e) =>
        Effect.gen(function* () {
          yield* s.stop("Deploy failed", 1)
          return yield* fail(e.message)
        }),
      ),
    )
    yield* s.stop("Deployed")
    yield* println(result.url)
  }),
})

// ── connect / disconnect ─────────────────────────────────────────────────────

export const CloudConnectCommand = effectCmd({
  command: "connect [dir]",
  describe: "connect a managed backend to this project",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("dir", { describe: "project directory", type: "string" })
      .option("label", { describe: "backend label", type: "string" }),
  handler: Effect.fn("Cli.cloud.connect")(function* (args) {
    const cwd = args.dir ?? process.cwd()
    const token = yield* Cloud.requireToken().pipe(Effect.mapError((e) => new CliError({ message: e.message })))
    const result = yield* Effect.tryPromise({
      try: () => runConnect(token, cwd, args.label),
      catch: (e) => new CliError({ message: Cloud.errMsg(e) }),
    })
    yield* println(`Connected backend ${result.backendId} (project ${result.projectId})`)
    yield* println(`Wrote .lingcode/opencode.json + .lingcode/project.json — the agent can now use mcp__lingcode-cloud__* tools.`)
  }),
})

export const CloudDisconnectCommand = effectCmd({
  command: "disconnect [dir]",
  describe: "disconnect the managed backend from this project",
  instance: false,
  builder: (yargs) => yargs.positional("dir", { describe: "project directory", type: "string" }),
  handler: Effect.fn("Cli.cloud.disconnect")(function* (args) {
    const cwd = args.dir ?? process.cwd()
    const changed = yield* Effect.tryPromise({
      try: () => runDisconnect(cwd),
      catch: (e) => new CliError({ message: Cloud.errMsg(e) }),
    })
    yield* println(changed ? "Disconnected managed backend" : "No managed backend was connected")
  }),
})

// ── parent ───────────────────────────────────────────────────────────────────

export const CloudCommand = cmd({
  command: "cloud",
  describe: "manage LingCode Cloud (auth, deploy, managed backend)",
  builder: (yargs) =>
    yargs
      .command({ ...CloudLoginCommand, describe: "sign in to LingCode Cloud" })
      .command({ ...CloudLogoutCommand, describe: "sign out of LingCode Cloud" })
      .command({ ...CloudWhoamiCommand, describe: "show the signed-in account" })
      .command({ ...CloudDeployCommand, describe: "deploy this project to LingCode Cloud" })
      .command({ ...CloudConnectCommand, describe: "connect a managed backend" })
      .command({ ...CloudDisconnectCommand, describe: "disconnect the managed backend" })
      .demandCommand(),
  async handler() {},
})
