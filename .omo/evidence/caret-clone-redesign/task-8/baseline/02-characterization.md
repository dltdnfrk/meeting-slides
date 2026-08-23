# Task 8 baseline characterization — current transcript projection behavior

Sources read (hashes in `01-source-hashes.txt`):

- `src/session.ts:63-100` — wire shapes: `CaptionUpdate{type:"caption",text,ts,speaker?}`,
  `LineUpdate{type:"line",text,ts,speaker?}`, `TranscriptEntry{text,ts,speaker?}`,
  `TranscriptUpdate{type:"transcript",entries,reason?:"snapshot"|"export",truncated?}`.
  `speaker` is an optional **number** (1-based turn index), never a string label.
- `src/session.ts:424-475` — server pushes one `line` per finalized chunk and appends the same
  entry to `transcriptLog`; provisional text is buffered and emitted as `caption` with the
  buffered speaker. `MAX_TRANSCRIPT_ENTRIES` shifting sets `truncated: true` on snapshots.
- `tests/fixtures/public-protocol-contract.json` — `transcriptMessage.reasons = ["snapshot","export"]`,
  requiredKeys `["entries"]`, optional `["reason","truncated"]`. Client actions carry
  `selectMeeting{meetingId}` and `startCapture{meeting_id}`; those spellings are load-bearing.

## `public/app.js` (shipped live client)

| Frame | Current behavior | Line |
| --- | --- | --- |
| `line` | `if (selectedMeetingId === null) renderTranscriptLine(msg)` — appended to the live feed only while no history meeting is selected. No duplicate suppression, no ordering guarantee: rows land in arrival order. | 1612-1613 |
| `caption` | `renderCaption(msg.text, msg.speaker)` — provisional single row, wholly replaced each frame, never added to the feed; empty text renders the idle placeholder. | 1578-1579 |
| `transcript` + `reason:"snapshot"` | Dropped when `selectedMeetingId !== null` or before the first authoritative capture frame; otherwise `renderTranscriptBacklog(entries)` **replaces** the whole feed (`replaceChildren`, count reset to 0) and `truncated` toggles the truncation warning. | 1603-1611 |
| `transcript` + other reason (`export`) | `exportTranscript(entries)` — download path only; never mutates the projection. | 1609-1610 |
| `meeting` | Dropped unless `msg.meetingId === selectedMeetingId` (stale detail for a superseded selection is ignored); otherwise `renderTranscriptBacklog(msg.transcript)` replaces the feed and the active meeting becomes that history meeting. | 1582-1600 |
| speaker metadata | `entry.speaker` (truthy number) renders `화자 N` with `SPEAKER_COLORS[(speaker-1) % 4]`; falsy/absent speaker renders no chip. | 888-891, 466 |
| reset / fresh workspace | `renderTranscriptBacklog([])` clears stream, count `0`, empty state shown, scroll to top. | 903-916 |

## `public/transcript-overlay.js` (module in tree, not linked from `index.html`)

Read as the behavioral reference for the compact projection; grep of `public/index.html`
and `public/*.js` finds no importer today, so it is a source of intended rules, not shipped state.

- `entryKey(entry) = [Number(ts)||0, Number(speaker)||0, normalizeText(text)].join(":")` and
  `normalizeText = String(v ?? "").trim().replace(/\s+/g," ")` (lines 8-18).
- `line()` (223-249): blank text is ignored; a finalized entry is appended **only when no existing
  confirmed entry shares its key** (duplicate suppression), then the list is truncated with
  `.slice(-3)`; a provisional caption whose normalized text equals the final (and whose speaker is
  absent or equal) is cleared — corrected-final replacement.
- `caption()` (204-221): empty text clears the provisional row; otherwise it replaces the single
  provisional entry, normalized, with `speaker: Number(speaker) || 0`.
- `snapshot()` (251-268): **replaces** the confirmed list from the entries array, drops blank text,
  normalizes, and keeps the last 3; the provisional caption is cleared.
- `reset()` (270-278): clears confirmed and provisional.

## Gap this task closes

Both surfaces recompute projection inline against the DOM, so ordering, duplicate suppression,
caption→final replacement, meeting scoping and reset only exist as side effects of rendering.
Todo 8 extracts one pure, typed projection (`public/transcript-state.ts`) with a parse boundary,
so these rules become directly testable without a DOM, clock, socket or storage.
