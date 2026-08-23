# Todo 18 - Remove obsolete shells and reconcile documentation

Task: `st_019ff230`. Worktree: `/Users/hyunjun/Documents/MUNI/meeting-slides`.
No commit, stage, reset, restore, plan/ledger/Boulder edit, microphone command, or meeting-row
write was performed.

## Result

- `public/index.html` now loads exactly two stylesheet sources, once each:
  `style.css` (generated slides and real review/settings components) and
  `caret-operator.css` (the one Caret operator token/component/geometry hierarchy).
- Removed active TIRO tail from `style.css`; deleted Operational Liquid, workspace-shell,
  shallow-Caret/foundation layer files, duplicate numbered review files, and obsolete browser
  transcript-overlay files. Canonical scripts, DOM/wire manifests, reducers, splitters,
  review owners, fonts, generated artifacts, native sources, and deck sources remain.
- README now documents real build/verify/launch/usage surfaces and no nonexistent login-item or
  `--mic-check` launcher. DESIGN 9.15 records final ownership rather than pending deletion.
- Privacy wording is exact: `.sharingType = .none` suppressed tested single-window SCK pixels;
  enumeration remained and application-side enumeration exclusion is unsupported; full-display
  capture was inconclusive. The product makes no privacy, exclusion, or invisibility claim.
- `scripts/verify-app.sh` now rejects a project missing the current browser asset graph or
  carrying an obsolete active-shell reference.

## Repair 3: exclusive selector-root ownership

Repair 3 removes the declaration/property ownership heuristic completely. The verifier parses only
selector-bearing rule preludes (including `@scope`), treats declaration bodies as opaque, masks
comments plus quoted and URL/data strings, and lexes every class token after `.`. Simple CSS escapes
and one-to-six-digit hexadecimal escapes with optional terminator whitespace are decoded before
exact/prefix root comparison.

- `style.css` must contain zero operator-owned selector roots, including workspace, shell state,
  workspace-grid, and canonical operator hierarchy roots.
- `caret-operator.css` must contain zero `.slide__inner--*` or `.review-panel*` selector roots.
- Four required `:is()` mutations each produce RED: `repair-3/red/01-four-is-mutations.txt`.
- Seven additional `:where()`/`:has()`/nested functional/comma/hex-escape/comment-token mutations
  each produce RED: `repair-3/red/02-adversarial-selector-mutations.txt`.
- Attribute/string/URL/data/custom-property/quoted-brace lookalikes remain GREEN:
  `repair-3/green/01-benign-lookalikes.txt`.
- Product and documentation hashes are unchanged. Final active shell is 12/12; the same 28 claimed
  files are 602/602 (the requested 600 baseline plus two new selector-only tests). Project and
  strict TypeScript and diff checks pass. Chromium was not rerun; PID 32804 was not polled.

## Repair 2: declaration-comment tokenization

The declaration parser now removes CSS comments before property extraction with a quote-aware
scanner. Comments become one token-separating space; comment-like text and braces inside quoted
strings remain byte-for-byte values. The parser fixture covers leading, interleaved, trailing,
and value-leading comments around shell geometry plus generated-slide/review declarations,
nested `@layer`/`@media`/`@supports`, top-level comma selectors containing `:is(...)`, custom
properties, and quoted URL/data strings.

- Test-first RED: `repair-2/red/01-parser-comment-fixture.txt` - 9 pass / 1 fail before the
  scanner fix.
- Exact verifier mutation RED: `repair-2/red/02-exact-leading-comment-mutation.txt` rejects
  `.workspace { /* valid comment */ grid-template-columns: 1fr; }` - 9 pass / 1 fail.
- Exact stylesheet bytes restored: `repair-2/product-hashes-restored.txt` matches
  `repair-2/source-hashes-before.txt` for both product stylesheets.
- GREEN: `repair-2/green/02-active-shell-final.txt` - 10/10;
  `repair-2/green/03-claimed-suites.txt` - 600/600 across the same 28 claimed files (the prior
  599 plus the parser fixture); project and strict TS, changed-test LSP, and diff check pass.
- Product and documentation hashes are unchanged, so the existing 45-capture Chromium QA was
  preserved and not rerun.
- PID 32804 remains independently classified as non-blocking macOS kernel `U`-state residue;
  Repair 2 did not inspect or poll it.

## TDD and adversarial receipts

- Initial RED: `red/01-active-shell-red.txt` - 7 failures / 1 pass before implementation.
- Ownership repair RED: `repair/red/01-style-cross-ownership.txt` rejects
  `.app[data-shell="live"] .workspace { grid-template-columns: 1fr; }` in `style.css`;
  `repair/red/02-operator-cross-ownership.txt` rejects `.slide__inner--live` and
  `.review-panel` rules in `caret-operator.css`. Each is 8 pass / 1 fail, then exact product
  bytes were restored (`repair/product-hashes-before.txt` equals `...-restored.txt`).
- Repaired active contract: `repair/green/01-active-shell.txt` - 9/9.
- `adversarial-probes.txt`: 26 independent mutations all RED, including both cross-ownership
  directions, then source bytes restored.

Ownership is parsed from machine-consumed CSS blocks and declarations, recursively through
conditional at-rules while ignoring comments and quoted braces. `style.css` exclusively owns
renderer-root selectors `.slide__inner--*` and `.review-panel*`; `caret-operator.css` may size
slide descendants inside the shell but cannot declare those renderer roots. Conversely,
`style.css` may retain legacy component paint but cannot select authoritative `data-shell`,
`data-capture-phase`, `data-stage-state`, or `data-ui-state`, nor declare shell grid geometry;
those belong exclusively to `caret-operator.css`.

## Required verification

- `repair/green/02-claimed-suites.txt`: **599 pass / 0 fail** across the same 28 claimed
  suite files (the prior 598 plus the new ownership guard).
- `repair/green/03-typescript.txt`: project TypeScript and explicit `--strict`, both exit 0.
- `repair/green/04-swift.txt`: all seven native sources typecheck together, exit 0.
- `repair/green/05-drift.txt`: both generated browser reducers match source.
- `repair/green/06-bundle-codesign.txt`: shell syntax, installed bundle verifier, and strict
  codesign pass.
- `repair/green/07-diff-product-hashes.txt`: `git diff --check` exit 0 and product hashes
  unchanged.
- `lsp.txt`: changed TS files clean. CSS/HTML, shell, and Markdown LSP executables are unavailable;
  real Chromium parsing, `bash -n`, bundle verifier, and strict compilers passed instead.

## Fresh deterministic Chromium QA

`capture-qa.ts` generated **45** fresh real-Chromium captures: five viewports
(1280x800, 960x760, 820x900, 375x812, 320x667) times library empty/populated/Notes/Transcript
and live starting/capturing/disconnected/stopping/error. Every capture has a PNG, full AX tree,
and computed-style JSON under `screenshots/`.

`browser-qa-validation.json`: `captures=45`, `badCount=0` for root overflow, duplicate IDs,
active removed references, enabled narrow targets below 44px, and keyboard focus painting.
The repair changed only the verifier test/evidence; both linked product stylesheet SHA-256 values
remain byte-identical, so Chromium product QA was intentionally preserved rather than rerun.
The live-error visual receipt uses the canonical `capture-error` data projection directly because
no server wire message names capture failure; reducer transition behavior remains covered by the
state-machine suite. No fake capability or protocol action was added.

## Installed executable truth

`direct-launch-qa.json` / `.log` directly executed
`$HOME/Applications/Meeting Slides.app/Contents/MacOS/meeting-slides`, subscribed to its launcher
log before launch, and observed readiness on port 8789. HTTP returned 200 with the health
signature; a real browser loaded only `/style.css` and `/caret-operator.css`, one shell, zero
removed references; WebSocket opened and delivered a `status` frame. SQLite meeting identity was
`count=60,maxId=60` before and after. No start/stop/mic action was sent. SIGTERM reaped the owned
server; cleanup shows no listener on 8787/8789.

## Integrity and manifests

- `baseline/01-inventory-sha256.txt`, `baseline/02-active-source-hashes.txt`: pre-edit inventory.
- `deletion-retention-manifest.txt`: explicit active owners and every deletion.
- `source-hashes.txt`: final deliverable hashes.
- `docs.diff`, `shipped-shell.diff`: reviewable documentation and tracked shell diffs.
- `protected-retention.txt`: protected source hashes/identity and tracked diff receipt. Models,
  provider/Alibaba work, HANDOFF, audits, research, historical evidence, plans, Boulder, ledger,
  installed symlink, native protocol sources, and deck source were not edited by this task.
- `repair/pid-32804-cleanup.txt`: PID 32804 was a PPID-1 Python residue in macOS state `U`
  (uninterruptible kernel wait), with no listener. TERM and KILL were delivered; the process
  cannot reap until its kernel wait returns, but its temp directory was removed and ports
  8787/8789 are free. No task listener or temp directory remains.
- `cleanup.txt`: no attributable listener, canonical public file list, meeting row truth.
- `CHECKSUMS.txt`: SHA-256 for this complete evidence bundle (excluding itself).
