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
//    clean header. opencode exposes no hook to transform reasoning text (the
//    native Responses parser feeds reasoning straight off the `*.delta` events;
//    packages/llm/src/protocols/openai-responses.ts), so this strips the empty
//    HTML-comment marker on the wire: it wraps globalThis.fetch and rewrites the
//    reasoning-summary `*.delta` SSE events for the Codex responses endpoint
//    before opencode parses them. After stripping, the empty body collapses and
//    only the bold headline shows (matching Codex).
//
// Dependency-free and `any`-typed on purpose: keeps the plugin trivial to load
// and resolve wherever node_modules ends up.

// Bump to match a current Codex CLI release if the backend ever tightens the
// check; the gate is prefix-based on `codex_cli_rs/`, so the version is not
// critical.
const CODEX_USER_AGENT = "codex_cli_rs/0.144.0"

// The ChatGPT/Codex Responses endpoint the built-in plugin rewrites requests to.
const CODEX_HOST = "chatgpt.com"
const CODEX_PATH = "/backend-api/codex/responses"

// Marks our wrapped fetch so repeated plugin loads don't stack interceptors.
const PATCH_FLAG = "__opencodeCodexReasoningCleanup"

// The native Responses parser routes all three of these `*.delta` events into
// reasoning text (openai-responses.ts step()); gpt-5.6 uses the last one. The
// matching `*.done` events are no-ops in the parser, so they need no cleanup.
const REASONING_DELTA_TYPES = new Set([
  "response.reasoning_text.delta",
  "response.reasoning_summary.delta",
  "response.reasoning_summary_text.delta",
])

// Remove the empty HTML-comment marker gpt-5.6 appends after a summary headline.
// Restricted to the empty marker so real comment content is never touched, and
// handles the marker being split across two consecutive delta events (observed
// as `...<!--` then ` -->`), since `<!--` and `-->` arrive as whole tokens.
function stripMarker(text: string): string {
  if (typeof text !== "string" || (!text.includes("<!--") && !text.includes("-->"))) return text
  return text
    .replace(/<!--\s*-->/g, "") // whole empty marker within one delta
    .replace(/<!--\s*$/g, "") // marker opened at the end of a delta
    .replace(/^\s*-->/g, "") // ...and closed at the start of the next delta
}

// Rewrite reasoning-summary delta text inside a block of complete SSE lines.
function processChunk(block: string): string {
  return block
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") return line
      let ev: any
      try {
        ev = JSON.parse(payload)
      } catch {
        return line
      }
      if (!REASONING_DELTA_TYPES.has(ev?.type) || typeof ev.delta !== "string") return line
      const cleaned = stripMarker(ev.delta)
      if (cleaned === ev.delta) return line
      ev.delta = cleaned
      return "data: " + JSON.stringify(ev)
    })
    .join("\n")
}

// Buffer partial lines so JSON is only parsed once an SSE line is complete.
function transformSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode() // flush any trailing multibyte sequence
          if (buffer) controller.enqueue(encoder.encode(processChunk(buffer)))
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        const cut = buffer.lastIndexOf("\n")
        if (cut === -1) continue
        const ready = buffer.slice(0, cut + 1)
        buffer = buffer.slice(cut + 1)
        controller.enqueue(encoder.encode(processChunk(ready)))
        return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function isCodexResponses(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === CODEX_HOST && parsed.pathname === CODEX_PATH
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
      // Only the Codex Responses endpoint, and only reasoning-summary delta
      // lines are ever modified; every other line passes through unchanged.
      if (isCodexResponses(url) && res.ok && res.body) {
        return new Response(transformSSE(res.body), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
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

export default () => {
  installReasoningCleanup()
  return {
    "chat.headers": async (input: any, output: any) => {
      if (input?.model?.providerID !== "openai") return
      output.headers.originator = "codex_cli_rs"
      output.headers["User-Agent"] = CODEX_USER_AGENT
    },
  }
}
