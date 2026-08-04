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

- **Structure**: `section.meeting-cover > img.cover-visual + div.cover-copy + p.cover-meta + aside.notes`
- **Variants**: default, long title
- **Spacing**: `--space-16`, `--space-20`
- **States**: static presentation surface
- **Accessibility**: decorative image uses empty alt text and `aria-hidden`
- **Motion**: none
- **Layout**: two-field asymmetric cover with a thin coral registration line

### Meeting topic

- **Structure**: `section.meeting-topic > div.topic-copy + figure.topic-visual + aside.notes`
- **Variants**: default, dense
- **Spacing**: `--space-6`, `--space-12`, `--space-16`
- **States**: static presentation surface
- **Accessibility**: decorative image remains hidden from assistive technology; semantic title and list carry all content
- **Motion**: none
- **Layout**: editorial two-column grid

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
- Texture belongs inside the local raster imagery, not as a noisy page overlay.

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

## 9. Operator Surface: Live Transcript Overlay

This contract applies only to the dark browser operator UI under `public/`. It is intentionally separate from the paper-based deck system above; the deck’s no-glass rule remains unchanged.

### Tokens

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Overlay surface | `--overlay-surface` | `rgba(12, 12, 15, 0.82)` | Floating transcript block |
| Overlay rule | `--overlay-rule` | `rgba(255, 255, 255, 0.12)` | Outer edge |
| Overlay highlight | `--overlay-highlight`, `--overlay-inset` | White alpha values | Surface light and inset edge |
| Overlay shadow | `--overlay-shadow` | `rgba(0, 0, 0, 0.46)` | Floating depth |
| Overlay live | `--overlay-live` | `#34D399` | Recording state, focus, action |
| Overlay live effects | `--overlay-live-border`, `--overlay-live-halo` | Emerald alpha values | Recording edge and signal halo |
| Overlay detecting | `--overlay-detect`, `--overlay-detect-border`, `--overlay-detect-halo` | Blue semantic set | AI-processing state only |
| Overlay internal rules | `--overlay-status-rule`, `--overlay-divider` | White alpha values | Status capsule and content divider |
| Muted operator text | `--z500` | `#7F7F89` | Secondary metadata with at least 4.5:1 contrast on operator surfaces |
| Confirmed text | `--overlay-confirmed` | `#F4F4F5` | Finalized utterances |
| Current caption | `--overlay-current` | `#A1A1AA` | Debounced recent-caption aggregation |
| Overlay radius | `--overlay-radius` | `22px` | Top-anchored island shell |
| Overlay motion | `--overlay-duration` | `240ms` | Size and opacity changes |

### Operator typography

| Role | Stack | Usage |
| --- | --- | --- |
| Display and body | `"General Sans", "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif` | General Sans shapes Latin, numerals, and punctuation; Korean falls through to Noto Sans KR or the platform Korean sans |
| Telemetry | `"JetBrains Mono", "SFMono-Regular", Consolas, monospace` | Timers, status capsules, indices, export controls |

General Sans is loaded at 400, 500, 600, and 700 through the official Fontshare API. The Korean fallback is deliberately part of the same token rather than a separate language class so mixed Korean/Latin meeting content preserves a consistent hierarchy.

Operator slide titles and bullets use `word-break: keep-all` with `overflow-wrap: break-word`, keeping normal Korean words intact while still allowing an unusually long unspaced token to fit the viewport.

### Live transcript overlay

- **Structure**: `aside.transcript-overlay` with a native disclosure button, bounded finalized-utterance list, a “최근 묶음” row for the real debounced `caption` aggregation, “전체 전사 보기” action, and a separate visually hidden completion announcer.
- **Variants**: hidden, minimized, expanded.
- **Content states**:
  - No finalized or current-caption content: hidden and removed from the accessibility tree.
  - Finalized `line` or reconnect `snapshot`: high-emphasis confirmed text, with at most three recent utterances in the overlay.
  - Debounced `caption`: lower-emphasis “최근 묶음” content that reflects the backend’s recent aggregation. It remains visually separate and never demotes finalized lines.
  - Empty `caption` clears only the current aggregation. Reconnect `snapshot` and reset clear the current aggregation; an empty snapshot also hides the overlay.
- **Interaction**: the header disclosure button toggles minimized and expanded states using `aria-expanded` and `aria-controls`. Escape collapses an expanded overlay while keeping focus on the disclosure button. “전체 전사 보기” activates the existing transcript tab and panel.
- **Layout**: centered over the lower part of the stage, max width `720px`, with a 16px viewport gutter. Expansion is top-anchored and grows downward; text itself is never scaled.
- **Motion**: shell size and content opacity use `--overlay-duration` with restrained ease-out timing. `prefers-reduced-motion: reduce` removes travel, blur, bounce, and size interpolation, leaving an immediate state change.
- **Accessibility**: only finalized utterances are announced through a dedicated `aria-live="polite"` node. The streaming transcript DOM itself is not live. All actions are keyboard reachable, have visible focus, and do not depend on hover.
- **Responsive**: Korean copy wraps with `overflow-wrap: anywhere` where needed; the overlay must not create horizontal overflow at 375×812.

### Operator shell responsive contract

- The document root must never overflow horizontally at 375×812 or wider.
- Below 620px, the header keeps the brand mark and recording action while moving connection detail out of the primary row.
- The stage uses a 14px viewport gutter, and Korean placeholder copy wraps inside the slide rather than widening it. Counter phrases such as “한 장씩” stay together.
- Dock tabs and export actions remain one ordered horizontal rail. The rail scrolls inside its own bounds so the final action is reachable without widening the document.

### Direct-file guard

- **Trigger**: `location.protocol === "file:"`.
- **Purpose**: replace the non-functional operator shell with a clear server-required state when `public/index.html` is opened directly.
- **Content**: one short Korean explanation, the exact local start command, and a visible link to `http://localhost:8787/`.
- **Visual contract**: reuse the operator surface’s zinc background, emerald action color, typography stack, and focus treatment. The guard is a centered editorial notice, not a modal or a new glass-card variant.
- **Runtime contract**: server-only stylesheets, the application module, and the WebSocket client must not boot under `file:`. Normal `http:` and `https:` behavior remains unchanged.
- **Accessibility**: a semantic `main`, one `h1`, selectable command text, visible keyboard focus, and copy that does not depend on color or icons.
- **Responsive**: the notice keeps a 20px minimum viewport gutter and must not create horizontal overflow at 320px or wider.
