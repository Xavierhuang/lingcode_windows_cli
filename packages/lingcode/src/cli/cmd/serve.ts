import { Effect } from "effect"
import path from "path"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@lingcode-ai/core/flag/flag"
import { requireLoginOrExit } from "../auth-guard"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("password", {
        type: "string",
        describe: "shared secret required to call the server (sets OPENCODE_SERVER_PASSWORD for this run)",
      })
      .option("workspace-root", {
        type: "string",
        describe: "sandbox every request's working directory to this root; paths outside it are clamped back in",
      })
      .option("max-concurrent", {
        type: "number",
        describe: "reject with HTTP 429 once this many requests are in flight (0 or unset = unlimited)",
      }),
  describe: "starts a headless lingcode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    // Inline `--password` is sugar for exporting OPENCODE_SERVER_PASSWORD; set it
    // before anything reads the auth config so the gate is active from request 1.
    if (args.password) process.env["OPENCODE_SERVER_PASSWORD"] = args.password
    if (args["workspace-root"]) {
      process.env["LINGCODE_WORKSPACE_ROOT"] = path.resolve(args["workspace-root"])
    }
    if (args["max-concurrent"] !== undefined) {
      process.env["LINGCODE_MAX_CONCURRENT"] = String(args["max-concurrent"])
    }

    // Require a usable credential before starting; the server can't serve model
    // requests without one. Prints a sign-in message and exits if not logged in.
    requireLoginOrExit()
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`lingcode server listening on http://${server.hostname}:${server.port}`)
    if (Flag.LINGCODE_WORKSPACE_ROOT) {
      console.log(`workspace sandboxed to ${Flag.LINGCODE_WORKSPACE_ROOT}`)
    }
    if (Flag.LINGCODE_MAX_CONCURRENT > 0) {
      console.log(`max concurrent requests: ${Flag.LINGCODE_MAX_CONCURRENT} (429 over limit)`)
    }

    yield* Effect.never
  }),
})
