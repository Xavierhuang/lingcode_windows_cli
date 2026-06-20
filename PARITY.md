# Swift CLI ↔ Windows/Linux CLI — Parity Matrix

Comparison of the macOS **Swift CLI** (`../LingCode/LingCodeCLI/`) against this
**Linux + Windows CLI** (LingCodeCLIv2, forked from opencode). These are two
**separate codebases**, not two builds of one binary — so "parity" is per-workflow,
not a single yes/no. Each side leads in some areas and trails in others.

See also: `README.md` ("What's NOT here") and `STATUS.md` ("What's still NOT wired")
for the canonical gap list. This file expands those with per-workflow detail and
file references, generated 2026-06-19.

> Architecture in one line: **Swift is key/IPC-centric and scripting-first**;
> **this CLI is SDK/server-centric and TUI-first**.

---

## Summary

| Workflow | Parity | One-line verdict |
|---|---|---|
| ACP server | ~95% | Effectively interchangeable; both ACP v1 over stdio, target Zed |
| run / ask headless | Divergent | Swift more scriptable; this CLI has cleaner `provider/model` resolution |
| serve HTTP | ~70% | Bigger REST API here; bearer auth + `--workspace-root` + `--max-concurrent` now matched (rc15) |
| auth / providers | ~90% | Multi-account + encrypted export/import now in this CLI; on-disk formats still differ |
| mcp | Partial | Swift has a registry; this CLI has OAuth + now the `lingcode-memory` tool (rc15) |
| plugin | Moderate | Different packaging (symlink dirs vs npm packages) |
| Bridge / IPC | ~10% | Mac-only by design; not coming to Linux/Windows |

---

## 1. Auth — `auth` (Swift) vs `providers` (this CLI)

**Verdict: ⚠️ Partial. Same LingModel token + env var, but credentials are NOT portable across platforms.**

| Item | Swift `auth` | This CLI `providers` (alias `auth`) |
|---|---|---|
| Subcommands | login, set, get, delete, status, list, **use**, **export**, **import** | login, list, logout |
| API key paste | ✅ | ✅ |
| Env-var fallback | ✅ | ✅ |
| OAuth | Device flow (lingmodel only) | Plugin auth hooks (generic) |
| LingModel token | `lcat_` + `LINGCODE_CLI_TOKEN` + **browser device flow** | `lcat_` + `LINGCODE_CLI_TOKEN`, **paste only** |
| LingModel portal | `https://lingcode.dev/cli-token.html` | `https://lingcode.dev/cli-token.html` |
| Storage (macOS) | Keychain `com.lingcode.api-keys` | N/A (this CLI is Linux/Windows) |
| Storage (Linux) | `~/.config/lingcode/keys.json` (nested by service) | `~/.lingcode/auth.json` (flat, provider-keyed) |
| Multi-account labels | ✅ `auth use --account` | ❌ |
| Encrypted export/import | ✅ (AES-GCM, password-derived) | ❌ |
| Org/workspace mgmt | ❌ | ✅ `console login/logout/switch/orgs/open` |

**Gaps in this CLI:** `set/get/delete/use` subcommands, multi-account labels,
encrypted export/import, device-flow OAuth for LingModel.
**Gaps in Swift:** org/workspace management, plugin-supplied auth hooks,
well-known provider federation (`providers login <url>`).

**Portability note:** storage formats differ — switching machines means
re-authenticating. No automatic migration today.

File refs:
- Swift: `Sources/lingcode/Commands/Auth.swift`, `AuthMigrate.swift`, `CLIDeviceFlow.swift`, `SecretStore.swift`
- This CLI: `packages/lingcode/src/cli/cmd/providers.ts`, `account.ts`, `src/provider/provider.ts`, `src/auth/index.ts`

---

## 2. Headless one-shot — `ask` (Swift) vs `run` (this CLI)

**Verdict: ⚠️ Divergent. Swift is scripting-first with many knobs; this CLI is TUI-first and delegates to its SDK/server.**

| Item | Swift `ask` | This CLI `run` |
|---|---|---|
| Model selection | `--claude-model`, `--model`, `--provider` | `--model provider/model` (unified) |
| Provider resolution | 3 code paths (Claude / OpenAI-compat / Codex), 16+ providers | 1 unified SDK abstraction |
| Output formats | text, json, **stream-json** (typed events), `--verbose` | default, json (raw SDK event stream) |
| Session continue/resume | `--continue`, `--resume`, `--fork-from` | `--continue`, `--session`, `--fork` |
| Session store | local, per-provider | server-side via SDK |
| Tool gating | `--allowed-tools` / `--disallowed-tools` (client-side) | `--dangerously-skip-permissions` (binary) |
| Permission modes | 4 (`default/acceptEdits/plan/dontAsk`) + `--yolo` | binary auto-approve |
| Extended thinking | `--thinking` (Claude only) | `--thinking` (provider-agnostic) |
| Attachments | `--file`, `--image` | `--file` (multi), no `--image` |
| Extras | cost display, retry/backoff, `--system-prompt`, `--max-turns`, `--base-url`, `--timeout`, Codex provider, `--via-daemon` | delegated to SDK/server |

**Swift leads:** scripting ergonomics — typed stream-json, tool allow/deny lists,
fine-grained permission modes, cost/token reporting, retry, custom endpoints, Codex.
**This CLI leads:** cleaner `provider/model` resolution, simpler session UX
(server-side, `--fork` as its own flag), single provider abstraction.

File refs:
- Swift: `Sources/lingcode/Commands/Ask.swift`, `HeadlessClaude.swift`, `HeadlessCodex.swift`, `HeadlessOpenAICompat.swift`, `KnownTools.swift`
- This CLI: `packages/lingcode/src/cli/cmd/run.ts`, `run/`

---

## 3. serve + acp

### ACP — ✅ ~95% parity (effectively interchangeable)

Both implement **ACP v1**, JSON-RPC 2.0 over stdin/stdout (newline-delimited),
target **Zed**, and accept `--agent` / `--cwd`. Core methods match: `initialize`,
`session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`.
Swift documents `fs/*` and `terminal/*` as deferred; this CLI covers them via its
wider server API.

### serve (HTTP) — ⚠️ ~40% parity (different shape)

| Item | Swift | This CLI |
|---|---|---|
| API surface | ~14 focused endpoints (`/v1/agent/ask` SSE, `/v1/workspace/*`, …) | 30+ route groups (Config/Session/Mcp/Provider/Pty/Sync/Tui/…) |
| Auth | **Bearer token** (`~/.lingcode/server.token`, constant-time compare) | **Basic auth** (`OPENCODE_SERVER_PASSWORD`) |
| Project scoping | `--workspace-root` sandboxing | per-request `x-opencode-directory` header |
| Bind / port | `--bind 127.0.0.1`, `--port 7878`, `--allow-remote` | `--hostname`, `--port 0` (auto), `--mdns` |
| Concurrency | `--max-concurrent` (429 on overflow) | ✅ `--max-concurrent` (429 on overflow) |
| CORS | `--web-origin` (repeatable) | `--cors` (repeatable) + mDNS |
| Service discovery | ❌ | ✅ mDNS |

**At parity now:** bearer auth (accepted alongside Basic), `--workspace-root` sandboxing,
and the `--max-concurrent` 429 limiter all landed in this CLI (rc15).
**Swift still leads:** a tighter, smaller documented surface.
**This CLI leads:** far larger REST surface, mDNS discovery.

### Bridge / IPC — ~10% parity (Mac-only by design)

Swift has a Unix-socket **IPC layer to LingCode.app** (`ipc.sock`: ping/open/status/ask/watch)
and an optional warm **bridge daemon** (`lingcode bridge daemon-start`,
`serve --bridge-daemon`) for cold-start pooling. This CLI has **neither** — there is
no GUI app on Linux/Windows, and the HTTP server is its pooling mechanism. This gap
is intentional and **not slated to close**.

File refs:
- Swift: `Sources/lingcode/Commands/Serve.swift`, `AcpServe.swift`, `Bridge.swift`, `IPCClient.swift`, `Sources/LingCodeIPC/IPCProtocol.swift`
- This CLI: `packages/lingcode/src/cli/cmd/serve.ts`, `acp.ts`, `src/server/`, `src/acp/`

---

## 4. mcp + plugin

### mcp — ⚠️ Partial / asymmetric

| Item | Swift | This CLI |
|---|---|---|
| Subcommands | `search`, `install`, `list`, `remove` | `add`, `list`, `auth`, `logout`, `debug` |
| Discovery | curated registry (8 servers) + search | manual `add` only |
| Transports | stdio (via command/args) | stdio + **HTTP** (StreamableHTTP) |
| OAuth | ❌ (token in generic config) | ✅ `mcp auth` / `logout` / `debug` |
| Role | client only | client only |
| Config | `.mcp.json`, `~/.claude.json` | `opencode.json(c)`, `auth.json` |
| `lingcode-memory` tool | ✅ present (memory_save / skill_propose / session_search) | ✅ present (rc15) — memory_save / memory_remove / skill_propose / session_search, file-backed |

Neither acts as an MCP **server**. The `lingcode-memory` tool is now present on both
sides (file-backed here vs IPC-backed on Mac).

### plugin — Moderate parity

Both support list / install / remove plus a hook system. Packaging differs:
Swift uses symlinked `.claude/plugins/<name>/` manifest directories (JSON manifest
with commands/agents/output-styles/hooks); this CLI uses **npm packages** with
`package.json` exports (`./server`, `./tui`) and a richer runtime `Hooks` interface.

File refs:
- Swift: `Sources/lingcode/Commands/MCP.swift`, `Plugin.swift`
- This CLI: `packages/lingcode/src/cli/cmd/mcp.ts`, `plug.ts`, `packages/plugin/`

---

## Gaps closed on Linux/Windows (shipped in v0.9.0-rc15, 2026-06-20)

Implemented in this CLI to match the Swift behavior:

- **`serve --max-concurrent` 429 limiter** — outer HTTP middleware tracking
  in-flight requests; over-limit requests get an immediate HTTP 429 instead of
  queueing. Unset / `<= 0` = unlimited. Verified: burst of 8 at limit=2 →
  served 200s within limit, 429s over it.
  (`server/routes/instance/httpapi/concurrency.ts`, wired in `server/server.ts`,
  `LINGCODE_MAX_CONCURRENT` flag, `cli/cmd/serve.ts`)

- **`lingcode-memory` tools** — `memory_save` / `memory_remove` / `skill_propose` / `session_search`,
  registered as always-on builtins. File-backed instead of IPC-backed:
  `~/.lingcode/USER.md`, `<cwd>/.lingcode/memory.md`, `.lingcode/skills-drafts/<name>/`, and a
  glob+match over `storage/session/part/**` transcripts.
  (`packages/lingcode/src/tool/lingcode-memory.ts`, wired in `tool/registry.ts`)
- **Tier-aware 402 UX** — the LingModel proxy's quota 402 now surfaces actionable, vendor-neutral
  copy in both the streaming and `formatRunError` paths. (`cli/cmd/run.ts`)
- **Auth parity** — multi-account labels (`providers login --account <label>`, `providers use`)
  and encrypted `providers export` / `import` (AES-256-GCM, scrypt). (`cli/cmd/providers.ts`)
- **Serve hardening** — `Bearer` token accepted alongside `Basic`; `serve --workspace-root`
  sandboxes every request directory; inline `serve --password`.
  (`server/.../middleware/authorization.ts`, `.../workspace-routing.ts`, `cli/cmd/serve.ts`)

## Still Mac-only / open

- `lingcode build` — Cosine/Genie-style autonomous bootstrap (Phase 4, ~5–7 days)
- RTK (Rust Token Killer) — transparent bash rewriting (Phase 4, ~2 days; needs Rust cross-compile)
- LingCode.app IPC integration — **Mac-only by definition, not coming**
- App-icon generator, embedded simulator, Xcode-project generator — **Mac-only**
- Credential portability across the Swift `keys.json` ↔ this CLI's `auth.json` format
  (encrypted export/import now exists *within* this CLI, but the two on-disk formats still differ)

---

*Generated by cross-codebase exploration on 2026-06-19; refreshed 2026-06-20 for the
v0.9.0-rc15 release (memory tools, auth multi-account + encrypted export/import, serve
bearer/`--workspace-root`/`--max-concurrent`). Line-level refs were accurate at refresh
time; re-verify against current source before relying on them.*
