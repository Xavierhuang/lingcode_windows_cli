import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import os from "node:os"
import { UI } from "../ui"
import { effectCmd, CliError } from "../effect-cmd"
import { Cloud } from "@/cloud/cloud"
import { ServerAuth } from "@/server/auth"
import { Process } from "@/util/process"
import { startServeTunnel } from "@/remote/serve-tunnel"

/**
 * `lingcode remote` — share this machine for zero-setup remote control from the
 * LingCode web app. Registers the machine as a remote host, starts a private
 * loopback `lingcode serve`, and tunnels the hosted relay to it (the same shape
 * as the macOS app's RemoteCodingService + collab-bridge). Runs until Ctrl-C.
 */
export const RemoteCommand = effectCmd({
  command: "remote",
  describe: "share this project for zero-setup remote control from the LingCode web app",
  instance: false,
  handler: Effect.fn("Cli.remote")(function* () {
    const token = yield* Cloud.requireToken().pipe(Effect.mapError((e) => new CliError({ message: e.message })))

    yield* Effect.tryPromise({
      try: () => run(token),
      catch: (e) => new CliError({ message: Cloud.errMsg(e) }),
    })
  }),
})

type HostRegistration = {
  ok: boolean
  host: { id: string; name: string }
  wsUrl: string
}

async function run(token: string): Promise<void> {
  // 1. Register this machine as a remote host with LingCode Cloud.
  const res = await fetch(`${Cloud.apiBase()}/api/remote/hosts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: os.hostname() }),
  })
  if (!res.ok) throw new Error(`host registration failed: ${res.status} ${res.statusText}`)
  const reg = (await res.json()) as HostRegistration
  const hostId = reg.host.id
  const wsBase = deriveWsBase(reg.wsUrl)
  UI.println(`Registered host ${reg.host.name} (${hostId})`)

  // 2. Start a private loopback `lingcode serve`. A fresh per-run password
  //    secures it; the tunnel authenticates loopback requests with the matching
  //    Basic header (ServerAuth), so only this tunnel can reach the server.
  const servePassword = randomUUID()
  const child = Process.spawn(["lingcode", "serve", "--hostname", "127.0.0.1"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: servePassword },
  })
  const servePort = await readServePort(child)
  const authHeader = ServerAuth.header({ password: servePassword })
  UI.println(`Local server on http://127.0.0.1:${servePort}`)

  // 3. Tunnel the relay ⇄ the loopback server.
  const stopTunnel = startServeTunnel({
    wsBase,
    roomId: hostId,
    relayToken: token,
    servePort,
    authHeader,
    log: (msg) => process.stderr.write(`  ${msg}\n`),
    onRegistered: () =>
      UI.println(`Reachable now — open ${Cloud.apiBase()}/remote-control.html on your phone.`),
  })

  UI.println(`Sharing — press Ctrl-C to stop.`)

  // 4. Run until interrupted or the local server dies; then clean up.
  await new Promise<void>((resolve) => {
    let done = false
    const shutdown = () => {
      if (done) return
      done = true
      try {
        stopTunnel()
      } catch {
        /* ignore */
      }
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve()
    }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
    void child.exited.then(() => shutdown())
  })
}

/**
 * The relay returns a wsUrl like `wss://host/ws/collab/<host-id>?token=…`.
 * y-websocket appends `/<roomId>/<file>` itself, so strip the trailing host-id
 * segment and the query to get the base `wss://host/ws/collab`.
 */
function deriveWsBase(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.search = ""
  const segments = url.pathname.replace(/\/$/, "").split("/")
  const last = segments[segments.length - 1]
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)) {
    segments.pop()
  }
  url.pathname = segments.join("/")
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "")
}

/** Read the `listening on http://127.0.0.1:PORT` line from the serve subprocess. */
function readServePort(child: ReturnType<typeof Process.spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for `lingcode serve`")), 30_000)
    let buffered = ""
    const onData = (chunk: Buffer) => {
      buffered += String(chunk)
      const match = buffered.match(/https?:\/\/[^\s]*?:(\d+)/)
      if (match) {
        clearTimeout(timer)
        child.stdout?.off("data", onData)
        resolve(Number.parseInt(match[1], 10))
      }
    }
    child.stdout?.on("data", onData)
    void child.exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`\`lingcode serve\` exited (${code}) before listening`))
    })
  })
}
