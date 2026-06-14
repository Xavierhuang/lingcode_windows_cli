// Anonymous telemetry — daily heartbeat ({installId, version, os, arch}) to
// lingcode.dev. No prompts, no API keys, no file paths — only metadata.
//
// Opt out:   lingcode telemetry off
// State at:  ~/.config/lingcode/telemetry.json
//
// Mirrors the Swift TelemetryClient at
// LingCodeAgentCore/Sources/LingCodeAgentCore/Telemetry.swift so the Linux/
// Windows CLI's heartbeats land in the same /api/cli/heartbeat endpoint as
// Mac users'. Per-turn model events are NOT sent in this v1 — only the
// daily heartbeat.

import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir, platform, arch as nodeArch } from "node:os"
import { dirname, join } from "node:path"

const ENDPOINT = "https://lingcode.dev/api/cli/heartbeat"
const ONE_DAY_MS = 23 * 60 * 60 * 1000

interface Store {
  installId: string
  enabled: boolean
  lastHeartbeat: number | null
}

function storePath(): string {
  return join(homedir(), ".config", "lingcode", "telemetry.json")
}

async function loadStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(storePath(), "utf-8")
    const parsed = JSON.parse(raw)
    return {
      installId: typeof parsed.installId === "string" ? parsed.installId : randomUUID(),
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      lastHeartbeat: typeof parsed.lastHeartbeat === "number" ? parsed.lastHeartbeat : null,
    }
  } catch {
    return { installId: randomUUID(), enabled: true, lastHeartbeat: null }
  }
}

async function saveStore(s: Store): Promise<void> {
  try {
    await fs.mkdir(dirname(storePath()), { recursive: true })
    await fs.writeFile(storePath(), JSON.stringify(s, null, 2), { mode: 0o600 })
  } catch {
    // best-effort; never let telemetry break user sessions
  }
}

function currentOS(): string {
  const p = platform()
  if (p === "darwin") return "darwin"
  if (p === "linux") return "linux"
  if (p === "win32") return "windows"
  return p
}

function currentArch(): string {
  const a = nodeArch()
  if (a === "arm64") return "arm64"
  if (a === "x64") return "x86_64"
  return a
}

export async function setEnabled(enabled: boolean): Promise<void> {
  const s = await loadStore()
  s.enabled = enabled
  await saveStore(s)
}

export async function isEnabled(): Promise<boolean> {
  return (await loadStore()).enabled
}

export async function currentInstallId(): Promise<string> {
  return (await loadStore()).installId
}

/**
 * Send a heartbeat at most once per day. Idempotent — safe to call freely
 * from the CLI startup middleware. Fire-and-forget; network failures are
 * swallowed and never affect the user's session.
 */
export async function sendHeartbeatIfDue(version: string): Promise<void> {
  let s: Store
  try {
    s = await loadStore()
  } catch {
    return
  }
  if (!s.enabled) return
  const now = Date.now()
  if (s.lastHeartbeat !== null && now - s.lastHeartbeat < ONE_DAY_MS) return

  const body = {
    installId: s.installId,
    version,
    os: currentOS(),
    arch: currentArch(),
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)
  } catch {
    // Network down / endpoint missing / aborted — that's fine. Don't update
    // lastHeartbeat so we retry on the next run.
    return
  }

  s.lastHeartbeat = now
  await saveStore(s)
}
