# Rule-level keep / replace / delete ledger

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
Scope: the four active stylesheets and six active scripts loaded by `public/index.html`.
Status: **inventory only.** Task 2 is read-only; nothing here has been applied. Todo 18 ("obsolete-layer cleanup") is the executor of these verdicts, and Todo 6 consumes them when writing the binding `DESIGN.md` contract.

Verdict vocabulary:

- **KEEP** — required functionality or a contract the redesign must not disturb; carries forward as-is.
- **REPLACE** — the surface stays but its styling is re-authored against the Caret token system; the DOM hook and its JS writer survive.
- **DELETE** — removed from the runtime with no successor rule.

Attribution buckets follow Todo 2's required taxonomy: `legacy Meeting Slides`, `TIRO`, `Operational Liquid`, `current Caret`, `required functionality`.

## A. Layer-level verdicts

Rule counts are top-level blocks from `css-rule-map.tsv`.

| Layer | Lines | Rules | Attribution | Verdict | Basis |
|-------|-------|-------|-------------|---------|-------|
| `public/style.css:1-1376` | 1376 | 376 | legacy Meeting Slides + required functionality | **REPLACE (partial KEEP)** | Root of the token graph; both other non-Caret layers resolve every variable here (`active-load-order.md` §3). Slide/deck/panel rules inside it are required functionality. Cannot be deleted wholesale. |
| `public/style.css:1377-1960` | 584 | 75 | TIRO | **DELETE** | Self-declared "TIRO-inspired focused operator surface" block (`style.css:1377-1380`). Plan Must-NOT-have: "obsolete active layers must be removed from the runtime." |
| `public/workspace-shell.css` | 372 | 55 | TIRO | **REPLACE** | Five-column geometry is TIRO's, but `workspace-split.js` writes `--rail-w`/`--transcript-w` here and persisted layout keys are a Todo 3 contract. Geometry must be re-authored, not dropped blind. |
| `public/operational-liquid.css` | 861 | 88 | Operational Liquid | **DELETE** | Defines zero tokens and contributes no DOM hook. Pure skin: 50 of its selectors merely re-style selectors `style.css` already styles. Named obsolete in `.omo/drafts/caret-clone-redesign.md:43`. |
| `public/caret-shell.css` | 579 | 79 | current Caret | **REPLACE** | Closest to target intent but implemented as a late override on top of three skins (`.omo/drafts/caret-clone-redesign.md:50`). Its `--caret-*` tokens are self-contained, so it is re-authorable in place as the single system. |

Net effect if applied: 861 lines deleted outright, 584 more deleted from `style.css`, leaving one measured system instead of four stacked ones.

## B. Selectors styled by three layers — forced REPLACE set

These 16 selectors each receive declarations from three different stylesheets and are the measured core of the cumulative-skin failure. Every one must end up owned by exactly one layer.

| Selector | style.css | workspace-shell.css | operational-liquid.css | caret-shell.css | Verdict |
|----------|-----------|--------------------|------------------------|-----------------|---------|
| `.workspace` | — | 36-43, 336-339 | 110-112 | 341-343, 386-398 | REPLACE — single owner |
| `.session-rail` | — | 49-57, 341-353, 363 | 114-124 | 36-47, 49-51, 345-353 | REPLACE — single owner |
| `.stage-pane` | — | 281-285, 341-361 | 195-206 | 36-47 | REPLACE — single owner |
| `.transcript-pane` | — | 49-56, 58, 341-353, 364 | 114-124 | 36-47, 513-516 | REPLACE — single owner |
| `.topbar` | 114-127, 1807-1819 | — | 36-49, 51-60 | 36-47 | REPLACE — single owner |
| `.dock` | 1821-1824 | — | 414-416 | 36-47, 270-274, 547-555 | REPLACE — single owner |
| `.stage` | — | — | 230-234 | 345-353, 495-511 | REPLACE — single owner |
| `.glance` | — | — | 293-303 | 36-47, 345-353 | REPLACE — single owner |
| `.record-btn` | — | — | 480-489 | 276-278 | REPLACE — recording state is coral/red only |
| `.ambient` | 85-94 | — | 16-22 | 23-25 | DELETE — ambient glow/grid/noise is Operational Liquid decoration; the Caret target is quiet matte near-black |
| `.doc-title` | — | — | 214-222 | 355-358 | REPLACE — single owner |
| `.doc-meta` | — | — | 224-228 | 360-364 | REPLACE — single owner |
| `.pane__title` | — | 69-75 | 138-141 | 355-358 | REPLACE — single owner |
| `.pane__eyebrow` | 1383+ | — | 133-136 | 360-364 | REPLACE — `style.css` copy is inside the deleted TIRO block |
| `.pane__empty` | — | 93-102 | 397-403 | 360-364 | REPLACE — single owner |
| `.output-switcher__item[aria-current="page"]` | — | — | 454-460 | 280-282 | REPLACE — keep the `aria-current` hook written by `operator-surface.js:27,67,74` |

## C. KEEP — required functionality

Not visual-layer debt. These must survive the cleanup untouched in behavior.

| Rules / assets | Location | Reason |
|----------------|----------|--------|
| Slide / deck / multi-kind stage design (67 rules) | `style.css:724-966` | Renders `#current-slide`; `.slide__title` is explicitly retained "기존 테스트 호환을 위해" (`style.css:726`). Bright slide surface is isolated inside `#stage-pane`. |
| Review / Ask panel block (91 rules) | `style.css:967-1376` | Backs `review-panel.js` / `review-panel-render.js`, including `review-item--${kind}` built at `review-panel-render.js:93`. |
| Provider, attendee, and STT settings rows | `style.css:217-603` | Real settings/provider/review/Ask capability; plan requires re-homing without renaming action IDs. |
| `.direct-file-guard` inline block | `index.html:16-30` | `file://` guard must render with no external stylesheet; cannot move into a layer. |
| `#runtime-bootstrap` | `index.html:12-15` | App health-check signature consumed by the macOS launcher. |
| `workspace-split.js`, `transcript-resize.js` | `index.html:456-457` | Own persisted layout keys and `#workspace` geometry variables — Todo 3 contract surface. |
| `app.js`, `review-panel*.js` | `index.html:459-461` | WebSocket dispatch, capture, transcript, sessions, slides. Explicitly out of scope for the redesign. |
| `operator-surface.js` | `index.html:458` | Writes `data-detail-tab` and `aria-current`; the Caret shell's state hooks depend on it. |

## D. DELETE — unreferenced rules (dead in the shipped DOM)

Verified by matching every `.class` / `#id` token in each selector against the concatenated text of `index.html` and all six shipped scripts, then hand-checking each hit for dynamic construction (see §E). These have no producer at all:

| Rule | Location | Attribution | Note |
|------|----------|-------------|------|
| `body.caret-shell .session-rail__title, .stage-pane__label, .transcript-pane__label` | `caret-shell.css:53-59` | current Caret | No such class in the DOM; the shell uses `.pane__title`. |
| `body.caret-shell .session-item.is-active, .session-item[aria-current="true"]` | `caret-shell.css:71-75` | current Caret | `app.js:136` emits a bare `<li class="session-item">`; selected state lives on the inner `.session-row--selected` (`app.js:137`). Neither `is-active` nor `aria-current` is ever set on it. |
| `body.caret-shell .session-item__title` | `caret-shell.css:77-80` | current Caret | Real markup is `.session-row__title`. |
| `body.caret-shell .session-item__meta` | `caret-shell.css:82-84` | current Caret | Real markup is `.session-row__meta`. |
| `.slide__header` | `style.css:336` | legacy Meeting Slides | Superseded by the multi-kind slide design at `style.css:724-966`. |
| `.review-item__deadline-label` | `style.css:1127-1131` | legacy Meeting Slides | Not emitted by `review-panel-render.js`. |
| `.review-btn__icon` | `style.css:1228,1230` | legacy Meeting Slides | Not emitted. |
| `.glance__metric--rec .glance__metric-value` | `style.css:297` | legacy Meeting Slides | Modifier never applied. |

`caret-shell.css:71-75` is the most consequential entry: the current Caret layer styles a selected-session state that the runtime never produces, so the shell has no working active-session affordance today. Todo 12 must supply one against `.session-row--selected`.

## E. Ruled NOT dead — dynamically constructed class names

Recorded so a later cleanup pass does not delete them from a naive static scan. Each is built by template literal at runtime:

| Family | Constructed at | Rules |
|--------|----------------|-------|
| `provider-row__badge--{ok,unknown,absent,off}` | `app.js:663` | `style.css:230-231,242-244` |
| `stt-row__badge--{selected,installed,downloading,failed,absent}` | `app.js:777` | `style.css:254-258` |
| `review-item--{decision,action_item,open_item}` | `review-panel-render.js:93` | `style.css:1062-1064,1078-1080` |
| `ask-message--{user,assistant}` | `app.js:1243` | `style.css:1305-1316` |
| `session-row__status--{open,ended}` | `app.js:141` | `workspace-shell.css:149` (only `--open` has a rule; `--ended` is emitted but unstyled) |

## F. Deletion order constraint

`operational-liquid.css` consumes 23 tokens from `style.css` and defines none. `caret-shell.css` consumes only its own `--caret-*` tokens. Therefore:

1. `operational-liquid.css` can be dropped from `index.html:33` first with zero token orphaning.
2. The `style.css:1377-1960` TIRO block can then be removed, since its only cross-layer readers were in the deleted skin.
3. `workspace-shell.css` and `caret-shell.css` are re-authored last, together, because they jointly own the geometry the splitter scripts write.
4. `style.css:1-1376` is re-authored only after the Caret token set exists, since every layer resolves through it.

Reversing steps 1 and 2 would leave `operational-liquid.css` reading variables that no longer exist.
