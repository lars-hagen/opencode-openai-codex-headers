# opencode-openai-codex-headers

Tiny [opencode](https://opencode.ai) plugin that makes OpenAI **ChatGPT
Plus/Pro OAuth** requests identify as the official **Codex CLI**, so the newer
GPT-5.6 models served through the ChatGPT Codex backend stop failing.

## The problem

When you log into the `openai` provider with ChatGPT Plus/Pro, opencode talks to
the Codex backend at `chatgpt.com/backend-api/codex`. Its built-in auth plugin
tags every request with `originator: opencode` and a `User-Agent: opencode/<version>`.

That backend gates the GPT-5.6 family on the client identity:

| Model | Without the Codex signature |
| --- | --- |
| `gpt-5.6-luna` (+ `-pro`) | HTTP 404 `Model not found gpt-5.6-luna` |
| `gpt-5.6-terra` | intermittent `server_is_overloaded` (deprioritized under load) |
| `gpt-5.6-sol` | HTTP 400 `not supported when using Codex with a ChatGPT account` on accounts without Sol entitlement (unfixable here) |

The genuine Codex CLI does not hit these because it sends
`originator: codex_cli_rs` **and** `User-Agent: codex_cli_rs/<version>`. The
backend requires **both**.

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

Add it to the `plugin` array in your `opencode.json`. No npm publish required;
opencode installs directly from GitHub:

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

- Fixes `gpt-5.6-luna`, `gpt-5.6-luna-pro`, and `gpt-5.6-terra` on a ChatGPT
  Plus/Pro subscription.
- Does **not** unlock `gpt-5.6-sol` on accounts that lack Sol entitlement; that is
  an account-level gate, not a header check. Sol is account-specific, so some
  accounts have it and some do not.
- The gate is prefix-based on `codex_cli_rs/`, so the exact version string is not
  critical; bump `CODEX_USER_AGENT` if OpenAI ever tightens the check.

## License

MIT
