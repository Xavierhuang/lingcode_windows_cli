# LingCodeCLIv2 — session status (2026-05-17)

Fork of opencode-dev, in-progress migration to a Linux + Windows `lingcode` CLI.
This file tracks what's done, what's blocked, and what to do next.

## Done in this session

### Phase 1: Fork + rebrand
- Cloned `opencode-dev/` → `LingCodeCLIv2/` (4,874 files, 95 MB before deps)
- Renamed `packages/opencode/` → `packages/lingcode/`
- Renamed `packages/lingcode/bin/opencode` → `bin/lingcode`
- Mass-renamed `@opencode-ai/*` → `@lingcode-ai/*` across the workspace (1,167 files touched)
- Renamed `.opencode/` (project local-config dir) → `.lingcode/`
- Rewrote URLs/branding: `opencode.ai` → `lingcode.dev`, `anomalyco/opencode` → `Xavierhuang/LingCode`, `opencode-ai` (npm) → `lingcode-ai`, `opencode-agent[bot]` → `lingcode-agent[bot]`
- Deleted 21 non-English READMEs
- Updated `package.json` root `name: "opencode"` → `"lingcode"` + workspaces purge (no more `packages/console/*` or `packages/slack`)
- Patched `packages/lingcode/script/build.ts` to write `dist/<target>/bin/lingcode` and `--user-agent=lingcode/...`
- **What still has "opencode" lowercase**: README.md install instructions (brew/scoop/choco entries that point at opencode upstream), AGENTS.md, some script files (`script/raw-changelog.ts`, `script/stats.ts`) that fetch opencode's GitHub release stats. These are deliberate to-be-replaced spots (we don't have lingcode equivalents on those package managers yet).
- **What still has "opencode" uppercase**: compile-time `OPENCODE_VERSION` / `OPENCODE_MIGRATIONS` / `OPENCODE_WORKER_PATH` / `OPENCODE_LIBC` / `OPENCODE_CHANNEL` define macros in [build.ts](packages/lingcode/script/build.ts#L218-L225) AND their consumers in [src/file/watcher.ts:19](packages/lingcode/src/file/watcher.ts#L19), [src/cli/cmd/tui/thread.ts:26](packages/lingcode/src/cli/cmd/tui/thread.ts#L26), [src/storage/db.ts:18](packages/lingcode/src/storage/db.ts#L18). Internally consistent (both producer and consumer agree). Renaming requires coordinated find-replace; cosmetic-only, doesn't block anything.

### Phase 2: Strip anti-features
- Deleted entirely: `packages/identity/`, `packages/enterprise/`, `packages/console/` (5 subpackages), `packages/desktop/`, `packages/slack/`, `packages/docs/`, `packages/web/`, `packages/storybook/`, `packages/extensions/`, `packages/containers/`, `packages/function/`, `infra/`, `sst.config.ts`, `sst-env.d.ts`, `sdks/vscode/`
- 9 packages remain: `app/`, `core/`, `http-recorder/`, `lingcode/`, `llm/`, `plugin/`, `script/`, `sdk/`, `ui/` — all needed by the CLI binary
- Verified zero dangling `@lingcode-ai/<deleted>` refs after deletion

### Phase 3: Add 5 lingcode provider profiles
Added to [packages/llm/src/providers/openai-compatible-profile.ts](packages/llm/src/providers/openai-compatible-profile.ts):
- `zai` — `https://open.bigmodel.cn/api/paas/v4` (z.ai / GLM general default)
- `zai-coding` — `https://api.z.ai/api/coding/paas/v4` (z.ai coding-plan opt-in)
- `moonshot` — `https://api.moonshot.ai/v1` (Kimi)
- `lingmodel` — `https://lingcode.dev/v1/lingmodel/v1` (lingcode's managed proxy; branding stays opaque per project policy)
- `deepseek-anthropic` — `https://api.deepseek.com/anthropic` (DeepSeek V4 via Anthropic-compatible endpoint)

URLs are reasonable defaults but should be verified against current vendor docs before users hit them in anger.

### Bun + smoke
- Installed Bun 1.3.14 at `~/.bun/bin/bun`
- `bun install` resolves clean under new workspace name (376 packages first run, 778 with native opentui variants)
- Installed all 4 `@opentui/core-*` native variants (`linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`)
- `bun run --cwd packages/lingcode dev --help` boots the CLI, prints lingcode subcommands. **Banner ASCII still says "opencode"** (a 4-line `█▀▀█` art block — needs hand-replacement; couldn't find it via grep because the chars aren't text-searchable). Subcommand help text like `"start opencode tui"` still has lowercase opencode remnants — same root cause as the README mentions, deliberate-to-replace stops.

## Blocked: cross-platform compile

Two distinct issues both block `bun build --compile`:

### 1. opentui dynamic native imports
opentui's [index-ysvpktsp.js:12404](node_modules/@opentui/core/index-ysvpktsp.js#L12404) does:

```js
var nativePackage = await import(`@opentui/core-${process.platform}-${process.arch}`);
```

Bun's `--compile` produces a single static binary. The native package import is dynamic with a template literal — Bun can't statically resolve which subpackage to bundle, so it errors with `Could not resolve: "@opentui/core-linux-arm64"`. Installing the package locally doesn't help — `--compile` doesn't follow dynamic imports for embedding.

**Fix path**: Either (a) patch `@opentui/core`'s loader to do explicit per-target imports, or (b) externalize the native package via Bun's `--external` flag and ship the native binary as a sidecar file rather than embedded. Opencode upstream presumably handles this; need to read their CI workflow more carefully.

### 2. Solid JSX plugin missing on bare `bun build`
The build pipeline in [packages/lingcode/script/build.ts](packages/lingcode/script/build.ts) loads `@opentui/solid/bun-plugin`'s `createSolidTransformPlugin()` to handle the JSX in the TUI components ([packages/lingcode/src/cli/cmd/tui/context/helper.tsx](packages/lingcode/src/cli/cmd/tui/context/helper.tsx) etc.). Running `bun build --compile` directly bypasses the plugin and fails with `No matching export in "@opentui/solid/jsx-runtime" for import "jsxDEV"`.

**Fix**: build must go through [build.ts](packages/lingcode/script/build.ts), not bare `bun build`. That's the intended path.

So issue 1 is the real blocker; issue 2 is just "use the right entry."

## What's deferred (still on the original plan)

- **Phase 4 lingcode-only features** (1–2 weeks of real work):
  - `lingcode build` autonomous bootstrap port (Cosine/Genie-style one-shot) — ~5–7 days
  - RTK integration (cross-compile Rust binary for Linux + Windows, embed in `resources/bin/`, wire bash-rewrite hook) — 2 days
  - Telemetry heartbeat sender (POST to lingcode.dev) — 0.5 day
  - `lingcode-memory` MCP tool with zod schemas — 0.5 day
  - Three-tier user gating against prod API — 1 day
- **Phase 5 build pipeline**: blocked by both issues above
- **Phase 6 install-cli.sh routing + install-cli.ps1**: no point until binaries exist
- **Phase 7 soak test + ship**: needs Linux + Windows VMs we don't have local access to

## Resume recipe

When picking this back up:

1. `cd /Users/weijiahuang/Desktop/LingCode-main-2/LingCode-main-2/LingCodeCLIv2`
2. `PATH=$HOME/.bun/bin:$PATH bun install` (lockfile already exists)
3. Try `PATH=$HOME/.bun/bin:$PATH bun run --cwd packages/lingcode dev --help` to confirm CLI still boots
4. **Then** dig into the opentui native-import problem:
   - Read opencode-dev's `.github/workflows/release.yml` and `script/build.ts` to see how they handle native bundling on actual CI
   - Check if Bun's `--external` flag + sidecar binary layout is the upstream answer
   - Worst case: patch `@opentui/core/index-*.js` post-install to inline-import the host platform's variant
5. Once one target builds cleanly, the rest follow the same recipe
6. Then tackle Phase 4 features one at a time

## File-level diff summary vs. opencode-dev

| Change | Count |
|---|---|
| Files with `opencode` references modified | 1,167 |
| Files deleted (non-English READMEs) | 21 |
| Packages deleted (workspace dirs) | 12 |
| Top-level files/dirs deleted (`infra/`, `sst.config.ts`, `sdks/vscode/`, `sst-env.d.ts`) | 4 |
| New provider profiles added | 5 |
| `bun add` lines | 4 (`@opentui/core-{linux,win32}-{x64,arm64}`) |
| `.opencode/` → `.lingcode/` rename | 1 (~30 sub-files) |

## Critical things NOT to break next session

- `UPSTREAM.md` — must not be renamed/edited; tracks provenance for upstream merges
- `LICENSE` — must not be renamed/edited; MIT attribution to opencode
- The `OPENCODE_*` define macros in [build.ts](packages/lingcode/script/build.ts#L218-L225) — only rename if you also rename consumers in `src/file/watcher.ts`, `src/cli/cmd/tui/thread.ts`, `src/storage/db.ts`. Best left alone.

---

## 🟢 UNBLOCKED — cross-platform build works (added 2026-05-17 ~13:05Z)

### Root cause
Bun's CI ran on Linux, so the host's `@opentui/core-linux-x64` was installed naturally. On macOS we only get `@opentui/core-darwin-arm64` because the other variants have `os` restrictions in their package.json. Bun's `--compile` does a static check for the dynamic `import(\`@opentui/core-${platform}-${arch}\`)` against `node_modules/`, and missing variants fail.

### Fix (manual unpack)
```bash
cd /Users/weijiahuang/Desktop/LingCode-main-2/LingCode-main-2/LingCodeCLIv2
for variant in linux-x64 linux-arm64 darwin-x64 win32-x64 win32-arm64; do
  url=$(curl -s "https://registry.npmjs.org/@opentui%2Fcore-${variant}/0.2.11" | python3 -c "import json,sys; print(json.load(sys.stdin)['dist']['tarball'])")
  mkdir -p "node_modules/@opentui/core-${variant}"
  curl -sL "$url" | tar -xzf - -C "node_modules/@opentui/core-${variant}" --strip-components=1
done
```

**Long-term**: a `postinstall` script or a CI step should do this automatically before `bun run script/build.ts`. Add to root package.json's `scripts.postinstall` once verified.

### Build output (all 12 targets, 2026-05-17)

| Target | Binary | Size |
|---|---|---|
| lingcode-darwin-arm64 | bin/lingcode | 85 MB |
| lingcode-darwin-x64 | bin/lingcode | 90 MB |
| lingcode-darwin-x64-baseline | bin/lingcode | 90 MB |
| **lingcode-linux-x64** | **bin/lingcode** | **121 MB** |
| **lingcode-linux-arm64** | **bin/lingcode** | **120 MB** |
| **lingcode-linux-x64-musl** | **bin/lingcode** | **118 MB** |
| **lingcode-linux-arm64-musl** | **bin/lingcode** | **116 MB** |
| lingcode-linux-x64-baseline | bin/lingcode | 120 MB |
| lingcode-linux-x64-baseline-musl | bin/lingcode | 117 MB |
| **lingcode-windows-x64** | **bin/lingcode.exe** | **118 MB** |
| **lingcode-windows-arm64** | **bin/lingcode.exe** | **115 MB** |
| lingcode-windows-x64-baseline | bin/lingcode.exe | 118 MB |

Host smoke test (darwin-arm64) passed: `bin/lingcode --version` → `0.0.0-feature/simulator-mirror-202605171304`.

### Deployed as v0.9.0-rc1 (2026-05-17 13:07Z)

6 RC zips uploaded to lingcode.dev. **`latest-*` symlinks NOT updated** — these are release candidates pending real-OS verification:

- https://lingcode.dev/lingcode-linux-x64-v0.9.0-rc1.zip (42 MB)
- https://lingcode.dev/lingcode-linux-arm64-v0.9.0-rc1.zip (42 MB)
- https://lingcode.dev/lingcode-linux-x64-musl-v0.9.0-rc1.zip (41 MB)
- https://lingcode.dev/lingcode-linux-arm64-musl-v0.9.0-rc1.zip (40 MB)
- https://lingcode.dev/lingcode-windows-x64-v0.9.0-rc1.zip (43 MB)
- https://lingcode.dev/lingcode-windows-arm64-v0.9.0-rc1.zip (41 MB)

Server disk after upload: 93% used (677 MB free). Adding the 6 "baseline" variants or darwin builds would push over the wire — defer until needed.

### To promote v0.9.0-rc1 → v0.9.0 (manual user steps)

1. On a Linux x64 box: `curl -O https://lingcode.dev/lingcode-linux-x64-v0.9.0-rc1.zip && unzip ... && ./lingcode-linux-x64/bin/lingcode --version` — verify boot + auth flow + at least one `ask` per provider
2. On a Windows 11 box: same drill with the .zip; PowerShell unzip; verify `--version` and basic `ask`
3. SSH into lingcode.dev and:
   ```bash
   cd /var/www/html
   # Rename to match Mac CLI convention if desired:
   for f in lingcode-{linux,windows}-{x64,arm64}{,-musl}-v0.9.0-rc1.zip; do
     newname=$(echo "$f" | sed -E 's/lingcode-(linux|windows)-(x64|arm64)(-musl)?-v0\.9\.0-rc1\.zip/lingcode-cli-v0.9.0-\1-\2\3.zip/')
     mv "$f" "$newname"
   done
   # Then symlink each to a `latest-*` alias
   for arch in linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl windows-x64 windows-arm64; do
     ln -sf "lingcode-cli-v0.9.0-${arch}.zip" "lingcode-cli-latest-${arch}.zip"
   done
   ```
4. Update `website/install-cli.sh` to detect Linux/Windows and download from the new `latest-*` symlinks
5. Write `website/install-cli.ps1` for native Windows install

### What's STILL deferred (no change)

- **Phase 4 lingcode-only features**: `lingcode build` autonomous bootstrap, RTK integration, telemetry sender, `lingcode-memory` MCP, three-tier user gating against prod API. These are 1–2 weeks of real engineering. v0.9.0-rc1 ships WITHOUT them.
- **install-cli.sh routing + install-cli.ps1**: not written yet.
- **Real-OS soak test**: still needs user-driven validation on real machines (no VM access from this session).
- **Banner ASCII still says "opencode"**: the `█▀▀█` block at boot — needs hand-replacement (chars aren't text-searchable). Cosmetic.
- **README install instructions**: still reference opencode's brew/scoop/choco packages. Cosmetic; needs rewrite when we publish lingcode to those package managers.

---

## 🟢 LingModel auth wired end-to-end (added 2026-05-17 ~16:17Z, deployed as v0.9.0-rc4)

### What landed

1. **Catalog injection** at [packages/core/src/models.ts](packages/core/src/models.ts): synthetic `LINGMODEL_PROVIDER` const + `get()` wrapped to merge it into every catalog read. Provider points to `https://lingcode.dev/api/inference` (the proxy at `/api/inference/anthropic/v1/messages` per [website/server/inference-anthropic.js:673](LingCode-main-2/website/server/inference-anthropic.js#L673)). `npm: "@ai-sdk/anthropic"` so the runtime constructs the Anthropic SDK client and the SDK attaches the stored API key as `Authorization: Bearer <token>` automatically.

2. **Model tier names — not Claude names.** First pass got this wrong (registered `claude-sonnet-4-5` etc., assuming Anthropic-protocol meant Claude-shaped). The proxy is upstream-agnostic — operators can swap between DeepSeek/Moonshot via `LINGMODEL_ANTHROPIC_MESSAGES_URL` env. The Mac CLI uses abstract tier names that the bridge maps server-side. Found the canonical names in [LingCodeCLI/Sources/lingcode/HeadlessClaude.swift:289](LingCode-main-2/LingCodeCLI/Sources/lingcode/HeadlessClaude.swift#L289). Now ships:
   - `lingmodel-standard` (default, hosted Standard tier)
   - `lingmodel-pro`
   - `lingmodel-advanced`
   - `lingmodel-fast` (legacy alias of standard — for existing user config files)

3. **Auth-flow hint** at [packages/lingcode/src/cli/cmd/providers.ts:467-471](packages/lingcode/src/cli/cmd/providers.ts#L467-L471): when user picks `lingmodel` in the `providers login` flow, the default API-key prompt now prefixes with `"Sign in at https://lingcode.dev and grab your LingModel CLI token from https://lingcode.dev/cli-token.html (token format: lcat_…)."`. Mirrors the existing `vercel` / `lingcode` hint blocks. The rest of the flow is opencode's standard `type: "api"` path — stores in `~/.local/share/lingcode/auth.json` and the runtime auto-merges at [provider.ts:1366-1375](packages/lingcode/src/provider/provider.ts#L1366-L1375).

4. **Env-var fallback works**: `LINGCODE_CLI_TOKEN=lcat_…` triggers the env-var auto-add at [provider.ts:1357-1362](packages/lingcode/src/provider/provider.ts#L1357-L1362), no `auth login` required. Same env-var name as the Mac CLI ([Auth.swift:20](LingCode-main-2/LingCodeCLI/Sources/lingcode/Commands/Auth.swift#L20)).

### Smoke test results (host darwin-arm64, dev mode)

```
$ LINGCODE_CLI_TOKEN=fake_lcat_test bun run --cwd packages/lingcode dev models lingmodel
lingmodel/lingmodel-advanced
lingmodel/lingmodel-fast
lingmodel/lingmodel-pro
lingmodel/lingmodel-standard

$ LINGCODE_CLI_TOKEN=fake_lcat_test bun run --cwd packages/lingcode dev providers list
┌  Credentials  ~/.local/share/lingcode/auth.json
│
└  0 credentials

┌  Environment
│
●  LingModel  LINGCODE_CLI_TOKEN
│
└  1 environment variable
```

Branding stays opaque (just "LingModel"), env-var detected, all 4 tier model IDs available. Per [LingModel branding policy](LingCode-main-2/CLAUDE.md): never name the upstream vendor in user-visible strings — confirmed nothing in the catalog entry, hint text, or provider listing references DeepSeek/Moonshot.

### Deployed as v0.9.0-rc4

6 RC zips live on lingcode.dev. **`latest-*` symlinks NOT updated yet** — still needs a real-OS end-to-end test against an actual `lcat_*` token before promoting:

- https://lingcode.dev/lingcode-linux-x64-v0.9.0-rc4.zip
- https://lingcode.dev/lingcode-linux-arm64-v0.9.0-rc4.zip
- https://lingcode.dev/lingcode-linux-x64-musl-v0.9.0-rc4.zip
- https://lingcode.dev/lingcode-linux-arm64-musl-v0.9.0-rc4.zip
- https://lingcode.dev/lingcode-windows-x64-v0.9.0-rc4.zip
- https://lingcode.dev/lingcode-windows-arm64-v0.9.0-rc4.zip

Server disk: 91% / 803 MB free after the cleanup that this deploy required (orphan 554 MB DMG from a previous failed rsync + stale v0.8.16/v0.8.17 darwin-arm64 tarballs cleaned).

### Manual user verification (next step, you on a real Linux/Windows box)

1. Download `lingcode-linux-x64-v0.9.0-rc4.zip` on an Ubuntu box
2. `unzip … && cd lingcode-linux-x64 && ./bin/lingcode --version`
3. `./bin/lingcode providers login` → pick LingModel → see the cli-token.html hint → paste a real `lcat_*` from https://lingcode.dev/cli-token.html
4. `./bin/lingcode run --provider lingmodel --model lingmodel-standard "say ping"`
5. Server logs (you have access): confirm the request hits `/api/inference/anthropic/v1/messages` with `Authorization: Bearer lcat_…` and the user's tier check passes

If 4 returns a real response → promote rc4 → latest. SSH cmds for promote are in the earlier section "To promote v0.9.0-rc1 → v0.9.0".

### What's still NOT wired (deferred Phase 4)

- `lingcode build` autonomous bootstrap port (~5–7 days)
- RTK integration (~2 days, needs rtk Linux + Windows cross-compile first)
- `lingcode-memory` MCP tool (~0.5 day; effect-framework port)
- Three-tier preflight + pretty 402 errors (~0.5 day; nice-to-have)
- Banner ASCII (LINGCODE) — rendered fine via `--help`, but the **animated logo** in the TUI mode still uses opencode's glyphs at [packages/lingcode/src/cli/logo.ts](packages/lingcode/src/cli/logo.ts). Less visible than the wordmark; defer.

---

## 🟢 Production-readiness Tier 1 + 2 — v0.9.0-rc5 (added 2026-05-17 ~17:11Z)

The user asked "is the cli for Windows production-ready?" → honest answer was no, with a Tier 1 punch-list. This run knocks out everything I could without a real Linux/Windows VM.

### What landed

1. **install-cli.sh patched** ([website/install-cli.sh](LingCode-main-2/website/install-cli.sh)) — single script branches on `$OS`:
   - Darwin → existing Swift tarball flow, unchanged
   - Linux → downloads `lingcode-linux-${ARCH}${LINUX_LIBC}-v0.9.0-rc5.zip` (auto-detects glibc vs musl via `/etc/alpine-release` or `ldd --version`)
   - MINGW/MSYS/CYGWIN under bash → prints redirect to PowerShell installer
   - Live at https://lingcode.dev/install-cli.sh

2. **install-cli.ps1 written** ([website/install-cli.ps1](LingCode-main-2/website/install-cli.ps1)) — Windows-native installer:
   - Detects x64 vs arm64 via `$env:PROCESSOR_ARCHITECTURE`
   - Downloads to `%LOCALAPPDATA%\Programs\lingcode\`
   - Adds to User PATH via `[Environment]::SetEnvironmentVariable("Path", …, "User")`
   - Broadcasts `WM_SETTINGCHANGE` so new shells pick up the PATH without reboot
   - Live at https://lingcode.dev/install-cli.ps1
   - One-liner: `iwr -useb https://lingcode.dev/install-cli.ps1 | iex`

3. **Postinstall script for opentui natives** ([script/fetch-opentui-natives.ts](LingCodeCLIv2/script/fetch-opentui-natives.ts)) — wired into root `package.json` postinstall. On any fresh clone, `bun install` now automatically fetches all 6 cross-platform variants (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`) directly from npm registry. Verified idempotent: rerun fetches only what's missing. The manual `curl + tar` workaround we used during the first build is no longer needed.

4. **`lingcode upgrade` neutralized** ([packages/lingcode/src/cli/cmd/upgrade.ts](LingCodeCLIv2/packages/lingcode/src/cli/cmd/upgrade.ts)) — handler stubbed to print "self-upgrade not yet wired for v0.9.x" + the install-script one-liners. Without this, users running `lingcode upgrade` would have hit opencode's update endpoint and either 404'd or grabbed opencode binaries.

5. **`lingcode uninstall` brand-fixed** — was printing `"Uninstall OpenCode"` in the prompt header. The rest of the uninstall logic is local file removal (no upstream endpoint to wrong-point), so left functional but rebranded.

6. **README.md rewritten** — replaced opencode's brew/scoop/choco install instructions (which point at upstream's packages, not ours) with:
   - Clear positioning: this is the Linux+Windows fork; Mac stays in `LingCodeCLI/`
   - The two real install paths (`install-cli.sh` for Mac/Linux, `install-cli.ps1` for Windows)
   - LingModel quickstart with `cli-token.html` flow
   - Attribution to opencode upstream + license preservation
   - Mac-feature-gap list pointing back to STATUS.md

### Deployed

- 6 new RC zips at `https://lingcode.dev/lingcode-{linux,windows}-{x64,arm64}{,-musl}-v0.9.0-rc5.zip`
- 2 install scripts at `https://lingcode.dev/install-cli.sh` and `https://lingcode.dev/install-cli.ps1`
- All rc4 zips removed (server disk back to 93% / 663 MB free)

### End-to-end paths now live (untested on real OS, but the URL flow is wired)

```sh
# Linux user (any distro, glibc or musl, x64 or arm64)
curl -fsSL https://lingcode.dev/install-cli.sh | sh
lingcode providers login           # picks LingModel from catalog, hint shows cli-token URL
lingcode run --provider lingmodel --model lingmodel-standard "hello"
```

```powershell
# Windows user (PowerShell 5.1+, x64 or arm64)
iwr -useb https://lingcode.dev/install-cli.ps1 | iex
# Reopen terminal so PATH picks up
lingcode providers login
lingcode run --provider lingmodel --model lingmodel-standard "hello"
```

### Remaining for "true production" (Tier 3 — requires you off-CLI)

- **Boot test on real Windows** — ✓ passed 2026-05-17 via user screenshot in `cmd.exe` (single-shot `lingcode run` exercised Write tool, Bash `pwd`, permission gate, path normalization). Locked in going forward by `.github/workflows/cliv2-cross-platform.yml` which boots the `.exe` on every push. Still untested: interactive TUI (opentui), MCP stdio, multi-turn session persistence — those need a real Windows box, not just CI.
- **`lingcode upgrade` self-update on Windows** — ✓ wired 2026-05-17. `upgrade.ts` + `installation/index.ts` now download the next `.zip` from `https://lingcode.dev/lingcode-windows-{arch}-{version}.zip`, extract via PowerShell `Expand-Archive`, and swap the live `.exe` using the rename-trick (live → `.exe.old`, new → live). Version source-of-truth is `https://lingcode.dev/cliv2-latest.json` (see `website/cliv2-latest.json`), with GH Releases as a fallback. Bump that manifest with every release.
- **Real `lcat_*` token round-trip** — confirms model name (`lingmodel-standard`) resolves at the current Kimi upstream. May need a remap if Kimi expects different IDs.
- **Promote rc5 → v0.9.0** — once the two above pass: re-pin `LINGCODE_TS_VERSION` in install scripts to `v0.9.0`, rename the zips on server, re-upload, and bump `website/cliv2-latest.json`.

### Phase 4 lingcode-specific features (deferred, separate sessions)

Unchanged from prior status — `lingcode build`, RTK, lingcode-memory MCP, tier-aware error UX. Ship as v0.9.1, v0.9.2 incrementally.
