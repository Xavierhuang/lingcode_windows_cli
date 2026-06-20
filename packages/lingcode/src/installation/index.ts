import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@lingcode-ai/core/process"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import * as Log from "@lingcode-ai/core/util/log"
import { makeRuntime } from "@lingcode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@lingcode-ai/core/installation/version"
import { NpmConfig } from "@lingcode-ai/core/npm-config"

const log = Log.create({ service: "installation" })

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

// Cheap source-of-truth for the lingcode CLIv2 latest version. Deploy as a
// static file at https://lingcode.dev/cliv2-latest.json next to the zip
// artifacts. See website/cliv2-latest.json for the shape. We fall back to
// the GitHub Releases API when the manifest is unavailable.
const LingcodeManifest = Schema.Struct({ version: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
      if (tapFormula.includes("lingcode")) return "anomalyco/tap/opencode"
      const coreFormula = yield* text(["brew", "list", "--formula", "lingcode"])
      if (coreFormula.includes("lingcode")) return "lingcode"
      return "lingcode"
    })

    const upgradeCurl = Effect.fnUntraced(function* (target: string) {
      // The live installer is install-cli.sh (the bare /install path 404s).
      // It pins the version via LINGCODE_TS_VERSION (with a leading "v"),
      // NOT the upstream-opencode "VERSION" env var, and builds the zip URL
      // as lingcode-<os>-<arch>-<version>.zip from it.
      const response = yield* httpOk.execute(HttpClientRequest.get("https://lingcode.dev/install-cli.sh"))
      const body = yield* response.text
      const bodyBytes = new TextEncoder().encode(body)
      const version = target.startsWith("v") ? target : `v${target}`
      const result = yield* appProcess.run(
        ChildProcess.make("bash", [], {
          stdin: Stream.make(bodyBytes),
          env: { LINGCODE_TS_VERSION: version },
          extendEnv: true,
        }),
      )
      return {
        code: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      }
    }, Effect.orDie)

    // Windows curl-method upgrade. Can't pipe install-cli.ps1 to bash (no
    // bash) and can't re-run install-cli.ps1 in-place (it Remove-Item's the
    // install dir, which fails while lingcode.exe is the running process).
    // So download the zip → extract → rename live exe → move new in place.
    // Windows uniquely permits renaming an open .exe via MoveFile; the
    // running process keeps executing against the renamed `.old` file.
    const upgradeCurlWindows = Effect.fnUntraced(function* (target: string) {
      const result = yield* Effect.promise(async () => {
        try {
          // Pull the SAME variant the running binary was built as. Baseline
          // installs (older CPUs / VMs without AVX2) must keep fetching
          // baseline zips, otherwise the upgrade hands them a binary their
          // CPU can't execute (STATUS_ILLEGAL_INSTRUCTION). The build script
          // injects `OPENCODE_BASELINE` as a global string ("true"/"false");
          // dev builds without the define fall through to non-baseline.
          const baselineRaw = (globalThis as unknown as { OPENCODE_BASELINE?: unknown })
            .OPENCODE_BASELINE
          const baseline = typeof baselineRaw === "string" && baselineRaw === "true"
          const arch =
            process.arch === "arm64" ? "arm64" : baseline ? "x64-baseline" : "x64"
          const version = target.startsWith("v") ? target : `v${target}`
          // Linux/Windows binaries are served from GitHub Releases (versioned
          // asset under the release tag); macOS still uses the lingcode.dev Swift
          // tarball. Override with LINGCODE_TARBALL_URL for a custom mirror.
          const url =
            process.env["LINGCODE_TARBALL_URL"] ??
            `https://github.com/Xavierhuang/lingcode_windows_cli/releases/download/${version}/lingcode-windows-${arch}-${version}.zip`

          const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } })
          if (!res.ok) {
            return { code: 1, stdout: "", stderr: `Could not download ${url}: HTTP ${res.status}` }
          }
          const bytes = new Uint8Array(await res.arrayBuffer())

          const os = await import("os")
          const fsMod = await import("fs/promises")
          const cp = await import("child_process")

          const tmpDir = path.join(os.tmpdir(), `lingcode-upgrade-${Date.now()}`)
          await fsMod.mkdir(tmpDir, { recursive: true })
          const zipPath = path.join(tmpDir, "lingcode.zip")
          await fsMod.writeFile(zipPath, bytes)

          // Expand-Archive ships with Windows PowerShell 5.1+. Single quotes
          // around paths inside -Command handle spaces in %TMP% (e.g.
          // "C:\Users\My Name\AppData\Local\Temp").
          const expand = cp.spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          )
          if (expand.status !== 0) {
            return {
              code: expand.status ?? 1,
              stdout: expand.stdout?.toString("utf8") ?? "",
              stderr: expand.stderr?.toString("utf8") ?? "Expand-Archive failed",
            }
          }

          // Two known zip layouts: build.ts produces
          // `lingcode-windows-{arch}/bin/lingcode.exe`; older artifacts are
          // flatter. Probe each.
          const candidates = [
            path.join(tmpDir, `lingcode-windows-${arch}`, "bin", "lingcode.exe"),
            path.join(tmpDir, `lingcode-windows-${arch}-baseline`, "bin", "lingcode.exe"),
            path.join(tmpDir, "bin", "lingcode.exe"),
            path.join(tmpDir, "lingcode.exe"),
          ]
          let newExe: string | undefined
          for (const c of candidates) {
            try {
              await fsMod.access(c)
              newExe = c
              break
            } catch {
              // probe next
            }
          }
          if (!newExe) {
            return {
              code: 1,
              stdout: "",
              stderr: `lingcode.exe not found in archive; tried: ${candidates.join(", ")}`,
            }
          }

          const live = process.execPath
          const oldPath = `${live}.old`
          // Best-effort cleanup of any prior .old left over from a previous
          // upgrade. If the OS still holds a lock on it, ignore.
          await fsMod.unlink(oldPath).catch(() => null)
          await fsMod.rename(live, oldPath)
          await fsMod.copyFile(newExe, live)

          // Tidy temp dir; leave .old behind — Windows only releases the
          // file lock once the current process exits.
          await fsMod.rm(tmpDir, { recursive: true, force: true }).catch(() => null)

          return { code: 0, stdout: `Upgraded to ${version}.`, stderr: "" }
        } catch (err) {
          return {
            code: 1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
          }
        }
      })
      return result
    }, Effect.orDie)

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".lingcode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        // Windows install via install-cli.ps1 lands the .exe in
        // %LOCALAPPDATA%\Programs\lingcode\lingcode.exe — treat that as the
        // "curl" (binary self-update) method.
        if (
          process.platform === "win32" &&
          process.execPath.toLowerCase().includes(path.join("programs", "lingcode").toLowerCase())
        ) {
          return "curl" as Method
        }
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "lingcode"]) },
          { name: "scoop", command: () => text(["scoop", "list", "lingcode"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "lingcode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName =
            check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "lingcode" : "lingcode-ai"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get("https://formulae.brew.sh/api/formula/opencode.json").pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              `${yield* NpmConfig.registry(process.cwd())}/lingcode-ai/${InstallationChannel}`,
            ).pipe(HttpClientRequest.acceptJson),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
          return data.d.results[0].Version
        }

        if (detectedMethod === "scoop") {
          const response = yield* httpOk.execute(
            HttpClientRequest.get(
              "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
            ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
          return data.version
        }

        // For curl + unknown installs, try the small lingcode.dev manifest
        // first — cheaper than GitHub's rate-limited API and the natural
        // source of truth for the binaries we host ourselves.
        const manifest = yield* httpOk
          .execute(
            HttpClientRequest.get("https://lingcode.dev/cliv2-latest.json").pipe(HttpClientRequest.acceptJson),
          )
          .pipe(
            Effect.flatMap((response) => HttpClientResponse.schemaBodyJson(LingcodeManifest)(response)),
            Effect.catch(() => Effect.succeed(null)),
          )
        if (manifest) return manifest.version.replace(/^v/, "")

        const response = yield* httpOk.execute(
          HttpClientRequest.get(
            "https://api.github.com/repos/Xavierhuang/lingcode_windows_cli/releases/latest",
          ).pipe(HttpClientRequest.acceptJson),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult =
              process.platform === "win32" ? yield* upgradeCurlWindows(target) : yield* upgradeCurl(target)
            break
          case "npm":
            upgradeResult = yield* run(["npm", "install", "-g", `lingcode-ai@${target}`])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", `lingcode-ai@${target}`])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", `lingcode-ai@${target}`])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
              if (tap.code !== 0) {
                upgradeResult = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  upgradeResult = pull
                  break
                }
              }
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            upgradeResult = yield* run(["choco", "upgrade", "lingcode", `--version=${target}`, "-y"])
            break
          case "scoop":
            upgradeResult = yield* run(["scoop", "install", `opencode@${target}`])
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          const stderr = m === "choco" ? "not running from an elevated command shell" : upgradeResult?.stderr || ""
          return yield* new UpgradeFailedError({ stderr })
        }
        log.info("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
