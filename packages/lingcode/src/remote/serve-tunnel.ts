// Remote-coding serve tunnel (HOST side).
//
// Faithful port of the macOS app's `collab-bridge/bridge.mjs` serve-host logic
// (openServeHost / onServeHostMessage / handleServeRequest / serveSend). Joins
// the relay room's `__serve` document over y-websocket, announces itself as the
// host, and answers `lc-serve-request` frames by calling the local headless
// `lingcode serve` over loopback — streaming the response back as
// `lc-serve-response-head` + `…-chunk`(s) + `…-close`/`…-error`.
//
// This is what gives the web remote-control zero-setup reach: the phone talks to
// the hosted relay, the relay routes frames to whichever host is online, and the
// host (this process) proxies them to its loopback server.
//
// Why JSON frames are sent as BINARY (Buffer): y-websocket peers feed every
// message through the Yjs decoder. A text JSON frame is mis-decoded and throws;
// a binary frame whose first byte is '{' (0x7b) is an unknown Yjs messageType
// that decoders ignore, while our 0x7b sniff still picks it up. (See the long
// comment in bridge.mjs.)

import * as Y from "yjs"
import { WebsocketProvider } from "y-websocket"
import WebSocket from "ws"

export interface ServeTunnelOptions {
  /** Relay base, e.g. `wss://lingcode.dev/ws/collab` (no trailing host-id/query). */
  wsBase: string
  /** The remote_hosts row id — the room this host serves. */
  roomId: string
  /** LingCode Cloud token, passed to the relay as `?token=`. */
  relayToken?: string
  /** Loopback port of the local `lingcode serve`. */
  servePort: number
  /** `Authorization` header value for the loopback server (Basic, from ServerAuth). */
  authHeader?: string
  log?: (msg: string) => void
  /** Fired when the relay acks our hello — the real proof we're reachable. */
  onRegistered?: () => void
}

type Frame = { type: string; [key: string]: unknown }

/** Start the tunnel. Returns a stop function that aborts streams and disconnects. */
export function startServeTunnel(opts: ServeTunnelOptions): () => void {
  const log = opts.log ?? (() => {})
  const ydoc = new Y.Doc()
  const provider = new WebsocketProvider(`${opts.wsBase}/${opts.roomId}`, "__serve", ydoc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    connect: true,
    params: opts.relayToken ? { token: opts.relayToken } : {},
  })

  // streamId → AbortController, so a cancelled/closing stream stops its fetch.
  const streams = new Map<string, AbortController>()

  const serveSend = (obj: Frame) => {
    const ws = (provider as unknown as { ws: WebSocket | null }).ws
    if (!ws || ws.readyState !== 1 /* OPEN */) return
    try {
      ws.send(Buffer.from(JSON.stringify(obj)))
    } catch {
      /* socket closed mid-send */
    }
  }

  const handleServeRequest = async (req: Frame) => {
    const streamId = typeof req.streamId === "string" ? req.streamId : ""
    if (!streamId) return
    const ac = new AbortController()
    streams.set(streamId, ac)
    try {
      const method = String(req.method ?? "GET").toUpperCase()
      const path = typeof req.path === "string" && req.path ? req.path : "/"
      const url = `http://127.0.0.1:${opts.servePort}${path}`
      const headers: Record<string, string> = { ...((req.headers as Record<string, string>) ?? {}) }
      if (opts.authHeader) headers["authorization"] = opts.authHeader
      let body: string | undefined
      if (method !== "GET" && method !== "HEAD" && req.body != null) {
        body = typeof req.body === "string" ? req.body : JSON.stringify(req.body)
        if (!headers["content-type"]) headers["content-type"] = "application/json"
      }

      const resp = await fetch(url, { method, headers, body, signal: ac.signal })
      const respHeaders: Record<string, string> = {}
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v
      })
      serveSend({ type: "lc-serve-response-head", streamId, status: resp.status, headers: respHeaders })

      if (resp.body) {
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          if (text) serveSend({ type: "lc-serve-response-chunk", streamId, text })
        }
        const tail = decoder.decode()
        if (tail) serveSend({ type: "lc-serve-response-chunk", streamId, text: tail })
      }
      serveSend({ type: "lc-serve-close", streamId })
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError"
      serveSend({
        type: aborted ? "lc-serve-close" : "lc-serve-error",
        streamId,
        message: aborted ? "cancelled" : e instanceof Error ? e.message : String(e),
      })
    } finally {
      streams.delete(streamId)
    }
  }

  const onServeHostMessage = (data: unknown) => {
    const buf = toBuffer(data)
    if (!buf || buf.length === 0 || buf[0] !== 0x7b /* '{' */) return // skip Yjs binary
    let parsed: Frame
    try {
      parsed = JSON.parse(buf.toString("utf8"))
    } catch {
      return
    }
    if (!parsed || typeof parsed.type !== "string") return
    if (parsed.type === "lc-serve-request") {
      void handleServeRequest(parsed)
      return
    }
    if (parsed.type === "lc-serve-cancel") {
      const ac = streams.get(String(parsed.streamId))
      if (ac) {
        try {
          ac.abort()
        } catch {
          /* already done */
        }
      }
      return
    }
    if (parsed.type === "lc-serve-host-ack") {
      log("registered with relay — reachable from the web")
      opts.onRegistered?.()
      return
    }
    // lc-agent-* live-session-mirror frames are intentionally not handled here:
    // they mirror an open GUI agent tab, which a headless CLI host has none of.
  }

  // y-websocket swaps its ws on every (re)connect, so rehook + resend the hello
  // each time. We wrap ws.onmessage to divert our JSON frames away from the Yjs
  // decoder (which would throw on them) and forward only genuine Yjs binary.
  const announce = () => {
    const ws = (provider as unknown as { ws: (WebSocket & { __lcServeHooked?: boolean; onmessage?: unknown }) | null }).ws
    if (!ws) return
    if (!ws.__lcServeHooked) {
      ws.__lcServeHooked = true
      const yjsOnMessage = ws.onmessage as ((event: { data: unknown }) => void) | undefined
      ;(ws as unknown as { onmessage: (event: { data: unknown }) => void }).onmessage = (event) => {
        const data = event?.data
        let isJson = false
        if (typeof data === "string") {
          isJson = data.charCodeAt(0) === 0x7b
        } else if (data != null) {
          const buf = toBuffer(data)
          isJson = !!buf && buf.length > 0 && buf[0] === 0x7b
        }
        if (isJson) {
          onServeHostMessage(data)
          return
        }
        if (yjsOnMessage) yjsOnMessage.call(ws, event)
      }
    }
    try {
      ws.send(Buffer.from(JSON.stringify({ type: "lc-serve-host-hello" })))
    } catch {
      /* not open yet — a later status/sync event will retry */
    }
  }

  provider.on("status", (ev: { status: string }) => {
    log(`relay ${ev.status}`)
    if (ev.status === "connected") announce()
  })
  provider.on("sync", (synced: boolean) => {
    if (synced) announce()
  })
  if ((provider as unknown as { ws: WebSocket | null }).ws) announce()

  return () => {
    for (const [, ac] of streams) {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
    }
    streams.clear()
    try {
      provider.destroy()
    } catch {
      /* ignore */
    }
    try {
      ydoc.destroy()
    } catch {
      /* ignore */
    }
  }
}

function toBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[])
  if (typeof data === "string") return Buffer.from(data)
  if (data && typeof data === "object") {
    try {
      return Buffer.from(data as Uint8Array)
    } catch {
      return null
    }
  }
  return null
}
