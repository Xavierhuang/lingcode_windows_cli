#!/usr/bin/env bun

// Package the compiled `dist/lingcode-<target>/` directories into the exact
// archive names the lingcode.dev installers and `lingcode upgrade` fetch:
//
//   https://lingcode.dev/lingcode-<target>-v<version>.zip
//   https://lingcode.dev/cliv2-latest.json
//
// Each zip contains the `lingcode-<target>/bin/lingcode{,.exe}` layout that
// install-cli.sh / install-cli.ps1 and Installation.upgradeCurl* expect (they
// look for `lingcode-<target>/bin/lingcode`). The version token carries a
// leading `v` to match LINGCODE_TS_VERSION (e.g. v0.9.0-rc6).
//
// Run AFTER script/build.ts. Output lands in `dist/release/`.
//
//   OPENCODE_VERSION=0.9.0 bun run script/package-cli.ts
//   OPENCODE_VERSION=v0.9.0-rc6 bun run script/package-cli.ts
//
// Requires the `zip` CLI on PATH (preinstalled on Linux/macOS CI; on Windows
// install it via Git-for-Windows/MSYS or run this step on Linux).

import { $ } from "bun"
import fs from "fs"
import path from "path"

const dir = path.resolve(import.meta.dir, "..") // packages/lingcode
process.chdir(dir)

const distDir = path.join(dir, "dist")
if (!fs.existsSync(distDir)) {
  console.error("dist/ not found — run `bun run script/build.ts` first")
  process.exit(1)
}

const rawVersion = process.env.OPENCODE_VERSION ?? process.env.LINGCODE_VERSION
if (!rawVersion) {
  console.error("Set OPENCODE_VERSION (e.g. 0.9.0 or v0.9.0-rc6)")
  process.exit(1)
}
const vtag = rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`
const plain = vtag.replace(/^v/, "")

const targets = fs
  .readdirSync(distDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("lingcode-"))
  .map((e) => e.name)
  .sort()

if (targets.length === 0) {
  console.error("no lingcode-* target directories found in dist/ — did the build succeed?")
  process.exit(1)
}

const outDir = path.join(distDir, "release")
// Version-LESS copies (Linux/Windows only) live in release/latest/. They get
// uploaded to the GitHub Release so `releases/latest/download/lingcode-<target>.zip`
// resolves to the newest build — letting install-cli.* + `lingcode upgrade` fetch
// from GitHub with no version pin and no server hosting. They are NOT rsynced to
// the droplet (the workflow excludes latest/) so its small disk only carries the
// versioned fallback set.
const latestDir = path.join(outDir, "latest")
await $`rm -rf ${outDir}`
await $`mkdir -p ${outDir}`
await $`mkdir -p ${latestDir}`

for (const name of targets) {
  const binary = path.join(distDir, name, "bin", name.startsWith("lingcode-windows") ? "lingcode.exe" : "lingcode")
  if (!fs.existsSync(binary)) {
    console.error(`✗ ${name}: expected binary missing at ${path.relative(dir, binary)} — skipping`)
    process.exit(1)
  }
  const zipPath = path.join(outDir, `${name}-${vtag}.zip`)
  // zip from dist/ so the archive's top-level entry is `lingcode-<target>/...`.
  await $`zip -r -q ${zipPath} ${name}`.cwd(distDir)
  console.log(`packaged ${path.basename(zipPath)}`)

  // macOS installs the Swift tarball from lingcode.dev, so only Linux/Windows
  // need a `releases/latest` alias.
  if (name.startsWith("lingcode-linux") || name.startsWith("lingcode-windows")) {
    await $`cp ${zipPath} ${path.join(latestDir, `${name}.zip`)}`
    console.log(`  + latest/${name}.zip`)
  }
}

// Upgrade manifest consumed by Installation.latest() (lingcode.dev/cliv2-latest.json).
// Match the live manifest shape: version keeps the leading `v`, plus channel /
// released_at / _comment. The CLI only requires `version`, but matching avoids
// downgrading the richer manifest already deployed.
void plain
const channel = /-rc\d*/i.test(vtag) ? "rc" : /-beta/i.test(vtag) ? "beta" : "latest"
const manifest = {
  version: vtag,
  channel,
  released_at: new Date().toISOString(),
  _comment:
    "Source of truth for `lingcode upgrade` (CLIv2 curl/PowerShell installs). Bump this in lockstep with the " +
    "install-cli.* scripts whenever a new rcN or stable release goes live. The CLI derives artifact URLs from this " +
    "version: https://lingcode.dev/lingcode-{os}-{arch}-{version}.{zip|tar.gz}.",
}
await Bun.write(path.join(outDir, "cliv2-latest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote cliv2-latest.json (version ${vtag}, channel ${channel})`)

console.log(`\n${targets.length} archives + manifest in ${path.relative(dir, outDir)}/:`)
for (const f of fs.readdirSync(outDir).sort()) console.log("  " + f)
