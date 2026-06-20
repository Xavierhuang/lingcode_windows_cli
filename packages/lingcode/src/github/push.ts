import { spawn } from "child_process"
import { Octokit } from "@octokit/rest"
import { parseGitHubRemote } from "@/util/repository"

/**
 * Commit the current project and push it to GitHub, creating the repository
 * when the working tree has no GitHub `origin` remote yet. This is the engine
 * behind `lingcode github push` and the desktop IDE's one-button "Push to
 * GitHub" (which drives it via `--ndjson`).
 *
 * Mirrors `src/cloud/deploy.ts`: a plain async function that reports progress
 * through an `emit` callback as discrete events, so callers render them however
 * they like (NDJSON for the Zed GPUI modal, or a plain log for the terminal).
 */

export type PushEvent =
  | { phase: "detect"; hasRemote: boolean; owner: string | null; repo: string | null; branch: string }
  | { phase: "need_repo" }
  | { phase: "create_repo"; owner: string; repo: string; url: string }
  | { phase: "commit"; message: string; changed: number }
  | { phase: "push"; status: "start" | "done"; branch: string }
  | { phase: "done"; url: string; branch: string }
  | { phase: "error"; message: string }

export interface PushOptions {
  cwd: string
  /** `owner/repo` to create when there is no existing GitHub remote. */
  repo?: string
  /** Create the new repository as private (only used when creating). */
  private?: boolean
  /** Commit message; defaults to "Update from LingCode". */
  message?: string
  /** When set (and no `message` given), generate the commit message from the staged diff. */
  aiMessage?: boolean
  emit: (e: PushEvent) => void
}

/**
 * `need_repo` is returned (not thrown) when there is no GitHub remote and no
 * `repo` was provided — the IDE reacts by prompting for an owner/repo and
 * re-invoking with `--repo`.
 */
export type PushResult = { status: "need_repo" } | { status: "done"; url: string; branch: string }

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (b) => (stdout += String(b)))
    child.stderr?.on("data", (b) => (stderr += String(b)))
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function spawnCapture(cwd: string, cmd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (b) => (stdout += String(b)))
    child.stderr?.on("data", (b) => (stderr += String(b)))
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args)
  if (r.code !== 0) {
    const detail = (r.stderr.trim() || r.stdout.trim()).split("\n")[0] ?? ""
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
  return r.stdout.trim()
}

function splitRepo(input: string): { owner: string | null; name: string } {
  const trimmed = input.trim().replace(/\.git$/, "")
  const parts = trimmed.split("/").filter(Boolean)
  if (parts.length >= 2) return { owner: parts[parts.length - 2], name: parts[parts.length - 1] }
  return { owner: null, name: trimmed }
}

async function resolveCommitMessage(opts: PushOptions, cwd: string, changed: number): Promise<string> {
  if (opts.message?.trim()) return opts.message.trim()
  if (opts.aiMessage && changed > 0) {
    const generated = await generateAiMessage(cwd).catch(() => null)
    if (generated) return generated
  }
  return "Update from LingCode"
}

/**
 * Best-effort AI commit message: ask the LingCode agent for a one-line message
 * from the staged diff, reusing the working `lingcode run` one-shot (non-TTY
 * stdout prints the response text). Any failure returns null so the caller falls
 * back to the default message; this never blocks the push.
 */
async function generateAiMessage(cwd: string): Promise<string | null> {
  const diff = await git(cwd, ["diff", "--cached", "--no-color"])
  if (diff.code !== 0 || !diff.stdout.trim()) return null
  const capped = diff.stdout.length > 12_000 ? `${diff.stdout.slice(0, 12_000)}\n…(truncated)` : diff.stdout
  const prompt =
    "Write a single-line git commit message (imperative mood, max 72 characters, no surrounding " +
    "quotes, no body) summarizing the following staged diff. Reply with ONLY the message.\n\n" +
    capped

  const res = await spawnCapture(cwd, "lingcode", ["run", prompt])
  if (res.code !== 0) return null
  const line = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const cleaned = line.replace(/^["'`]+|["'`]+$/g, "").trim()
  return cleaned.length > 0 ? cleaned.slice(0, 100) : null
}

export async function push(token: string, opts: PushOptions): Promise<PushResult> {
  const { cwd, emit } = opts

  // 1. Ensure we are inside a git work tree.
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    await gitOk(cwd, ["init"])
  }

  // Resolve the branch we will push (fall back to "main" for an unborn HEAD).
  let branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  if (!branch || branch === "HEAD") branch = "main"

  // 2. Inspect the origin remote.
  const remoteRes = await git(cwd, ["remote", "get-url", "origin"])
  const remoteUrl = remoteRes.code === 0 ? remoteRes.stdout.trim() : ""
  let parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : null
  emit({
    phase: "detect",
    hasRemote: Boolean(remoteUrl),
    owner: parsed?.owner ?? null,
    repo: parsed?.repo ?? null,
    branch,
  })

  // 3. No GitHub remote and nothing to create with → ask the caller for a repo.
  if (!parsed && !opts.repo) {
    emit({ phase: "need_repo" })
    return { status: "need_repo" }
  }

  // 4. Create the repository when we have a target but no remote yet.
  if (!parsed && opts.repo) {
    const { owner, name } = splitRepo(opts.repo)
    const octo = new Octokit({ auth: token })
    const me = await octo.users.getAuthenticated()
    const login = me.data.login
    if (!owner || owner === login) {
      await octo.repos.createForAuthenticatedUser({ name, private: Boolean(opts.private) })
      parsed = { owner: login, repo: name }
    } else {
      await octo.repos.createInOrg({ org: owner, name, private: Boolean(opts.private) })
      parsed = { owner, repo: name }
    }
    await gitOk(cwd, ["remote", "add", "origin", `https://github.com/${parsed.owner}/${parsed.repo}.git`])
    emit({
      phase: "create_repo",
      owner: parsed.owner,
      repo: parsed.repo,
      url: `https://github.com/${parsed.owner}/${parsed.repo}`,
    })
  }

  // 5. Stage everything and commit when the tree is dirty.
  await gitOk(cwd, ["add", "-A"])
  const statusOut = (await git(cwd, ["status", "--porcelain"])).stdout.trim()
  const changed = statusOut ? statusOut.split("\n").length : 0
  const message = await resolveCommitMessage(opts, cwd, changed)
  if (changed > 0) {
    const idArgs: string[] = []
    if (!(await git(cwd, ["config", "user.name"])).stdout.trim()) {
      idArgs.push("-c", "user.name=LingCode")
    }
    if (!(await git(cwd, ["config", "user.email"])).stdout.trim()) {
      idArgs.push("-c", "user.email=lingcode@users.noreply.github.com")
    }
    await gitOk(cwd, [...idArgs, "commit", "-m", message])
  }
  emit({ phase: "commit", message, changed })

  // Nothing committed and no prior commit means there is nothing to push.
  if ((await git(cwd, ["rev-parse", "HEAD"])).code !== 0) {
    throw new Error("Nothing to commit and no existing commits to push.")
  }

  // 6. Push, authenticating https remotes with the token via an ephemeral
  //    header so we never mutate the user's git config. SSH remotes ignore it
  //    and use the user's keys.
  const cred = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")
  emit({ phase: "push", status: "start", branch })
  await gitOk(cwd, ["-c", `http.extraheader=AUTHORIZATION: basic ${cred}`, "push", "-u", "origin", `HEAD:${branch}`])
  emit({ phase: "push", status: "done", branch })

  // 7. Done.
  const url = `https://github.com/${parsed!.owner}/${parsed!.repo}`
  emit({ phase: "done", url, branch })
  return { status: "done", url, branch }
}
