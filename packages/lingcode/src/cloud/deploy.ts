import path from "path"
import os from "os"
import fs from "fs/promises"
import { spawn } from "child_process"
import { apiBase, errMsg } from "./cloud"

/**
 * Deploy a built frontend to LingCode Cloud hosting (*.lingcode.app for static
 * SPAs, *.run.lingcode.dev for Workers/SSR). Ported from the macOS
 * CloudDeployService: detect → build → tar.gz → upload → (poll) → URL.
 *
 * Progress is reported through an `emit` callback as discrete events so callers
 * can render them however they like (the CLI prints NDJSON for the Zed GPUI
 * panel to parse, or a human-readable spinner log).
 */

export type DeployEvent =
  | { phase: "detect"; pm: string; outDir: string; build: string | null; worker: boolean }
  | { phase: "build"; line: string }
  | { phase: "package"; bytes: number }
  | { phase: "upload"; status: "start" | "done"; mode: "create" | "update" }
  | { phase: "poll"; jobId: string }
  | { phase: "done"; id: string; url: string }
  | { phase: "error"; message: string }

export interface DeployOptions {
  cwd: string
  title?: string
  worker?: boolean
  emit: (e: DeployEvent) => void
}

interface DeployState {
  appId?: string
  workerId?: string
  url?: string
}

interface DeployPlan {
  pm: string
  buildCommand: string | null
  outDir: string
}

const stateFile = (cwd: string) => path.join(cwd, ".lingcode", "deploy.json")

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readState(cwd: string): Promise<DeployState> {
  try {
    return JSON.parse(await fs.readFile(stateFile(cwd), "utf8")) as DeployState
  } catch {
    return {}
  }
}

async function writeState(cwd: string, state: DeployState): Promise<void> {
  await fs.mkdir(path.join(cwd, ".lingcode"), { recursive: true })
  await fs.writeFile(stateFile(cwd), JSON.stringify(state, null, 2) + "\n")
}

/** Mirror of CloudDeployService project-type detection. */
async function detect(cwd: string): Promise<DeployPlan> {
  let pkg: any = {}
  try {
    pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"))
  } catch {}

  const has = (f: string) => exists(path.join(cwd, f))
  const pm = (await has("bun.lock")) || (await has("bun.lockb")) || (await has("bunfig.toml"))
    ? "bun"
    : (await has("pnpm-lock.yaml"))
      ? "pnpm"
      : (await has("yarn.lock"))
        ? "yarn"
        : "npm"

  const deps: Record<string, unknown> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const dep = (n: string) => n in deps
  let outDir = "dist"
  if (dep("@tanstack/react-start") || dep("@cloudflare/vite-plugin")) outDir = "dist/client"
  else if (dep("next")) outDir = "out"
  else if (dep("vite")) outDir = "dist"
  else if (dep("svelte") || dep("@sveltejs/kit")) outDir = "build"
  else if (dep("nuxt")) outDir = ".output/public"
  else if (dep("vue")) outDir = "dist"
  else if (dep("react-scripts") || dep("react")) outDir = "build"

  const buildCommand = pkg?.scripts?.build ? `${pm} install && ${pm} run build` : null
  return { pm, buildCommand, outDir }
}

/** Augment PATH so common JS toolchain bins resolve regardless of how Zed/CLI was launched. */
function augmentedEnv(): NodeJS.ProcessEnv {
  const home = os.homedir()
  const extra = [
    "./node_modules/.bin",
    path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".local/bin"),
    path.join(home, "Library/pnpm"),
    path.join(home, ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const sep = process.platform === "win32" ? ";" : ":"
  return {
    ...process.env,
    COPYFILE_DISABLE: "1", // exclude macOS AppleDouble (._*) from tar
    PATH: [...extra, process.env.PATH ?? ""].join(sep),
  }
}

function runShell(cwd: string, command: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: augmentedEnv() })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, 10 * 60 * 1000)
    const pump = (buf: Buffer) =>
      String(buf)
        .split(/\r?\n/)
        .forEach((l) => l.length && onLine(l))
    child.stdout?.on("data", pump)
    child.stderr?.on("data", pump)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error("build timed out after 10 minutes"))
      code === 0 ? resolve() : reject(new Error(`build exited with code ${code}`))
    })
  })
}

/** tar.gz the output dir contents at archive root (static) or the dir itself (worker). */
function tarball(srcRoot: string, dirArg: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-czf", dest, "--exclude", "._*", "--exclude", ".DS_Store", "-C", srcRoot, dirArg]
    const child = spawn("tar", args, { env: augmentedEnv() })
    let stderr = ""
    child.stderr?.on("data", (b) => (stderr += String(b)))
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("tar failed: " + stderr.trim()))))
  })
}

async function upload(opts: {
  token: string
  endpoint: string
  mode: "create" | "update"
  id?: string
  title: string
  slug?: string
  body: Uint8Array<ArrayBuffer>
}): Promise<{ id: string; url?: string; jobId?: string }> {
  const url = opts.mode === "update" && opts.id ? `${opts.endpoint}/${opts.id}` : opts.endpoint
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    "content-type": "application/gzip",
    "x-app-title": encodeURIComponent(opts.title),
  }
  if (opts.slug && opts.mode === "create") headers["x-app-slug"] = opts.slug
  const res = await fetch(url, {
    method: opts.mode === "update" ? "PUT" : "POST",
    headers,
    body: new Blob([opts.body]),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 400)}`)
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; jobId?: string }
  if (!json.id) throw new Error("server did not return an app id")
  return { id: json.id, url: json.url, jobId: json.jobId }
}

async function pollWorkerJob(token: string, jobId: string): Promise<{ id: string; url: string }> {
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000))
    const res = await fetch(`${apiBase()}/api/account/cloud-workers/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    })
    if (!res.ok) continue
    const j = (await res.json().catch(() => ({}))) as { status?: string; id?: string; url?: string; message?: string }
    if (j.status === "success" && j.id && j.url) return { id: j.id, url: j.url }
    if (j.status === "failed") throw new Error(j.message ?? "worker deploy failed")
  }
  throw new Error("worker deploy timed out after 15 minutes")
}

export async function deploy(token: string, opts: DeployOptions): Promise<{ id: string; url: string }> {
  const { cwd, emit } = opts
  const worker = opts.worker ?? false
  const title = opts.title ?? path.basename(cwd)

  const plan = await detect(cwd)
  emit({ phase: "detect", pm: plan.pm, outDir: plan.outDir, build: plan.buildCommand, worker })

  if (plan.buildCommand) await runShell(cwd, plan.buildCommand, (line) => emit({ phase: "build", line }))

  const outAbs = path.resolve(cwd, worker ? "dist" : plan.outDir)
  if (!(await exists(outAbs))) throw new Error(`build output not found at ${outAbs}`)

  const tmp = path.join(os.tmpdir(), `lingcode-${worker ? "worker" : "app"}-${process.pid}-${Date.now()}.tgz`)
  if (worker) await tarball(path.dirname(outAbs), path.basename(outAbs), tmp)
  else await tarball(outAbs, ".", tmp)
  const body = new Uint8Array(await fs.readFile(tmp)) // copy into an ArrayBuffer-backed view for fetch/Blob
  await fs.rm(tmp, { force: true })
  emit({ phase: "package", bytes: body.byteLength })

  const prev = await readState(cwd)
  const existingId = worker ? prev.workerId : prev.appId
  const mode: "create" | "update" = existingId ? "update" : "create"
  const endpoint = `${apiBase()}/api/account/${worker ? "cloud-workers" : "cloud-apps"}`

  emit({ phase: "upload", status: "start", mode })
  const up = await upload({ token, endpoint, mode, id: existingId, title, body })
  emit({ phase: "upload", status: "done", mode })

  let result: { id: string; url: string }
  if (up.jobId) {
    emit({ phase: "poll", jobId: up.jobId })
    result = await pollWorkerJob(token, up.jobId)
  } else {
    if (!up.url) throw new Error("server did not return a deployment url")
    result = { id: up.id, url: up.url }
  }

  await writeState(cwd, { ...prev, ...(worker ? { workerId: result.id } : { appId: result.id }), url: result.url })
  emit({ phase: "done", id: result.id, url: result.url })
  return result
}

export { errMsg }
