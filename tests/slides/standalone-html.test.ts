import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedAssetLayer } from "../../src/slides/assets/integration.ts";
import type {
  CompileIssue,
  GeometryElement,
  GeometryPreflightResult,
  GeometrySlide,
} from "../../src/slides/geometry/contract.ts";
import type { Theme } from "../../src/slides/model/plan.ts";
import { toCssCustomProperties } from "../../src/slides/theme/css-tokens.ts";
import {
  StandaloneHtmlError,
  renderStandaloneHtml,
  writeStandaloneHtml,
  type StandaloneDeckInput,
  type StandaloneHtmlArtifact,
} from "../../src/slides/render/standalone-html.ts";

const FONT_BYTES = new TextEncoder().encode("fixture-woff2\0deterministic-font-bytes\xff");
const ASSET_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path d="M0 0h32v24H0z" fill="#335C81"/></svg>',
);
const SPECIAL_TEXT = "Decision </script> & <go>\n\"quoted\" 'owner' \u2028 line";
const SPECIAL_NOTES = "Presenter </script> & <note> \u2028 다음";
const SPECIAL_ALT = 'Chart "A&B" <danger> \'quoted\'';

let root = "";
let fontPath = "";
let assetPath = "";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function theme(): Theme {
  const fontHash = sha256(FONT_BYTES);
  return {
    id: "standalone-test-theme",
    canvas: { width: 1280, height: 720 },
    font: {
      family: 'Fixture Sans "Local"',
      localPath: `fonts/${fontHash}.woff2`,
      sha256: fontHash,
    },
    colors: {
      paper: "F6F1E8",
      raised: "FFFDF8",
      ink: "14213D",
      muted: "5B6475",
      rule: "D9D2C4",
      coral: "AD4B2F",
      blue: "335C81",
      focus: "1E5AA8",
    },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: {
      display: { size: 64, lineHeight: 68, weight: 700 },
      heading: { size: 36, lineHeight: 42, weight: 700 },
      body: { size: 22, lineHeight: 30, weight: 400 },
      label: { size: 16, lineHeight: 20, weight: 600 },
    },
    stroke: { thin: 1, strong: 3 },
    radius: { small: 8, large: 24 },
  };
}

function geometryElement(
  slideId: string,
  id: string,
  role: string,
  text: string,
  lines: readonly string[],
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
  readingOrder: number,
): GeometryElement {
  const decorative = role === "decoration";
  const fontSize = role === "title" ? 36 : 22;
  return {
    id,
    role,
    text,
    box,
    tokens: {
      color: decorative ? "colors.coral" : "colors.ink",
      size: role === "title" ? "typography.heading.size" : "typography.body.size",
      font: "font.family",
    },
    resolvedTokens: {
      color: decorative ? "AD4B2F" : "14213D",
      size: fontSize,
      font: 'Fixture Sans "Local"',
    },
    accessibility: {
      role: decorative ? "presentation" : role,
      label: decorative ? "" : `${role}: ${text}`,
      readingOrder,
    },
    evidence: decorative ? null : {
      fieldPath: `${slideId}.${role}</script>&`,
      claimIds: [`claim-${slideId}-${readingOrder}`],
    },
    lines,
    fitTrace: {
      policy: "wrap",
      requestedFontSize: fontSize,
      finalFontSize: fontSize,
      fontFloor: 18,
      outcome: "fit",
      lines,
      attempts: [{ fontSize, lines, width: box.width - 1, height: box.height - 1, fits: true }],
    },
  };
}

function geometry(slideId: string, special = false): GeometrySlide {
  const title = special ? SPECIAL_TEXT : "Second slide";
  const titleLines = special
    ? ["Decision </script> & <go>", '"quoted" \'owner\' \u2028 line']
    : [title];
  return {
    id: `${slideId}:geometry`,
    slideId,
    layout: "summary",
    canvas: { width: 1280, height: 720 },
    variant: special ? "special<&\"'" : "plain",
    elements: [
      geometryElement(slideId, `${slideId}:title`, "title", title, titleLines,
        { x: 80, y: 56, width: 760, height: 96 }, 0),
      geometryElement(slideId, `${slideId}:body`, "body", "Alpha\nBeta", ["Alpha", "Beta"],
        { x: 80, y: 180, width: 540, height: 120 }, 1),
      geometryElement(slideId, `${slideId}:rule`, "decoration", "", [""],
        { x: 80, y: 330, width: 1120, height: 3 }, 2),
    ],
  };
}

function preflight(slide: GeometrySlide): GeometryPreflightResult {
  return { slide, issues: [], status: "publishable" };
}

function assetLayer(slideId: string, withAsset: boolean): ResolvedAssetLayer {
  const hash = sha256(ASSET_BYTES);
  return {
    id: `${slideId}:assets`,
    slideId,
    canvas: { width: 1280, height: 720 },
    placements: withAsset ? [{
      id: `${slideId}:asset:chart`,
      assetId: "asset-chart",
      purpose: "informative",
      kind: "chart",
      localPath: `assets/${hash}.svg`,
      sha256: hash,
      mediaType: "image/svg+xml",
      sourceWidth: 32,
      sourceHeight: 24,
      byteLength: ASSET_BYTES.byteLength,
      box: { x: 880, y: 160, width: 240, height: 180 },
      fit: "contain",
      accessibility: { role: "img", label: SPECIAL_ALT },
      evidence: { claimIds: ["claim-slide-01-0"] },
    }] : [],
  };
}

function input(overrides: Partial<StandaloneDeckInput> = {}): StandaloneDeckInput {
  const first = geometry("slide-01", true);
  const second = geometry("slide-02");
  return {
    id: "deck-standalone-01",
    title: "Launch <review> & \"decisions\"",
    lang: "ko",
    theme: theme(),
    resourceRoot: root,
    slides: [
      { geometry: preflight(first), assets: assetLayer(first.slideId, true), notes: SPECIAL_NOTES },
      { geometry: preflight(second), assets: assetLayer(second.slideId, false), notes: "Second note" },
    ],
    includeSlidesGrabDocuments: true,
    ...overrides,
  };
}

function render(overrides: Partial<StandaloneDeckInput> = {}): StandaloneHtmlArtifact {
  return renderStandaloneHtml(input(overrides));
}

function metadata(html: string): Record<string, unknown> {
  const match = html.match(/<script id="deck-metadata" type="application\/json">([^<]*)<\/script>/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

function slideSections(html: string): string[] {
  return html.match(/<section class="slide"[\s\S]*?<\/section>/g) ?? [];
}

function expectFailure(
  operation: () => unknown,
  expected: { code: string; path: string; detail?: RegExp },
): void {
  try {
    operation();
    throw new Error("expected standalone HTML failure");
  } catch (error) {
    expect(error).toBeInstanceOf(StandaloneHtmlError);
    const failure = error as StandaloneHtmlError;
    expect(failure.name).toBe("StandaloneHtmlError");
    expect(failure.code).toBe(expected.code);
    expect(failure.path).toBe(expected.path);
    expect(failure.message).toContain(`[${expected.code}]`);
    expect(failure.message).toContain(expected.path);
    if (expected.detail !== undefined) expect(failure.message).toMatch(expected.detail);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meeting-slides-standalone-html-"));
  const fixtureTheme = theme();
  fontPath = join(root, fixtureTheme.font.localPath);
  assetPath = join(root, `assets/${sha256(ASSET_BYTES)}.svg`);
  mkdirSync(join(root, "fonts"), { recursive: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(fontPath, FONT_BYTES);
  writeFileSync(assetPath, ASSET_BYTES);
});

afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("deterministic self-contained standalone deck HTML", () => {
  test("renders and writes one byte-identical UTF-8 presentation document with every resource embedded", () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((..._arguments_: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error("standalone export must never fetch");
    }) as unknown as typeof fetch;

    try {
      const artifact = render();
      const outputPath = join(root, "exports", "presentation.html");
      const written = writeStandaloneHtml(input(), outputPath);
      const diskBytes = readFileSync(outputPath);

      expect(fetchCalls).toBe(0);
      expect(artifact.html.startsWith("<!doctype html>\n<html lang=\"ko\"")).toBe(true);
      expect(artifact.html).toContain('<meta charset="utf-8">');
      expect(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes)).toBe(artifact.html);
      expect(artifact.bytes[0]).not.toBe(0xef);
      expect(diskBytes).toEqual(Buffer.from(artifact.bytes));
      expect(written).toEqual(artifact);
      expect(artifact.sha256).toBe(sha256(artifact.bytes));
      expect(artifact.html).toContain(
        `url("data:font/woff2;base64,${Buffer.from(FONT_BYTES).toString("base64")}")`,
      );
      expect(artifact.html).toContain(
        `src="data:image/svg+xml;base64,${Buffer.from(ASSET_BYTES).toString("base64")}"`,
      );
      expect(artifact.html).not.toContain(theme().font.localPath);
      expect(artifact.html).not.toContain(assetLayer("slide-01", true).placements[0]!.localPath);
      expect(artifact.html).not.toContain("https://");
      expect(artifact.html).not.toContain("http://");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("embeds canonical theme CSS tokens, semantic selectable text, and exact 1280x720 geometry", () => {
    const html = render().html;
    const properties = toCssCustomProperties(theme());

    for (const [name, value] of Object.entries(properties)) {
      if (name === "--theme-font-localPath") {
        expect(html).toContain(`${name}: url(\"data:font/woff2;base64,`);
      } else {
        expect(html).toContain(`${name}: ${value};`);
      }
    }

    const sections = slideSections(html);
    expect(sections).toHaveLength(2);
    for (const [index, section] of sections.entries()) {
      expect(section).toContain(`data-slide-index="${index}"`);
      expect(section).toContain('role="group"');
      expect(section).toContain('aria-roledescription="slide"');
      expect(section).toContain('style="width:1280px;height:720px"');
    }

    const first = sections[0]!;
    expect(first).toContain(
      'data-element-id="slide-01:title" style="position:absolute;left:80px;top:56px;width:760px;height:96px;font-size:36px',
    );
    expect(first).toContain('data-element-id="slide-01:body" style="position:absolute;left:80px;top:180px;width:540px;height:120px;font-size:22px');
    expect(first).toContain('data-element-id="slide-01:rule" style="position:absolute;left:80px;top:330px;width:1120px;height:3px');
    expect(first).toContain('<span class="text-line">Decision &lt;/script&gt; &amp; &lt;go&gt;</span><br>');
    expect(first).toContain('<span class="text-line">&quot;quoted&quot; &#39;owner&#39; \u2028 line</span>');
    expect(first).toContain('<span class="text-line">Alpha</span><br><span class="text-line">Beta</span>');
    expect(first).not.toMatch(/<(canvas|svg)[\s>][\s\S]*Decision/);
    expect(html).not.toMatch(/\b(auto-?fit|fit-to-box|shrink-text|line-clamp|text-overflow)\b/i);
    expect(html).not.toMatch(/overflow\s*:\s*hidden/i);
    expect(html).not.toMatch(/clip(?:-path)?\s*:/i);
  });

  test("keeps evidence and presenter notes in escaped inert JSON while XML attributes are escaped exactly", () => {
    const html = render().html;
    const rawMetadata = html.match(/<script id="deck-metadata" type="application\/json">([^<]*)<\/script>/)![1]!;

    expect(rawMetadata).toContain("\\u003c/script\\u003e");
    expect(rawMetadata).toContain("\\u0026");
    expect(rawMetadata).toContain("\\u2028");
    expect(rawMetadata).not.toContain("</script>");
    expect(html).toContain(
      'alt="Chart &quot;A&amp;B&quot; &lt;danger&gt; &#39;quoted&#39;"',
    );
    expect(html).toContain('data-variant="special&lt;&amp;&quot;&#39;"');
    expect(html).not.toContain(SPECIAL_NOTES);
    expect(metadata(html)).toEqual({
      schemaVersion: 1,
      deckId: "deck-standalone-01",
      title: 'Launch <review> & "decisions"',
      slides: [
        {
          slideId: "slide-01",
          notes: SPECIAL_NOTES,
          evidence: [
            { elementId: "slide-01:title", fieldPath: "slide-01.title</script>&", claimIds: ["claim-slide-01-0"] },
            { elementId: "slide-01:body", fieldPath: "slide-01.body</script>&", claimIds: ["claim-slide-01-1"] },
          ],
        },
        {
          slideId: "slide-02",
          notes: "Second note",
          evidence: [
            { elementId: "slide-02:title", fieldPath: "slide-02.title</script>&", claimIds: ["claim-slide-02-0"] },
            { elementId: "slide-02:body", fieldPath: "slide-02.body</script>&", claimIds: ["claim-slide-02-1"] },
          ],
        },
      ],
    });
  });

  test("ships keyboard navigation, counter, overview, presenter notes, focus, reduced motion, and print contracts inline", () => {
    const html = render().html;

    expect(html).toContain('data-slide-counter aria-live="polite">1 / 2</');
    expect(html).toContain('button type="button" data-action="previous"');
    expect(html).toContain('button type="button" data-action="next"');
    expect(html).toContain('button type="button" data-action="overview"');
    expect(html).toContain('button type="button" data-action="presenter"');
    expect(html).toContain('data-presenter-notes');
    expect(html).toContain('addEventListener("keydown"');
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape"]) {
      expect(html).toContain(`"${key}"`);
    }
    expect(html).toMatch(/:focus-visible\s*{[^}]*outline\s*:/s);
    expect(html).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*animation-duration\s*:\s*0(?:\.0+)?(?:ms|s)/);
    expect(html).toMatch(/@media\s+print\s*{[\s\S]*\.slide\s*{[^}]*width\s*:\s*1280px[^}]*height\s*:\s*720px[^}]*break-after\s*:\s*page/s);
    expect(html).toMatch(/@page\s*{[^}]*size\s*:\s*1280px 720px[^}]*margin\s*:\s*0/s);
  });

  test("contains no external loading, imports, hotlinks, dynamic code execution, or active metadata", () => {
    const html = render().html;
    const resourceUrls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);

    expect(resourceUrls.length).toBeGreaterThan(0);
    expect(resourceUrls.every((url) => url.startsWith("data:"))).toBe(true);
    expect(html).not.toMatch(/@import\b/i);
    expect(html).not.toMatch(/\bimport\s*(?:\(|[^<])/);
    expect(html).not.toMatch(/\beval\s*\(/);
    expect(html).not.toMatch(/\bnew\s+Function\b/);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|EventSource/);
    expect(html).not.toMatch(/<(?:iframe|object|embed|link)\b/i);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).toContain('<script id="deck-metadata" type="application/json">');
    expect(html).toMatch(/<script id="deck-runtime">[\s\S]*<\/script>/);
  });

  test("is deterministic across fresh values, mtimes, rendering, and disk writes", () => {
    const first = renderStandaloneHtml(structuredClone(input()));
    writeFileSync(fontPath, FONT_BYTES);
    writeFileSync(assetPath, ASSET_BYTES);
    const second = renderStandaloneHtml(structuredClone(input()));
    const firstPath = join(root, "one.html");
    const secondPath = join(root, "two.html");
    const firstWrite = writeStandaloneHtml(structuredClone(input()), firstPath);
    const secondWrite = writeStandaloneHtml(structuredClone(input()), secondPath);

    expect(second).toEqual(first);
    expect(second.html).toBe(first.html);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(sha256(first.bytes));
    expect(firstWrite.sha256).toBe(first.sha256);
    expect(secondWrite.sha256).toBe(first.sha256);
    expect(readFileSync(firstPath)).toEqual(readFileSync(secondPath));
  });

  test("optionally emits per-slide slides-grab documents from the exact same section renderer", () => {
    const artifact = render();

    expect(artifact.slidesGrabDocuments).toHaveLength(2);
    expect(artifact.slidesGrabDocuments.map((document) => document.filename)).toEqual([
      "slide-01.html",
      "slide-02.html",
    ]);
    const deckSections = slideSections(artifact.html);
    for (const [index, document] of artifact.slidesGrabDocuments.entries()) {
      expect(document.html.startsWith("<!doctype html>\n<html lang=\"ko\"")).toBe(true);
      expect(slideSections(document.html)).toEqual([deckSections[index]!]);
      expect(document.bytes).toEqual(new TextEncoder().encode(document.html));
      expect(document.sha256).toBe(sha256(document.bytes));
      expect(document.html).toContain("data:font/woff2;base64,");
      if (index === 0) expect(document.html).toContain("data:image/svg+xml;base64,");
      expect(document.html).not.toMatch(/https?:\/\//i);
    }

    const withoutGrab = renderStandaloneHtml({ ...input(), includeSlidesGrabDocuments: false });
    expect(withoutGrab.slidesGrabDocuments).toEqual([]);
    expect(slideSections(withoutGrab.html)).toEqual(deckSections);
  });
});

describe("standalone HTML typed publication failures", () => {
  test("rejects blocked geometry and preserves the compiler issue path", () => {
    const blockedSlide = geometry("slide-01", true);
    const issue: CompileIssue = {
      code: "text-overflow",
      severity: "error",
      path: "elements[0].fitTrace",
      elementIds: ["slide-01:title"],
      message: "title does not fit",
    };
    const blocked: GeometryPreflightResult = { slide: blockedSlide, issues: [issue], status: "blocked" };
    const source = input();
    const slides = [{ ...source.slides[0]!, geometry: blocked }, source.slides[1]!];

    expectFailure(
      () => renderStandaloneHtml({ ...source, slides }),
      { code: "STANDALONE_GEOMETRY_BLOCKED", path: "slides[0].geometry.issues[0]", detail: /text-overflow/ },
    );
  });

  test("rejects missing and mutated bundled font bytes before producing HTML", () => {
    unlinkSync(fontPath);
    expect(existsSync(fontPath)).toBe(false);
    expectFailure(
      () => render(),
      { code: "STANDALONE_FONT_NOT_FOUND", path: "theme.font.localPath", detail: /woff2/ },
    );

    writeFileSync(fontPath, new TextEncoder().encode("mutated font bytes"));
    expectFailure(
      () => render(),
      { code: "STANDALONE_FONT_HASH_MISMATCH", path: "theme.font.sha256", detail: /sha-?256/i },
    );
  });

  test("rejects missing and mutated local asset bytes before producing HTML", () => {
    unlinkSync(assetPath);
    expectFailure(
      () => render(),
      { code: "STANDALONE_ASSET_NOT_FOUND", path: "slides[0].assets.placements[0].localPath", detail: /asset-chart/ },
    );

    writeFileSync(assetPath, new TextEncoder().encode("mutated asset bytes"));
    expectFailure(
      () => render(),
      { code: "STANDALONE_ASSET_HASH_MISMATCH", path: "slides[0].assets.placements[0].sha256", detail: /asset-chart/ },
    );
  });

  test("rejects a caller-supplied expected output hash mismatch", () => {
    expectFailure(
      () => renderStandaloneHtml({ ...input(), expectedSha256: "0".repeat(64) }),
      { code: "STANDALONE_OUTPUT_HASH_MISMATCH", path: "expectedSha256", detail: /0{64}/ },
    );
  });

  test("rejects unresolved, absolute, URL, and traversal resource paths without reading outside the root", () => {
    const cases: Array<[string, StandaloneDeckInput, string]> = [
      ["relative traversal", { ...input(), theme: { ...theme(), font: { ...theme().font, localPath: "../font.woff2" } } }, "theme.font.localPath"],
      ["absolute font", { ...input(), theme: { ...theme(), font: { ...theme().font, localPath: fontPath } } }, "theme.font.localPath"],
      ["font URL", { ...input(), theme: { ...theme(), font: { ...theme().font, localPath: "https://cdn.example/font.woff2" } } }, "theme.font.localPath"],
    ];
    const source = input();
    const badLayer = structuredClone(source.slides[0]!.assets) as ResolvedAssetLayer;
    (badLayer.placements[0] as { localPath: string }).localPath = "assets/../outside.svg";
    cases.push(["asset traversal", {
      ...source,
      slides: [{ ...source.slides[0]!, assets: badLayer }, source.slides[1]!],
    }, "slides[0].assets.placements[0].localPath"]);

    for (const [label, candidate, path] of cases) {
      expectFailure(
        () => renderStandaloneHtml(candidate),
        { code: "STANDALONE_PATH_UNRESOLVED", path, detail: new RegExp(label.endsWith("URL") ? "https" : "(?:outside|root|relative|absolute|traversal)", "i") },
      );
    }
  });

  test("rejects unsupported font and asset media rather than embedding executable content", () => {
    const wrongFont = { ...theme(), font: { ...theme().font, localPath: theme().font.localPath.replace(/\.woff2$/, ".ttf") } };
    expectFailure(
      () => renderStandaloneHtml({ ...input(), theme: wrongFont }),
      { code: "STANDALONE_MEDIA_UNSUPPORTED", path: "theme.font.localPath", detail: /woff2/i },
    );

    const source = input();
    const badLayer = structuredClone(source.slides[0]!.assets) as ResolvedAssetLayer;
    (badLayer.placements[0] as { mediaType: string }).mediaType = "text/html";
    expectFailure(
      () => renderStandaloneHtml({
        ...source,
        slides: [{ ...source.slides[0]!, assets: badLayer }, source.slides[1]!],
      }),
      { code: "STANDALONE_MEDIA_UNSUPPORTED", path: "slides[0].assets.placements[0].mediaType", detail: /text\/html/ },
    );
  });

  test("rejects duplicate slide, geometry element, and asset placement IDs at the second occurrence", () => {
    const source = input();
    const duplicateSlide = structuredClone(source.slides[1]!);
    const duplicateGeometry = structuredClone(source.slides[0]!.geometry) as GeometryPreflightResult;
    (duplicateGeometry.slide.elements[1] as { id: string }).id = duplicateGeometry.slide.elements[0]!.id;
    const duplicateAssets = structuredClone(source.slides[0]!.assets) as ResolvedAssetLayer;
    (duplicateAssets.placements as unknown as Array<ResolvedAssetLayer["placements"][number]>).push(
      { ...duplicateAssets.placements[0]! },
    );

    const cases: Array<[StandaloneDeckInput, string, RegExp]> = [
      [{ ...source, slides: [source.slides[0]!, { ...duplicateSlide, geometry: {
        ...duplicateSlide.geometry,
        slide: { ...duplicateSlide.geometry.slide, slideId: "slide-01" },
      } }] }, "slides[1].geometry.slide.slideId", /slide-01/],
      [{ ...source, slides: [{ ...source.slides[0]!, geometry: duplicateGeometry }, source.slides[1]!] },
        "slides[0].geometry.slide.elements[1].id", /slide-01:title/],
      [{ ...source, slides: [{ ...source.slides[0]!, assets: duplicateAssets }, source.slides[1]!] },
        "slides[0].assets.placements[1].id", /slide-01:asset:chart/],
    ];

    for (const [candidate, path, detail] of cases) {
      expectFailure(
        () => renderStandaloneHtml(candidate),
        { code: "STANDALONE_DUPLICATE_ID", path, detail },
      );
    }
  });

  test("rejects an empty deck instead of emitting a misleading presentation shell", () => {
    expectFailure(
      () => renderStandaloneHtml({ ...input(), slides: [] }),
      { code: "STANDALONE_EMPTY_DECK", path: "slides", detail: /at least one slide/i },
    );
  });
});
