// Benchmark-instrumented variant of the plugin. DEV-ONLY: tracked in the repo but
// excluded from the published package (package.json files: ["src"]), so a clone
// has it and an npm/github install does not. Measures HTTP-vs-WebSocket
// time-to-first-token for the Codex Responses stream.
//
// It does not duplicate marker logic: it imports the shipped internals from
// ../src/index.ts and only adds timing, so there is a single source of truth.
//
// Usage (no config change; src/index.ts imports this only when the env var is set):
//   OPENCODE_EXPERIMENTAL_WEBSOCKETS=true CODEX_HEADERS_BENCH=/tmp/ch.log opencode
// Each `/responses` round trip logs `<transport> first_byte_ms` and `done total_ms`.

import { EventEmitter } from "node:events"
import { appendFileSync } from "node:fs"
import * as core from "../src/index.ts"

const BENCH_FILE = process.env.CODEX_HEADERS_BENCH || ""
function bench(line: string): void {
  if (!BENCH_FILE) return
  try {
    appendFileSync(BENCH_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // best effort; never break the stream on a logging failure
  }
}

// Timestamp first-byte and completion of an already-transformed SSE stream.
function timeStream(src: ReadableStream<Uint8Array>, label: string, start: number): ReadableStream<Uint8Array> {
  const reader = src.getReader()
  let first = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        bench(`${label} done total_ms=${Date.now() - start}`)
        controller.close()
        return
      }
      if (!first) {
        first = true
        bench(`${label} first_byte_ms=${Date.now() - start}`)
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

const HTTP_FLAG = "__opencodeCodexBenchHttp"
function installHttpBench(): void {
  const g = globalThis as any
  const current = g.fetch
  if (typeof current !== "function" || current[HTTP_FLAG]) return
  const wrapped = async function (input: any, init?: any): Promise<Response> {
    const res = await current(input, init)
    try {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url ? input.url : ""
      const contentType = (res.headers.get("content-type") || "").toLowerCase()
      const isStream = contentType === "" || contentType.includes("text/event-stream")
      if (core.isResponsesEndpoint(url) && res.ok && res.body && isStream) {
        const headers = new Headers(res.headers)
        headers.delete("content-length")
        headers.delete("content-encoding")
        const start = Date.now()
        return new Response(timeStream(core.transformSSE(res.body), "http", start), {
          status: res.status,
          statusText: res.statusText,
          headers,
        })
      }
    } catch {
      // fall through to the untouched response
    }
    return res
  }
  ;(wrapped as any)[HTTP_FLAG] = true
  g.fetch = wrapped
}

const WS_FLAG = "__opencodeCodexBenchWs"
function installWsBench(): void {
  const proto = EventEmitter.prototype as any
  const originalEmit = proto.emit
  if (typeof originalEmit !== "function" || originalEmit[WS_FLAG]) return

  type SocketState = { rewriter: ReturnType<typeof core.createReasoningRewriter>; start: number; count: number }
  const states = new WeakMap<object, SocketState>()
  const lastSend = new WeakMap<object, number>()
  const sendWrapped = new WeakSet<object>()

  function stateFor(sock: object): SocketState {
    let s = states.get(sock)
    if (!s) {
      s = { rewriter: core.createReasoningRewriter(), start: 0, count: 0 }
      states.set(sock, s)
    }
    return s
  }

  // Record the outbound response.create time so a warm socket's first inbound frame
  // yields a true first_byte_ms. The wrap is installed on the first inbound frame,
  // so turn 1 (cold) is untimed and turns 2+ (warm, reused socket) are measured;
  // only response.create frames are timestamped, so keepalive pings do not skew it.
  // Best-effort and fully isolated: a non-writable send must never block cleanup.
  function timeSends(sock: any): void {
    if (sendWrapped.has(sock)) return
    try {
      const origSend = sock.send
      if (typeof origSend !== "function") return
      sock.send = function (this: any, ...a: any[]) {
        try {
          const frame = typeof a[0] === "string" ? a[0] : a[0] != null ? Buffer.from(a[0]).toString("utf-8") : ""
          if (frame.includes("response.create")) lastSend.set(sock, Date.now())
        } catch {
          // ignore un-inspectable frames; timing just stays unset for this send
        }
        return origSend.apply(this, a)
      }
      sendWrapped.add(sock)
    } catch {
      // socket non-extensible / send non-writable: skip timing, never block cleanup
    }
  }

  const patched = function (this: any, eventName: string, ...args: any[]): boolean {
    if (eventName !== "message" && eventName !== "close") return originalEmit.apply(this, [eventName, ...args])
    if (!core.isWsResponsesSocket(this)) return originalEmit.apply(this, [eventName, ...args])

    if (eventName === "message") {
      const data = args[0]
      const isBinary = args[1] === true
      if (!isBinary && data != null) {
        try {
          const text = typeof data === "string" ? data : Buffer.from(data).toString("utf-8")
          timeSends(this)
          const st = stateFor(this)
          if (st.count === 0) {
            st.start = Date.now()
            const sent = lastSend.get(this)
            if (sent) bench(`ws first_byte_ms=${st.start - sent}`)
          }
          st.count++
          const { text: rewritten, terminal } = st.rewriter.processFrame(text)
          if (rewritten !== text) args[0] = Buffer.from(rewritten, "utf-8")
          if (terminal) {
            const carried = st.rewriter.flushFrame()
            if (carried) originalEmit.apply(this, ["message", Buffer.from(carried, "utf-8"), false])
            bench(`ws done frames=${st.count} total_ms=${Date.now() - st.start}`)
            states.delete(this)
          }
        } catch {
          // pass the frame through untouched on any error
        }
      }
    } else {
      const st = states.get(this)
      if (st) {
        const carried = st.rewriter.flushFrame()
        if (carried) originalEmit.apply(this, ["message", Buffer.from(carried, "utf-8"), false])
        bench(`ws close frames=${st.count} total_ms=${st.start ? Date.now() - st.start : 0}`)
        states.delete(this)
      }
    }

    return originalEmit.apply(this, [eventName, ...args])
  }
  ;(patched as any)[WS_FLAG] = true
  proto.emit = patched
}

export default () => {
  installHttpBench()
  installWsBench()
  return { "chat.headers": core.headersHook() }
}
