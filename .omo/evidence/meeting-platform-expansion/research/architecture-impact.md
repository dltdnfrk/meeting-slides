# Architecture Impact Evidence

Worker: `st_019fc56e`
Status: completed
Date: 2026-08-03

## Current flows

- Provider: `src/providers.ts` -> `server.ts` -> WebSocket -> `public/app.js`
- CLI inference: `src/config.ts` -> `src/llm-cli.ts` -> `src/session.ts`
- Whisper: `server.ts` -> `src/whisper.ts` -> capture process
- Persistence: `src/store.ts`
- App bootstrap: `macos/launcher.swift` -> `bun run server.ts`

## Frozen worker boundaries

1. P0 integration owns `server.ts` and `public/app.js` first.
2. Provider core owns provider/CLI/settings modules and unit tests, not UI/server wiring.
3. STT core owns a new catalog/downloader/settings module and unit tests, not UI/server wiring.
4. Final integration owns `server.ts`, `src/session.ts`, `public/app.js`, HTML/CSS, and protocol tests
   after P0/provider/STT core workers complete.
5. macOS worker owns only launcher/build integration if required.

This serialization prevents concurrent edits to `server.ts`, `public/app.js`, and `src/config.ts`.
