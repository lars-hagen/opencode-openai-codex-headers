// opencode-openai-codex-headers
//
// Two fixes for opencode on ChatGPT OAuth (the Codex backend at
// chatgpt.com/backend-api/codex), both scoped to the openai provider:
//
// 1. HEADERS. opencode's built-in CodexAuthPlugin sets `originator: "opencode"`
//    and `User-Agent: opencode/<version> (...)` on every openai request via its
//    "chat.headers" hook (packages/opencode/src/plugin/openai/codex.ts). OpenAI's
//    Codex backend gates newer models on the client identity:
//      - gpt-5.6-luna  -> HTTP 404 "Model not found" unless BOTH originator AND
//                         User-Agent are the codex_cli_rs pair
//      - gpt-5.6-terra -> served, but deprioritized ("server_is_overloaded"
//                         load-shed) for non-codex clients under contention
//    Both clear once the request presents the genuine Codex CLI signature.
//    Config plugins load AFTER internal plugins, and Plugin.trigger runs every
//    "chat.headers" hook in order against one shared `output`, so this override
//    lands last and wins. It cannot help entitlement-blocked models such as
//    gpt-5.6-sol, which return HTTP 400 "not supported when using Codex with a
//    ChatGPT account" regardless of headers.
//
// 2. REASONING SUMMARIES. gpt-5.6 emits reasoning summaries in a new
//    headline format: each part is `**Bold title**\n\n<!-- -->` with no prose
//    body. opencode's TUI summary parser (packages/tui/src/context/thinking.ts)
//    takes the leading `**bold**` as the title and renders the rest as the body,
//    so 5.6 "Thought" blocks show the literal `<!-- -->` marker instead of a
//    clean header. opencode exposes no hook to transform reasoning text, so this
//    strips the empty HTML-comment marker on the wire, on BOTH transports opencode
//    can use for the Responses API:
//      - HTTP/SSE: wraps globalThis.fetch and rewrites the reasoning-summary
//        `*.delta` SSE events for any Responses endpoint (matched by `/responses`
//        path suffix, so it also covers a proxied/custom baseURL) before opencode
//        parses them.
//      - WebSocket (opencode's experimental transport, OPENCODE_EXPERIMENTAL_WEBSOCKETS
//        or channel local/dev/beta): that path bypasses globalThis.fetch and drives
//        the `ws` package directly (packages/opencode/src/plugin/openai/ws.ts),
//        delivering one JSON `response.*` event per text frame. We patch
//        EventEmitter.prototype.emit (which every `ws` socket inherits) and rewrite
//        the same reasoning-delta frames for sockets whose url ends in `/responses`.
//    After stripping, the empty body collapses and only the bold headline shows.
//
// Dependency-free and `any`-typed on purpose: keeps the plugin trivial to load
// and resolve wherever node_modules ends up.

import { EventEmitter } from "node:events"

// Bump to match a current Codex CLI release if the backend ever tightens the
// check; the gate is prefix-based on `codex_cli_rs/`, so the version is not
// critical.
export const CODEX_USER_AGENT = "codex_cli_rs/0.144.0"

// The Responses API endpoint carrying reasoning-summary events. Matched by path
// suffix only (never host), the same way opencode scopes it internally
// (ws-pool.ts, llm.test.ts). Host-agnostic so it also matches when the openai
// provider is routed through a custom baseURL / proxy such as Sleev, where the
// URL is e.g. http://127.0.0.1:17321/v1/responses instead of chatgpt.com.
const RESPONSES_PATH_SUFFIX = "/responses"

// Marks our wrapped fetch / patched emit so repeated plugin loads don't stack.
const PATCH_FLAG = "__opencodeCodexReasoningCleanup"
const WS_PATCH_FLAG = "__opencodeCodexReasoningCleanupWs"

// The native Responses parser routes all three of these `*.delta` events into
// reasoning text (openai-responses.ts step()); gpt-5.6 uses the last one. The
// matching `*.done` events are no-ops in the parser, so they need no cleanup.
const REASONING_DELTA_TYPES = new Set([
  "response.reasoning_text.delta",
  "response.reasoning_summary.delta",
  "response.reasoning_summary_text.delta",
])

// Terminal Responses events: after any of these no more reasoning deltas arrive,
// so a still-withheld dangling `<!--` fragment must be flushed before they pass.
// Matched on the exact top-level event `type` (not a raw-text regex, which could
// hit a nested field), and includes `error`, which opencode treats as terminal.
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

// A stateful rewriter that removes the empty HTML-comment marker gpt-5.6 appends
// after a summary headline. It strips only the empty `<!-- -->` marker, so real
// comment content is never dropped, and it reconstructs the marker when it is
// split across two consecutive reasoning deltas (observed as `...<!--` then
// ` -->`) WITHOUT corrupting content: a dangling `<!--` at a delta's end is held
// back and only removed once the next reasoning delta completes the empty
// marker; otherwise the held text is restored verbatim (prepended to the next
// delta, or flushed at stream end), so a genuine trailing `<!--` is never lost.
export function createReasoningRewriter() {
  let carry = "" // dangling open-marker fragment withheld from a prior delta
  let carryEvent: any = null // the event it came from, reused verbatim if flushed

  // Rewrite a single JSON `response.*` event object in place. Returns true if the
  // delta changed (or carry state advanced). Shared by the SSE and WS paths.
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

  // Build the event that restores a never-completed dangling `<!--`: the original
  // event (keeping its item_id / summary_index so opencode attributes the text to
  // the right reasoning item) with only the delta swapped for the held fragment.
  function carriedEvent(): any {
    const ev = carryEvent || { type: "response.reasoning_summary_text.delta" }
    ev.delta = carry
    carry = ""
    carryEvent = null
    return ev
  }

  // HTTP/SSE: rewrite reasoning-delta text inside a block of complete SSE lines.
  // A withheld fragment is flushed as its own `data:` line immediately before a
  // terminal event or `[DONE]`, since opencode stops reading the body there.
  function process(block: string): string {
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

  // WebSocket: rewrite reasoning-delta text inside one text frame (one or more
  // newline-delimited raw JSON events, no `data:` prefix). Also reports whether
  // the frame held a terminal event so the caller can flush before it passes.
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

  // Emit any still-withheld fragment as its own SSE line so a genuine trailing
  // `<!--` that was never completed is restored rather than swallowed.
  function flush(): string {
    if (!carry) return ""
    return "data: " + JSON.stringify(carriedEvent())
  }

  // WebSocket equivalent of flush(): the withheld fragment as a bare JSON frame.
  function flushFrame(): string {
    if (!carry) return ""
    return JSON.stringify(carriedEvent())
  }

  return { process, processFrame, flush, flushFrame }
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
          let tail = buffer ? rewriter.process(buffer) : ""
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
        controller.enqueue(encoder.encode(rewriter.process(ready)))
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
      // Only Responses-API SSE streams, and only reasoning-summary delta lines
      // are ever modified; every other line passes through unchanged. Treat a
      // missing content-type as a stream: a proxy (e.g. Sleev) may forward the
      // SSE without the header, while a real non-stream reply (an error body)
      // still declares application/json and is left untouched.
      const contentType = (res.headers.get("content-type") || "").toLowerCase()
      const isStream = contentType === "" || contentType.includes("text/event-stream")
      if (isResponsesEndpoint(url) && res.ok && res.body && isStream) {
        // Rewriting the body changes its length, and the underlying fetch has
        // already decoded any transfer encoding, so drop the headers that would
        // otherwise describe the original bytes.
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

// Positively identify a `ws` WebSocket before touching it: duck-type on the
// ws-specific API (ping/send/readyState) so an unrelated EventEmitter that merely
// exposes a `url` is never rewritten, and read `url` behind a try/catch in case
// it is a throwing getter. This keeps the shared prototype patch inert elsewhere.
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
    // Fast path: nothing but "message"/"close" on an identified ws Responses
    // socket is ever inspected; url is only read once past the event-name gate.
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

export default async () => {
  // Opt-in latency instrumentation. `CODEX_HEADERS_BENCH=/path/to/log opencode`
  // loads the local-only benchmark variant (.dev/index.bench.ts, gitignored),
  // which reuses the exports above and adds first_byte/done timing on both the
  // HTTP and WebSocket transports. That folder is absent in published/github
  // installs, so a missing or failed import silently falls back to the normal
  // plugin below. No behavior change unless the env var is set.
  if (process.env.CODEX_HEADERS_BENCH) {
    let benchModule: any
    try {
      benchModule = await import("../dev/benchmark.ts")
    } catch {
      // dev/benchmark.ts is tracked in the repo but excluded from the published
      // package (files: ["src"]), so it is present in a clone but absent from an
      // npm/github install: in that case fall back to the normal plugin. Only a
      // failure to LOAD the module is swallowed here; if the module loads, any
      // error it throws while installing propagates rather than silently stacking
      // core over a partial benchmark install.
      benchModule = undefined
    }
    if (benchModule) return await benchModule.default()
  }
  installReasoningCleanup()
  installWebSocketCleanup()
  return {
    "chat.headers": async (input: any, output: any) => {
      if (input?.model?.providerID !== "openai") return
      output.headers.originator = "codex_cli_rs"
      output.headers["User-Agent"] = CODEX_USER_AGENT
    },
  }
}
