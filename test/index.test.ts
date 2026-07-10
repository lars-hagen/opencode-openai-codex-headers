import { describe, test, expect, beforeAll } from "bun:test"
import { EventEmitter } from "node:events"
import * as core from "../src/index.ts"

// --- helpers ---------------------------------------------------------------

const enc = new TextEncoder()
const sseBlock = (events: any[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")

async function runSSE(input: string): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(input))
      c.close()
    },
  })
  return await new Response(core.transformSSE(stream)).text()
}

// Stream that emits its chunks separately, to exercise line buffering across reads.
async function runSSEChunks(chunks: string[]): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
  return await new Response(core.transformSSE(stream)).text()
}

class FakeWs extends EventEmitter {
  url: string
  readyState = 1
  constructor(url: string) {
    super()
    this.url = url
  }
  ping() {}
  send() {}
  close() {}
}
const collect = (sock: EventEmitter): string[] => {
  const out: string[] = []
  sock.on("message", (d: any) => out.push(typeof d === "string" ? d : Buffer.from(d).toString("utf-8")))
  return out
}

const DELTA = "response.reasoning_summary_text.delta"

// --- exported helpers ------------------------------------------------------

describe("isResponsesEndpoint", () => {
  test("matches any host whose path ends in /responses", () => {
    expect(core.isResponsesEndpoint("https://chatgpt.com/backend-api/codex/responses")).toBe(true)
    expect(core.isResponsesEndpoint("http://127.0.0.1:17321/v1/responses")).toBe(true)
    expect(core.isResponsesEndpoint("http://127.0.0.1:17321/responses")).toBe(true)
  })
  test("rejects other paths and garbage", () => {
    expect(core.isResponsesEndpoint("https://api.anthropic.com/v1/messages")).toBe(false)
    expect(core.isResponsesEndpoint("https://x/responses/extra")).toBe(false)
    expect(core.isResponsesEndpoint("not a url")).toBe(false)
  })
})

describe("isWsResponsesSocket", () => {
  test("true for a ws-like object with a /responses url", () => {
    expect(core.isWsResponsesSocket(new FakeWs("wss://x/responses"))).toBe(true)
  })
  test("false for a plain EventEmitter even with a matching url", () => {
    const e: any = new EventEmitter()
    e.url = "wss://x/responses"
    expect(core.isWsResponsesSocket(e)).toBe(false)
  })
  test("false and safe when url getter throws", () => {
    const e: any = new FakeWs("wss://x/responses")
    Object.defineProperty(e, "url", {
      get() {
        throw new Error("boom")
      },
    })
    expect(core.isWsResponsesSocket(e)).toBe(false)
  })
})

describe("isTerminalType", () => {
  test("recognizes terminal event types incl error", () => {
    for (const t of ["response.completed", "response.done", "response.failed", "response.incomplete", "error"]) {
      expect(core.isTerminalType(t)).toBe(true)
    }
  })
  test("rejects deltas and non-strings", () => {
    expect(core.isTerminalType(DELTA)).toBe(false)
    expect(core.isTerminalType(undefined)).toBe(false)
    expect(core.isTerminalType(42)).toBe(false)
  })
})

// --- HTTP/SSE marker stripping --------------------------------------------

describe("transformSSE marker stripping", () => {
  test("strips a whole empty marker and keeps the headline", async () => {
    const out = await runSSE(sseBlock([{ type: DELTA, delta: "**Plan**\n\n<!-- -->" }, { type: "response.completed" }]))
    expect(out).not.toContain("<!-- -->")
    expect(out).toContain("**Plan**")
  })

  test("strips a marker split across two consecutive deltas without corruption", async () => {
    const out = await runSSE(
      sseBlock([
        { type: DELTA, delta: "**T**\n\n<!--" },
        { type: DELTA, delta: " -->" },
        { type: "response.completed" },
      ]),
    )
    expect(out).not.toContain("<!--")
    expect(out).not.toContain("-->")
    expect(out).toContain("**T**")
  })

  test("restores a genuine dangling <!-- that never completes (no content loss)", async () => {
    const out = await runSSE(sseBlock([{ type: DELTA, delta: "keep <!--" }, { type: "response.completed" }]))
    expect(out).toContain("<!--")
    expect(out).toContain("keep")
  })

  test("leaves a non-empty real comment untouched", async () => {
    const out = await runSSE(sseBlock([{ type: DELTA, delta: "<!-- real note -->" }, { type: "response.completed" }]))
    expect(out).toContain("<!-- real note -->")
  })

  test("leaves non-reasoning events untouched", async () => {
    const out = await runSSE(sseBlock([{ type: "response.output_text.delta", delta: "<!-- -->" }]))
    expect(out).toContain("<!-- -->")
  })

  test("handles a marker split across a network chunk boundary mid-line", async () => {
    const line = `data: ${JSON.stringify({ type: DELTA, delta: "**Z**\n\n<!-- -->" })}\n\n`
    const mid = Math.floor(line.length / 2)
    const out = await runSSEChunks([line.slice(0, mid), line.slice(mid)])
    expect(out).not.toContain("<!-- -->")
    expect(out).toContain("**Z**")
  })

  test("preserves a leading BOM byte-for-byte", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0xef, 0xbb, 0xbf]))
        c.enqueue(enc.encode(sseBlock([{ type: DELTA, delta: "hi" }])))
        c.close()
      },
    })
    const buf = new Uint8Array(await new Response(core.transformSSE(stream)).arrayBuffer())
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf])
  })
})

// --- WebSocket marker stripping (via the emit patch installed by default()) --

describe("WebSocket transport", () => {
  let headers: any
  beforeAll(async () => {
    const plugin = (await import("../src/index.ts")).default
    headers = await plugin() // installs the fetch wrap + emit patch once
  })

  test("strips markers on a ws /responses socket", () => {
    const ws = new FakeWs("wss://chatgpt.com/backend-api/codex/responses")
    const out = collect(ws)
    ws.emit("message", JSON.stringify({ type: DELTA, delta: "**Scope**\n\n<!-- -->" }), false)
    ws.emit("message", JSON.stringify({ type: "response.completed" }), false)
    expect(out.some((m) => m.includes("**Scope**"))).toBe(true)
    expect(out.some((m) => m.includes("<!-- -->"))).toBe(false)
  })

  test("flushes a dangling <!-- before a terminal frame", () => {
    const ws = new FakeWs("wss://x/responses")
    const out = collect(ws)
    ws.emit("message", JSON.stringify({ type: DELTA, delta: "tail <!--" }), false)
    ws.emit("message", JSON.stringify({ type: "response.completed" }), false)
    const joined = out.join("")
    expect(joined).toContain("<!--")
    // the restored fragment is emitted before the terminal event
    expect(out.findIndex((m) => m.includes("<!--"))).toBeLessThan(out.findIndex((m) => m.includes("response.completed")))
  })

  test("does not touch binary frames", () => {
    const ws = new FakeWs("wss://x/responses")
    const out = collect(ws)
    const payload = JSON.stringify({ type: DELTA, delta: "**B**\n\n<!-- -->" })
    ws.emit("message", Buffer.from(payload, "utf-8"), true)
    expect(out[0]).toContain("<!-- -->")
  })

  test("blast radius: a plain EventEmitter with a /responses url is untouched", () => {
    const e: any = new EventEmitter()
    e.url = "wss://x/responses"
    let got: any
    e.on("message", (d: any) => (got = d))
    e.emit("message", "raw <!-- --> text", false)
    expect(got).toBe("raw <!-- --> text")
  })

  test("blast radius: unrelated events on a ws socket pass through", () => {
    const ws = new FakeWs("wss://x/responses")
    let closed = false
    ws.on("someEvent", () => (closed = true))
    ws.emit("someEvent")
    expect(closed).toBe(true)
  })
})

// --- chat.headers hook -----------------------------------------------------

describe("chat.headers hook", () => {
  test("spoofs the Codex signature for the openai provider only", async () => {
    const plugin = (await import("../src/index.ts")).default
    const hooks: any = await plugin()

    const openai = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]({ model: { providerID: "openai" } }, openai)
    expect(openai.headers.originator).toBe("codex_cli_rs")
    expect(openai.headers["User-Agent"]).toBe(core.CODEX_USER_AGENT)

    const anthropic = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]({ model: { providerID: "anthropic" } }, anthropic)
    expect(anthropic.headers).toEqual({})
  })
})
