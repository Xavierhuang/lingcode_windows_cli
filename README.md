<p align="center">
  <a href="https://lingcode.dev">
    <strong>LingCode CLI v2</strong>
  </a>
</p>
<p align="center">Cross-platform AI coding agent for Linux + Windows.</p>

---

## What this is

LingCode v0.9.x is the **Linux and Windows** build of the `lingcode` CLI.
On macOS, `lingcode` is a separate Swift binary that integrates with the
LingCode.app IDE over Unix-socket IPC — that's a different codebase, in
`../LingCodeCLI/`. This codebase (LingCodeCLIv2) is forked from
[opencode](https://github.com/sst/opencode) (MIT) and stripped down to
the CLI feature set we need: multi-provider chat, tools, MCP, HTTP serve,
ACP, and the lingcode-specific provider profiles (LingModel, GLM/z.ai,
Moonshot, plus the 13 OpenAI-compat providers opencode already ships).

Forked at opencode commit `<see UPSTREAM.md>`, fork date 2026-05-17.
License: MIT (LICENSE preserved upstream attribution).

## Install (end-user)

### Linux

```sh
curl -fsSL https://lingcode.dev/install-cli.sh | sh
```

Detects glibc vs musl, downloads the right Bun-compiled binary, drops the
symlink at `~/.local/bin/lingcode`. Reopen your shell or `source ~/.bashrc`
to pick up the PATH change if it wasn't already configured.

### Windows

```powershell
iwr -useb https://lingcode.dev/install-cli.ps1 | iex
```

Installs to `%LOCALAPPDATA%\Programs\lingcode\`, adds it to the User PATH,
broadcasts a settings-change event so new terminals see the change without
reboot. The binary is unsigned in v0.9.x — Windows Defender SmartScreen
will warn on first run; click "More info" → "Run anyway".

### macOS

Don't use this codebase. The Mac CLI ships separately from `LingCodeCLI/`
in this repo, with full LingCode.app integration. Run the Mac installer:

```sh
curl -fsSL https://lingcode.dev/install-cli.sh | sh    # same script, branches on OS
```

## Quickstart

```sh
# Sign in to one or more providers (browser-based for OAuth, paste-token for API keys)
lingcode providers login

# Headless one-shot
lingcode run "explain this directory"

# Interactive TUI
lingcode

# HTTP server (bearer-token gated)
lingcode serve

# Agent Client Protocol server (for IDE integrations)
lingcode acp
```

For **LingModel** (the managed lingcode.dev provider, free + Pro tiers):

```sh
# Get a token at https://lingcode.dev/cli-token.html (token starts with lcat_)
lingcode providers login    # pick "LingModel" from the list

# Then call it like any other provider
lingcode run --provider lingmodel --model lingmodel-standard "ping"
```

LingModel exposes a single model: `lingmodel-standard`. (All requests resolve
to the managed upstream server-side — the former pro/advanced/fast tiers were
identical and have been consolidated.)

## Build (developer)

Requires Bun 1.3+. From a fresh clone:

```sh
bun install                                     # postinstall fetches opentui native variants
bun run --cwd packages/lingcode dev --help      # boots in dev mode (no compile)

# Cross-platform binaries (12 targets — darwin/linux/windows, x64/arm64, glibc/musl)
cd packages/lingcode
bun run script/build.ts --skip-embed-web-ui --skip-install
```

Output lands in `packages/lingcode/dist/lingcode-<os>-<arch>{,-musl}/bin/lingcode{,.exe}`.

For the ship pipeline (zip + rsync to lingcode.dev), see scripts in
[`../../LingCode-main-2/scripts/`](../scripts/) once they're wired for v2.

## What's NOT here (Mac feature gaps)

The Mac Swift CLI has these and the v0.9.x Linux/Windows CLI doesn't yet:

- `lingcode build "..."` — Cosine/Genie-style autonomous bootstrap
- RTK (Rust Token Killer) — transparent bash command rewriting for token savings
- `lingcode-memory` MCP tool — memory_save / skill_propose / session_search
- Tier-aware pre-flight error UX (currently the proxy returns 402; CLI surfaces it as a generic error)
- LingCode.app IPC integration — Mac-only by definition; not coming to Linux/Windows
- App icon generator, embedded simulator, Xcode-project generator — Mac-only

These are tracked in `STATUS.md` (`## What's still NOT wired`).

## Architecture

This is a Bun monorepo. The packages that survive after the anti-feature
strip (12 deletions during the fork):

| Package | What it does |
|---|---|
| `packages/lingcode/` | The CLI itself. Subcommands, REPL, TUI |
| `packages/core/` | Agent runtime, filesystem, model catalog injection |
| `packages/llm/` | Provider abstraction (Anthropic, OpenAI, OpenAI-compat, etc.) |
| `packages/ui/` | TUI components (uses opentui-solid) |
| `packages/app/` | Embedded web UI (Bun-compiled into the binary as static assets) |
| `packages/plugin/` | Plugin loader and hooks |
| `packages/sdk/` | TypeScript SDK (consumed by external integrations) |
| `packages/script/` | Build pipeline (@lingcode-ai/script) |
| `packages/http-recorder/` | Test utility for recording HTTP interactions |

The 12 packages we deleted from upstream opencode are listed in STATUS.md.

## Contributing

Open PRs, bugs, feature requests at [github.com/Xavierhuang/LingCode](https://github.com/Xavierhuang/LingCode).

Before working on anything bigger than a typo, check `STATUS.md` for what's
currently broken or partially wired — there's a lot of in-flight work and
some pipeline steps (e.g., `lingcode upgrade`) are intentionally neutralized
in v0.9.x.

## Attribution

This codebase is a fork of [opencode](https://github.com/sst/opencode) by SST.
Upstream is MIT-licensed; we preserved the LICENSE file unchanged. Many of
the patterns here — the provider abstraction, the Effect framework usage,
the build pipeline — are theirs. We added the lingcode-specific provider
profiles, branding pass, telemetry heartbeat, and Windows/Linux distribution
packaging. See `UPSTREAM.md` for the exact commit we forked from and the
upstream-merge protocol.
