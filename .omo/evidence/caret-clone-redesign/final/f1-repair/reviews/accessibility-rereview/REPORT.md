# Independent Accessibility Re-review

Status: **FAIL**  
Verdict: **FAIL**  
Reviewer task: `st_019ff402`  
Reviewer session: `019ff402-b15b-72d4-970e-2de12fbdcf46`  
Parent/root session: `019fef5e-6de0-7b8b-9d1c-e4d629a0379b`  
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
HEAD: `a1ed25f95980980cd958044b90e739ac45e8280d`  
Timestamp: `2026-08-12T03:30:17Z`

## Decision

The repaired browser dialogs now trap and restore focus correctly, the current browser accessibility/layout suites are green, all retained repair artifacts validate against their SHA-256 index, and installed AppKit receipts directly establish native role/label/help/enabled/size semantics. The gate nevertheless **fails** because a separate binding Todo 15 focus requirement is currently broken on the product's only Start surface:

> User-started capture focuses visible Stop.

A direct real-Chromium transition probe clicked `#btn-record`, observed the real outbound `{ "action": "startCapture" }`, delivered the authoritative `starting` capture frame, and then read:

```json
{
  "activeTag": "BODY",
  "activeId": "",
  "stopFocused": false,
  "stopVisible": true,
  "shell": "live"
}
```

The browser is the only Start surface by design. Therefore this is a **current product defect**, not merely absent evidence. Source inspection agrees: the Start/live transition has no focus call for `#btn-live-stop`; focus calls in current browser source are limited to dialogs, tabs, and output targets.

The native Stop-focus discrepancy is separately an evidence gap/possible native defect, not the basis needed for this FAIL. Unobserved native announcement notifications are a legitimate platform-observation limitation demonstrated by the control experiment, not evidence that announcements are absent.

## Exact requirement/evidence mapping

| Requirement | Independent result | Evidence and interpretation |
| --- | --- | --- |
| Todo 15 / DESIGN 9.12: every interactive control is keyboard reachable with visible focus | **PASS except Start-to-Stop transition below** | Current library/live/foundation suites passed. Existing focus-ring checks are green. |
| Todo 15: user-started capture focuses visible Stop | **FAIL - product defect** | Direct current-byte Chromium probe: click Start -> real `startCapture` command -> authoritative `starting` -> live shell, Stop visible, `document.activeElement === BODY`, not `#btn-live-stop`. Browser is the only Start surface (`DESIGN` 9.10 and Todo 19 boundary), so no other surface can satisfy this transition. No current focused test covers it. |
| DESIGN 9.12: sheets/modals trap Tab and Shift+Tab, Escape closes, trigger focus restores | **PASS** | Inspected `public/focus-trap.js` and all four trap/release wiring sites. Fresh focused run: **14 pass / 0 fail**, covering provider, attendee, review, and Ask in both wrap directions, Escape restoration, closed-dialog exclusion, and no inert/`aria-hidden` residue. Output SHA-256: `c074d2440ccb1051a9a23c4dbd470232850dbcf87f867044329343913973b6bf`. Current focus-trap bytes SHA-256: `0c706e13cf47afee5643e26283303e3888acda6d11e8d5f0f660cec8c961dc19`. |
| Browser semantic ARIA, tablist behavior, CJK wrapping, contrast, motion, controls, overflow | **PASS on current bytes** | Fresh `public-caret-foundation + library + live`: **105 pass / 0 fail**, output SHA-256 `61097d77f81d12fbfd9941bfd5c2694b8f33cd4c8e2c0a966f09d75dfdf2eb23`. The focused trap run adds 14 current a11y passes. Prior complete current-byte a11y evidence is checksummed and its index validates. |
| Canonical viewport matrix: 1440x900 library, 1244x836 library, 960x760 live, 820x900 live, 375x812 live, 320x667 library | **PASS only as combined evidence, with explicit receipt limitation** | Repair receipts include all six dimensions and report 0 root overflow, 0 clipped controls, 0 undersized controls, and settings focus containment. However, `viewports.json` truthfully records **library for all six**, despite filenames/state labels saying live at 960/820/375. Thus repair receipts directly cover current installed library geometry at every size, not current installed live geometry. Todo 19 independently has actual installed live receipts/state JSON for 960/820/375 and library 320; fresh current browser tests cover both shells through all canonical sizes, including live 320. This combined coverage supports layout, but no claim is made that the repair's `*-live.png` files contain a live shell. |
| Canonical receipt integrity | **PASS** | `shasum -a 256 -c .../accessibility-repair/SHA256SUMS` validates all 29 indexed artifacts. `installed-viewports/viewports.json` SHA-256: `8365f88c419fb993017f5603ead2e87aa8fb9e5884d1598e1fa19e8d97073d92`. |
| Native deterministic shipping-module behavior | **PASS** | Inspected `MinibarProjection.swift`, `MinibarView.swift`, and `MinibarWindowController.swift`. Fresh `native-minibar + native-surface-contract`: **81 pass / 0 fail**, including Swift compilation/typecheck, group/name/help/44pt targets, explicit non-color states, reduced motion, one-time status/error/recovery announcement decisions, and activation policy. Output SHA-256: `21b4dc2be5c4e444501b0b1e4b31b3e7033781ca2536db986b7d40ff3066481a`. |
| Installed native AXRole, label, help, enabled, target size | **PASS** | Installed runtime receipts expose `AXGroup` "Meeting Slides 미니바", real `AXButton` controls, truthful Stop help/enabled changes, and 46pt control heights in idle/live/stopped captures. Source hashes match the original rejection's inspected shipping bytes: `MinibarView.swift` `33f538...`, projection `7847d1...`, controller `6af281...`. |
| Native announcement notifications and de-duplication at installed runtime | **EXPLICIT PLATFORM-OBSERVATION LIMITATION; not a demonstrated product defect** | Product transition observer saw 0 announcements, but the minimal independent AppKit control posted one known-good `.announcementRequested` (`POSTED`) and the identical external AX observer also saw 0. This demonstrates that this machine's external observer does not receive that notification without an active assistive client. Shipping source does post medium-priority announcements, and deterministic projection tests prove status-change de-duplication. Installed delivery remains unproven, but zero observed notifications cannot honestly be classified as product failure. Control receipt SHA-256: `71688864299c66556791cc7fa76b23c3541b6c88b929c8a68994cabf14c740a8`. |
| Native Stop focus on user-origin present | **UNRESOLVED EVIDENCE GAP / possible native defect** | Installed receipts show `AXFocusedUIElement` remained the window and Stop `AXFocused=false` after real status-item activation, while source calls `makeKeyAndOrderFront`, activates the app, and calls `makeFirstResponder(stopControl)`. The repair investigation established the Stop AX focus attribute was externally settable. This is not a legitimate observer-delivery limitation like announcements; observable focus disagrees with intended source behavior. The evidence does not distinguish AppKit nonactivating-panel behavior from a product defect. Separately, the browser Start-to-Stop failure above is conclusive. |
| Native body/meaningful-text contrast | **DERIVED PASS for current shipped default colors** | `MinibarView.draw` paints `NSColor.windowBackgroundColor`; labels/buttons use AppKit semantic default text colors, and provisional transcript applies view alpha 0.7. Fresh sRGB resolution and WCAG composition yielded normal label/control text **14.94:1 Aqua / 12.23:1 Dark Aqua**, and provisional text **5.59:1 / 6.64:1**, all above 4.5:1. Status is also glyph + text, never color-only. Disabled text measured 1.82:1 / 2.26:1 but disabled controls are exempt from WCAG text contrast; help exposes the reason. |
| Native focus indicator / non-text contrast | **EXPLICIT LIMITATION** | A semantic-color-only derivation gives the composited `keyboardFocusIndicatorColor` about **2.15:1 Aqua / 2.57:1 Dark Aqua** against `windowBackgroundColor`, below 3:1. That is not a rendered-pixel measurement of AppKit's complete NSButton bezel/focus treatment, so it cannot prove either pass or defect. Since installed Stop focus itself was not observed, no native focused-state pixel receipt exists. |
| Reduced motion and non-color state | **PASS** | Browser computed-style suites and native projection/source checks pass; native state always has distinct glyph + text. |
| 44x44 minimum targets | **PASS** | Current browser tests cover narrow shells and current native receipt heights are 46pt; deterministic native minimum is 44x44. |

## Viewport receipt truth table

| Canonical row | Repair installed receipt actually observed | Other retained/fresh coverage | Honest conclusion |
| --- | --- | --- | --- |
| 1440x900 library | library | current library tests | direct current installed library receipt |
| 1244x836 library | library | current library tests | direct current installed library receipt |
| 960x760 live | **library**, despite live filename/state label | Todo 19 actual installed live receipt + current live test | live supported by combined evidence, not by repair PNG |
| 820x900 live | **library**, despite live filename/state label | Todo 19 actual installed live receipt + current live test | live supported by combined evidence, not by repair PNG |
| 375x812 live | **library**, despite live filename/state label | Todo 19 actual installed live receipt + current live test | live supported by combined evidence, not by repair PNG |
| 320x667 library | library | Todo 19 installed library + current library/live tests | direct current installed library receipt; live 320 is test-only and is not a canonical state row |

## Classification of the disputed native observations

1. **Announcements: legitimate platform-observation limitation.** The control app posted exactly one known-good notification and the same observer still received none. Therefore the product's zero-observation record is non-diagnostic. Runtime delivery/de-duplication remains an evidence gap; deterministic shipping-module behavior passes.
2. **Native Stop focus: unresolved evidence gap / possible defect.** Focus is an AX state, not an ephemeral observer notification. Installed state did not match the intended `makeFirstResponder` path, and external setting proved the attribute observable. It cannot be waived as the same platform limitation.
3. **Browser Stop focus: confirmed product defect.** The only Start surface transitions to live with focus on `BODY`, not visible Stop. This independently fails the binding requirement.

## Verification executed in this reviewer session

- `bun test tests/public-caret-accessibility.test.ts --test-name-pattern 'every shipped dialog traps'` -> **14 pass / 0 fail**.
- `bun test tests/public-caret-foundation.test.ts tests/public-caret-library.test.ts tests/public-caret-live.test.ts` -> **105 pass / 0 fail**.
- `bun test tests/native-minibar.test.ts tests/native-surface-contract.test.ts` -> **81 pass / 0 fail**.
- `shasum -a 256 -c .omo/evidence/caret-clone-redesign/final/f1-repair/accessibility-repair/SHA256SUMS` -> **29/29 OK**.
- Fresh AppKit semantic-color resolution under Aqua and Dark Aqua plus WCAG relative-luminance composition -> ratios reported above.
- Direct current Chromium Start-to-live focus probe -> real command observed; Stop visible; active element `BODY`.

## Residual risk and required closure

- **Blocking:** move focus to the visible browser `#btn-live-stop` after an authoritative user-started transition and add a real-keyboard regression that subscribes before Start, observes the command/state transition, and asserts Stop focus without sleeps or polling.
- **Native focus:** independently resolve why user-origin `makeFirstResponder(stopControl)` does not appear in installed AX state; either fix it or retain a reproducible platform explanation with a matching control.
- **Native announcements:** installed VoiceOver/assistive-client delivery remains unverified; the external-observer limitation is explicit and acceptable only as a limitation, not as runtime proof.
- **Native focus contrast:** retain a rendered focused-state pixel/appearance receipt if the final gate requires direct proof of the 3:1 non-text boundary rather than relying on AppKit defaults.
- **Viewport evidence:** preserve the truthful distinction between the repair's all-library installed captures and Todo 19's earlier actual-live captures.

No product, plan, ledger, or governance file was edited. Only this review's `REPORT.md` and `DoneClaim.json` are created.
