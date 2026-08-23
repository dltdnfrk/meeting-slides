# F3 gap B native visual supplemental receipt

**Terminal verdict: FAIL**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed executable SHA-256: `dddc34ffa7d7776daf183ae5c601d4c28a578f81c8fb3ac2543a6e01d2b34a7c`  
Bundle id: `com.meetingslides.app`  
Observation path: fresh full-screen `screencapture` plus one-shot `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` inventories. No `AXVisible` query, AX lifecycle observer, product edit, microphone input, user database, or external API was used. System Events `AXPress` was the only user-action mechanism.

## Decisive result

Gap B is **not closed**. The first menu-bar `AXPress` succeeded as an action, but it did not hide the minibar:

- initial CGWindowList result: one on-screen Meeting Slides window, id `103563`, alpha `1`, bounds `1136,854,360,56`;
- after first menu press: the same on-screen window id `103563`, alpha `1`, bounds `1136,854,360,56` remained;
- after second menu press: the same window still remained at the same bounds;
- `screenshots/01-collapsed.png`, `02-after-menu-first.png`, and `03-after-menu-second.png` visually show the minibar before and after both presses.

This is a direct native-window observation, materially different from the rejected AX window-count/visibility paths. Because required window absence after the first menu press was directly disproved, the required hide/restore lifecycle cannot receive PASS.

## Other B observations from the same run

- **Artifact identity - PASS.** Hash, bundle verifier, and strict codesign passed before launch; post-cleanup hash and strict codesign passed again.
- **Off-display restore and collapsed geometry - PASS.** The run seeded `9000,9000,360,56`; the launched panel was visibly restored on an available display at `1136,854,360,56`.
- **Disclosure - PASS.** System Events `AXPress` succeeded. Screenshot `04-expanded.png` visibly shows the expanded surface; CGWindowList records `936,690,560,220`.
- **Open Workspace - PASS.** System Events `AXPress` succeeded. The adopted server recorded a post-action browser GET for host `localhost:54745` at receipt sequence 7, matching `http://localhost:54745/`.
- **Recording projection and Stop - PASS.** Screenshot `06-capturing-stop.png` visibly shows `녹음 중`, timer `00:00`, projected line, and enabled `녹음 중지`.
- **Exactly-once Stop - PASS.** Five direct System Events `AXPress` activations succeeded; the adopted server received exactly one client command, `{"action":"stopCapture"}`, at sequence 10. Screenshot `07-after-stop-idle.png` visibly shows the authoritative idle projection after the correlated idle frame.
- **Menu-bar owner continuity - PASS.** Fresh CGWindow inventories expose on-screen Control Center windows named `com.meetingslides.app`; the final menu-bar `AXPress` also succeeded after all other interactions. Screenshot `08-menu-owner-remains.png` retains the status glyph.

`window-summary.json` is the compact bounds/owner receipt. `protocol-summary.json` correlates Open Workspace, capture projection, five Stop activations, exactly one wire command, and idle restoration. The complete raw inventories and server event stream are retained.

## Visual inspection

I inspected all eight fresh screenshots. The minibar is visible at collapsed size in checkpoints 01-03, visibly expands at checkpoint 04, projects the live state/line/Stop at checkpoint 06, returns to idle at checkpoint 07, and retains the menu-bar glyph through checkpoint 08. Crucially, checkpoint 02 visually agrees with CGWindowList: the first menu press did not hide the panel.

## Preservation and cleanup

A/C/D and segmented build/terminal evidence hashes are byte-identical before and after (`acd-preservation-before.txt` vs `acd-preservation-after.txt`). Cleanup restored the canonical project marker and original minibar defaults, removed the temporary root, stopped only the task app/server, freed port 54745, retained the exact executable hash, and revalidated strict codesign. See `cleanup.json`.

No product, plan, governance, F4, user database, or existing segmented evidence file was edited. Since every B behavior was not directly observed as passing, the only truthful terminal result is **FAIL**.
