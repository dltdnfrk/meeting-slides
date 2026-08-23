# F3 real manual QA - final synthesis

**Verdict: APPROVE**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed app: `/Users/hyunjun/Applications/Meeting Slides.app`  
Installed executable SHA-256: `23865fbdc70fcc0d7db65bc995b893854fff1e04ef939d29b513dabdb422538d`

This synthesis is limited to F3. No monolithic journey was rerun, no product source was edited, F4 was not entered, and no commit/staging action occurred.

## Freshness and artifact identity

The menu-toggle repair changed the executable from the segmented run's `dddc34...` to `23865f...`. I therefore did not reuse old executable-identity claims.

Current-hash checks in `current-identity/` establish:

- `scripts/build-app.sh`: exit 0;
- `scripts/verify-app.sh`: exit 0;
- `codesign --verify --deep --strict`: exit 0;
- deterministic rebuilt executable remains `23865f...`, exactly matching the genuine repair receipt;
- ad-hoc identity is `com.meetingslides.app`;
- the repository app symlink and installed `project-path.txt` both resolve to the canonical root.

## Exact F3 requirement map

### A - browser product: PASS

The segmented A behavior remains valid rather than merely hash-assumed. The intervening repair scope contains only `macos/NativeSurfaceContract.swift`, `macos/MinibarWindowController.swift`, and their native test/fixture. `current-identity/browser-byte-equivalence.txt` records current hashes for the active browser/server graph, the repair scope, the canonical installed marker, and the current executable. The installed app still resolves and bundle-verifies that same canonical browser graph; no browser/server product byte was changed by the native repair.

Fresh segmented A evidence therefore still covers the current bytes:

- browser Start, focus handoff to the real 66x44 Stop, 16 finalized lines;
- live PPT/transcript at 1440x900, 1244x836, 960x760, 820x900, 375x812, and 320x667, with measured zero horizontal overflow;
- compile to three slides, visible history preview/return, and checksummed memo/JSON/transcript/web/PPTX exports;
- transport disconnect/reconnect with all 16 lines retained;
- browser close/reopen into authoritative live state;
- Stop to authoritative idle and just-ended meeting/library restoration;
- Review, grounded Ask, and one controlled bad local-recorder input.

I personally inspected all 14 A screenshots: empty library, all live width classes, history/compiled states, disconnect/reopen, stopped library, Review, Ask, and bad input. The wide layouts preserve a complete stage beside transcript; sub-900 layouts stack them; controls remain reachable at 375/320. The only logged console error is the non-product favicon 404.

### B - installed native minibar: PASS

The genuine repair QA is already tied to the current `23865f...` executable, and the fresh rebuild reproduced that exact hash, so no B behavior was invalidated. I personally inspected screenshots 01-05, the direct System Events AXPress action receipts, native AX inventories, and every one-shot CGWindow inventory.

Observed complete sequence:

- invalid saved frame `9000,9000,360,56` restored on-screen at `1136,854,360,56`;
- first menu-bar AXPress hid the panel (`targetWindowCount: 0`);
- second AXPress restored the same window id at `1136,854,360,56`;
- disclosure expanded it to `936,690,560,220`;
- Open Workspace produced a new `GET /` with host `localhost:54746`;
- capturing projection visibly showed recording state, timer, line, and enabled Stop;
- five direct Stop AXPress activations emitted exactly one `{"action":"stopCapture"}`;
- authoritative idle was broadcast and cleanup restored defaults.

The repaired screenshots visibly agree with the inventories: panel present, absent, restored, expanded, then live/Stop. AX output identifies one `Meeting Slides 미니바` window and the expected Stop/disclosure/Open Workspace owners.

### C - non-idle quit protection: PASS

`current-quit/result.json` is a direct current-installed-app observation at `23865f...`: an isolated adopted server broadcast authoritative `capturing`; one-shot AX confirmed enabled Stop; an AX window-created observer was armed before requesting application termination; the installed app created the quit-protection window; `계속 녹음` was found and pressed successfully (`pressStatus: 0`); the app and adopted server both remained alive. `current-quit/cleanup.json` records run exit 0 and complete cleanup.

Two retained setup attempts are not product failures: one exposed `.env` port precedence; one showed the synthetic Cmd-Q trigger was not delivered. The final materially narrower `NSRunningApplication.terminate()` trigger exercised the real installed `applicationShouldTerminate` delegate and passed without retrying product behavior.

### D - launcher/documented surface and cleanup: PASS

Current build/verify/signing and executable identity pass. README's applicable launcher surface remains `bash scripts/build-app.sh`, `bash scripts/verify-app.sh "$HOME/Applications/Meeting Slides.app"`, and `open -a "Meeting Slides"`; this GUI launcher has no documented CLI `--help` contract. The canonical marker and repository symlink are correct. Adopted-server ownership was observable in C: quitting/cleanup did not terminate it before task cleanup.

`final-cleanup.txt` confirms no installed Meeting Slides process, no listener on any F3 port (54741-54746, 54748, 8789), restored canonical marker/symlink, removed temporary roots, restored native defaults in B, and unchanged current executable hash. No microphone input, user database, or external API/account was used.

## Final decision

Every exact F3 behavior is covered by observable evidence tied either directly to current executable `23865f...` (build/B/C/D) or to browser behavior whose current-byte validity is established across the native-only repair (A). Cleanup is complete. **F3 APPROVE.**
