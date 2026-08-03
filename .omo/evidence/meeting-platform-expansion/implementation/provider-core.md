# Subscription Provider Core Evidence

Primary worker: `st_019fc570` (cancelled after preserving edits)
Finisher: `st_019fc578`
Status: core completed; server/UI integration remains

## Delivered

- Strict provider adapter registry for OpenAI Codex, xAI Grok Build, Anthropic Claude Code,
  and Google Gemini CLI.
- GUI-safe executable discovery, including xAI's official `~/.grok/bin`.
- Vendor-specific headless invocation and output parsing.
- Conservative installed/auth/connect projection.
- Login/connect command descriptors.
- Project-local provider/model/effort settings store.

## Files

- `src/config.ts`
- `src/llm-cli.ts`
- `src/providers.ts`
- `src/provider-adapters.ts`
- `src/app-settings.ts`
- provider/CLI/settings tests

## Verification

- Focused provider suite: 35 passed, 0 failed, exit 0.
- Global `tsc` temporarily blocked only by concurrent `src/stt-model-catalog.ts:69` TS1360.

## Verified limitation

Grok Build and Gemini CLI do not expose a verified noninteractive authentication-status command.
Installed instances therefore report auth as `unknown` until a real request succeeds; connection
uses `grok login` or Gemini's interactive first-run sign-in flow.
