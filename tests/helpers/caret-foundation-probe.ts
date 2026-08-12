// Deterministic real-Chromium probe for the Todo 9 token/font foundation.
//
// The probe serves ONLY public/ over a local origin and refuses every off-origin
// request outright (no stub, no fallback), so a reintroduced network font
// dependency surfaces as a failed load rather than a silently substituted face.
//
// Synchronization is exclusively document.fonts.ready plus the browser's own
// load event. There is no sleep, no polling and no timing-based settle anywhere.
import { file } from "bun";
import { join } from "node:path";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";

const publicDir = join(import.meta.dir, "..", "..", "public");

/** Isolated fixture: the token layer only, with no shell, script or app state. */
const FIXTURE_PATH = "/__caret-foundation-fixture";

/**
 * Minimal document that exercises exactly the roles the token layer declares.
 * It carries no product copy, no branding and no shell structure - it exists so
 * computed values, rendered font families and focus painting can be measured
 * without depending on Todo 11/12 surfaces that do not exist yet.
 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="ko" data-caret-foundation="probe">
<head>
<meta charset="utf-8">
<title>caret foundation probe</title>
<link rel="stylesheet" href="/caret-operator.css">
<style>
  /* Fixture-local layout ONLY. These rules lay the swatches out for human review;
     they declare no colour, type, radius or motion of their own - every visual
     property under inspection comes from caret-operator.css. */
  body { margin: 0; }
  .probe { padding: var(--cf-space-6); display: grid; gap: var(--cf-space-5); }
  .probe__row { display: flex; gap: var(--cf-space-3); align-items: stretch; flex-wrap: wrap; }
  .probe__swatch { min-width: 132px; min-height: 72px; padding: var(--cf-space-3); }
  .probe__chip { padding: var(--cf-space-1) var(--cf-space-3); }
  #rule { width: 100%; }
  #motion { min-width: 132px; min-height: 24px; background-color: var(--cf-raised); }
</style>
</head>
<body class="cf-root">
  <div class="probe">
    <p id="latin-body" class="cf-body">Deterministic foundation sample</p>
    <p id="hangul-body" class="cf-body">한국어 본문 표본 문장</p>
    <h1 id="display" class="cf-display">Display heading</h1>
    <p id="telemetry" class="cf-telemetry">00:00 / REC 0001</p>
    <p class="cf-body cf-muted">Muted secondary text · 보조 텍스트</p>
    <p class="cf-body cf-faint">Faint tertiary text · 희미한 텍스트</p>

    <div class="probe__row">
      <div id="rail" class="cf-rail probe__swatch"><span class="cf-telemetry">rail</span></div>
      <div id="surface" class="cf-surface probe__swatch">
        <span class="cf-telemetry">surface</span>
        <div id="raised" class="cf-raised probe__swatch"><span class="cf-telemetry">raised</span></div>
      </div>
      <div id="overlay" class="cf-overlay probe__swatch"><span class="cf-telemetry">overlay</span></div>
    </div>

    <div class="probe__row">
      <span class="cf-accent-chip cf-telemetry probe__chip">AI suggestion</span>
      <span class="cf-record-chip cf-telemetry probe__chip">REC 02:05</span>
      <span class="cf-accent-fg cf-body">accent text</span>
      <span class="cf-record-fg cf-body">recording text</span>
    </div>

    <div id="rule" class="cf-rule-strong"></div>

    <div class="probe__row">
      <button id="focusable" class="cf-focusable cf-body cf-raised probe__chip" type="button">focus target</button>
      <div id="motion" class="cf-motion-state"></div>
    </div>
  </div>
</body>
</html>`;

export interface RenderedFont {
  /** Normalized family name, with the variable-font instance suffix removed. */
  family: string;
  /** Glyphs this face contributed to the sample. */
  glyphs: number;
  /** True when the face came from an @font-face rule rather than the host OS. */
  bundled: boolean;
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

export interface FoundationSnapshot {
  origin: string;
  viewport: { width: number; height: number };
  fontsReady: boolean;
  loadedFamilies: string[];
  /** Faces the browser tried and failed to load. Must always be empty. */
  failedFaces: string[];
  /**
   * Faces still "unloaded" after fonts.ready. This is expected for a face whose
   * unicode-range or weight the fixture text never matches - lazy loading, not a
   * missing asset - so it is reported, not asserted empty.
   */
  pendingFaces: string[];
  requestedUrls: string[];
  /** Font asset URLs Chromium actually fetched. All must be same-origin. */
  fontRequests: string[];
  /** Off-origin URLs that actually reached the network. Must always be empty. */
  externalRequests: string[];
  tokens: Record<string, string>;
  computedFamilies: { body: string; display: string; mono: string };
  /**
   * The face Chromium actually rasterized for each sample, reported by the
   * renderer itself (CDP CSS.getPlatformFontsForNode) rather than inferred from
   * advance widths - metric inference cannot distinguish a family from its own
   * fallback and would silently pass on a missing face.
   */
  renderedFamilies: {
    latinBody: RenderedFont[];
    hangulBody: RenderedFont[];
    telemetry: RenderedFont[];
  };
  backdropFilters: { main: Record<string, string>; overlay: string };
  composited: { ruleStrongOnSurface: string };
  focus: { outlineStyle: string; outlineWidth: string; outlineColor: string };
  motion: { transitionDuration: string; animationDuration: string };
  rootOverflow: { horizontal: number };
}

export interface MeasureOptions {
  reducedMotion?: boolean;
  screenshot?: boolean;
}

export interface FoundationProbe {
  readonly origin: string;
  measure(
    viewport: { width: number; height: number },
    options?: MeasureOptions,
  ): Promise<FoundationSnapshot>;
  screenshot(viewport: { width: number; height: number }, options?: MeasureOptions): Promise<Uint8Array>;
  close(): Promise<void>;
}

// ── color math (sRGB, WCAG 2.x) ──────────────────────────────────────────────

export function parseCssColor(value: string): RgbaColor {
  const text = value.trim();
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean);
    return {
      r: Number.parseFloat(parts[0]!),
      g: Number.parseFloat(parts[1]!),
      b: Number.parseFloat(parts[2]!),
      alpha: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
    };
  }
  const hex = text.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((d) => d + d).join("");
    }
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      alpha: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  throw new Error(`caret foundation probe: unsupported color value "${value}"`);
}

export function relativeLuminance(color: RgbaColor): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(a: RgbaColor, b: RgbaColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** sRGB hue angle in degrees; undefined hue (grey) is reported as 0. */
export function hueDegrees(color: RgbaColor): number {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/**
 * Shortest angular separation between two hues. Used instead of luminance
 * contrast when the question is "are these two semantic states perceived as
 * different colours", which luminance cannot answer for two mid-tone hues.
 */
export function hueDistanceDegrees(a: RgbaColor, b: RgbaColor): number {
  const raw = Math.abs(hueDegrees(a) - hueDegrees(b)) % 360;
  return raw > 180 ? 360 - raw : raw;
}

// ── probe ────────────────────────────────────────────────────────────────────

/** Reads only machine-consumed computed values; never prose or copy. */
function readFoundation(): Omit<
  FoundationSnapshot,
  "origin" | "viewport" | "requestedUrls" | "externalRequests" | "fontRequests"
> {
  const styleOf = (id: string): CSSStyleDeclaration => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`caret foundation probe: missing fixture node #${id}`);
    return getComputedStyle(el);
  };
  const root = getComputedStyle(document.documentElement);

  const tokenNames = new Set<string>();
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin sheet: unreadable by design. There are none in this fixture,
      // but skipping is correct rather than throwing.
      continue;
    }
    const visit = (list: CSSRuleList): void => {
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          for (const property of rule.style) {
            if (property.startsWith("--cf-")) tokenNames.add(property);
          }
        } else if (rule instanceof CSSMediaRule) {
          visit(rule.cssRules);
        }
      }
    };
    visit(rules);
  }
  const tokens: Record<string, string> = {};
  for (const name of [...tokenNames].sort()) {
    tokens[name] = root.getPropertyValue(name).trim();
  }

  const faces = [...document.fonts];
  // Focus is applied by the driver via a real Tab keypress before this runs, so
  // :focus-visible matches exactly as it would for a keyboard user. Calling
  // .focus() here instead would silently measure a ring the user never sees.
  const focus = document.getElementById("focusable") as HTMLButtonElement;
  const focusStyle = getComputedStyle(focus);

  return {
    fontsReady: (document as Document & { __cfFontsReady?: boolean }).__cfFontsReady === true,
    loadedFamilies: [...new Set(faces.filter((f) => f.status === "loaded").map((f) => f.family))].sort(),
    failedFaces: faces.filter((f) => f.status === "error").map((f) => `${f.family}:${f.status}`),
    pendingFaces: faces.filter((f) => f.status !== "loaded").map((f) => `${f.family}:${f.status}`),
    tokens,
    computedFamilies: {
      body: styleOf("latin-body").fontFamily,
      display: styleOf("display").fontFamily,
      mono: styleOf("telemetry").fontFamily,
    },
    // Filled in by the driver from CDP; the page itself cannot see the rasterizer.
    renderedFamilies: { latinBody: [], hangulBody: [], telemetry: [] },
    backdropFilters: {
      main: {
        "html": root.backdropFilter,
        ".cf-rail": styleOf("rail").backdropFilter,
        ".cf-surface": styleOf("surface").backdropFilter,
        ".cf-raised": styleOf("raised").backdropFilter,
      },
      overlay: styleOf("overlay").backdropFilter,
    },
    composited: {
      // Rules are declared as alpha over the surface; report the painted result.
      ruleStrongOnSurface: (() => {
        const rule = styleOf("rule").borderTopColor;
        const surface = getComputedStyle(document.getElementById("surface")!).backgroundColor;
        const parse = (v: string): number[] => v.match(/[\d.]+/g)!.map(Number);
        const [rr, rg, rb, ra = 1] = parse(rule);
        const [sr, sg, sb] = parse(surface);
        const mix = (f: number, b: number): number => Math.round(f * ra! + b * (1 - ra!));
        return `rgb(${mix(rr!, sr!)}, ${mix(rg!, sg!)}, ${mix(rb!, sb!)})`;
      })(),
    },
    focus: {
      outlineStyle: focusStyle.outlineStyle,
      outlineWidth: focusStyle.outlineWidth,
      outlineColor: focusStyle.outlineColor,
    },
    motion: {
      transitionDuration: styleOf("motion").transitionDuration,
      animationDuration: styleOf("motion").animationDuration,
    },
    rootOverflow: {
      horizontal: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    },
  };
}

export async function createFoundationProbe(): Promise<FoundationProbe> {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === FIXTURE_PATH) {
        return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const name = url.pathname.slice(1);
      if (!/^[a-z0-9._/-]+$/i.test(name) || name.includes("..")) {
        return new Response("not found", { status: 404 });
      }
      const asset = file(join(publicDir, name));
      // Resolve existence here: streaming a missing file rejects inside the server
      // and tears the whole fixture down instead of returning an honest 404.
      return asset.exists().then((exists) =>
        exists ? new Response(asset) : new Response("not found", { status: 404 }),
      );
    },
    error() {
      return new Response("fixture server error", { status: 500 });
    },
  });
  const origin = `http://localhost:${server.port}`;
  const browser: Browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });

  /**
   * Measurements are serialized. Concurrent pages would each attach their own CDP
   * session and race the shared DOM/CSS agents, which surfaces as an intermittent
   * protocol error rather than a real contract failure. This is a correctness
   * queue, not a delay: each measurement starts the instant the previous resolves.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function open(
    viewport: { width: number; height: number },
    options: MeasureOptions,
  ): Promise<{ page: Page; requestedUrls: string[]; externalRequests: string[] }> {
    const page = await browser.newPage();
    const requestedUrls: string[] = [];
    const externalRequests: string[] = [];

    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    await page.emulateTimezone("Asia/Seoul");
    await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
    if (options.reducedMotion === true) {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    }
    await page.setRequestInterception(true);
    page.on("request", (request: HTTPRequest) => {
      const url = request.url();
      requestedUrls.push(url);
      if (url.startsWith(origin) || url.startsWith("data:") || url === "about:blank") {
        void request.continue();
        return;
      }
      // Hard refusal, never a stub: a network font dependency must fail loudly.
      externalRequests.push(url);
      void request.abort();
    });

    await page.goto(`${origin}${FIXTURE_PATH}`, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      (document as Document & { __cfFontsReady?: boolean }).__cfFontsReady = true;
    });
    // Real keyboard focus, so :focus-visible applies and the measured ring is the
    // ring a keyboard user actually gets. Tab order reaches the only button.
    await page.focus("body");
    await page.keyboard.press("Tab");
    return { page, requestedUrls, externalRequests };
  }

  /**
   * Asks the renderer which physical faces rasterized a node. Must run AFTER
   * document.fonts.ready, otherwise the renderer reports the pre-swap fallback.
   * Chromium names a variable font by its file's default instance ("Figtree
   * Light"), so the instance suffix is stripped back to the CSS family.
   */
  async function renderedFontsFor(page: Page, selectors: Record<string, string>): Promise<Record<string, RenderedFont[]>> {
    // The session is intentionally not detached here: page.close() tears it down,
    // and an explicit detach races that teardown into a "Target closed" error.
    const client = await page.createCDPSession();
    {
      await client.send("DOM.enable");
      await client.send("CSS.enable");
      const { root } = await client.send("DOM.getDocument");
      const families = ["Pretendard Variable", "DM Mono", "Figtree"];
      const normalize = (name: string): string =>
        families.find((family) => name === family || name.startsWith(`${family} `)) ?? name;

      const result: Record<string, RenderedFont[]> = {};
      for (const [key, selector] of Object.entries(selectors)) {
        const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        if (nodeId === 0) throw new Error(`caret foundation probe: missing fixture node ${selector}`);
        const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
        result[key] = fonts
          .map((font) => ({
            family: normalize(font.familyName),
            glyphs: font.glyphCount,
            bundled: font.isCustomFont,
          }))
          .sort((a, b) => b.glyphs - a.glyphs);
      }
      return result;
    }
  }

  return {
    origin,
    measure(viewport, options = {}) {
      return serialize(async () => {
      const { page, requestedUrls, externalRequests } = await open(viewport, options);
      try {
        const measured = await page.evaluate(readFoundation);
        const rendered = await renderedFontsFor(page, {
          latinBody: "#latin-body",
          hangulBody: "#hangul-body",
          telemetry: "#telemetry",
        });
        return {
          ...measured,
          renderedFamilies: {
            latinBody: rendered.latinBody!,
            hangulBody: rendered.hangulBody!,
            telemetry: rendered.telemetry!,
          },
          origin,
          viewport,
          requestedUrls,
          fontRequests: requestedUrls.filter((url) => /\.(woff2?|ttf|otf)(\?|$)/i.test(url)),
          externalRequests,
        };
      } finally {
        await page.close();
      }
      });
    },
    screenshot(viewport, options = {}) {
      return serialize(async () => {
        const { page } = await open(viewport, options);
        try {
          return await page.screenshot({ type: "png", captureBeyondViewport: false });
        } finally {
          await page.close();
        }
      });
    },
    async close() {
      await browser.close();
      server.stop(true);
    },
  };
}
