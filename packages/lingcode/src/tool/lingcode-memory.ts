// lingcode-memory — persistent file-backed memory + skill drafts + transcript
// search. This is the Linux/Windows port of the in-process MCP tools the macOS
// Swift CLI exposes via its agent-bridge (memory_save / memory_remove /
// skill_propose / session_search). On macOS those round-trip to LingCode.app
// over IPC so the IDE can render the write; there is no app here, so each tool
// writes directly to the same on-disk layout the Mac app uses:
//
//   user scope     → ~/.lingcode/USER.md          (facts that travel everywhere)
//   project scope  → <cwd>/.lingcode/memory.md    (facts about this codebase)
//   skill drafts   → <scope>/.lingcode/skills-drafts/<name>/SKILL.md
//
// Memory entries are upserted by their `## <title>` markdown section so the
// model can revise a fact in place rather than appending duplicates.

import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@lingcode-ai/core/filesystem"
import { Global } from "@lingcode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"

const SCOPES = ["user", "project"] as const
const TYPES = ["user", "feedback", "project", "reference"] as const

// ── shared helpers ──────────────────────────────────────────────────────────

function userMemoryFile() {
  return path.join(Global.Path.home, ".lingcode", "USER.md")
}

function projectMemoryFile(directory: string) {
  return path.join(directory, ".lingcode", "memory.md")
}

// Split a memory document into `## <title>` sections. The preamble (anything
// before the first header) is returned under the empty-string key so we can
// preserve it on rewrite.
function parseSections(doc: string): Array<{ title: string; body: string }> {
  const lines = doc.split(/\r?\n/)
  const sections: Array<{ title: string; body: string }> = []
  let current: { title: string; body: string[] } | null = null
  const preamble: string[] = []
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (current) sections.push({ title: current.title, body: current.body.join("\n") })
      current = { title: match[1], body: [] }
      continue
    }
    if (current) current.body.push(line)
    else preamble.push(line)
  }
  if (current) sections.push({ title: current.title, body: current.body.join("\n") })
  const out: Array<{ title: string; body: string }> = []
  const pre = preamble.join("\n").trim()
  if (pre) out.push({ title: "", body: pre })
  return out.concat(sections)
}

function renderSections(sections: Array<{ title: string; body: string }>): string {
  const blocks = sections.map((s) => (s.title === "" ? s.body.trim() : `## ${s.title}\n\n${s.body.trim()}`))
  return blocks.join("\n\n").trim() + "\n"
}

// ── memory_save ─────────────────────────────────────────────────────────────

export const MemorySaveParameters = Schema.Struct({
  scope: Schema.Literals(SCOPES).annotate({
    description: '"project" for facts about this codebase, "user" for facts that travel across all projects.',
  }),
  type: Schema.Literals(TYPES).annotate({
    description:
      "Category tag: user (who they are), feedback (how to work), project (project context), reference (external systems).",
  }),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
    description: "Short section title — becomes the markdown `## <title>` header. A section with the same title is replaced.",
  }),
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({
    description:
      "The memory body. Plain markdown. Lead with the rule/fact; for feedback include a short Why; for project include a How-to-apply.",
  }),
})

export const MemorySaveTool = Tool.define(
  "memory_save",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description:
        "Save or update a single memory entry. Picks the file based on `scope`: \"project\" → <cwd>/.lingcode/memory.md, " +
        "\"user\" → ~/.lingcode/USER.md. Use this rather than write/edit on memory files so entries are upserted by title and size limits apply atomically.",
      parameters: MemorySaveParameters,
      execute: (params: { scope: (typeof SCOPES)[number]; type: (typeof TYPES)[number]; title: string; content: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = params.scope === "user" ? userMemoryFile() : projectMemoryFile(instance.directory)
          const existing = (yield* fs.readFileStringSafe(file)) ?? ""
          const sections = parseSections(existing)
          const body = `*[${params.type}]*\n\n${params.content.trim()}`
          const idx = sections.findIndex((s) => s.title.toLowerCase() === params.title.toLowerCase())
          const replaced = idx >= 0
          if (replaced) sections[idx] = { title: params.title, body }
          else sections.push({ title: params.title, body })
          yield* fs.writeWithDirs(file, renderSections(sections))
          const rel = file.startsWith(Global.Path.home) ? file.replace(Global.Path.home, "~") : file
          return {
            title: params.title,
            output: `✓ ${replaced ? "Updated" : "Saved"} memory '${params.title}' in ${rel}`,
            metadata: { file, scope: params.scope, replaced },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── memory_remove ───────────────────────────────────────────────────────────

export const MemoryRemoveParameters = Schema.Struct({
  scope: Schema.Literals(SCOPES).annotate({ description: "Which memory file to edit." }),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
    description: "Title of the section to remove. Matched case-insensitively.",
  }),
})

export const MemoryRemoveTool = Tool.define(
  "memory_remove",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description: "Remove a memory entry by section title from project or user memory.",
      parameters: MemoryRemoveParameters,
      execute: (params: { scope: (typeof SCOPES)[number]; title: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = params.scope === "user" ? userMemoryFile() : projectMemoryFile(instance.directory)
          const existing = yield* fs.readFileStringSafe(file)
          if (existing === undefined) {
            return { title: params.title, output: `✗ No memory file at ${file}`, metadata: { file, removed: false } }
          }
          const sections = parseSections(existing)
          const next = sections.filter((s) => s.title.toLowerCase() !== params.title.toLowerCase())
          const removed = next.length !== sections.length
          if (removed) yield* fs.writeWithDirs(file, renderSections(next))
          return {
            title: params.title,
            output: removed ? `✓ Removed memory '${params.title}'` : `✗ No section titled '${params.title}'`,
            metadata: { file, removed },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── skill_propose ───────────────────────────────────────────────────────────

export const SkillProposeParameters = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50), Schema.isPattern(/^[a-z0-9-]+$/)).annotate({
    description: 'Slug for the skill. Lowercase, hyphens only, e.g. "migrate-feature-flag". Becomes the directory name and slash-command.',
  }),
  scope: Schema.Literals(SCOPES).annotate({
    description: '"project" if the procedure is specific to this codebase, "user" if it generalizes across all your work.',
  }),
  description: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(200)).annotate({
    description: "One-line summary shown when the user types `/`. Explain when to invoke the skill.",
  }),
  body: Schema.String.check(Schema.isMinLength(50), Schema.isMaxLength(8000)).annotate({
    description:
      "The skill prompt — the instructions a future invocation gives the agent. Write in second person. Be concrete. Do not include YAML frontmatter; it is added for you.",
  }),
})

export const SkillProposeTool = Tool.define(
  "skill_propose",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description:
        "Propose a NEW reusable skill (slash-command) based on a procedure you just executed. Drafts are saved under " +
        ".lingcode/skills-drafts/<name>/SKILL.md (project) or ~/.lingcode/skills-drafts/<name>/SKILL.md (user) and do NOT activate until the user promotes them.",
      parameters: SkillProposeParameters,
      execute: (params: { name: string; scope: (typeof SCOPES)[number]; description: string; body: string }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = params.scope === "user" ? Global.Path.home : instance.directory
          const file = path.join(root, ".lingcode", "skills-drafts", params.name, "SKILL.md")
          if (yield* fs.existsSafe(file)) {
            return { title: params.name, output: `✗ A draft named '${params.name}' already exists at ${file}`, metadata: { file, written: false } }
          }
          const frontmatter = ["---", `name: ${params.name}`, `description: ${params.description}`, "---", ""].join("\n")
          yield* fs.writeWithDirs(file, frontmatter + params.body.trim() + "\n")
          return {
            title: params.name,
            output: `✓ Proposed skill draft '${params.name}' at ${file}. Promote it from skills-drafts/ to skills/ to activate.`,
            metadata: { file, written: true },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── session_search ──────────────────────────────────────────────────────────

export const SessionSearchParameters = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Words to search for across past session transcripts. All words must appear (AND). Case-insensitive.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20))).annotate({
    description: "Maximum number of hits to return. Default 5.",
  }),
})

export const SessionSearchTool = Tool.define(
  "session_search",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description:
        "Full-text search across past session transcripts stored on this machine. Returns matching snippets with their session id " +
        'and the directory the session ran in. Use when the user references prior work ("the bug we hit last week", "did I already fix Y").',
      parameters: SessionSearchParameters,
      execute: (params: { query: string; limit?: number }, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const limit = params.limit ?? 5
          const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean)
          // Part files hold the actual message text:
          // <data>/storage/session/part/<sessionID>/<messageID>/<partID>.json
          const partFiles = yield* fs
            .glob("storage/session/part/*/*/*.json", { cwd: Global.Path.data, absolute: true, dot: true })
            .pipe(Effect.orElseSucceed(() => [] as string[]))

          // Resolve each session's directory once for context in the results.
          const dirCache = new Map<string, string | undefined>()
          const sessionDir = (sessionID: string) =>
            Effect.gen(function* () {
              if (dirCache.has(sessionID)) return dirCache.get(sessionID)
              const infos = yield* fs
                .glob(`storage/session/info/${sessionID}.json`, { cwd: Global.Path.data, absolute: true, dot: true })
                .pipe(Effect.orElseSucceed(() => [] as string[]))
              let dir: string | undefined
              const raw = infos[0] ? yield* fs.readFileStringSafe(infos[0]) : undefined
              if (raw) {
                try {
                  dir = JSON.parse(raw).directory
                } catch {}
              }
              dirCache.set(sessionID, dir)
              return dir
            })

          const hits: Array<{ sessionID: string; dir?: string; snippet: string }> = []
          for (const f of partFiles) {
            if (hits.length >= limit) break
            const raw = yield* fs.readFileStringSafe(f)
            if (!raw) continue
            let text = ""
            try {
              const parsed = JSON.parse(raw)
              if (parsed?.type !== "text" || typeof parsed.text !== "string") continue
              text = parsed.text
            } catch {
              continue
            }
            const lower = text.toLowerCase()
            if (!terms.every((t) => lower.includes(t))) continue
            const sessionID = path.basename(path.dirname(path.dirname(f)))
            const at = lower.indexOf(terms[0])
            const snippet = text.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, " ").trim()
            hits.push({ sessionID, dir: yield* sessionDir(sessionID), snippet })
          }

          if (hits.length === 0) {
            return { title: params.query, output: `No matches for: ${params.query}`, metadata: { count: 0 } }
          }
          const lines = hits.map((h, i) => `${i + 1}. session=${h.sessionID}${h.dir ? ` cwd=${h.dir}` : ""}\n   …${h.snippet}…`)
          return { title: params.query, output: lines.join("\n\n"), metadata: { count: hits.length } }
        }).pipe(Effect.orDie),
    }
  }),
)

export const LingcodeMemoryTools = [
  MemorySaveTool,
  MemoryRemoveTool,
  SkillProposeTool,
  SessionSearchTool,
]
