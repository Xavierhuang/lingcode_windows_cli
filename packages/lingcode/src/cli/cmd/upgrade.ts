import type { Argv } from "yargs"
import semver from "semver"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@lingcode-ai/core/installation/version"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade lingcode to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, e.g. '0.9.0' or 'v0.9.0'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")

    const method = ((args.method as Installation.Method | undefined) ?? (await Installation.method())) as Installation.Method
    prompts.log.info(`Installation method: ${method}`)
    prompts.log.info(`Current version: ${InstallationVersion}`)

    if (method === "unknown") {
      prompts.log.warn(
        "Could not detect installation method. Pass --method explicitly, or re-run the install script:",
      )
      prompts.log.info(
        `  macOS / Linux:  curl -fsSL https://lingcode.dev/install-cli.sh | sh\n` +
          `  Windows:        iwr -useb https://lingcode.dev/install-cli.ps1 | iex`,
      )
      prompts.outro("Done")
      return
    }

    const explicitTarget = args.target !== undefined
    let target = args.target
    if (!target) {
      const checking = prompts.spinner()
      checking.start("Checking for the latest version…")
      try {
        target = await Installation.latest(method)
        checking.stop(`Latest version: ${target}`)
      } catch (err) {
        checking.stop(
          `Could not check latest version: ${err instanceof Error ? err.message : String(err)}`,
          1,
        )
        prompts.outro("Done")
        return
      }
    }

    const current = InstallationVersion.replace(/^v/, "")
    const next = target.replace(/^v/, "")
    // Skip if already on the requested version, but only when the user
    // didn't pass --target. An explicit target should always run — useful
    // for forcing a reinstall, downgrading, or testing the swap flow.
    if (!explicitTarget && semver.valid(current) && semver.valid(next) && semver.gte(current, next)) {
      prompts.log.success(`Already on ${InstallationVersion}. Nothing to do.`)
      prompts.outro("Done")
      return
    }

    const upgrading = prompts.spinner()
    upgrading.start(`Upgrading to ${next}…`)
    try {
      await Installation.upgrade(method, next)
      upgrading.stop(`Upgraded to ${next}`)
      if (method === "curl" && process.platform === "win32") {
        // Windows doesn't allow overwriting a running .exe, so the upgrade
        // path renames the live binary to `lingcode.exe.old` and writes the
        // new one in place. The current process keeps running against the
        // renamed .old until it exits.
        prompts.log.info(
          "Restart your shell (or relaunch lingcode) to pick up the new binary.",
        )
      }
    } catch (err) {
      upgrading.stop("Upgrade failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }

    prompts.outro("Done")
  },
}
