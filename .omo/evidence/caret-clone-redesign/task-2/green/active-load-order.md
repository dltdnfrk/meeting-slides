# Active stylesheet / script load order — `public/index.html`

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
Source of truth: `public/index.html` (SHA-256 recorded in `protected-hashes-before.tsv`)
Read-only inventory. No product file was modified by task 2.

## 1. Stylesheet cascade (document order = override order)

Rule and `@media` counts are top-level blocks reported by the parser in `css-rule-map.tsv`; `style.css` and `workspace-shell.css` use many single-line rules, so a naive `grep -c '{'` undercounts them.

| # | Line | Href | Lines | Top-level rules | `@media` blocks | Custom props defined | Layer attribution |
|---|------|------|-------|-----------------|-----------------|----------------------|-------------------|
| 1 | `index.html:31` | `/style.css` | 1960 | 451 | 13 | 50 | Legacy Meeting Slides (`aside` dashboard) + an appended TIRO operator block at `style.css:1377-1960` |
| 2 | `index.html:32` | `/workspace-shell.css` | 372 | 55 | 3 | 16 | TIRO five-column workspace shell (rail / splitter / stage / splitter / transcript) |
| 3 | `index.html:33` | `/operational-liquid.css` | 861 | 88 | 5 | 0 | Operational Liquid Glass skin (style-gallery selection) |
| 4 | `index.html:34` | `/caret-shell.css` | 579 | 79 | 2 | 16 | Current Caret overlay (untracked, newest layer) |

Two inline blocks also ship ahead of the cascade:

- `index.html:12-15` — `<script id="runtime-bootstrap">` sets `documentElement.dataset.runtime` to `file`/`server`. Required functionality (app health-check signature + `file://` guard).
- `index.html:16-30` — inline `<style>` for `.direct-file-guard`. Required functionality; must stay inline because it renders when no stylesheet path is trustworthy.

Remote font/CDN links at `index.html:7-11` (Google Fonts `Inter` + `JetBrains Mono`, jsDelivr `Pretendard`) are external network dependencies in the shipped document. The plan's deterministic-fixture rule ("no external network dependency during regression tests") makes these a task-4/task-10 concern, recorded here as an observation only.

## 2. Script execution order

| # | Line | Src | Role | Attribution |
|---|------|-----|------|-------------|
| 1 | `index.html:456` | `/workspace-split.js` | Splitter drag, `--rail-w` / `--transcript-w` geometry, persisted layout keys | TIRO workspace shell |
| 2 | `index.html:457` | `/transcript-resize.js` | Transcript card S/SW grip resize | TIRO workspace shell |
| 3 | `index.html:458` | `/operator-surface.js` | Detail tabs, output switcher `aria-current`, note routing | Current Caret overlay (dirty/tracked) |
| 4 | `index.html:459` | `/review-panel-render.js` | Review candidate markup | Required functionality |
| 5 | `index.html:460` | `/review-panel.js` | Review panel behavior | Required functionality |
| 6 | `index.html:461` | `/app.js` | WebSocket dispatch, capture, transcript, sessions, providers, slides | Required functionality |

Scripts are plain classic tags with no `defer`/`async`/`type=module`; execution order is document order and later files depend on earlier globals.

Present in `public/` but **not** loaded by the document: `transcript-overlay.css`, `transcript-overlay.js` (plus their `* 2.*` Finder copies, which `.gitignore` excludes). These are unshipped references, consistent with `.omo/drafts/caret-clone-redesign.md:57`.

## 3. Token ownership and dependency direction

Measured with `grep -oE 'var\(--[a-z0-9-]+'` per layer against each layer's own definitions:

- `style.css` defines the zinc/live/glass/motion base (50 custom properties) and is the root of the token graph.
- `workspace-shell.css` defines 16 geometry properties (`--rail-w`, `--transcript-w`, `--splitter-w`, spacing/radius scale) that `workspace-split.js` overwrites on `#workspace` at runtime.
- `operational-liquid.css` defines **zero** custom properties. All 23 tokens it consumes (`--z950`, `--live`, `--glass-*`, `--focus-ring`, `--ease-out`, `--motion-quick`, ...) resolve to `style.css`.
- `caret-shell.css` defines 16 `--caret-*` properties, and no other stylesheet consumes them (`grep -l 'var(--caret-' public/*.css` returns only `caret-shell.css`).

Direction is one-way: `caret-shell` → (self-contained tokens) and `operational-liquid` / `workspace-shell` → `style.css`. Removing `operational-liquid.css` or `caret-shell.css` therefore cannot orphan another layer's variables; removing `style.css` would orphan both dependents at once.

## 4. Cumulative-skin measurement

From `layer-overlap.txt` (selectors normalized by stripping the `body.caret-shell` prefix and splitting selector lists):

- 566 distinct selectors across the four active layers.
- **80** are styled by more than one layer.
- **16** are styled by three layers: `.ambient`, `.doc-meta`, `.doc-title`, `.dock`, `.glance`, `.output-switcher__item[aria-current="page"]`, `.pane__empty`, `.pane__eyebrow`, `.pane__title`, `.record-btn`, `.session-rail`, `.stage`, `.stage-pane`, `.topbar`, `.transcript-pane`, `.workspace`.
- Largest single overlap is `operational-liquid.css` re-styling 50 selectors already styled by `style.css`.

This is the measured form of the failure named in `.omo/drafts/caret-clone-redesign.md:43` ("the current 10-15% fidelity failure came from cumulative skins") and is the quantitative basis for the delete decisions in `ledger.md`.

## 5. Runtime state hooks the shell depends on

`caret-shell.css` keys off state that JavaScript owns, so any layer removal must preserve these writers:

| Hook | Written by | Read by |
|------|-----------|---------|
| `body.caret-shell` | static, `index.html:36` | 46 of 79 rules in `caret-shell.css` |
| `.app.caret-live` | static, `index.html:56` | live-split rules `caret-shell.css:381-579` |
| `.app--capturing` | `app.js:927,931` | `caret-shell.css:366-576`, `style.css:307-312,600,1670` |
| `data-detail-tab` | `index.html:56,212-214` + `operator-surface.js:4` | `caret-shell.css:366-379` |
| `aria-current="page"` | `operator-surface.js:27,67,74` | `caret-shell.css:280-282,326-329`, `operational-liquid.css:454-460` |
| `--rail-w` / `--transcript-w` on `#workspace` | `workspace-split.js` | `workspace-shell.css:36-43` |

Per `.omo/plans/caret-clone-redesign.md` Todo 2 these are observations, not contracts; the binding DOM/protocol manifest is Todo 3's deliverable.
