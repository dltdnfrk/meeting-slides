# Old → new assertion map (Todo 11 compatibility migrations)

Every migrated assertion required the SUPERSEDED transcript-column layout. Each
row states what was dropped and the replacement that binds the single-document
contract or the same capability, so coverage is redirected, never weakened.

## tests/public-workspace.test.ts

| Old assertion | Why it cannot hold | Replacement |
| --- | --- | --- |
| `워크스페이스가 좌/중앙/우 세 패널을 담는다` — `#workspace` children are `[rail, stage, transcript]` | Todo 11 acceptance: one rail + exactly ONE document surface | `워크스페이스가 레일과 단일 문서 표면을 담고 전사는 탭으로 도달된다` — workspace owns `[session-rail, document-surface]`; stage AND transcript are inside the surface; transcript is `role=tabpanel` and `#detail-tab-transcript` `aria-controls` it |
| `세 패널이 가로로 나란히 …` — `stage.right <= transcript.left` | requires a permanent transcript column | `레일과 문서 표면이 가로로 나란히 …` — rail left of document, same row, document widest, `>= 280px`, dock preserved. Non-column assertions kept verbatim |
| `두 스플리터가 패널 사이 DOM 순서에 놓인다` — five workspace children | `#splitter-transcript` moved inside `#document-surface` with the panes it separates | `스플리터가 자신이 나누는 패널 사이 DOM 순서에 놓인다` — workspace `[rail, splitter-rail, document-surface]`; surface `[stage-pane, splitter-transcript, transcript-pane]`; both keep `role=separator` |
| `키보드 Arrow/Home/End가 양쪽 스플리터 …` | transcript splitter is inert in library (DESIGN §9.9) | split in two: rail half unchanged in library; new `라이브 셸에서 키보드가 전사 스플리터 …` asserts the identical transcript behaviour in live shell |
| `우 스플리터를 왼쪽으로 끌면 전사 패널이 넓어진다` | same | `라이브 셸에서 우 스플리터를 …` — identical assertions, live shell |
| `최소 폭 밑으로는 접히지 않는다` (rail AND transcript minimums) | transcript column absent in library | split in two: `라이브 셸에서 전사는 최소 폭 …` (>=240, stage >=320) and `라이브러리에서 레일은 최소 폭 …` (>=180). Both minimums keep real coverage |
| `드래그 결과가 workspace.layout.v1 …` — `rightPx` equals rendered transcript width | `rightPx` is still persisted, just not painted as a column | key and BOTH payload keys unchanged; `rightPx` asserted as persisted state (`>= 240`) |
| `저장값이 손상돼도 …` — restored transcript width | same | fallback unchanged; transcript width read from the persisted `--transcript-w` |
| `375px에서 도크 액션이 내부 스크롤되고 …` — `flexWrap: nowrap`, `internalScroll: true` | DESIGN §9.9 forbids a label ending as a partial glyph behind an overflow fade at 375/320, which the scroller produced | `375px에서 도크 액션이 줄바꿈으로 모두 도달되고 …` — STRONGER: zero offscreen AND zero truncated controls, plus the original overflow/compile/stage assertions |

## tests/public-operator-surface.test.ts

| Old assertion | Why it cannot hold | Replacement |
| --- | --- | --- |
| `3-way 출력 …` faked library mode via `classList.remove("app--capturing")` | DESIGN §9.3: state is server-authoritative; hand-editing the class produced a state the product cannot reach | drives a real `capture`/`idle` frame via a `returnToLibrary` helper; the capability assertion itself is unchanged and now passes |
| `비활성 사유 …` compared `.capability-reason` to the PANE's outer edge | the pane is now full width; the measure-bound reading column is `#transcript-card` | bound is `max(card.right, pane.right)`; the no-clipping intent is unchanged. The underlying 45px overflow was ALSO fixed in CSS for every shell |

## Coverage added (not migrated) in tests/public-caret-library.test.ts

* 1100x800 added to the matrix — the seam that hid the 5px collapse.
* Usable-geometry matrix: `#document-surface >= 280px`, `#slide-frame >= 240x130`, document wider than rail, at all 7 widths.
* Notes matrix: `#notes-box`/`#notes-input` displayed, `>= 240x120`, enabled, focusable, and accepting typed Korean at all 7 widths.
* Label matrix: zero offscreen and zero truncated labels across tabs, dock, record, rail rows, output switcher at all 7 widths.
* `data-connection` asserted as EXACTLY `connected`/`disconnected` (legacy vocabulary) with the canonical state on `data-connection-state`.
