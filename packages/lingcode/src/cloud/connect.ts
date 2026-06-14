import path from "path"
import fs from "fs/promises"
import crypto from "crypto"
import { apiBase, mcpUrl } from "./cloud"

/**
 * Connect a workspace to a LingCode Cloud managed backend.
 *
 * Unlike the macOS app (which writes a `.mcp.json` stdio entry pointing at a
 * bundled stdio↔HTTP proxy), the CLI's MCP layer speaks remote MCP natively and
 * already auto-loads `.lingcode/opencode.json` for every session — including the
 * `lingcode acp` agent the Zed fork launches. So we write a single `remote` MCP
 * entry there with the auth + project headers; no proxy and no ACP patch needed.
 * `.lingcode/` is auto-gitignored by the config loader, keeping the token out of
 * source control. We also write `.lingcode/project.json` for parity with the Mac
 * app's ProjectManifest so collaborators resolve the same backend.
 */

export const MCP_SERVER_NAME = "lingcode-cloud"

export interface ConnectResult {
  backendId: string
  projectId: string
  projectKey: string
}

/** Stable, path-derived project key: "proj_" + first 20 hex chars of sha256(absPath). */
export function projectKey(cwd: string): string {
  const abs = path.resolve(cwd)
  const hex = crypto.createHash("sha256").update(abs).digest("hex")
  return "proj_" + hex.slice(0, 20)
}

async function provision(token: string, key: string, label: string): Promise<{ backendId: string; projectId: string }> {
  const res = await fetch(`${apiBase()}/api/cloud/account/backends/provision`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ project_key: key, label }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`provision failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { backend_id?: string; project_id?: string } }
  const backendId = body.data?.backend_id
  const projectId = body.data?.project_id
  if (!backendId || !projectId) throw new Error("provision response missing backend_id/project_id")
  return { backendId, projectId }
}

async function readJsonObject(file: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export async function connect(token: string, cwd: string, label?: string): Promise<ConnectResult> {
  const key = projectKey(cwd)
  const { backendId, projectId } = await provision(token, key, label ?? path.basename(path.resolve(cwd)))

  const dir = path.join(cwd, ".lingcode")
  await fs.mkdir(dir, { recursive: true })

  // Merge the remote MCP server into .lingcode/opencode.json (auto-loaded by the CLI/ACP).
  const configFile = path.join(dir, "opencode.json")
  const config = await readJsonObject(configFile)
  config.mcp = config.mcp ?? {}
  config.mcp[MCP_SERVER_NAME] = {
    type: "remote",
    url: mcpUrl(),
    enabled: true,
    headers: {
      authorization: `Bearer ${token}`,
      "x-lingcode-project": key,
      "x-lingcode-project-id": projectId,
    },
  }
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + "\n")

  // ProjectManifest parity (path-independent identity for collaborators).
  await fs.writeFile(
    path.join(dir, "project.json"),
    JSON.stringify({ projectId, apiBase: apiBase() }, null, 2) + "\n",
  )

  return { backendId, projectId, projectKey: key }
}

export async function disconnect(cwd: string): Promise<boolean> {
  const dir = path.join(cwd, ".lingcode")
  const configFile = path.join(dir, "opencode.json")
  const config = await readJsonObject(configFile)
  let changed = false
  if (config.mcp && MCP_SERVER_NAME in config.mcp) {
    delete config.mcp[MCP_SERVER_NAME]
    if (Object.keys(config.mcp).length === 0) delete config.mcp
    await fs.writeFile(configFile, JSON.stringify(config, null, 2) + "\n")
    changed = true
  }
  await fs.rm(path.join(dir, "project.json"), { force: true })
  return changed
}
