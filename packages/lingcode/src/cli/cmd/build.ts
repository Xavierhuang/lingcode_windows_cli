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
  implement: boolean
  build: boolean
  "max-iterations": number
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
  return { ok: false, detail: "no Android SDK (install Android Studio or cmdline-tools, then set ANDROID_HOME)" }
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

// --- agent loop -------------------------------------------------------------
// Re-invoke this same CLI's `run` to drive the model over the scaffold. In the
// compiled binary process.execPath IS lingcode; under `bun src/index.ts` (dev)
// argv[1] is the entry script, so we forward it.
function selfRun(promptArgs: string[]): number {
  const entry = process.argv[1]
  const isDev = !!entry && /\.(ts|js|mjs)$/.test(entry)
  const argv = isDev ? [entry, ...promptArgs] : [...promptArgs]
  const r = spawnSync(process.execPath, argv, { stdio: "inherit" })
  return r.status ?? 1
}

function implementPrompt(description: string, pkgPath: string): string {
  return [
    "You are implementing an Android app in the current project directory.",
    "",
    `App to build: "${description}"`,
    "",
    "A minimal Jetpack Compose app (Kotlin, AGP 8.7, compileSdk 35) is already scaffolded:",
    `  app/src/main/java/${pkgPath}/MainActivity.kt  — entry point`,
    "  app/build.gradle.kts                          — module config + dependencies",
    "  app/src/main/AndroidManifest.xml",
    "",
    "Implement the described app: idiomatic Kotlin + Jetpack Compose (Material3),",
    "add screens/state/components as needed, add any deps to app/build.gradle.kts,",
    "keep it a single module and buildable with `gradlew assembleDebug` (minSdk 24).",
    "Edit the files directly; do not explain — just implement.",
  ].join("\n")
}

// Run `gradle wrapper` once, then `gradlew assembleDebug`. Returns the captured
// output so failures can be fed back to the model.
function gradleBuild(dir: string): { ok: boolean; output: string } {
  spawnSync("gradle", ["wrapper"], { cwd: dir, encoding: "utf8", shell: true })
  const gw = process.platform === "win32" ? "gradlew.bat" : "./gradlew"
  const r = spawnSync(gw, ["assembleDebug"], { cwd: dir, encoding: "utf8", shell: true })
  const output = (r.stdout ?? "") + (r.stderr ?? "")
  const apk = path.join(dir, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
  return { ok: fs.existsSync(apk), output }
}

export const BuildCommand: CommandModule<object, Args> = {
  command: "build [name]",
  describe: "scaffold, implement, and build an app from a prompt (experimental; Android-first)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", describe: "app name / one-line description" })
      .option("dir", { type: "string", describe: "target directory (default ./<name>)" })
      .option("package", { type: "string", describe: "Android applicationId (default dev.lingcode.<name>)" })
      .option("platform", { type: "string", default: "android", describe: "target platform (android)" })
      .option("implement", { type: "boolean", default: true, describe: "drive the model to implement the app" })
      .option("build", { type: "boolean", default: true, describe: "run the Gradle build (and fix-up loop)" })
      .option("max-iterations", { type: "number", default: 3, describe: "build/fix attempts" }) as any,
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
    const pkgPath = pkg.replace(/\./g, "/")

    console.log(`▶ lingcode build (android)`)
    console.log(`  app: ${appName}   package: ${pkg}`)
    console.log(`  dir: ${dir}`)

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
    const ready = jdk.ok && sdk.ok && gradle.ok

    // 2. Scaffold
    console.log("\n▶ scaffolding")
    const written = await scaffoldAndroid({ dir, appName, pkg })
    for (const f of written) console.log(`  + ${f}`)

    // 3. Implement (agent) — then build, feeding any Gradle errors back to iterate.
    if (args.implement) {
      console.log("\n▶ implementing (lingcode run)")
      process.chdir(dir)
      const code = selfRun(["run", implementPrompt(rawName, pkgPath), "--dangerously-skip-permissions"])
      if (code !== 0) console.log("  (implementation step exited non-zero — sign in / pick a model and retry)")

      if (args.build && ready) {
        let built = false
        for (let i = 1; i <= Math.max(1, args["max-iterations"]); i++) {
          console.log(`\n▶ building (attempt ${i}/${args["max-iterations"]})`)
          const res = gradleBuild(dir)
          if (res.ok) {
            built = true
            console.log(`✓ APK: ${path.join(dir, "app/build/outputs/apk/debug/app-debug.apk")}`)
            break
          }
          if (i < args["max-iterations"]) {
            console.log("  build failed — feeding errors back to the model")
            const tail = res.output.split(/\r?\n/).slice(-60).join("\n")
            selfRun(["run", `The Gradle build failed:\n\n${tail}\n\nFix these errors in the project.`, "--dangerously-skip-permissions"])
          }
        }
        if (!built) console.log("⚠ could not produce an APK within the iteration budget — see Gradle output above.")
      }
    }

    if (!ready && args.build) {
      console.log("\n⚠ build skipped — install the missing toolchain above, then:")
      console.log(`    cd ${dir} && gradle wrapper && ${process.platform === "win32" ? "gradlew.bat" : "./gradlew"} assembleDebug`)
    }

    console.log(`\n✓ ${appName} at ${dir}`)
  },
}
