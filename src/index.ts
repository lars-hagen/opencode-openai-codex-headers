// opencode-openai-codex-headers
//
// Identify OpenAI (ChatGPT OAuth / Codex backend) requests as the real Codex CLI.
//
// opencode's built-in CodexAuthPlugin sets `originator: "opencode"` and a
// `User-Agent: opencode/<version> (...)` on every openai request via its
// "chat.headers" hook (packages/opencode/src/plugin/openai/codex.ts). OpenAI's Codex
// backend (chatgpt.com/backend-api/codex) gates newer models on the client identity:
//   - gpt-5.6-luna  -> HTTP 404 "Model not found" unless BOTH originator AND
//                      User-Agent are the codex_cli_rs pair
//   - gpt-5.6-terra -> served, but deprioritized ("server_is_overloaded" load-shed)
//                      for non-codex clients under contention
// Both clear once the request presents the genuine Codex CLI signature.
//
// Config plugins load AFTER internal plugins, and Plugin.trigger runs every
// "chat.headers" hook in order against one shared `output`, so this override lands
// last and wins. Scope: providerID === "openai" only; all other providers untouched.
// It cannot help entitlement-blocked models such as gpt-5.6-sol, which return HTTP
// 400 "not supported when using Codex with a ChatGPT account" regardless of headers.
//
// Dependency-free and `any`-typed on purpose: keeps the plugin trivial to load and
// resolve wherever node_modules ends up.

// Bump to match a current Codex CLI release if the backend ever tightens the check;
// the gate is prefix-based on `codex_cli_rs/`, so the exact version is not critical.
const CODEX_USER_AGENT = "codex_cli_rs/0.144.0"

export default () => ({
  "chat.headers": async (input: any, output: any) => {
    if (input?.model?.providerID !== "openai") return
    output.headers.originator = "codex_cli_rs"
    output.headers["User-Agent"] = CODEX_USER_AGENT
  },
})
