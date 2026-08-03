# Subscription Provider Contract Evidence

Worker: `st_019fc56c`
Corrective verification: lead web fetch
Status: completed
Date: 2026-08-03

| Provider | CLI | Connect | Headless |
| --- | --- | --- | --- |
| OpenAI | `codex` | `codex login` / device auth | `codex exec` |
| xAI | `grok` | first-run browser authentication | `grok -p`, streaming JSON |
| Anthropic | `claude` | first-run interactive login | `claude -p` |
| Google | `gemini` | Sign in with Google | headless mode with cached auth |

## Official sources

- OpenAI Codex auth: https://developers.openai.com/codex/auth.md
- OpenAI non-interactive mode: https://developers.openai.com/codex/non-interactive-mode.md
- xAI Grok Build: https://docs.x.ai/build/overview
- Anthropic Claude Code: https://code.claude.com/docs/en/overview.md
- Gemini authentication: https://geminicli.com/docs/get-started/authentication.md
- Gemini plans: https://geminicli.com/plans/

## xAI correction

The initial research worker did not find an official CLI. A direct fetch of the current xAI
documentation verified the official Grok Build installer, `grok` executable, first-run browser
authentication, headless `-p` mode, streaming JSON output, and `-m` model selection.
