# F3 segmented manual QA

**Verdict: REJECT**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed executable SHA-256: `dddc34ffa7d7776daf183ae5c601d4c28a578f81c8fb3ac2543a6e01d2b34a7c`

All segments referenced the same freshly rebuilt, bundle-verified, strictly codesigned installed executable. F4 was not entered and no product source was edited by this task.

## Segment results

- **A - PASS.** Fresh isolated browser/server workflow completed Start with focus handed to Stop, 16 deterministic finalized lines, six canonical live sizes, compile into three slides, visible history-preview return, four export paths with checksummed artifacts, disconnect/reconnect without line loss, browser close/reopen, browser Stop, Review, grounded Ask, and controlled failing local-recorder input. The scenario used no native AX. Final screenshots and machine states are in `segment-a-browser/`; I inspected the wide/narrow live, history, Review, Ask, and final bad-input captures. No horizontal overflow was measured at any canonical width. The sole console error was the non-product favicon 404.
- **B - FAIL.** The fresh installed AppKit scenario verified the visible collapsed AX owner at `1136,854,360,56` and off-display restoration from the saved `9000,9000,360,56` frame. It then failed the required menu lifecycle observation: after direct `AXPress` of the visible menu-bar owner, the window count was `1`, not the expected disappearance. Per the correction cap, the exact run was preserved under `segment-b-native/attempts/b1-post-action-count/`. A materially different direct Swift/installed-process attempt was made, but its readiness subscriber timed out even though the retained app log later contained `미니바 준비됨 port=54743`; it was not retried. Therefore no fresh passing B sequence proves menu disappearance/reappearance, disclosure, Open Workspace, and native Stop together.
- **C - PASS at the requested shipping seams.** `tests/native-minibar.test.ts` passed 56/56 and `tests/native-launcher-boundary.test.ts` passed 42/42. These shipped suites cover non-idle quit protection, exactly-once owned-server termination, adopted-server non-termination, and installed executable wiring without microphone or user database use.
- **D - PASS.** Fresh build, artifact verifier, strict codesign, documented launcher commands, canonical marker, repository app symlink, and executable identity all passed. Build/verify/codesign exit statuses were zero.

## Exact uncovered F3 requirement

**Native minibar/menu scenario B lacks a fresh passing observation of the expected window disappearance/reappearance around the direct menu-bar press; consequently the required complete B action sequence is unproven.** F3 requires A-D all PASS, so the terminal verdict is REJECT. This is an evidence/harness failure, not a claimed product defect.

## Safety and cleanup

Each runtime used isolated project/database/export roots and local deterministic fixtures. No microphone input, external API/account, or user database was used. Final verification confirms:

- marker restored to the canonical root;
- ports 54741-54744 free;
- no installed Meeting Slides executable process alive;
- minibar defaults restored after each mutating native attempt;
- user database hashes unchanged;
- installed executable hash unchanged and bundle still verified/codesigned.

Unrelated dirty work was preserved. No commit, plan, ledger, Todo, or F4 edit was made.
