# Whisper Model Manager Core Evidence

Primary worker: `st_019fc572` (cancelled after preserving edits)
Finisher: `st_019fc57a`
Status: core completed; server/capture/UI integration remains

## Delivered

- Four-model whisper.cpp-compatible Q8_0 catalog.
- Streamed download progress and redirect handling.
- LFS SHA-256 payload verification.
- Cancellation, active/stale partial cleanup, and atomic installation.
- Disk-authoritative installed state.
- Persisted selected-model settings core.
- Hermetic fake-server regression suite.

## Catalog

| ID | File | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| small | `ggml-small-q8_0.bin` | 264464607 | `49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f` |
| medium | `ggml-medium-q8_0.bin` | 823369779 | `42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502` |
| large-v3-turbo | `ggml-large-v3-turbo-q8_0.bin` | 874188075 | `317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1` |
| large-v3 | `ggml-large-v3-q8_0.bin` | 1656538283 | `24bc434f372355688ab9a623077a63e5361a1c41f4d8d648977e39f9b060f09e` |

## Files

- `src/stt-model-catalog.ts`
- `src/stt-model-downloader.ts`
- `src/stt-model-settings.ts`
- `tests/stt-model-manager.test.ts`

## Verification

- `bun test tests/stt-model-manager.test.ts`: 5 passed, 0 failed, 22 assertions, exit 0.
- `bunx tsc --noEmit`: exit 0.
