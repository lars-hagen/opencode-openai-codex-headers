# opencode-openai-codex-headers

> **TL;DR** — A one-hook [opencode](https://opencode.ai) plugin that makes your
> ChatGPT Plus/Pro (Codex backend) requests identify as the real **Codex CLI**.
> **Fixes** the GPT-5.6 **Luna** models that otherwise return `404 Model not
> found`, and stops GPT-5.6 **Terra** getting `server_is_overloaded` under load.
> Install: `opencode plugin github:lars-hagen/opencode-openai-codex-headers -g`

Tiny plugin that makes OpenAI **ChatGPT Plus/Pro OAuth** requests identify as the
official **Codex CLI**, so the newer GPT-5.6 models served through the ChatGPT
Codex backend stop failing.

## The problem

When you log into the `openai` provider with ChatGPT Plus/Pro, opencode talks to
the Codex backend at `chatgpt.com/backend-api/codex`. Its built-in auth plugin
tags every request with `originator: opencode` and a `User-Agent: opencode/<version>`.

That backend gates the GPT-5.6 family on the client identity. Surveying all 12
stock GPT-5.6 models on a ChatGPT Plus account (the `-fast` / `-pro` suffixes are
not separate API ids; opencode sends the base model with a `service_tier` /
`reasoning.mode` body param, so each row covers its whole family):

| Model family | Without the Codex signature | With this plugin |
| --- | --- | --- |
| `gpt-5.6-luna` (`-fast`, `-pro`) | HTTP 404 `Model not found gpt-5.6-luna` | fixed, served |
| `gpt-5.6-terra` (`-fast`, `-pro`) | works, but load-shed with `server_is_overloaded` under contention | works + Codex priority tier |
| `gpt-5.6-sol` (`-fast`, `-pro`) | HTTP 400 `not supported when using Codex with a ChatGPT account` | unchanged (account gate) |
| `gpt-5.6` (`-fast`, `-pro`) | HTTP 400 `not supported when using Codex with a ChatGPT account` | unchanged (account gate) |

The genuine Codex CLI does not hit the 404 / load-shed because it sends
`originator: codex_cli_rs` **and** `User-Agent: codex_cli_rs/<version>`. The
backend requires **both**. The `400 not supported` cases are a separate
account-entitlement gate that no header can change.

## What it does

Registers a `chat.headers` hook that overwrites those two headers for the
`openai` provider only. Config plugins load after opencode's internal ones, and
opencode runs every `chat.headers` hook in order against one shared output, so
this override lands last and wins. No fetch wrapping, no token handling, no
source patch. Every other provider is left untouched.

```ts
export default () => ({
  "chat.headers": async (input, output) => {
    if (input?.model?.providerID !== "openai") return
    output.headers.originator = "codex_cli_rs"
    output.headers["User-Agent"] = "codex_cli_rs/0.144.0"
  },
})
```

## Install

One command, installs from GitHub and writes it into your config (no npm publish
involved). Use `-g` for your global `~/.config/opencode`, drop it to add to the
current project:

```bash
opencode plugin github:lars-hagen/opencode-openai-codex-headers -g
```

Or add it to the `plugin` array in your `opencode.json` by hand:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:lars-hagen/opencode-openai-codex-headers"]
}
```

Pin a version with a tag if you want reproducible installs:

```json
{ "plugin": ["github:lars-hagen/opencode-openai-codex-headers#v1.0.0"] }
```

## Notes

- Recovers the entire **Luna** tier (`gpt-5.6-luna` + `-fast` / `-pro`), which is
  otherwise a hard 404, and keeps the **Terra** tier in the Codex priority tier so
  it stops getting `server_is_overloaded` under load.
- Does **not** unlock `gpt-5.6-sol` or base `gpt-5.6`. Those return `400 not
  supported` from an account-entitlement gate, not a header check. Entitlement is
  account-specific: some accounts have Sol, some do not, and no header changes that.
- The gate is prefix-based on `codex_cli_rs/`, so the exact version string is not
  critical; bump `CODEX_USER_AGENT` if OpenAI ever tightens the check.

## License

MIT
