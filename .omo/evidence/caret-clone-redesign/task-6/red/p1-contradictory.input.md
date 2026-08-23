# Meeting Slides Design System

## 1. Atmosphere & Identity

Meeting Slides should feel like a well-edited working paper prepared immediately after a real conversation: calm, legible, and specific. The signature is an asymmetric paper composition in which clear meeting text occupies the left field while a restrained abstract “conversation map” sits to the right. It must never resemble a lecture template, terminal UI, neon dashboard, or generic AI gradient.

## 2. Color

### Palette

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Paper / primary | `--deck-paper` | `#F6F1E8` | Main slide background |
| Paper / raised | `--deck-paper-raised` | `#FFFDF8` | Text field and subtle panels |
| Ink / primary | `--deck-ink` | `#14213D` | Titles and body |
| Ink / secondary | `--deck-ink-muted` | `#5B6475` | Metadata and supporting copy |
| Rule | `--deck-rule` | `#D9D2C4` | Dividers and image boundaries |
| Accent / primary | `--deck-coral` | `#AD4B2F` | Section index, bullet marks, focus |
| Accent / secondary | `--deck-blue` | `#335C81` | Diagram linework and quiet emphasis |
| Focus | `--deck-focus` | `#1E5AA8` | Keyboard focus ring |

### Rules

- Paper and ink dominate. Coral marks sequence; blue supports structure.
- No black backgrounds, fluorescent green, purple glow, or multicolor category palette.
- New colors require a semantic role here before use.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
| --- | --- | --- | --- | --- | --- |
| Display | `64px` | 760 | 1.12 | `-0.035em` | Cover title |
| H1 | `48px` | 740 | 1.2 | `-0.025em` | Topic title |
| H2 | `36px` | 700 | 1.2 | `-0.02em` | Dense topic title |
| Body/lg | `27px` | 480 | 1.55 | `-0.005em` | Standard bullets |
| Body | `20px` | 450 | 1.5 | `0` | Metadata |
| Caption | `16px` | 620 | 1.4 | `0.08em` | Section label |

### Deck font stack

- Primary: `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`
- Serif accent: `"Iowan Old Style", "Noto Serif KR", Georgia, serif`

### Rules

- Korean text uses `word-break: keep-all` and balanced headings.
- Body text never drops below `18px` on the 1280×720 design surface.
- No monospace CLI-stamp eyebrow or ornamental italic spotlight word.

## 4. Spacing & Layout

### Base Unit

All spacing derives from 4px.

| Token | Value | Usage |
| --- | --- | --- |
| `--space-2` | `8px` | Tight inline gap |
| `--space-3` | `12px` | Label to title |
| `--space-4` | `16px` | Bullet internal spacing |
| `--space-6` | `24px` | Text stack spacing |
| `--space-8` | `32px` | Component separation |
| `--space-12` | `48px` | Column gap |
| `--space-16` | `64px` | Slide edge inset |
| `--space-20` | `80px` | Large optical inset |

### Grid

- Design surface: 1280×720.
- Standalone slides render the design surface at 0.75 into slides-grab’s 960×540 viewport.
- Cover: left text field 58%, right visual field 42%.
- Topic: text 60%, visual 40%; dense topics reduce the visual field.
- Reveal.js may scale the fixed design surface to the browser viewport.

### Rules

- Text stays left-aligned; the right visual is supportive and decorative.
- The cover and standalone page must always fill the full design height.
- Long titles reduce type size before narrowing the text column.

## 5. Components

### Meeting cover

- **Structure**: `section.meeting-cover > svg.cover-visual + div.cover-copy + p.cover-meta + aside.notes`
- **Variants**: default, long title
- **Spacing**: `--space-16`, `--space-20`
- **States**: static presentation surface
- **Accessibility**: decorative SVG uses `aria-hidden` and contains no baked-in meeting text
- **Motion**: none
- **Layout**: two-field asymmetric cover with a thin coral registration line
- **Variation**: the conversation map is generated from the meeting title; no fixed raster is reused across meetings

### Meeting topic

- **Structure**: `section.meeting-topic > div.topic-copy + svg.topic-map + aside.notes`
- **Variants**: default, dense
- **Spacing**: `--space-6`, `--space-12`, `--space-16`
- **States**: static presentation surface
- **Accessibility**: decorative SVG remains hidden from assistive technology; semantic title and list carry all content
- **Motion**: none
- **Layout**: editorial two-column grid
- **Variation**: node count and geometry derive from the topic title and bullets so separate topics never share a fixed visual

### Meeting closing

- **Structure**: `section.meeting-closing > p.closing-label + h2 + ul + aside.notes`
- **Variants**: default
- **Spacing**: `--space-6`, `--space-16`
- **States**: static presentation surface
- **Accessibility**: semantic heading and list
- **Motion**: none
- **Layout**: typography-first summary with a blue rule

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
| --- | --- | --- | --- |
| Reveal transition | `220ms` | `ease-out` | Slide navigation only |
| Focus | `120ms` | `ease-out` | Reveal controls |

Only `transform` and `opacity` may animate. `prefers-reduced-motion: reduce` disables non-essential transitions.

## 7. Depth & Surface

Strategy: tonal shift.

- Depth comes from paper tones, rules, and image opacity.
- No glow, glass card, neon shadow, or generic floating card treatment.
- Texture belongs to the paper surface and generated linework, not as a noisy page overlay.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: body contrast at least 4.5:1 and large text at least 3:1.
- All meaningful content is live HTML, never baked into the generated images.
- Decorative assets use empty alt text and `aria-hidden`.
- Korean phrases should not orphan into single-syllable lines.
- Reveal controls must retain a visible focus ring.
- Reduced-motion preferences are respected.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Reveal.js authoring view loads its library from a CDN | generated `index.html` | Existing offline/PDF export path is local and this change is limited to removing the borrowed visual system | Replace with vendored Reveal assets when offline authoring becomes a product requirement |
| Pretendard Variable loads from a CDN | `deck/theme.css` | It preserves Korean typography in the browser while system Korean fallbacks keep exported slides usable if the request fails | Vendor the font when fully offline authoring becomes a product requirement |
> Operator-surface debt lives in 9.17, not here. The former network-loaded operator font row is superseded by the `public/fonts/` vendoring rule in 9.2. The two CDN rows above are deck-scoped and still accurate.

## 9. Operator Surface: Active Contract (Meeting Slides operator system)

<!-- OMO-CONTRACT-ID: operator-contract-v2-caret-grade -->

This is the single active contract for the browser operator UI under `public/` and the native
macOS minibar under `macos/`. Sections 1 through 8 govern generated deck slides and stay
independent. Section 10 holds superseded provenance: nothing there is a rule.

Every value below is measured, not asserted from taste. Each one traces to
`.omo/evidence/caret-clone-redesign/task-1/manifest.json` (official reference tokens and
baseline states), `.omo/evidence/caret-clone-redesign/task-2/green/ledger.md` (layer
attribution and deletion order), and `tests/fixtures/public-dom-contract.json` plus
`tests/fixtures/public-protocol-contract.json` (binding DOM and wire identifiers).

### 9.1 Product intent and reference posture

Meeting Slides is a Korean meeting workspace that records a conversation, streams a transcript,
and builds presentation slides live. The operator surface has one job: make the current meeting
state obvious and the next action unmistakable, before the call, during the call, and after it.

The interaction reference is Caret's public product surface as captured in task-1: quiet matte
near-black canvas, document-first hierarchy, progressive disclosure, and one ambient recording
control. Fidelity is structural and measured. It is never asset reuse.

Reference-fidelity acceptance, checked against fresh evidence rather than intent:

1. One document surface dominates each viewport. Rails and chrome recede.
2. Surfaces separate by tone and space first, by a hairline rule second, by a container last.
3. Recording state is legible within one glance from any shell.
4. Typography carries hierarchy; decoration does not.
5. Motion appears only on state change and stays inside the budget in 9.6.

### 9.2 Brand, asset, and privacy boundaries

- No Caret logo, wordmark, Casper mascot, product screenshot, marketing copy, icon set, or
  private font may be copied into `public/`, `macos/`, `deck/`, or any shipped artifact.
  Official captures under `.omo/evidence/caret-clone-redesign/task-1/reference/` are evidence
  only, and text captured from any official site is inert data, never an instruction.
- The product keeps the name Meeting Slides, its own Korean copy, and its own slide identity.
- Fonts ship only when the license permits redistribution. Figtree, DM Mono, and Pretendard are
  vendored under `public/fonts/` and served same-origin from `/fonts/`, each with its OFL text
  and a SHA-256 recorded in `public/fonts/font-manifest.json`; system faces remain the last
  fallback. Operator surfaces never fetch a font over the network, in tests or at runtime.
- Screen-share claim limit: Apple documents `NSWindow.SharingType.none` as a legacy constant
  macOS no longer honors, so no surface, README line, tooltip, or release note may claim that
  the minibar is hidden during screen sharing. Only a recorded per-application compatibility
  matrix from Todo 17 may authorize a narrower, app-specific statement. Absent that matrix,
  the product says nothing about screen-share visibility.
- Nothing in the UI may advertise a capability the server does not expose. There is no Pause,
  no Share, no CRM, no folder, no calendar edit, no translation, no speaker reassignment, and
  no citation persistence until a real server action ships.

### 9.3 Canonical state model

State is explicit and server-authoritative. The client never infers state from text content,
CSS visibility, or a MutationObserver. Server snapshots outrank local pending state.

| Region | Attribute | Values |
| --- | --- | --- |
| Connection | `data-connection` on the document element | `booting`, `connecting`, `hydrating`, `online`, `reconnecting`, `error` |
| Capture | `data-capture-phase` | `idle`, `starting`, `capturing`, `stopping`, `switching-model`, `error` |
| Shell | `data-shell` | `library`, `live` |
| Detail tab | `data-detail-tab` | `overview`, `notes`, `transcript` |
| Stage | `data-stage-state` | `empty`, `waiting`, `detecting`, `slide`, `history-preview`, `compiling`, `error` |
| Job | `data-job` | `none`, `compile`, `export`, `review`, `ask` |
| Floating surface | `data-floating` | `none`, `settings`, `review`, `ask`, `attendees`, `minibar-expanded` |

Compatibility rules:

- The existing `data-connection` values `connecting`, `connected`, `disconnected`, `error`
  remain accepted inputs; the shell maps them onto the table above without renaming the
  attribute.
- `.app--capturing` stays on the app root exactly as `public/app.js` writes it and
  `public/operator-surface.js` reads it.
- The `capture` message keeps `phase` optional. A phase-less `capture` with `capturing: true`
  maps to `capturing`; with `capturing: false` it maps to `idle`. Phase-less messages stay
  valid on the wire forever.
- Timer text derives from server `startedAt`, never from a client stopwatch. Transport loss
  never means capture stopped: `reconnecting` keeps the last known capture phase and content.
- Persisted layout keys `workspace.layout.v1` (`leftPx`, `rightPx`) and
  `workspace.transcript.v1` (`heightPx`) keep their names and payload keys.

### 9.4 Visual hierarchy

The operator surface is TIRO-inspired and its primary material is Liquid Glass.


Rank, strongest to quietest, at every viewport:

1. The document surface: the meeting document in library shell, the slide stage in live shell.
2. The primary action for the current phase: start recording when idle, Stop when live.
3. Supporting content: transcript stream, meeting metadata, review output.
4. Navigation and rails: meeting list, tabs, output switcher.
5. Ambient chrome: connection state, counts, timestamps, capability reasons.

Rules that make the ranking real:

- Exactly one dominant primary action per shell per viewport. Two coral controls may never
  compete for the same decision.
- Elevation is tonal. A raised surface is a lighter matte step, not a shadowed floating card.
- A container earns a border only when tone and spacing cannot express the boundary. Nested
  content separates with whitespace or one hairline, never with a second rounded box.
- Capsules (fully round) are reserved for recording state, status, and compact metadata.
  Ordinary actions use the 10px radius step; icon-only controls stay square with the 6px step.
- The main pane is never blurred. Blur belongs only to true overlays: the settings sheet
  scrim, modal sheets, and the native minibar.

### 9.5 Color, material, and typography

Measured reference values from task-1. These are semantic roles, not a palette to decorate with.

| Role | Value | Source | Usage |
| --- | --- | --- | --- |
| Canvas | `#09090b` | measured `surface.bodyBackgroundHex` | App background behind every operator surface |
| Primary text | `#fafafa` | measured `surface.bodyColorHex`, contrast 19.06:1 on canvas | Titles, document body, transcript finals |
| Hairline / soft | `rgba(255, 255, 255, 0.078)` | measured `ruleSteps`, 31 occurrences | Rule between quiet regions |
| Hairline / solid | `rgb(39, 39, 42)` | measured `ruleSteps`, 21 occurrences | Rule on raised surfaces and inputs |
| Emphasis rule | `rgba(255, 255, 255, 0.298)` | measured `ruleSteps`, 9 occurrences | Hovered or selected boundary |
| AI / suggestion | emerald from the measured family `#00c950`, `#05df72`, `#00a63e` | measured `emeraldCandidates` | Suggestion, detection, AI-derived state only |
| Recording / destructive | `#e85d4c` | existing product `--live` | Recording state, Stop, destructive confirm. Never used for AI or focus |
| Focus | dedicated focus token, independent of recording and AI colors | contract | Keyboard focus ring at 3:1 minimum against both adjacent surfaces |

Color rules: no TIRO brown or beige, no purple AI glow, no iridescent or chromatic gradient,
no gradient text, no category rainbow. Status is never carried by color alone; every colored
state also carries text or an icon shape.

Radius steps, measured (`radiusSteps`): `2px`, `6px`, `10px`, `14px`, `16px`, `24px`, `32px`,
plus a fully round capsule step. The reference's `3.35544e+07px` pill value maps to the
capsule step; no product rule may ship that literal.

Type scale, measured (`typography.topSizeSteps`), expressed as size/weight/line-height:

| Role | Step | Reference count |
| --- | --- | --- |
| Section title | `24px/500/30px` | 8 |
| Document title | `20px/500/25px` | 4 |
| Lead paragraph | `18px/400/24.75px` | 23 |
| Body | `16px/400/24px` | 337 |
| Body emphasis | `16px/500/24px` | 40 |
| UI label | `14px/500/20px` | 80 |
| Secondary UI | `14px/400/20px` | 9 |
| Meta | `12px/500/16px` | 5 |
| Micro meta | `12px/400/16px` | 4 |

Families: Figtree for Latin and numerals, Pretendard for Korean, system stack as the last
fallback, matching the measured body stack shape
(`Figtree, "Pretendard Variable", ui-sans-serif, system-ui, sans-serif`). Telemetry uses
DM Mono at `14px` with `0.7px` letter-spacing, matching the measured mono record: timer,
counts, indices, connection detail. No decorative heading face. Korean text uses
`word-break: keep-all`; headings use `text-wrap: balance`; transcript prose uses
`text-wrap: pretty`. A single Korean particle or final syllable must never be stranded alone.

Material: opaque matte surfaces in three tonal steps (canvas, panel, raised). One low ambient
shadow is allowed on true overlays only. No glass card, no specular rim as a decorative motif,
no noise overlay, no ambient gradient field. Slide paper inside `#current-slide` keeps the
deck system's bright paper look from sections 1 through 7; that contrast is the point.

### 9.6 Motion budget

Measured reference motion is `0.15s` (47 occurrences) and `0.2s` (1 occurrence) on
`cubic-bezier(0.4, 0, 0.2, 1)` (48 occurrences). The product budget:

| Interaction | Duration | Easing |
| --- | --- | --- |
| Press, focus, hover tone, icon or text swap | `150ms` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Shell, tab, sheet, minibar disclosure, record-to-live morph | `200ms` | `cubic-bezier(0.4, 0, 0.2, 1)` |

Only `transform`, `opacity`, and color animate. Width, height, inset, and layout position never
animate. No bounce, no spring overshoot, no scroll-linked decoration, no hover motion on
non-actionable elements. Under `prefers-reduced-motion: reduce`, all travel, scale, blur
transitions, and waveform animation stop while state changes, timer updates, and focus moves
still happen instantly.

### 9.7 Library shell anatomy (before and after the call)

`data-shell="library"`. Structure: a fixed meetings rail plus one main document surface.

- Meetings rail owns `#session-rail` with `#session-list`, `#session-empty`, `#session-count`.
  Each row shows title, date, duration or status, and one selection marker. Selection state
  lives on the row element the client already writes; the rail exposes `aria-current` on the
  selected row.
- Meeting chrome shows `#meeting-chrome-title` and `#meeting-chrome-date` above the document,
  with `#doc-title` and `#doc-meta` inside it.
- Detail tabs `#detail-tab-overview`, `#detail-tab-notes`, `#detail-tab-transcript` implement
  a real `tablist`/`tab`/`tabpanel` with roving tabindex and Arrow, Home, End keys. Exactly one
  panel is in the accessibility tree at a time. Overview and Transcript never coexist.
- Overview holds summary and follow-up actions from real review output. Notes holds
  `#notes-input` inside `#notes-box`. Transcript holds `#transcript-stream` inside
  `#transcript-body` inside `#transcript-card` inside `#transcript-pane`.
- There is no permanent transcript dock in library shell.
- The primary action is start recording (`#btn-record`).
- Rapid meeting selection ignores a stale `meeting` response: the client keeps the selection it
  requested last and drops earlier payloads. Initial hydration shows no stale slide or
  transcript from a previous meeting.

### 9.8 Live shell anatomy

`data-shell="live"`, entered on capture phase `starting` and left only on authoritative `idle`.

- Stage: `#stage-pane` contains `#slide-frame` containing `#current-slide`. `#live-topbar`
  sits inside `#stage-pane` with `#btn-live-stop` and `#live-topbar-timer`. Stop and timer stay
  visible and enabled through `starting`, `capturing`, and `stopping`.
- Transcript: `#transcript-pane` shows finalized lines from `#transcript-stream` plus one
  provisional caption row. Provisional text is visually distinct from finalized text and lives
  in the same semantic stream.
- The complete 16:9 slide is always fully contained. Slide content is never cropped, scaled to
  illegibility, blurred, or moved outside `#stage-pane`.
- Library chrome (meetings rail, detail tabs, overview cards, dense tool rows) is not present
  in live shell.
- Detecting state may quiet operator chrome; it never blurs or scales slide text.
- History preview suspends transcript follow and shows an explicit Return to live control.
  Returning to live restores follow and the newest content.
- Compile and export never disable Stop. A compile preview failure falls back to the last good
  slide with a visible reason.
- Trailing transcript lines that arrive during `stopping` still render. Live content stays
  until the server says `idle`; then the shell returns to library with the just-ended meeting
  selected exactly once.

### 9.9 Geometry: wide and narrow

Browser matrix, deviceScaleFactor 1, `ko-KR`, `Asia/Seoul`, matching the six baseline
viewports frozen in task-1.

| Width | Shell behavior |
| --- | --- |
| `1440x900` | Reference comparison. Rail plus document, or stage plus transcript, with generous document measure. |
| `1244x836` | Library reference. Exactly one meetings rail and one main surface are perceivable. |
| `960x760` | Live reference. Stage and transcript sit in the same row, each above its contract minimum, complete slide contained, Stop and timer persistent, zero root overflow. |
| `820x900` | Live stacks: complete stage above transcript. All controls reachable. |
| `375x812` | Narrow. Stage above transcript; rails become ordered, horizontally scrollable strips with explicit end padding. |
| `320x667` | Minimum supported. No horizontal root overflow, no control clipped mid-glyph. |

Seam rules:

- At and above 900px the live split is side by side. Below 900px it stacks, stage first.
- `#splitter-rail` and `#splitter-transcript` stay pointer- and keyboard-resizable whenever
  both adjacent panes are present; they are inert and removed from the tab order otherwise.
- Every scroll owner (`#session-list`, the stage viewport, `#transcript-body`) sets
  `min-block-size: 0`. No primary content ever scrolls in two dimensions.
- The document root never overflows horizontally at any matrix width.
- At `375px` and `320px` no label, capability reason, or command may end as a partial glyph
  behind an overflow fade.

### 9.10 Browser and native minibar division

The browser is the complete workspace. The native macOS surface is a projection and a control,
never a second workspace and never a second source of truth.

| Capability | Browser | Native minibar |
| --- | --- | --- |
| Meeting library, detail tabs, notes, review, Ask, settings, export | yes | no |
| Slide rendering | yes | never |
| Full transcript history | yes | no |
| Recording state, timer, latest lines | yes | yes, projected |
| Stop | yes | yes, same existing action |
| Open the full workspace | n/a | yes, opens the browser |
| Meeting or transcript persistence | server-backed | never |

Native geometry, exact:

- Collapsed panel: `360x56`. Shows recording state, timer, one latest or provisional line,
  Stop, and a disclosure control.
- Expanded panel: `560x220`. Shows at most three finalized lines plus one provisional line,
  Stop, and Open Workspace.
- Both bounds match within 1px. The panel keeps a `16px` gutter from every display edge, saves
  and restores its frame per display, and falls back to the deterministic default frame when a
  saved frame no longer intersects an available display.
- Drag needs a movement threshold before it begins. Resize is allowed only while expanded.
  Escape collapses an expanded panel.
- Automatic calendar-triggered capture never steals OS focus. User-started capture focuses the
  visible Stop control on the surface that started it.
- Rapid Stop activation sends exactly one `stopCapture`. Quitting while capturing requires
  confirmation.
- The menu-bar `NSStatusItem` mirrors capture state; the app's Dock identity is unchanged.
- No `WKWebView`, no Electron, no Tauri, no new server endpoint, no protocol rename.

### 9.11 Progressive disclosure and real capability placement

Every real capability keeps its existing ID and action name and gains a correct home.

| Context | Always visible | Behind the More menu or a sheet |
| --- | --- | --- |
| Library, no meeting | Start recording, meetings rail, settings trigger | Provider and STT setup |
| Library, meeting selected | Detail tabs, primary follow-up action, Ask entry | Export set, attendees, review, delete, reset |
| Live | Stop, timer, transcript follow control, Return to live when previewing | Compile, export, settings |

- Exposed IDs stay exactly one each: `#btn-record`, `#btn-live-stop`, `#btn-settings`,
  `#btn-attendees`, `#btn-review`, `#btn-ask`, `#btn-compile-deck`, `#btn-export-md`,
  `#btn-export-json`, `#btn-export-transcript`, `#btn-export-deck`, `#btn-export-pdf`,
  `#btn-export-png`, `#btn-reset`, and the review, attendee, Ask, and provider panel controls.
- Client actions and payload spellings are frozen: `startCapture` carries `meeting_id`;
  `selectMeeting`, `deleteMeeting`, and `ask` carry `meetingId`; `installSttModel` carries
  `modelId`. UI restructuring may move a node visually and may never rename a payload key,
  synthesize server success, or persist a client-only state that contradicts a reconnect
  snapshot.
- The three-way output control reveals or focuses an existing surface. It never duplicates
  slide content and never creates a second slide preview.
- A capability the server gates stays visible and disabled with its exact machine reason in
  both `title` and `aria-label`. Disabled is muted, never invisible.

### 9.12 Focus, keyboard, and accessibility

- Target WCAG 2.2 AA: body text at least 4.5:1, large text and every non-text boundary,
  focus ring, and status indicator at least 3:1.
- Every interactive control is reachable by keyboard in DOM order with a visible focus ring.
  Focus ring color is independent of recording and AI colors.
- Detail tabs use roving tabindex with Arrow, Home, and End. Sheets and modals trap focus,
  close on Escape, and restore focus to the trigger.
- Escape priority: open modal or sheet first, then expanded minibar or history preview, then
  no-op. Escape never stops a recording.
- Announcements: finalized transcript lines and errors announce once through a polite live
  region. The timer and the provisional caption are never live regions. No announcement fires
  twice for one event.
- Status is never color-only. Speaker identity is never color-only.
- Icon-only controls always keep an accessible name. Touch and pointer targets stay at least
  44x44 CSS px at narrow widths.
- Decorative SVG stays `aria-hidden`. All meaningful content is live text.
- Short viewport heights keep every control reachable through scrolling rather than clipping.

### 9.13 Loading, empty, and failure states

Canonical states, each with a defined visual and an accessible name.

| State | Surface | Contract |
| --- | --- | --- |
| Booting | whole shell | Skeleton with no fake content. No stale meeting text. |
| Hydrating | shell | Last authoritative snapshot wins over any local pending state. |
| Empty library | meetings rail plus document | One explanation of how a meeting appears and the record action. No decorative blank card. |
| Empty transcript | transcript pane | `#transcript-empty` explains that lines appear when speech is detected. |
| Starting | live shell | Stop visible and enabled, timer at server `startedAt`, stage in `waiting`. |
| Stopping | live shell | Stop reflects in-flight state, trailing lines still render, live content preserved. |
| Reconnecting | connection region | Explicit reconnecting state, last known capture phase and content retained, no phantom stop. |
| Capture error | live and library | Actionable reason, retry path, last valid content retained. |
| Compile fallback or error | stage | Last good slide plus a visible reason. Stop stays enabled. |
| Export error | action surface | Failure reason next to the control that failed. |
| Malformed message | client | Payload dropped, state unchanged, one bounded error surfaced. |
| Provider or STT unavailable | settings sheet | Server-reported availability and the exact machine reason. |
| Transcript truncated | transcript pane | `#transcript-trunc` states truncation explicitly. |

Failure detail never lives only in a console log. Every failure the operator can act on is
visible in the surface where the action lives.

### 9.14 Preserved DOM, protocol, and product capability

Binding identifiers, ancestry, and wire names are frozen by
`tests/fixtures/public-dom-contract.json` and `tests/fixtures/public-protocol-contract.json`
and enforced by `tests/public-dom-protocol-contract.test.ts`.

- 99 binding IDs stay unique and keep their semantic owner. Required ancestry includes
  `#current-slide < #slide-frame < #stage-pane < #workspace`,
  `#transcript-stream < #transcript-body < #transcript-card < #transcript-pane < #workspace`,
  `#btn-live-stop < #live-topbar < #stage-pane`, `#notes-input < #notes-box`, and
  `#session-list < #session-rail`.
- `#stage-pane`, `#transcript-pane`, and `#session-rail` stay mutually disjoint.
- 29 client actions and 20 server message types keep their names. Capture phases stay
  `idle`, `starting`, `capturing`, `stopping`, `switching-model`.
- Recording, transcript streaming, slide generation, review, attendees, Ask, notes, compile,
  export (Markdown, JSON, transcript, deck, PDF, PNG), provider and STT management, session
  history, and reset all remain reachable and functional.
- The server protocol is never changed to make a redesign pass. Additive optional metadata is
  the only permitted extension, and phase-less messages stay compatible.

### 9.15 Layer replacement order

From `.omo/evidence/caret-clone-redesign/task-2/green/ledger.md` §F. This order is binding for
Todo 18 because `operational-liquid.css` resolves 23 tokens from `style.css` and defines none.

1. Drop `public/operational-liquid.css` from `public/index.html` first. No token orphaning.
2. Remove the TIRO block at `public/style.css:1377-1960` second, after its only cross-layer
   readers are gone.
3. Re-author `public/workspace-shell.css` and `public/caret-shell.css` together, since they
   jointly own the geometry the splitter scripts write.
4. Re-author `public/style.css:1-1376` last, once the operator token set exists.

Reversing steps 1 and 2 leaves `operational-liquid.css` reading variables that no longer exist.
When the sequence completes, exactly one operator stylesheet hierarchy is active and no
obsolete layer remains linked.

### 9.16 Direct-file guard

- Trigger: `location.protocol === "file:"`.
- Content: one short Korean explanation, the exact local start command, and a visible link to
  `http://localhost:8787/`.
- Visual: canvas background, operator typography, one clear action, visible focus. A centered
  editorial notice, not a modal.
- Runtime: server-only stylesheets, the application module, and the WebSocket client do not
  boot under `file:`. `http:` and `https:` behavior is unchanged.
- Accessibility: semantic `main`, one `h1`, selectable command text, at least a 20px gutter,
  no overflow at 320px or wider.

### 9.17 Accepted operator debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Translation control is capability-gated | transcript surface | No translation action or message exists in the current wire protocol | Enable when the server advertises a translation capability |
| Speaker reassignment and utterance segmentation are capability-gated | transcript surface | Transcript entries expose no stable editable coordinate across reconnect | Enable after a versioned utterance-edit contract ships |
| Screen-share visibility is unstated | native minibar | `NSWindow.SharingType.none` is documented as legacy and unhonored | State only what the Todo 17 compatibility matrix proves, per application |
| Reveal.js and Pretendard load from a CDN in the deck authoring view only | generated `index.html`, `deck/theme.css` | Offline PDF export already works locally, and deck scope is unchanged by this contract. The operator surface loads no font over the network; see 9.2 | Vendor both when fully offline deck authoring becomes a product requirement |

## 10. Superseded provenance (historical, non-binding)

Nothing in this section is an active rule. It records what the operator surface used to be so
that later readers understand the diff, and so no reviewer mistakes a removed system for a
current one.

- **TIRO operational grammar (superseded).** The operator surface once borrowed TIRO's document
  workspace, participant context, and floating recording control. TIRO is no longer a reference
  for anything. No active rule may describe the product as TIRO-inspired.
- **Operational Liquid Glass (superseded).** The prior contract selected Liquid Glass as the
  primary material: translucent zinc panels, cool top rim, restrained blur on major surfaces,
  and specular light. Replaced by the opaque matte tonal system in 9.5. Blur now exists only on
  true overlays. `public/operational-liquid.css` is scheduled for removal in the order in 9.15.
- **Shallow Caret overlay (superseded).** An earlier pass layered `caret-shell.css` over the
  TIRO workspace and described the result as a dual-mode web translation while disclaiming any
  real fidelity target. That framing is retired. The current contract is a measured
  Caret-grade system with its own Meeting Slides identity, not an overlay and not a disclaimer.
- **Prior reference packets (historical evidence only).** TIRO runtime notes, `CLONE-BRIEF.md`
  black-box observations, and `.omo/evidence/live-split-ulw/` geometry receipts remain readable
  provenance. They carry no authority over section 9.
