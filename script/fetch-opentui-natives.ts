#!/usr/bin/env bun
//
// Fetch opentui-core's platform-specific native variants and unpack them
// into node_modules/@opentui/core-${platform}-${arch}/.
//
// Why: opentui's loader does `await import(\`@opentui/core-\${process.platform}-\${process.arch}\`)`.
// Bun's `bun install` honors each package's `os`/`cpu` restrictions and skips
// any that don't match the host. So on macOS arm64, ONLY @opentui/core-darwin-arm64
// lands in node_modules. When `bun build --compile --target=bun-linux-x64`
// tries to statically resolve `@opentui/core-linux-x64`, it errors out with
// "Could not resolve" because the package isn't on disk.
//
// This script manually downloads all 5 variants we ship for (darwin-arm64,
// darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64) and unpacks
// each one. Idempotent — skips packages that already have an index.js
// inside their @opentui/core-${variant}/ directory.
//
// Runs as the workspace's `postinstall` hook so `bun install` automatically
// sets up a working cross-platform build environment on any fresh clone.

import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, "..")
const targetsDir = join(repoRoot, "node_modules", "@opentui")

// Versions must match what opencode-upstream pinned at the time of the fork.
// Read from the lingcode workspace package.json instead of hardcoding so a
// version bump in one place updates everywhere.
const OPENTUI_VERSION = "0.2.11"

// process.platform values: darwin, linux, win32. process.arch values: x64, arm64.
const variants = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
] as const

async function fetchTarball(npmName: string, version: string): Promise<ArrayBuffer> {
  const url = `https://registry.npmjs.org/${npmName.replace("/", "%2F")}/${version}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`npm registry GET ${url} → ${res.status}`)
  const meta = (await res.json()) as { dist?: { tarball?: string } }
  const tarballUrl = meta?.dist?.tarball
  if (!tarballUrl) throw new Error(`no tarball URL in npm metadata for ${npmName}@${version}`)
  const tarRes = await fetch(tarballUrl)
  if (!tarRes.ok) throw new Error(`tarball fetch ${tarballUrl} → ${tarRes.status}`)
  return await tarRes.arrayBuffer()
}

async function ensureVariant(variant: string): Promise<"ok" | "skipped" | "failed"> {
  const pkgName = `@opentui/core-${variant}`
  const destDir = join(targetsDir, `core-${variant}`)
  const probe = join(destDir, "index.js")
  if (existsSync(probe)) return "skipped"

  try {
    const buf = await fetchTarball(pkgName, OPENTUI_VERSION)
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
    mkdirSync(destDir, { recursive: true })
    const tarPath = join(destDir, ".pkg.tgz")
    await Bun.write(tarPath, buf)
    // Use system tar — npm tarballs have a top-level `package/` directory
    // that we strip via --strip-components=1.
    const result = spawnSync("tar", ["-xzf", tarPath, "-C", destDir, "--strip-components=1"], {
      stdio: "inherit",
    })
    if (result.status !== 0) {
      throw new Error(`tar extraction failed (exit ${result.status})`)
    }
    rmSync(tarPath, { force: true })
    return "ok"
  } catch (err) {
    console.error(`  ✗ ${pkgName}: ${err instanceof Error ? err.message : String(err)}`)
    return "failed"
  }
}

async function main() {
  if (!existsSync(targetsDir)) {
    mkdirSync(targetsDir, { recursive: true })
  }
  console.log("• opentui-core cross-platform natives:")
  let okCount = 0
  let skipCount = 0
  let failCount = 0
  for (const variant of variants) {
    const status = await ensureVariant(variant)
    if (status === "ok") {
      console.log(`  ✓ fetched @opentui/core-${variant}`)
      okCount++
    } else if (status === "skipped") {
      skipCount++
    } else {
      failCount++
    }
  }
  const summary: string[] = []
  if (okCount) summary.push(`${okCount} fetched`)
  if (skipCount) summary.push(`${skipCount} already present`)
  if (failCount) summary.push(`${failCount} FAILED`)
  console.log(`  → ${summary.join(", ")}`)
  // Don't exit non-zero on failure — a partial set is enough to build for the
  // host platform, and we'd rather let the build fail loudly later than
  // block `bun install` entirely if npm is temporarily unreachable.
}

await main()
