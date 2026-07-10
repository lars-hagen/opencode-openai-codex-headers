# opencode-openai-codex-headers

[![npm](https://img.shields.io/npm/v/opencode-openai-codex-headers)](https://www.npmjs.com/package/opencode-openai-codex-headers)

An [opencode](https://opencode.ai) plugin for ChatGPT Plus/Pro (Codex backend)
users. It does two things, both scoped to the `openai` provider:

1. Makes requests identify as the real **Codex CLI**, fixing GPT-5.6 **Luna**
   models that otherwise return `404 Model not found` and stopping GPT-5.6
   **Terra** getting `server_is_overloaded` under load.
2. Cleans up GPT-5.6 **reasoning summaries** so the "Thought" blocks show a clean
   headline instead of a stray `<!-- -->` marker.

## Install

**Via the opencode CLI** (`-g` writes it to your global config; drop it for the
current project):

```bash
opencode plugin opencode-openai-codex-headers -g
```

**Manual**: add it to the `plugin` array in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openai-codex-headers"]
}
```

Pin a version for reproducible installs (`opencode-openai-codex-headers@1.2.3`), or
drop the suffix to track the latest release.

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

**Headers.** A `chat.headers` hook overwrites `originator` and `User-Agent` for the
`openai` provider only, so requests present the genuine Codex CLI signature. It
loads after opencode's internal hooks and runs against the same shared output, so
it wins; every other provider is untouched.

## Reasoning summaries

GPT-5.6 emits each reasoning-summary part as a bold title followed by an empty HTML
comment, `**Title**\n\n<!-- -->`, with no prose body. opencode's TUI takes the
`**bold**` as the header and renders the rest as the body, so "Thought" blocks show
a literal `<!-- -->` (5.5 is unaffected; it emits real prose).

opencode exposes no hook to transform reasoning text, so the plugin strips the empty
marker on the wire, on both the HTTP/SSE path and opencode's experimental WebSocket
transport. It touches only reasoning-summary events on `/responses` endpoints
(host-agnostic, so it also works through a proxy or custom `baseURL`); everything
else passes through unchanged. Once the empty comment is gone only the headline
remains, matching the Codex CLI.

## Notes

- Recovers the **Luna** tier (a hard 404 otherwise) and keeps **Terra** in the
  Codex priority tier so it stops getting `server_is_overloaded` under load.
- Does **not** unlock `gpt-5.6-sol` or base `gpt-5.6`: those hit an
  account-entitlement gate (`400 not supported`), not a header check, and it is
  account-specific.

## License

MIT
