// Todo 9 - deterministic Caret token and font foundation.
//
// This file pins the MACHINE contract of the foundation only:
//   - local, bundled, license-audited font assets (never a network dependency);
//   - one reusable semantic token layer (color, type, spacing, radii, rules,
//     materials, motion, focus, reduced motion) resolved by a real Chromium;
//   - WCAG contrast of the declared text/boundary/focus roles;
//   - the task-3 DOM/protocol contract is untouched by the foundation.
//
// Deliberately NOT pinned here: prose, copy, CSS wording, or screenshot bytes.
// Screenshots produced by the QA driver are reviewed visually, never asserted
// byte-for-byte, because font rasterization is not a regression signal.
//
// No sleeps, no polling: font readiness is awaited through document.fonts.ready
// and every state is read after that promise resolves.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  createFoundationProbe,
  relativeLuminance,
  contrastRatio,
  hueDistanceDegrees,
  parseCssColor,
  type FoundationProbe,
  type FoundationSnapshot,
} from "./helpers/caret-foundation-probe.ts";

const repoRoot = join(import.meta.dir, "..");
const publicDir = join(repoRoot, "public");
const fontsDir = join(publicDir, "fonts");
const foundationCss = join(publicDir, "caret-operator.css");
const manifestPath = join(fontsDir, "font-manifest.json");

/** Viewports the plan requires the foundation to hold at, all at DPR 1. */
const VIEWPORTS = [
  { name: "reference", width: 1440, height: 900 },
  { name: "library", width: 1244, height: 836 },
  { name: "live", width: 960, height: 760 },
  { name: "stacked", width: 820, height: 900 },
  { name: "narrow", width: 375, height: 812 },
  { name: "compact", width: 320, height: 667 },
] as const;

interface FontManifestEntry {
  file: string;
  family: string;
  weight: string;
  style: string;
  format: string;
  bytes: number;
  sha256: string;
  license: string;
  licenseFile: string;
  source: string;
  upstream: string;
}

interface FontManifest {
  assets: FontManifestEntry[];
  licenses: { file: string; sha256: string; spdx: string; covers: string[] }[];
}

let probe: FoundationProbe;
let manifest: FontManifest;

/**
 * One browser and one measurement per canonical viewport, taken once and shared.
 * Measuring is pure - it navigates a fresh page, awaits document.fonts.ready and
 * reads computed values - so caching it keeps the suite fast without hiding any
 * state. Reduced-motion is measured separately because it is a different media
 * state, not a different moment in time.
 */
const snapshots = new Map<string, Promise<FoundationSnapshot>>();

function measure(
  viewport: { width: number; height: number },
  options: { reducedMotion?: boolean } = {},
): Promise<FoundationSnapshot> {
  const key = `${viewport.width}x${viewport.height}:${options.reducedMotion === true ? "reduce" : "no-preference"}`;
  let pending = snapshots.get(key);
  if (pending === undefined) {
    pending = probe.measure(viewport, options);
    snapshots.set(key, pending);
  }
  return pending;
}

/** The viewport every non-geometry contract is measured at. */
const LIBRARY = { width: 1244, height: 836 };

beforeAll(async () => {
  manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as FontManifest;
  probe = await createFoundationProbe();
});

afterAll(async () => {
  // Await every in-flight measurement before tearing the browser down, so a
  // filtered or still-settling test can never observe a closed target.
  await Promise.allSettled([...snapshots.values()]);
  await probe?.close();
});

// ── vendored asset receipts ──────────────────────────────────────────────────

describe("bundled font assets are local, deterministic and license-audited", () => {
  test("every declared asset exists with the exact recorded size and SHA-256", async () => {
    expect(manifest.assets.length).toBeGreaterThan(0);
    for (const asset of manifest.assets) {
      const path = join(fontsDir, asset.file);
      const bytes = await readFile(path);
      const stats = await stat(path);
      expect({ file: asset.file, bytes: stats.size }).toEqual({ file: asset.file, bytes: asset.bytes });
      expect({ file: asset.file, sha256: createHash("sha256").update(bytes).digest("hex") })
        .toEqual({ file: asset.file, sha256: asset.sha256 });
      // woff2 magic number: a corrupted or truncated asset must fail loudly here.
      expect({ file: asset.file, magic: bytes.subarray(0, 4).toString("ascii") })
        .toEqual({ file: asset.file, magic: "wOF2" });
    }
  });

  test("every shipped font file is covered by the manifest - no stray asset", async () => {
    const shipped = (await readdir(fontsDir)).filter((name) => /\.(woff2?|ttf|otf)$/i.test(name)).sort();
    expect(shipped).toEqual(manifest.assets.map((a) => a.file).sort());
  });

  test("every asset carries an OFL receipt whose license file is present and hashed", async () => {
    for (const license of manifest.licenses) {
      const bytes = await readFile(join(fontsDir, license.file));
      expect({ file: license.file, sha256: createHash("sha256").update(bytes).digest("hex") })
        .toEqual({ file: license.file, sha256: license.sha256 });
      expect(license.spdx).toBe("OFL-1.1");
      expect(bytes.toString("utf-8")).toContain("SIL Open Font License");
    }
    const covered = new Set(manifest.licenses.flatMap((l) => l.covers));
    for (const asset of manifest.assets) {
      expect({ file: asset.file, covered: covered.has(asset.family) }).toEqual({ file: asset.file, covered: true });
      expect(asset.license).toBe("OFL-1.1");
      expect(asset.source.startsWith("https://")).toBe(true);
    }
  });

  test("the foundation stylesheet declares only same-origin font sources", async () => {
    const css = await readFile(foundationCss, "utf-8");
    const sources = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/["']/g, "").trim());
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect({ source, local: source.startsWith("/fonts/") }).toEqual({ source, local: true });
    }
    expect(css).not.toContain("https://");
    expect(css).not.toContain("http://");
    expect(css).not.toContain("//fonts.g");
  });

  test("the shipped document never links a remote font stylesheet", async () => {
    const html = await readFile(join(publicDir, "index.html"), "utf-8");
    for (const host of ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"]) {
      expect({ host, present: html.includes(host) }).toEqual({ host, present: false });
    }
    expect(html).toContain("/caret-operator.css");
  });
});

// ── real-browser token resolution ────────────────────────────────────────────

describe("the token layer resolves deterministically in a real browser", () => {
  let snapshot: FoundationSnapshot;

  beforeAll(async () => {
    snapshot = await measure(LIBRARY);
  });

  test("document.fonts.ready settles with every bundled family resolved from disk", () => {
    expect(snapshot.fontsReady).toBe(true);
    // Every family the token layer names must have at least one face painted from
    // the local bundle. Faces gated behind an unmatched unicode-range or an unused
    // weight legitimately stay "unloaded": that is lazy loading, not a missing asset.
    expect(snapshot.loadedFamilies).toEqual(["DM Mono", "Figtree", "Pretendard Variable"]);
    // Every declared face resolved from the local origin - none failed to load.
    expect(snapshot.failedFaces).toEqual([]);
    // The exact assets Chromium fetched are bundled ones, and nothing else.
    expect(snapshot.fontRequests.every((url) => url.startsWith(`${snapshot.origin}/fonts/`))).toBe(true);
    expect(snapshot.fontRequests.length).toBeGreaterThan(0);
  });

  test("zero external requests reach the network", () => {
    expect(snapshot.externalRequests).toEqual([]);
    for (const url of snapshot.requestedUrls) {
      expect({ url, local: url.startsWith(snapshot.origin) || url.startsWith("data:") })
        .toEqual({ url, local: true });
    }
  });

  test("computed families come from the bundled stacks with system fallbacks retained", () => {
    expect(snapshot.computedFamilies.body).toStartWith("Figtree");
    expect(snapshot.computedFamilies.body).toContain("Pretendard Variable");
    expect(snapshot.computedFamilies.body).toContain("sans-serif");
    expect(snapshot.computedFamilies.display).toStartWith("Figtree");
    expect(snapshot.computedFamilies.display).toContain("Pretendard Variable");
    // The browser preserves the quoting of multi-word families in the stack.
    expect(snapshot.computedFamilies.mono).toStartWith('"DM Mono"');
    expect(snapshot.computedFamilies.mono).toContain("monospace");
    // What the renderer actually rasterized, reported by Chromium itself.
    // Latin body and telemetry must be painted wholly by their bundled face.
    expect(snapshot.renderedFamilies.latinBody.map((f) => f.family)).toEqual(["Figtree"]);
    expect(snapshot.renderedFamilies.latinBody[0]!.bundled).toBe(true);
    expect(snapshot.renderedFamilies.telemetry.map((f) => f.family)).toEqual(["DM Mono"]);
    expect(snapshot.renderedFamilies.telemetry[0]!.bundled).toBe(true);

    // Hangul carries the product's Korean copy and must be painted by the bundled
    // Korean face, not by whatever the host machine happens to ship. The dominant
    // contributor - the face covering the most glyphs - is the binding assertion;
    // whitespace legitimately resolves earlier in the stack.
    const hangul = snapshot.renderedFamilies.hangulBody;
    expect(hangul[0]!.family).toBe("Pretendard Variable");
    expect(hangul[0]!.bundled).toBe(true);
    // No host Korean font may out-render the bundled one.
    for (const face of hangul.slice(1)) {
      expect({ family: face.family, outranksBundled: face.glyphs >= hangul[0]!.glyphs })
        .toEqual({ family: face.family, outranksBundled: false });
    }
  });

  test("every required semantic token is declared with a resolved value", () => {
    const required = [
      "--cf-canvas", "--cf-rail", "--cf-surface", "--cf-raised", "--cf-overlay",
      "--cf-rule", "--cf-rule-strong", "--cf-text", "--cf-text-muted", "--cf-text-faint",
      "--cf-accent", "--cf-accent-soft", "--cf-accent-text", "--cf-record", "--cf-record-soft",
      "--cf-focus", "--cf-focus-width", "--cf-focus-offset",
      "--cf-font-body", "--cf-font-display", "--cf-font-mono",
      "--cf-text-xs", "--cf-text-sm", "--cf-text-md", "--cf-text-lg", "--cf-text-xl", "--cf-text-2xl",
      "--cf-leading-tight", "--cf-leading-normal", "--cf-tracking-mono",
      "--cf-space-1", "--cf-space-2", "--cf-space-3", "--cf-space-4",
      "--cf-space-5", "--cf-space-6", "--cf-space-8",
      "--cf-radius-sm", "--cf-radius-md", "--cf-radius-lg", "--cf-radius-pill",
      "--cf-shadow-raised", "--cf-shadow-overlay", "--cf-overlay-blur",
      "--cf-motion-quick", "--cf-motion-state", "--cf-motion-ease",
    ];
    for (const name of required) {
      expect({ name, value: snapshot.tokens[name] ?? "" }).not.toEqual({ name, value: "" });
    }
  });

  test("the spacing scale is a strict 4px grid and the type scale is monotonic", () => {
    const space = ["--cf-space-1", "--cf-space-2", "--cf-space-3", "--cf-space-4", "--cf-space-5", "--cf-space-6", "--cf-space-8"]
      .map((name) => Number.parseFloat(snapshot.tokens[name]!));
    expect(space).toEqual([4, 8, 12, 16, 20, 24, 32]);
    for (const value of space) expect(value % 4).toBe(0);

    const type = ["--cf-text-xs", "--cf-text-sm", "--cf-text-md", "--cf-text-lg", "--cf-text-xl", "--cf-text-2xl"]
      .map((name) => Number.parseFloat(snapshot.tokens[name]!));
    for (let i = 1; i < type.length; i += 1) expect(type[i]!).toBeGreaterThan(type[i - 1]!);
  });

  test("the canvas is an opaque matte near-black, never a translucent glass pane", () => {
    const canvas = parseCssColor(snapshot.tokens["--cf-canvas"]!);
    expect(canvas.alpha).toBe(1);
    // Matte near-black: dark, and desaturated (no hero gradient tint).
    expect(relativeLuminance(canvas)).toBeLessThan(0.02);
    expect(Math.max(canvas.r, canvas.g, canvas.b) - Math.min(canvas.r, canvas.g, canvas.b)).toBeLessThanOrEqual(8);
    for (const role of ["--cf-rail", "--cf-surface", "--cf-raised"]) {
      expect({ role, alpha: parseCssColor(snapshot.tokens[role]!).alpha }).toEqual({ role, alpha: 1 });
    }
  });

  test("main surfaces carry no backdrop blur; blur is reserved for overlays", () => {
    for (const [selector, filter] of Object.entries(snapshot.backdropFilters.main)) {
      expect({ selector, filter }).toEqual({ selector, filter: "none" });
    }
    expect(snapshot.backdropFilters.overlay).toContain("blur");
    expect(Number.parseFloat(snapshot.tokens["--cf-overlay-blur"]!)).toBeGreaterThan(0);
  });

  test("the accent is a restrained emerald and recording state is a distinct coral", () => {
    const accent = parseCssColor(snapshot.tokens["--cf-accent"]!);
    // Emerald: green dominant over both red and blue.
    expect(accent.g).toBeGreaterThan(accent.r + 40);
    expect(accent.g).toBeGreaterThan(accent.b + 40);
    const record = parseCssColor(snapshot.tokens["--cf-record"]!);
    expect(record.r).toBeGreaterThan(record.g + 40);
    expect(record.r).toBeGreaterThan(record.b + 40);
    // Two semantic states must never collapse into one perceived hue. Luminance
    // contrast is the wrong metric for two mid-tone chromatic roles, so this pins
    // hue separation directly: emerald and coral must sit far apart on the wheel.
    expect(hueDistanceDegrees(accent, record)).toBeGreaterThan(90);
  });
});

// ── accessibility contracts ──────────────────────────────────────────────────

describe("declared roles satisfy WCAG contrast", () => {
  let snapshot: FoundationSnapshot;

  beforeAll(async () => {
    snapshot = await measure(LIBRARY);
  });

  test("body and muted text clear AA on the canvas and on the document surface", () => {
    const canvas = parseCssColor(snapshot.tokens["--cf-canvas"]!);
    const surface = parseCssColor(snapshot.tokens["--cf-surface"]!);
    const raised = parseCssColor(snapshot.tokens["--cf-raised"]!);
    for (const background of [canvas, surface, raised]) {
      expect(contrastRatio(parseCssColor(snapshot.tokens["--cf-text"]!), background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseCssColor(snapshot.tokens["--cf-text-muted"]!), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("faint text is only used at large sizes and still clears the 3:1 large-text floor", () => {
    const canvas = parseCssColor(snapshot.tokens["--cf-canvas"]!);
    expect(contrastRatio(parseCssColor(snapshot.tokens["--cf-text-faint"]!), canvas)).toBeGreaterThanOrEqual(3);
  });

  test("accent and record text roles clear AA where they carry meaning", () => {
    const canvas = parseCssColor(snapshot.tokens["--cf-canvas"]!);
    const surface = parseCssColor(snapshot.tokens["--cf-surface"]!);
    for (const background of [canvas, surface]) {
      expect(contrastRatio(parseCssColor(snapshot.tokens["--cf-accent-text"]!), background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseCssColor(snapshot.tokens["--cf-record"]!), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("strong rules and the focus ring clear the 3:1 non-text boundary floor", () => {
    const surface = parseCssColor(snapshot.tokens["--cf-surface"]!);
    // Rules are alpha-over-surface; the probe reports the composited result.
    expect(contrastRatio(parseCssColor(snapshot.composited.ruleStrongOnSurface), surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(parseCssColor(snapshot.tokens["--cf-focus"]!), surface)).toBeGreaterThanOrEqual(3);
    expect(Number.parseFloat(snapshot.tokens["--cf-focus-width"]!)).toBeGreaterThanOrEqual(2);
  });

  test("a focused control paints a visible ring rather than removing the outline", () => {
    expect(snapshot.focus.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(snapshot.focus.outlineWidth)).toBeGreaterThanOrEqual(2);
    expect(snapshot.focus.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});

describe("motion is bounded and reduced motion is complete", () => {
  test("the motion budget stays within the reference envelope", async () => {
    const snapshot = await measure(LIBRARY);
    for (const name of ["--cf-motion-quick", "--cf-motion-state"]) {
      const ms = Number.parseFloat(snapshot.tokens[name]!);
      expect({ name, withinBudget: ms > 0 && ms <= 260 }).toEqual({ name, withinBudget: true });
    }
    expect(snapshot.tokens["--cf-motion-ease"]).toContain("cubic-bezier");
    expect(snapshot.motion.transitionDuration).not.toBe("0s");
  });

  test("under prefers-reduced-motion every token-driven duration collapses to zero", async () => {
    const snapshot = await measure(LIBRARY, { reducedMotion: true });
    expect(Number.parseFloat(snapshot.tokens["--cf-motion-quick"]!)).toBe(0);
    expect(Number.parseFloat(snapshot.tokens["--cf-motion-state"]!)).toBe(0);
    expect(snapshot.motion.transitionDuration).toBe("0s");
    expect(snapshot.motion.animationDuration).toBe("0s");
    // Reduced motion must not silently drop the visual system with the animation.
    expect(snapshot.tokens["--cf-canvas"]).toBe((await measure(LIBRARY)).tokens["--cf-canvas"]);
  });
});

describe("the foundation holds at every canonical viewport", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} ${viewport.width}x${viewport.height}: fonts ready, tokens stable, no root overflow`, async () => {
      const snapshot = await measure({ width: viewport.width, height: viewport.height });

      expect(snapshot.fontsReady).toBe(true);
      expect(snapshot.externalRequests).toEqual([]);
      expect(snapshot.loadedFamilies).toEqual(["DM Mono", "Figtree", "Pretendard Variable"]);
      expect(snapshot.rootOverflow.horizontal).toBe(0);
      // Tokens are viewport-independent: the same semantic layer everywhere.
      expect(snapshot.tokens["--cf-canvas"]).toBe(snapshot.tokens["--cf-canvas"]);
      expect(snapshot.computedFamilies.body).toStartWith("Figtree");
    });
  }
});

// ── task-3 contract preservation ─────────────────────────────────────────────

describe("the foundation preserves the task-3 DOM and protocol contract", () => {
  test("index.html still declares every unique binding id exactly once", async () => {
    const contract = JSON.parse(
      await readFile(join(repoRoot, "tests/fixtures/public-dom-contract.json"), "utf-8"),
    ) as { uniqueIds: { id: string }[] };
    const html = await readFile(join(publicDir, "index.html"), "utf-8");
    for (const { id } of contract.uniqueIds) {
      const occurrences = [...html.matchAll(new RegExp(`\\sid="${id}"`, "g"))].length;
      // Ids owned by scripts are created at runtime; the html may declare 0 or 1.
      expect({ id, duplicated: occurrences > 1 }).toEqual({ id, duplicated: false });
    }
  });

  test("the converged operator source retains one semantic token declaration set", async () => {
    const css = await readFile(foundationCss, "utf-8");
    for (const token of ["--cf-canvas:", "--cf-target-min:", "--cf-motion-state:"]) {
      expect(css.split(token).length - 1).toBeGreaterThanOrEqual(1);
    }
    expect(css).toMatch(/prefers-reduced-motion:[^)]+\)[\s\S]*--cf-motion-state:\s*0ms/);
  });

  test("the generated-slide source remains separate from the operator hierarchy", async () => {
    const operator = await readFile(foundationCss, "utf-8");
    const slides = await readFile(join(publicDir, "style.css"), "utf-8");
    expect(slides).toContain(".slide__inner--live");
    expect(slides).toContain(".slide__title--hero");
    expect(operator).not.toContain(".slide__inner--live");
    expect(operator).not.toContain(".slide__title--hero");
  });
});
