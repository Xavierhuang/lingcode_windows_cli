# Upstream provenance

This directory is a vendored fork of [opencode](https://github.com/sst/opencode),
copied from a local snapshot at:

    /Users/weijiahuang/Desktop/LingCode-main-2/opencode-dev

**Fork date**: 2026-05-17

**Upstream commit SHA**: *unavailable* — the local snapshot has no `.git/` tree.
The first time we want to merge upstream changes, we should `git clone` opencode
fresh, identify the commit closest to our snapshot, and record that SHA below
retroactively.

**License**: opencode is MIT-licensed. The `LICENSE` file in this directory is
the unmodified opencode license and must be preserved as part of attribution.
When we ship `lingcode` binaries built from this fork, the LICENSE notice must
be reachable (e.g., bundled as a resource or referenced in `--version` output).

## What this fork will become

A Linux + Windows `lingcode` CLI binary, sibling to the Swift `LingCodeCLI/`
which remains macOS-only.

Target binary outputs (per `packages/opencode/script/build.ts` build matrix,
trimmed to non-Mac):

- `lingcode-cli-v0.9.X-linux-x64.zip`
- `lingcode-cli-v0.9.X-linux-arm64.zip`
- `lingcode-cli-v0.9.X-linux-x64-musl.zip`
- `lingcode-cli-v0.9.X-linux-arm64-musl.zip`
- `lingcode-cli-v0.9.X-windows-x64.zip`
- `lingcode-cli-v0.9.X-windows-arm64.zip` (optional v1)

Plan: `~/.claude/plans/2026-05-17-windows-linux-cli-opencode-fork.md`

## Upstream-merge protocol (to be exercised when we want updates)

1. `git clone https://github.com/sst/opencode upstream-opencode` in `/tmp`
2. `git -C /tmp/upstream-opencode log --oneline | head` to see recent activity
3. Cherry-pick or rebase the changes we want into our `LingCodeCLIv2/` tree
4. Update the "Upstream commit SHA" field above to the commit we just merged to
5. Re-run smoke tests; if green, commit with message
   `LingCodeCLIv2: sync with opencode @ <sha>`

## Renames in progress (Phase 1)

- [ ] `packages/opencode/` → `packages/lingcode/`
- [ ] `package.json` `"name": "opencode"` → `"name": "lingcode"`
- [ ] `s/@opencode-ai/@lingcode/g` across workspace deps + imports
- [ ] `s/opencode/lingcode/g` in source files (NOT in this file, NOT in LICENSE,
      NOT in any code comments that reference upstream opencode for attribution)
- [ ] ASCII banner in `install` script replaced with lingcode equivalent
- [ ] Non-English READMEs (`README.ar.md`, `README.bn.md`, etc.) removed
- [ ] `bun install` runs clean under new name
