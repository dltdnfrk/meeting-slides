# Independent Accessibility Review

Status: **FAIL**  
Verdict: **REJECT**  
Review lens: Web and native accessibility for F1 rejection gap #2  
Reviewer: **omo accessibility reviewer** (`st_019ff3d7`)  
Parent/root session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`  
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Timestamp: `2026-08-12T02:38:34Z`

## Decision

The current implementation is strong on semantics, contrast, reduced motion, target size, Korean text layout, native projection semantics, and broad responsive behavior. It does **not** fully satisfy `DESIGN.md` section 9.12 because browser sheets/dialogs do not trap keyboard focus. In addition, the retained Todo 19 installed-app journey does not itself cover the complete six-viewport design matrix, and its native AX receipts are flattened text rather than runtime role/help/announcement evidence. These are concrete residual gaps, so this reviewer cannot approve F1.

## Results by required area

| Area | Result | Current source/evidence |
| --- | --- | --- |
| Keyboard and focus | **FAIL** | Tabs are correctly implemented in `public/operator-surface.js:181-241`; current `public-caret-library` exercises ArrowLeft/Right, Home, End and passes. Escape and trigger restoration exist for settings (`public/app.js:917-921,1682-1685`), Ask (`public/app.js:1688-1693`), and Review (`public/review-panel.js:77-87,233-237`). However, the settings sheet only focuses its first control and the dialog handlers only handle Escape; there is no Tab/Shift+Tab containment in the current browser source. This contradicts `DESIGN.md:456-457`, “Sheets and modals trap focus.” The focused a11y test checks initial focus/restoration, names, tabindex, and Escape, but not focus containment. |
| Semantics and ARIA | **PASS** | `public/index.html` provides named dialogs, a real `tablist`/`tab`/`tabpanel`, named separators, `role="log"` for finalized lines, `role="status"`/`role="alert"` for status and errors, and names for icon-only controls. `public/operator-surface.js:181-207` leaves exactly one library panel in the accessibility tree. Current focused suites pass. `aria-modal="false"` on Review/Ask is consistent with their declared non-modal state, but does not cure the separate settings-sheet focus-trap requirement. |
| Contrast and non-color cues | **PASS (web); native runtime measurement not retained** | `DESIGN.md:452-453` floors are exercised by `tests/public-caret-foundation.test.ts:293-329` and `tests/public-caret-accessibility.test.ts:1249-1340`; token contrast, real painted body text, focus boundaries, and non-color status all pass. Native uses an AppKit system background (`macos/MinibarView.swift:247-250`) plus glyph/title pairs (`macos/MinibarProjection.swift:167-202`), but Todo 19 retains no native computed contrast measurement. |
| Reduced motion | **PASS** | Web computed-style sweeps find no painted transition/running animation under reduced motion. Native reads `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` and bypasses animation (`macos/MinibarWindowController.swift:358-368`); projection tests verify 0 seconds versus 0.2 seconds. |
| 44px targets | **PASS** | Current scroll-inclusive hit/size checks pass for library and live at 375x812 and 320x667. Per-row delete checks pass across the full test matrix. Native constraints are at least 44x44 (`macos/MinibarView.swift:119-131`) and native projection/control tests pass. Todo 19’s post-repair receipt `task-19/verification/verification-accessibility-targets.txt` is 4/4. |
| CJK clipping and wrapping | **PASS for current web bytes** | Long Korean row-title reserve/clipping is checked at 1440, 1244, 1100, 960, 900, 899, 820, 375, and 320 in `tests/public-caret-accessibility.test.ts`. Live Korean multiline wrapping is exercised at the same widths in `tests/public-caret-live.test.ts:530-573`. Library labels and dock controls are checked for clipping/truncation across the canonical matrix. Current runs are green. |
| Native AX roles, help, focus, announcements | **PASS in source/pure seam; Todo 19 runtime evidence incomplete** | The AppKit root is an AX group (`macos/MinibarView.swift:115-116`); native buttons retain AppKit button roles and receive labels/help (`:183-191`); user-started presentation focuses Stop (`macos/MinibarWindowController.swift:176-184`); status changes post medium-priority announcements only when projection state changes (`macos/MinibarView.swift:160-177`); timer/transcript are not live regions. Current native suite passes role/group, focus order, help, target, reduced-motion, and announcement deduplication assertions. Todo 19’s `native-cycle1-ax.txt` and `native-cycle2-ax.txt` are flattened text/bounds/control dumps and do not retain runtime AXRole, AXHelp, focus, or announcement-notification fields, so they cannot independently prove those installed-binary properties. |
| Viewport matrix | **PASS in current browser tests; FAIL in Todo 19 journey evidence** | Current foundation/library/live/a11y tests cover the six `DESIGN.md:375-380` viewports and additional 1100/900/899 seam widths. Todo 19’s installed journey records live widths only 375/820/960 and library widths 320/375/960/1280 (`task-19/journey-final/checkpoint.json:45-49,106-113`). It omits canonical 1440x900 and 1244x836 and substitutes non-canonical 1280; it also has no installed-journey live 320 capture. |

## Verification executed against current bytes

- `bun test tests/public-caret-accessibility.test.ts tests/public-caret-foundation.test.ts` -> **112 pass / 0 fail**.
- `bun test tests/public-caret-library.test.ts tests/public-caret-live.test.ts` -> **76 pass / 0 fail**.
- `bun test tests/native-minibar.test.ts` -> **50 pass / 0 fail**; Swift pure driver compiled, AppKit shell typechecked, and the deterministic driver ran once.
- Source search found no browser `Tab`/`Shift+Tab` focus-containment handler or focus-trap helper under `public/`; current handlers shown above cover initial focus and Escape only.

## Residual gaps required for approval

1. Implement and exercise bounded Tab/Shift+Tab focus containment for the settings sheet and any modal surface governed by `DESIGN.md:456-457`, while preserving Escape close and trigger restoration. The test must tab from the last item to the first and Shift+Tab from the first to the last through the real browser surface.
2. Retain installed-app viewport evidence for all six canonical sizes: 1440x900, 1244x836, 960x760, 820x900, 375x812, and 320x667. The shell/state appropriate to each design row must be visible, with no root overflow, clipping, or unreachable controls.
3. Retain installed-native AX records that enumerate AXRole, AXLabel, AXHelp, AXEnabled, focused element/order, and observed announcement notifications/deduplication. Flattened text is useful visual truth but is not role/help/announcement proof.
4. Add a native contrast receipt if native WCAG contrast is intended to be covered by this final accessibility gate; current web contrast evidence cannot establish AppKit rendered contrast.

## Scope and independence

This conclusion was derived from current `DESIGN.md`, current browser/AppKit source, current executable focused tests, and raw Todo 19 journey artifacts. `task-19/visual-reviews.md` was not used as the reviewer conclusion. No product, plan, ledger, or governance file was edited; no commit was created.
