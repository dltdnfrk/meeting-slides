# Independent Functional Capability Review

**Verdict: PASS**  
**Reviewer task:** `st_019ff3d6`  
**Reviewer name:** `omo / functional-capability reviewer`  
**Reviewed at:** `2026-08-12T02:40:00Z`  
**Scope:** Read-only review of current source and retained Todo 19 real-surface evidence. I did not use any prior combined review's conclusion.

## Decision

The requested functional slice passes. Current source preserves the approved capability division: recording can be started from the browser only; native is a server-derived projection whose outbound wire vocabulary is only `stopCapture`, with disclosure and Open Workspace as local AppKit controls. The retained installed-app journey demonstrates two browser-started cycles, native projection in both cycles, two total wire Stops (one per cycle), compile/export, browser reconnect without transcript loss, history preview, review confirmation, grounded Ask, visible bounded failure handling, and final restoration to two meetings.

The Todo 19 phrase "start recording from browser and minibar" is not treated as permission to add native Start. The binding capability boundary and this review's explicit assignment require browser-only Start (`DESIGN.md:393-406`); native Start would violate that boundary.

## Requirement map

| Functional requirement | Independent evidence and current-source reference | Result |
| --- | --- | --- |
| Browser-only Start | Browser owns `#btn-record` (`public/index.html:398-403`) and `sendCaptureToggle()` emits `startCapture` with the frozen optional `meeting_id` (`public/app.js:1280-1323`). Native's complete outbound action set is only `stopCapture` (`macos/TransportClient.swift:54-65`; `macos/NativeSurfaceContract.swift:284-289`). `journey-final/wire-actions.json` contains exactly two `startCapture` actions and two cycles are recorded in `checkpoint.json`. | PASS |
| Native is projection/control, not workspace or state store | Contract says browser complete workspace/native projection (`DESIGN.md:393-406`). Current transport retains only projected capture/connection/status state (`macos/TransportClient.swift:68-84`), while current native controls are Stop, disclosure, and Open Workspace (`macos/MinibarView.swift:63-80,132-145`). Both `native-cycle1-ax.txt` and `native-cycle2-ax.txt` expose recording state, timer, projected transcript, Stop, disclosure, and Open Workspace. | PASS |
| Open Workspace | `MinibarWindowController.swift:319-327` routes Open Workspace to `NSWorkspace.shared.open(workspaceURL)`. `native-open-workspace.json` records the real installed AX control and target `http://localhost:54321/`; both cycle AX receipts contain `작업 공간 열기`. | PASS |
| Exactly-once native Stop over two cycles | Source funnels native Stop through one transport guard (`MinibarWindowController.swift:265-271,319-323`; `TransportClient.swift:132-135`; `NativeSurfaceContract.swift:294-317`). Cycle 1 records five AX activations and one emitted command (`native-stop-cycle1.json`). Cycle 2 records its live native AX control (`native-cycle2-ax.txt`) and one `stopsSent` in `journey-report.json`; the independent wire log contains exactly two `stopCapture` frames total, separated by the two `startCapture` frames (`wire-actions.json`). `checkpoint.json` closes with `totalStarts: 2`, `totalStops: 2`, `finalSessions: 2`. | PASS |
| Live projection/layout and transcript | `native-projection.json` records capturing, server timer, three lines, enabled Stop, and no decode/drop failures. `02-live-960.png` shows persistent Stop/timer and side-by-side stage/transcript; `02-live-375.png` shows the stacked narrow surface with Stop/timer. `live-viewports.json` records online/capturing state at 375, 820, and 960. | PASS |
| Compile, history preview, export while live | `03-live-compiled-history.png` visibly retains Stop/timer and transcript around the compiled slide. `history-preview.json` records three thumbnails and `stageState: history-preview` while capture remains `capturing`. `export-steps.json` records Markdown, JSON, transcript, and deck actions; `export-hashes.json` records 17 artifacts with matching compile/export deck hashes. | PASS |
| Reconnect/reopen without data loss | `reconnect.json` records 16 lines before and after connection loss plus explicit reconnecting text. `checkpoint.json` records live reopen with 16 lines; source retains capture truth on close (`macos/TransportClient.swift:124-130`) and the design forbids phantom stop (`DESIGN.md:479-485`). | PASS |
| Stop restoration and two completed cycles | `checkpoint.json` records just-ended selection after cycle 1, restored 16-line history after reload, and cycle 2 with five finalized lines, one Stop, and two sessions. `09-after-cycle2.png` visibly shows Meeting #2 selected and Meeting #1 retained; `journey-report.json` reports two sessions and one cycle-2 Stop. | PASS |
| Review | `review.json` records reachable ready state and a real `reviewConfirmed` response; `03b-review.png` shows the distinct review surface and completion action. Current server dispatch includes `startReview`/`confirmReview` (`server.ts:1015-1024,1072-1074`). | PASS |
| Ask | `ask.json` contains a transcript-grounded answer; `07-ask.png` shows the real Ask sheet and answer. Current server dispatch includes `ask` in the real WebSocket whitelist (`server.ts:1072-1074`). | PASS |
| Failure state without data loss | `failure-state.json` records malformed compile target `bad-id`, a status-role error, and 16 lines both before and after. `08-bad-payload-failure.png` visibly surfaces the failure and Retry without losing the selected meeting. This matches `DESIGN.md:469-490`. | PASS |
| Evidence integrity/current relevance | Todo 19 `SHA256SUMS` independently verifies all 71/71 retained files. Current `public/app.js` and `server.ts` match Todo 19's recorded source hashes. Current native/browser source was separately read and hashed for this review. | PASS |

## Independently recomputed key artifact SHA-256

- `02-live-960.png`: `43fe64c09fc31b570a386f3ade9d8bdcd7da0a15dc936d23a2edc7fcb4a97e6c`
- `02-live-375.png`: `116d72dc4d09c1c4dfc7b759f77cf7ce591f0b4161c6d1924f8bce3b73a38b6a`
- `03-live-compiled-history.png`: `86452ca73b782bf7223e41ae803ba4fa1d9abf5ca12a900b87fe56daf571bacb`
- `native-cycle1-ax.txt`: `0f4e301002fc32556480367bf74bd5efaa9f0ac3147134cdd856b76d2eaf4fd9`
- `native-cycle2-ax.txt`: `7873419bdfe99610780d10d5e1959729c9edd1959c6c6ce6d9924b9055fdd0c3`
- `wire-actions.json`: `d2305489ebe9a88d45e4f26e6b0312330a183b293a644e4637cb60394d9c4954`
- `reconnect.json`: `a404aa1df1cea86c35e7d72ac2d5e71e0cafbc82f10f0674f33efea829adfe5a`
- `review.json`: `a66352d9107f0386e28f1ca3a5cc85359ce19684047a1d28e696a043d7a3274f`
- `ask.json`: `0edbb0063bc2c08b42f18fd4af8f26348f4d8de7e57ca0a7294d1298c49b5caa`
- `failure-state.json`: `593f387bba85273a8a576c1f95effa6c4058ffd14ed38eba4184321e51fe73f5`
- `journey-report.json`: `f34c81faa46ff0d7986cdd2acac2034ded35c48faae4a3dbb6c84f90ecf9a7ba`

## Uncovered risks / evidence limits

1. Native pixels were not capturable through CGWindowList; both cycle receipts truthfully mark this unsupported. Functional native state/control presence is supported by installed-process AX text and wire receipts, not a native panel screenshot. No screen-share exclusion claim is justified.
2. Cycle 2's exactly-once result is retained as `journey-report.json`/`checkpoint.json` plus the full wire log, rather than a second dedicated `native-stop-cycle2.json`. The combination is sufficient for this verdict, but a per-cycle activation-count receipt would make future attribution stronger.
3. `StopCommandGuard.apply` clears `stopInFlight` for every authoritative phase other than `stopping` (`macos/NativeSurfaceContract.swift:302-306`), while its comment says it rearms only after leaving stopping. The exercised rapid-activation and reconnect paths passed, but an out-of-order repeated `capturing` snapshot between activations is a residual source-level edge risk not directly exercised by the retained real-surface journey.
4. Todo 19's `source-hashes.txt` covers the files changed during its final defect repairs, not every native source. This review therefore independently hashed/read current native source; it does not claim the task-level source index alone proves native-source freshness.

These are non-blocking for the observed functional acceptance slice; they do not contradict the retained two-cycle result.
