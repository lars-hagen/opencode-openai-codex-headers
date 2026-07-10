// Benchmark-instrumented variant of the plugin. DEV-ONLY: this file is tracked in
// the repo but excluded from the published package (package.json files: ["src"]),
// so a clone has it and an npm/github install does not. It measures
// HTTP-vs-WebSocket time-to-first-token for the openai/Codex Responses stream.
//
// It does NOT duplicate the marker-stripping logic. It imports the shipped plugin
// internals from ../src/index.ts via a wildcard import and only wraps them with
// latency instrumentation, so the audited pieces (createReasoningRewriter,
// transformSSE, isWsResponsesSocket, isTerminalType, isResponsesEndpoint) have a
// single source of truth. When src/index.ts changes, this file picks it up on the
// next load; never copy logic here.
//
// Usage: no config change needed. The shipped plugin (src/index.ts) dynamically
// imports this file only when CODEX_HEADERS_BENCH is set, so just run:
//   OPENCODE_EXPERIMENTAL_WEBSOCKETS=true CODEX_HEADERS_BENCH=/tmp/ch.log opencode
// Each `/responses` round trip logs `<transport> first_byte_ms=<n>` and
// `<transport> done total_ms=<n>`. Compare medians across HTTP and WS, dropping
// the cold turn-1 WS sample (its socket send is not wrapped until first frame).

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

// Passthrough wrapper around an already-transformed SSE stream that timestamps
// the first byte and completion. Reuses core.transformSSE, adds only timing.
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

  type St = { rewriter: ReturnType<typeof core.createReasoningRewriter>; start: number; count: number }
  const states = new WeakMap<object, St>()
  const lastSend = new WeakMap<object, number>()
  const sendWrapped = new WeakSet<object>()

  function stateFor(sock: object): St {
    let s = states.get(sock)
    if (!s) {
      s = { rewriter: core.createReasoningRewriter(), start: 0, count: 0 }
      states.set(sock, s)
    }
    return s
  }

  // Record the outbound response.create time so a warm socket's first inbound
  // frame yields a true first_byte_ms. Wrapped once per socket (tracked in a
  // WeakSet, never a socket property); because the wrap is installed when the
  // first inbound frame is seen, turn 1 (cold) is untimed and turns 2+ (warm,
  // reused socket) get a real time-to-first-token. Only response.create frames
  // are timestamped, so keepalive pings between request and first token cannot
  // skew the metric. All of this is best-effort: any failure here must never
  // block marker cleanup, so it is fully isolated and the send is left intact.
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
  return {
    "chat.headers": async (input: any, output: any) => {
      if (input?.model?.providerID !== "openai") return
      output.headers.originator = "codex_cli_rs"
      output.headers["User-Agent"] = core.CODEX_USER_AGENT
    },
  }
}
