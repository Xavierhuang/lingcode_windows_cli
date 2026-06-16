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
await $`rm -rf ${outDir}`
await $`mkdir -p ${outDir}`

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
}

// Upgrade manifest consumed by Installation.latest() (lingcode.dev/cliv2-latest.json).
await Bun.write(path.join(outDir, "cliv2-latest.json"), JSON.stringify({ version: plain }, null, 2) + "\n")
console.log(`wrote cliv2-latest.json (version ${plain})`)

console.log(`\n${targets.length} archives + manifest in ${path.relative(dir, outDir)}/:`)
for (const f of fs.readdirSync(outDir).sort()) console.log("  " + f)
