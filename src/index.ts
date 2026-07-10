// opencode-openai-codex-headers
//
// Two fixes for the opencode `openai` provider on ChatGPT OAuth (the Codex
// backend). Dependency-free and `any`-typed on purpose.
//
// 1. HEADERS. opencode's built-in hook tags requests as `originator: opencode` /
//    `User-Agent: opencode/...`; the Codex backend gates newer GPT-5.6 models on
//    the client identity, so a `chat.headers` hook overrides both to the genuine
//    `codex_cli_rs` pair. Config plugins load after internal ones and every hook
//    runs against one shared output, so this override wins. It cannot lift
//    account-entitlement gates, which fail regardless of headers.
//
// 2. REASONING SUMMARIES. gpt-5.6 emits each summary part as
//    `**Bold title**\n\n<!-- -->` with no prose body, and opencode's TUI renders
//    the leading `<!-- -->` literally. opencode exposes no hook to transform
//    reasoning text, so we strip the empty marker on the wire, on BOTH transports
//    opencode uses for the Responses API:
//      - HTTP/SSE: wrap globalThis.fetch and rewrite the reasoning-delta events.
//      - WebSocket (opencode's experimental transport): that path drives the `ws`
//        package directly and never touches globalThis.fetch, so we patch
//        EventEmitter.prototype.emit, which every `ws` socket inherits, and
//        rewrite the same frames. See installWebSocketCleanup for why.

import { EventEmitter } from "node:events"

// Bump if the backend tightens the check; the gate matches the `codex_cli_rs/` prefix.
export const CODEX_USER_AGENT = "codex_cli_rs/0.144.0"

// The Responses API endpoint, matched by path suffix only (never host), so it also
// matches when the openai provider is routed through a custom baseURL / proxy.
const RESPONSES_PATH_SUFFIX = "/responses"

// Marks our wrapped fetch / patched emit so repeated plugin loads don't stack.
const PATCH_FLAG = "__opencodeCodexReasoningCleanup"
const WS_PATCH_FLAG = "__opencodeCodexReasoningCleanupWs"

// The three `*.delta` event types opencode routes into reasoning text; gpt-5.6
// uses the last. The matching `*.done` events need no cleanup.
const REASONING_DELTA_TYPES = new Set([
  "response.reasoning_text.delta",
  "response.reasoning_summary.delta",
  "response.reasoning_summary_text.delta",
])

// Terminal Responses events: after any of these no more reasoning deltas arrive,
// so a withheld dangling `<!--` must be flushed before they pass. Matched on the
// exact top-level `type` (not raw text), and includes `error`.
const TERMINAL_TYPES = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "response.incomplete",
  "error",
])
export function isTerminalType(t: unknown): boolean {
  return typeof t === "string" && TERMINAL_TYPES.has(t)
}

// Stateful rewriter that removes the empty `<!-- -->` gpt-5.6 appends after a
// summary headline. A `<!--` dangling at a delta's end is held back and dropped
// only if the next delta completes an empty marker; otherwise it is restored
// verbatim, so real content and a genuine trailing `<!--` are never lost.
export function createReasoningRewriter() {
  let carry = "" // dangling open-marker fragment withheld from a prior delta
  let carryEvent: any = null // the event it came from, reused verbatim if flushed

  // Rewrite one JSON `response.*` event in place; returns whether it changed.
  function rewriteEvent(ev: any): boolean {
    if (!ev || !REASONING_DELTA_TYPES.has(ev.type) || typeof ev.delta !== "string") return false
    const hadCarry = carry !== ""
    let out = carry + ev.delta
    carry = ""
    carryEvent = null
    out = out.replace(/<!--\s*-->/g, "") // complete empty marker(s)
    const dangling = out.match(/<!--\s*$/) // marker possibly opened at the end
    if (dangling) {
      carry = dangling[0]
      carryEvent = { ...ev } // keep item_id / summary_index for a later flush
      out = out.slice(0, out.length - dangling[0].length)
    }
    if (out === ev.delta && !hadCarry && carry === "") return false
    ev.delta = out
    return true
  }

  // Restore a never-completed dangling `<!--`: the original event (keeps item_id /
  // summary_index so opencode attributes the text right) with the delta swapped
  // for the held fragment.
  function carriedEvent(): any {
    const ev = carryEvent || { type: "response.reasoning_summary_text.delta" }
    ev.delta = carry
    carry = ""
    carryEvent = null
    return ev
  }

  // HTTP/SSE: rewrite reasoning deltas in a block of complete SSE lines, flushing
  // a withheld fragment as its own `data:` line before a terminal event or `[DONE]`
  // (opencode stops reading the body there).
  function processSseBlock(block: string): string {
    const out: string[] = []
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) {
        out.push(line)
        continue
      }
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") {
        if (carry) out.push("data: " + JSON.stringify(carriedEvent()))
        out.push(line)
        continue
      }
      if (!payload) {
        out.push(line)
        continue
      }
      let ev: any
      try {
        ev = JSON.parse(payload)
      } catch {
        out.push(line)
        continue
      }
      if (isTerminalType(ev?.type)) {
        if (carry) out.push("data: " + JSON.stringify(carriedEvent()))
        out.push(line)
        continue
      }
      out.push(rewriteEvent(ev) ? "data: " + JSON.stringify(ev) : line)
    }
    return out.join("\n")
  }

  // WebSocket: rewrite reasoning deltas in one text frame (newline-delimited raw
  // JSON, no `data:` prefix); also reports whether a terminal event appeared.
  function processFrame(frame: string): { text: string; terminal: boolean } {
    let terminal = false
    const text = frame
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        let ev: any
        try {
          ev = JSON.parse(trimmed)
        } catch {
          return line
        }
        if (isTerminalType(ev?.type)) terminal = true
        if (!rewriteEvent(ev)) return line
        return JSON.stringify(ev)
      })
      .join("\n")
    return { text, terminal }
  }

  // Emit a still-withheld fragment so a genuine trailing `<!--` is restored, not swallowed.
  function flush(): string {
    if (!carry) return ""
    return "data: " + JSON.stringify(carriedEvent())
  }

  // WebSocket equivalent of flush().
  function flushFrame(): string {
    if (!carry) return ""
    return JSON.stringify(carriedEvent())
  }

  return { processSseBlock, processFrame, flush, flushFrame }
}

// Buffer partial lines so JSON is only parsed once an SSE line is complete.
export function transformSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true }) // keep a leading BOM byte-for-byte
  const encoder = new TextEncoder()
  const rewriter = createReasoningRewriter()
  let buffer = ""
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode() // flush any trailing multibyte sequence
          let tail = buffer ? rewriter.processSseBlock(buffer) : ""
          const flushed = rewriter.flush() // restore any withheld open-marker fragment
          if (flushed) tail += (tail && !tail.endsWith("\n") ? "\n" : "") + flushed
          if (tail) controller.enqueue(encoder.encode(tail))
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        const cut = buffer.lastIndexOf("\n")
        if (cut === -1) continue
        const ready = buffer.slice(0, cut + 1)
        buffer = buffer.slice(cut + 1)
        controller.enqueue(encoder.encode(rewriter.processSseBlock(ready)))
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export function isResponsesEndpoint(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith(RESPONSES_PATH_SUFFIX)
  } catch {
    return false
  }
}

function installReasoningCleanup(): void {
  const g = globalThis as any
  const current = g.fetch
  if (typeof current !== "function" || current[PATCH_FLAG]) return
  const wrapped = async function (input: any, init?: any): Promise<Response> {
    const res = await current(input, init)
    try {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url ? input.url : ""
      // Treat a missing content-type as a stream: a proxy (e.g. Sleev) may forward
      // SSE without the header, while a real non-stream reply (an error body) still
      // declares application/json and is left untouched. Only reasoning-delta lines
      // are ever modified.
      const contentType = (res.headers.get("content-type") || "").toLowerCase()
      const isStream = contentType === "" || contentType.includes("text/event-stream")
      if (isResponsesEndpoint(url) && res.ok && res.body && isStream) {
        // Body length changes and fetch already decoded transfer encoding; drop
        // the headers that describe the original bytes.
        const headers = new Headers(res.headers)
        headers.delete("content-length")
        headers.delete("content-encoding")
        return new Response(transformSSE(res.body), {
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
  ;(wrapped as any)[PATCH_FLAG] = true
  g.fetch = wrapped
}

// Positively identify a `ws` socket before touching it (this is a process-wide
// prototype patch): duck-type on the ws API and read `url` behind try/catch, so an
// unrelated EventEmitter that merely exposes a `url` is never rewritten.
export function isWsResponsesSocket(obj: any): boolean {
  if (!obj || typeof obj.ping !== "function" || typeof obj.send !== "function" || typeof obj.readyState !== "number")
    return false
  let url: unknown
  try {
    url = obj.url
  } catch {
    return false
  }
  return typeof url === "string" && isResponsesEndpoint(url)
}

// opencode's experimental WS transport imports the `ws` package directly, so it
// is NOT reachable via globalThis.WebSocket. Every `ws` socket does, however,
// emit its inbound "message" through the shared EventEmitter.prototype, which we
// patch once. The patch returns immediately for any event other than
// "message"/"close" and for any emitter that is not an identified ws Responses
// socket, so every other emit in the process is untouched.
function installWebSocketCleanup(): void {
  const proto = EventEmitter.prototype as any
  const originalEmit = proto.emit
  if (typeof originalEmit !== "function" || originalEmit[WS_PATCH_FLAG]) return
  // Each socket keeps its own rewriter: a dangling `<!--` can span adjacent
  // frames, and pooled sockets are reused across responses.
  const rewriters = new WeakMap<object, ReturnType<typeof createReasoningRewriter>>()
  function rewriterFor(sock: object): ReturnType<typeof createReasoningRewriter> {
    let r = rewriters.get(sock)
    if (!r) {
      r = createReasoningRewriter()
      rewriters.set(sock, r)
    }
    return r
  }

  const patched = function (this: any, eventName: string, ...args: any[]): boolean {
    // Only "message"/"close" on an identified ws Responses socket is inspected.
    if (eventName !== "message" && eventName !== "close") return originalEmit.apply(this, [eventName, ...args])
    if (!isWsResponsesSocket(this)) return originalEmit.apply(this, [eventName, ...args])

    if (eventName === "message") {
      const data = args[0]
      const isBinary = args[1] === true
      if (!isBinary && data != null) {
        try {
          const text = typeof data === "string" ? data : Buffer.from(data).toString("utf-8")
          const rewriter = rewriterFor(this)
          const { text: rewritten, terminal } = rewriter.processFrame(text)
          if (rewritten !== text) args[0] = Buffer.from(rewritten, "utf-8")
          // A terminal event ends the reasoning stream: flush any withheld
          // dangling `<!--` as its own message BEFORE the terminal passes, then
          // drop the socket state so a reused pooled socket starts clean.
          if (terminal) {
            const carried = rewriter.flushFrame()
            if (carried) originalEmit.apply(this, ["message", Buffer.from(carried, "utf-8"), false])
            rewriters.delete(this)
          }
        } catch {
          // pass the frame through untouched on any error
        }
      }
    } else {
      // "close": restore any never-flushed fragment, then drop the socket state.
      const rewriter = rewriters.get(this)
      if (rewriter) {
        const carried = rewriter.flushFrame()
        if (carried) originalEmit.apply(this, ["message", Buffer.from(carried, "utf-8"), false])
        rewriters.delete(this)
      }
    }

    return originalEmit.apply(this, [eventName, ...args])
  }
  ;(patched as any)[WS_PATCH_FLAG] = true
  proto.emit = patched
}

// The `chat.headers` hook: override the two identity headers on the openai
// provider only. Exported so the benchmark variant reuses it without duplicating.
export function headersHook() {
  return async (input: any, output: any) => {
    if (input?.model?.providerID !== "openai") return
    output.headers.originator = "codex_cli_rs"
    output.headers["User-Agent"] = CODEX_USER_AGENT
  }
}

export default async () => {
  // Opt-in latency instrumentation: `CODEX_HEADERS_BENCH=/path opencode` loads the
  // dev-only benchmark variant, which reuses the exports below and adds timing.
  // dev/benchmark.ts is tracked but excluded from the published package (files:
  // ["src"]), so it is absent from npm/github installs; a failed import silently
  // falls back to the normal plugin. Only load failures are swallowed; an error
  // thrown while the module installs propagates.
  if (process.env.CODEX_HEADERS_BENCH) {
    let benchModule: any
    try {
      benchModule = await import("../dev/benchmark.ts")
    } catch {
      benchModule = undefined
    }
    if (benchModule) return await benchModule.default()
  }
  installReasoningCleanup()
  installWebSocketCleanup()
  return { "chat.headers": headersHook() }
}
