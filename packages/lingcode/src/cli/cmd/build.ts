import type { CommandModule } from "yargs"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Flag } from "@lingcode-ai/core/flag/flag"
import { scaffoldAndroid } from "./build/android"

type Args = {
  name?: string
  dir?: string
  package?: string
  platform: string
  build: boolean
}

// --- toolchain doctor -------------------------------------------------------
// `lingcode build --platform android` needs a JDK, the Android SDK, and Gradle.
// We detect each and report precisely what's missing rather than failing deep in
// a Gradle stack trace.

function which(cmd: string): string | undefined {
  const probe = process.platform === "win32" ? "where" : "which"
  const r = spawnSync(probe, [cmd], { encoding: "utf8" })
  if (r.status !== 0) return undefined
  return r.stdout.split(/\r?\n/).find(Boolean)?.trim()
}

function detectJdk(): { ok: boolean; detail: string } {
  if (process.env["JAVA_HOME"] && fs.existsSync(process.env["JAVA_HOME"])) {
    return { ok: true, detail: `JAVA_HOME=${process.env["JAVA_HOME"]}` }
  }
  const java = which("java")
  if (java) {
    const v = spawnSync("java", ["-version"], { encoding: "utf8" })
    return { ok: true, detail: (v.stderr || v.stdout || java).split(/\r?\n/)[0]!.trim() }
  }
  return { ok: false, detail: "no JDK (set JAVA_HOME or put `java` on PATH; JDK 17+ recommended)" }
}

function detectAndroidSdk(): { ok: boolean; detail: string } {
  const candidates = [
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local", "Android", "Sdk") : undefined,
  ].filter(Boolean) as string[]
  const found = candidates.find((p) => fs.existsSync(p))
  if (found) return { ok: true, detail: found }
  return {
    ok: false,
    detail: "no Android SDK (install Android Studio or cmdline-tools, then set ANDROID_HOME)",
  }
}

function detectGradle(): { ok: boolean; detail: string } {
  const g = which("gradle")
  if (g) {
    const v = spawnSync("gradle", ["-v"], { encoding: "utf8" })
    const line = (v.stdout || "").split(/\r?\n/).find((l) => l.startsWith("Gradle "))
    return { ok: true, detail: line ?? g }
  }
  return { ok: false, detail: "no system Gradle (needed once to generate the ./gradlew wrapper)" }
}

export const BuildCommand: CommandModule<object, Args> = {
  command: "build [name]",
  describe: "scaffold and build an app from a prompt (experimental; Android-first)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", describe: "app name / one-line description" })
      .option("dir", { type: "string", describe: "target directory (default ./<name>)" })
      .option("package", { type: "string", describe: "Android applicationId (default dev.lingcode.<name>)" })
      .option("platform", { type: "string", default: "android", describe: "target platform (android)" })
      .option("build", { type: "boolean", default: true, describe: "run the Gradle build after scaffolding" }) as any,
  handler: async (args) => {
    if (!Flag.LINGCODE_EXPERIMENTAL_BUILD) {
      console.error(
        "lingcode build is experimental and off by default.\n" +
          "Enable it with:  LINGCODE_EXPERIMENTAL_BUILD=1 lingcode build <name>",
      )
      process.exitCode = 1
      return
    }
    if (args.platform !== "android") {
      console.error(`lingcode build: only --platform android is supported right now (got "${args.platform}").`)
      process.exitCode = 1
      return
    }

    const rawName = (args.name ?? "myapp").trim()
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "") || "myapp"
    const appName = rawName || "MyApp"
    const dir = path.resolve(args.dir ?? slug)
    const pkg = args.package ?? `dev.lingcode.${slug}`

    console.log(`▶ lingcode build (android)`)
    console.log(`  app:     ${appName}`)
    console.log(`  package: ${pkg}`)
    console.log(`  dir:     ${dir}`)

    // 1. Doctor
    console.log("\n▶ toolchain")
    const jdk = detectJdk()
    const sdk = detectAndroidSdk()
    const gradle = detectGradle()
    for (const [label, r] of [
      ["JDK", jdk],
      ["Android SDK", sdk],
      ["Gradle", gradle],
    ] as const) {
      console.log(`  ${r.ok ? "✓" : "✗"} ${label.padEnd(12)} ${r.detail}`)
    }

    // 2. Scaffold (always — a missing toolchain doesn't stop us writing the project)
    console.log("\n▶ scaffolding")
    const written = await scaffoldAndroid({ dir, appName, pkg })
    for (const f of written) console.log(`  + ${f}`)

    // 3. Build (only if the toolchain is present and --build)
    const ready = jdk.ok && sdk.ok && gradle.ok
    if (args.build && ready) {
      console.log("\n▶ building (gradle wrapper + assembleDebug)")
      const wrap = spawnSync("gradle", ["wrapper"], { cwd: dir, stdio: "inherit", shell: true })
      if (wrap.status === 0) {
        const gw = process.platform === "win32" ? "gradlew.bat" : "./gradlew"
        spawnSync(gw, ["assembleDebug"], { cwd: dir, stdio: "inherit", shell: true })
      }
      const apk = path.join(dir, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
      console.log(fs.existsSync(apk) ? `\n✓ APK: ${apk}` : "\n⚠ build did not produce an APK — see the Gradle output above.")
    } else if (args.build) {
      console.log("\n⚠ skipping the build — install the missing toolchain above, then run:")
      console.log(`    cd ${dir} && gradle wrapper && ${process.platform === "win32" ? "gradlew.bat" : "./gradlew"} assembleDebug`)
    }

    console.log(`\n✓ scaffolded ${appName} at ${dir}`)
    console.log("  (agent-driven implementation from your prompt lands in the next checkpoint.)")
  },
}
