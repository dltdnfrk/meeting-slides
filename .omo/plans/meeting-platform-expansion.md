# Meeting Slides Platform Expansion

Work ID: `meeting-platform-expansion-019fc3bf`
Delivery mode: direct in canonical project root
Baseline: `c655ad023a450fa1d29f5c505b305ed50ad2af0c`
Requested: 2026-08-03

## Goal

Complete the remaining audit P0 reliability work, add user-selectable subscription-account
LLM providers for OpenAI, xAI, Anthropic, and Gemini, and add Analog-style downloadable
Whisper model management for `small`, `medium`, `large-v3-turbo`, and `large-v3`.

## Constraints

- Preserve existing user changes and current meeting data.
- Work only in `/Users/hyunjun/Documents/MUNI/meeting-slides`.
- Product edits, tests, QA, and review are delegated to workers.
- Provider controls must report real executable/auth availability rather than optimistic labels.
- Consumer subscription authentication must use each vendor's supported CLI login flow.
- Model downloads require observable states: absent, downloading, installed, selected, failed.
- No silent LLM, deck, export, or model-install fallback.
- Tests subscribe to state changes; no fixed sleeps or timing-luck assertions.

## Evidence sources

- Aside audit: `MEETING_SLIDES_PAGE_BY_PAGE_AUDIT_2026-08-03.md`
- P0 map worker: `st_019fc56b`
- Provider official-contract worker: `st_019fc56c`
- xAI official correction: `https://docs.x.ai/build/overview` verifies the `grok`
  CLI, first-run browser authentication, headless prompts, streaming JSON, and model selection.
- Analog STT worker: `st_019fc56d`
- Architecture impact worker: `st_019fc56e`

## Work packages

### A. Research and reconciliation

- [x] Map current audit P0 behavior and tests.
- [x] Verify OpenAI/xAI/Anthropic/Gemini subscription CLI contracts.
- [x] Extract Analog model catalog, download, install, and selection behavior.
- [x] Verify an official whisper.cpp medium model artifact because Anarlog does not ship medium.
- [x] Freeze provider/STT protocol and file ownership from architecture map.

Recommended task executor category: `explore` / `librarian`

### B. Audit P0 reliability

- [x] Wire transcript export to the dedicated transcript action.
- [x] Include the current slide in filmstrip content and totals.
- [x] Hydrate selected historical meeting transcript, slides, and compiled state.
- [x] Add export job IDs, progress, errors, timeout reporting, and retry.
- [x] Disable compile, PNG, and PDF actions while conflicting work is active.
- [x] Preserve and regression-test existing Whisper artifact filtering.

Acceptance:
- Historical session selection changes all three panes and export target.
- Transcript export differs from Markdown notes export.
- Filmstrip/current/total state is internally consistent.
- Export jobs expose deterministic progress and restore controls on every terminal state.

Recommended task executor category: `deep`

### C. Subscription provider platform

- [x] Implement a typed subscription-provider adapter contract.
- [x] Keep OpenAI Codex subscription support.
- [x] Add xAI Grok subscription support.
- [x] Add Anthropic Claude subscription support.
- [x] Add Google Gemini subscription support.
- [x] Add connect/login actions with real availability and auth state.
- [x] Persist provider, model, and effort selections in the core settings store.
- [x] Expose account connection and selection controls in the provider overlay.

Acceptance:
- Each installed CLI can be detected in Finder-like PATH.
- Login/connect launches the vendor-supported flow.
- Selecting a provider updates the live detector and observable model state.
- Missing CLI/auth is shown as unavailable or disconnected, never as connected.

Recommended task executor category: `deep`

### D. Whisper model manager

- [x] Implement a typed catalog for small, medium, large-v3-turbo, and large-v3.
- [x] Detect installed model files and selected model.
- [x] Download with progress, cancellation-safe temporary files, and atomic install.
- [x] Persist selection and restart capture with the selected model.
- [x] Expose install/select/progress/error controls in the UI.

Acceptance:
- All four required models appear immediately.
- Installed state reflects disk state after restart.
- Selection persists across app launches.
- A selected installed model is the exact path passed to Whisper.
- Interrupted downloads do not appear installed.

Recommended task executor category: `deep`

### E. Integrated UI

- [x] Integrate provider connection state into the settings overlay.
- [x] Integrate STT model install/selection state into the settings overlay.
- [x] Keep narrow-screen behavior usable and controls keyboard accessible.

Recommended task executor category: `visual-engineering`

### F. Verification and delivery

- [x] Run TypeScript diagnostics and complete Bun test suite.
- [x] Build and launch the macOS application.
- [x] Manually QA historical session hydration and all export surfaces.
- [x] Manually QA all subscription provider controls.
- [x] Manually QA model download/install/select with representative installed and absent states.
- [x] Run adversarial final review and record evidence.

## Final verification

- TypeScript: `bunx tsc --noEmit` passed.
- Full suite: 188 passed, 0 failed, 669 assertions across 33 files.
- macOS package: `/Users/hyunjun/Applications/Meeting Slides.app`; strict codesign and PID-scoped launch/health passed.
- Manual QA: historical sessions/exports, all provider controls, and all four production STT artifacts/install/select/recheck/restart passed.
- Fresh visual evidence: 18/18 states passed both independent design/accessibility and responsive/CJK reviews.
- Evidence manifest: `.omo/evidence/meeting-platform-expansion/manual-qa-post-fix/final-manifest.json`

Recommended task executor category: `unspecified-high`

## Dependency graph

```text
A -> B
A -> C
A -> D
B + C + D -> E
E -> F
```

File overlap rule:
- Only one active worker may own `server.ts` or `public/app.js`.
- Core provider and STT workers must stay in new modules/tests until the integration worker owns wiring.
