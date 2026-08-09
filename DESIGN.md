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
| General Sans loads through the official Fontshare API | `public/index.html` | The operator surface gains a licensed Latin/numeral face without redistributing closed-source font files; Korean and system fallbacks remain available if the request fails | Revisit only if the operator surface must work fully offline |

## 9. Operator Surface: Focused Live Workspace

This contract applies only to the browser operator UI under `public/`. It borrows TIRO’s
operational grammar — a quiet document workspace, compact participant context, a floating
recording control, and transcript-first editing — without copying TIRO’s colors, logo, copy,
or assets. The paper deck system above remains independent, and slide drafts may render only
inside `#stage-pane` / `#current-slide`.

### Style-gallery decision: Operational Liquid Glass

The installed UI/UX style gallery was queried for a premium dark operator console. The selected
primary style is **Liquid Glass**. VisionOS spatial UI, cyberpunk UI, pure OLED black, and generic
glassmorphism are rejected because they either weaken dense workbench legibility, introduce
decorative color, or make every surface look equally elevated.

The product translation is **Operational Liquid Glass**:

- Liquid Glass supplies the material language: translucent zinc, a cool top rim, restrained
  blur, soft specular light, and short fluid state transitions.
- The meeting operator job supplies the information architecture: one dominant editorial stage,
  one dense transcript workbench, quiet history/status context, and bottom command islands.
- Existing zinc and `--live` coral remain the entire color story. Iridescent gallery colors,
  chromatic aberration, gradient text, and decorative glow are prohibited.
- Depth is role-based rather than decorative: stage paper is brightest, live transcript is
  denser, supporting rails recede, and the recording control floats closest to the operator.

Visual hierarchy must not collapse into a wall of equal rounded rectangles:

1. Use spacing, light, type scale, and surface opacity before adding another border.
2. Major islands may have one outer edge and one inner highlight; nested content must usually
   separate with whitespace or a hairline, not another rounded container.
3. Capsules are reserved for recording, view modes, status, and compact metadata. Normal actions
   use compact rounded rectangles; icon-only controls remain square.
4. At each viewport there is one obvious next action. On an empty workspace that action is
   recording; during capture it is the live waveform/stop control.
5. At 375 and 768 widths no label, reason, or terminal command may end as a partial glyph behind
   an overflow fade. Rails must retain explicit end padding.

### Direction and material

- **Atmosphere**: a dim, zinc-toned studio made from separated floating islands around one
  bright editorial stage. The page background remains visible between header, rails, stage,
  transcript, and command islands; a restrained radial light field may reveal depth without
  becoming a decorative gradient.
- **Signature material**: Apple-inspired translucent zinc glass with a cool top rim, inner
  edge, restrained blur, and one low black shadow. Glass is selective: header, navigation,
  major panel shells, recording dock, and settings may use it; slide paper, transcript prose,
  tool rows, and long settings lists retain denser surfaces for legibility. Glass communicates
  operator layering only and never enters generated decks.
- **Color story**: `--z950` through `--z100` carry structure, `--live: #e85d4c` is the only
  live/recording accent, and muted zinc text carries secondary state. No TIRO brown, beige,
  emerald live state, purple AI glow, or additional category palette.
- **Memorable moment**: the bottom recording pill changes from a compact record target into
  a live waveform and timer while preserving its position and action meaning.

### Required tokens

| Role | Token | Contract |
| --- | --- | --- |
| Zinc ramp | `--z950` … `--z100` | Existing neutral hierarchy; values in `style.css` remain the source of truth |
| Live accent | `--live` | `#e85d4c`; recording, active waveform, destructive stop affordance |
| Glass fill | `--glass-bg` | Existing translucent operator fill |
| Glass blur | `--glass-blur` | Existing blur strength; operator overlays only |
| Glass edge | `--glass-border`, `--glass-highlight` | Outer rule plus cool top-light rim |
| Glass depth | `--glass-shadow`, `--glass-inset` | One low ambient shadow and one inner edge |
| Glass radius | `--glass-radius` | `18px`; shared island shell radius |
| Island gap | `--island-gap` | `10px`; visible canvas between major operator surfaces |
| Focus | `--focus-ring` | High-contrast keyboard focus, independent of recording color |
| Motion / quick | `--motion-quick` | `120ms`; press, focus, icon/text swap |
| Motion / state | `--motion-state` | `220ms`; panel, pill, and content-state transition |
| Motion easing | `--ease-out` | Restrained ease-out; no decorative bounce |

New operator colors or timing values must be declared here and in `:root` before use.
Hard-coded TIRO values are prohibited.

### Current upgrade acceptance

- The top bar reads as one shallow floating island, not a bordered toolbar.
- The stage is the strongest surface at desktop and the first content surface at 768/375.
- History and transcript shells are quieter than the stage; utility rows do not create nested
  card-on-card noise.
- The recording control reads as the closest floating object and preserves its record↔waveform
  morph without layout shift.
- Disabled Ask, translation, and edit controls keep their capability reason readable; disabled
  state is muted, never vanished.
- The 768 output rail and 375 action rail keep at least one control-width of terminal breathing
  room so the final visible control never ends mid-glyph.
- Keyboard focus remains independent of `--live`; reduced-motion mode removes ambient and morph
  animation while preserving state changes.

### Operator typography

| Role | Stack | Usage |
| --- | --- | --- |
| Display and body | `"Inter", "Pretendard", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif` | Inter shapes Latin/numerals and Pretendard shapes Korean across shell labels, transcript, settings, and stage chrome |
| Telemetry | `"JetBrains Mono", "SFMono-Regular", Consolas, monospace` | Timer, connection state, counts, indices |

Inter and Pretendard are the product UI pair. Display and body roles share the same family
stack; hierarchy comes from weight, scale, and spacing rather than a decorative heading face.
Mixed Korean/Latin text uses the shared stack. Headings and slide copy use
`word-break: keep-all`, `text-wrap: balance`, and a safe overflow fallback; transcript prose
uses `text-wrap: pretty`. Single Korean particles or final syllables must not be stranded by
overly narrow controls.

### Shell and scroll ownership

- `#app` is a bounded `100dvh` shell. The header and floating dock stay fixed in the shell.
- At desktop widths, the header, session rail, center frame, transcript workbench, and dock
  reveal `--island-gap` of the ambient canvas between their rounded glass shells.
- `#workspace` retains the existing five-column desktop grid:
  `rail / splitter / stage / splitter / transcript`.
- `#session-list`, the stage viewport inside `#stage-pane`, and the body containing
  `#transcript-stream` own their respective vertical scrolling. Every scroll child has
  `min-block-size: 0`.
- At and above `1180px`, all five desktop columns are visible and the two existing splitters
  remain pointer- and keyboard-resizable.
- Below `1180px`, the session rail becomes a compact top/side context strip while the stage
  and transcript remain side by side. Splitters are non-interactive when their adjacent pane
  is not in the five-column state.
- Below `900px`, the stage is primary; sessions and transcript become explicit, keyboard
  reachable views in the ordered control rail. No primary content uses two-dimensional
  scrolling.
- At 375px, 768px, and 1280px the document root never overflows horizontally.

### Primitive: workspace header

- **Structure**: brand and meeting identity, connection state, session actions, and settings
  trigger. Existing action IDs and WebSocket payloads remain unchanged.
- **States**: disconnected, connecting, ready, recording, processing, error.
- **Behavior**: state copy is specific and concise. Disabled actions always expose a visible
  reason and the same reason through `title` and `aria-label`.
- **Responsive**: status detail yields before the primary record affordance; no icon-only
  action loses its accessible name.

### Primitive: session rail

- **Structure**: `#session-list` is the sole stored-session list. Each item contains title,
  last activity, duration/status metadata, and one selected-state marker.
- **States**: loading, empty, populated, selected, unavailable.
- **Behavior**: selection uses the existing session actions/messages. Empty state explains
  how a session appears instead of presenting a decorative blank card.
- **Responsive**: metadata truncates before titles; at narrow widths the rail becomes a
  bounded horizontal reel or explicit view without changing DOM identity.

### Primitive: center stage

- **Structure**: `#stage-pane` owns stage chrome; `#current-slide` owns every live slide draft.
  No slide card, preview, or draft may be added to sidebars, overlays, settings, or the dock.
- **States**: waiting, detecting, topic, decision, actions, summary, compile-ready, error.
- **Material**: the slide itself remains bright paper with deck typography; surrounding chrome
  is dark operator glass. The contrast makes draft content unmistakable.
- **Behavior**: existing live-kind rendering and slide history remain intact. Detecting state
  may soften operator chrome but never blur or scale slide text.

### Primitive: transcript workbench

- **Structure**: panel heading, spoken/written language summary, translation control,
  finalized utterance stream `#transcript-stream`, debounced current caption, and transcript
  actions.
- **Utterance anatomy**: timestamp, speaker chip, spoken text, optional written/translated
  line, and citation anchor. Spoken and written text are visually distinct but remain in one
  semantic utterance.
- **Editing states**: resting, hovered/focused, range-selected, speaker menu open, segmented,
  unavailable with reason.
- **Interaction**:
  - Selecting a contiguous utterance range prepares one speaker reassignment.
  - `Enter` at an editable utterance boundary requests a segment split.
  - Citation actions move focus and scroll to the referenced utterance, then apply a brief
    focus highlight.
  - These controls are enabled only when the current server contract supplies a stable
    utterance coordinate and action. Otherwise they remain visibly disabled with the exact
    reason “서버 편집 계약이 필요합니다”; the client must not invent persistence.
- **Translation**: spoken and written language selectors describe separate roles. The live
  translation switch is disabled with the exact reason “번역 모델 연결이 필요합니다” until
  a real backend capability is advertised. No local fake translation is permitted.
- **Accessibility**: finalized transcript updates use one restrained polite announcement;
  streaming caption text is not repeatedly announced. Speaker color is never the sole cue.

### Primitive: three-way output control

- **Destinations**: slide draft, full transcript, and reviewed meeting output.
- **Contract**: the control reveals or focuses existing surfaces; it does not duplicate their
  content or create a second slide preview.
- **States**: available, selected, processing, disabled-with-reason. Selection is represented
  with `aria-current` or `aria-selected` as appropriate.
- **Responsive**: it remains one ordered, horizontally scrollable rail below `900px`; every
  destination and trailing action stays keyboard reachable.

### Primitive: floating recording dock

- **Structure**: elevated pill below `#workspace`, containing input mode, language context,
  the primary record control, live timer/waveform, and immediately related actions.
- **Geometry**: `.dock` remains after and below the workspace in DOM/layout order so existing
  geometry and tests remain valid. Visual elevation may overlap the workspace edge without
  moving slide content.
- **Idle state**: a clear coral record target and “녹음 시작” label.
- **Recording state**: the same target morphs to a stop affordance while a five-bar waveform
  and tabular timer appear. Wave bars animate only while real capture is active.
- **Processing/error states**: waveform stops; status copy and retry/blocked reason replace
  decorative motion.
- **Mechanism**: adapted from beui.dev `dynamic-island` shell morph and `action-swap` content
  replacement. The shell uses opacity/filter crossfades and transform-based content travel;
  it never animates `width`, `height`, inset, or layout position.
- **Reduced motion**: the waveform becomes a static level glyph and all content swaps are
  immediate while timer updates continue.

### Primitive: settings sheet

- **Structure**: the existing `#provider-panel` becomes a focused settings sheet with grouped
  AI provider, model/effort, speech model, and connection rows. Existing control IDs and
  WebSocket actions/messages remain unchanged.
- **States**: closed, open, loading, connected, login required, install required, downloading,
  failed, selected.
- **Behavior**: Escape closes and restores focus; outside click closes; background remains
  readable but non-competing. Provider and model availability always comes from server data.
- **Disabled-with-reason**: disabled controls expose why beside the control, not only through
  color or hover text.

### Motion and interaction contract

| Interaction | Mechanism | Timing |
| --- | --- | --- |
| Record target ↔ live waveform | `dynamic-island`-style shell continuity plus `action-swap` crossfade | `--motion-state` |
| View indicator | dock/tabs-style translated active background | `--motion-state` |
| Settings open/close | opacity + small Y transform; focus transfer after settle | `--motion-state` |
| Press feedback | scale transform only on actionable controls | `--motion-quick` |
| Citation arrival | opacity/rim emphasis, no scroll-linked decoration | `--motion-state` |

Motion communicates capture, selection, disclosure, or focus only. Hover motion on
non-actionable elements is prohibited. All transforms are interruptible CSS transitions;
`prefers-reduced-motion: reduce` removes travel, blur, scale, and waveform animation.

### DOM and WebSocket preservation

- Required IDs including `#current-slide`, `#stage-pane`, `#session-list`, and
  `#transcript-stream` retain their identity and purpose.
- Existing WebSocket actions and message types are preserved exactly. UI restructuring may
  move a node visually but must not rename payload fields, synthesize server success, or add a
  client-only persisted state that contradicts a reconnect snapshot.
- Existing resizer, review, attendee, compile, export, provider, STT, session, and capture
  flows remain operable.

### Direct-file guard

- **Trigger**: `location.protocol === "file:"`.
- **Purpose**: replace the non-functional operator shell with a clear server-required state.
- **Content**: one short Korean explanation, the exact local start command, and a visible link
  to `http://localhost:8787/`.
- **Visual contract**: zinc background, coral action, operator typography, and focus treatment;
  centered editorial notice rather than a glass modal.
- **Runtime contract**: server-only stylesheets, application module, and WebSocket client do
  not boot under `file:`. Normal `http:` and `https:` behavior remains unchanged.
- **Accessibility/responsive**: semantic `main`, one `h1`, selectable command, visible focus,
  and at least 20px viewport gutter without overflow at 320px or wider.

### Accepted operator debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Translation control is capability-gated | transcript workbench | Current WebSocket contract has no translation action/message and `server.ts` is out of scope | Enable only when the server advertises a translation capability |
| Range speaker reassignment and Enter segmentation are capability-gated | transcript workbench | Current transcript entries do not expose a stable editable coordinate/action across reconnect | Enable after a versioned utterance-edit contract ships |
| TIRO authenticated app views are represented by public docs/runtime evidence | reference packet | The source product requires an account; no brand assets or private content may be copied | Re-extract only with user-provided authorized access |
