import { describe, expect, test } from "bun:test";

import type { LayoutDraft, LayoutElement } from "../../src/slides/layouts/contract.ts";
import type {
  CompileIssue,
  GeometryCompileResult,
  GeometrySlide,
  TextMeasureInput,
  TextMeasurer,
  TextFitPolicy,
} from "../../src/slides/geometry/contract.ts";
import { compileGeometrySlide } from "../../src/slides/geometry/compiler.ts";
import { preflightGeometrySlide } from "../../src/slides/geometry/preflight.ts";
import { createDeckTheme } from "../../src/slides/theme/theme.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";

const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

/**
 * A deliberately boring, injected font metric. It never consults a browser,
 * canvas, installed font, clock, or process state. ASCII glyphs are 0.5em,
 * spaces are 0.5em, and Korean syllables are 1em.
 */
class DeterministicTextMeasurer implements TextMeasurer {
  readonly calls: TextMeasureInput[] = [];

  measure(input: TextMeasureInput): { width: number; height: number } {
    this.calls.push({ ...input });
    const ems = [...input.text].reduce((sum, character) =>
      sum + (/^[\uac00-\ud7a3]$/.test(character) ? 1 : 0.5), 0);
    return { width: ems * input.fontSize, height: input.fontSize };
  }
}

const policies = {
  title: {
    mode: "wrap",
    wordBreak: "keep-all",
    overflowWrap: "break-word",
    fontFloor: 28,
  },
  body: {
    mode: "wrap",
    wordBreak: "keep-all",
    overflowWrap: "break-word",
    fontFloor: 18,
  },
  label: {
    mode: "shrink",
    wordBreak: "normal",
    overflowWrap: "normal",
    fontFloor: 20,
  },
  reject: {
    mode: "reject",
    wordBreak: "normal",
    overflowWrap: "normal",
    fontFloor: 20,
  },
  decoration: {
    mode: "reject",
    wordBreak: "normal",
    overflowWrap: "normal",
    fontFloor: 1,
  },
} as const satisfies Readonly<Record<string, TextFitPolicy>>;

function element(
  id: string,
  role: keyof typeof policies,
  text: string,
  box: LayoutElement["box"],
  tokenOverrides: Readonly<Record<string, string>> = {},
): LayoutElement {
  return {
    id: `geometry-fixture:${id}`,
    role,
    text,
    box,
    tokens: {
      color: role === "decoration" ? "colors.coral" : "colors.ink",
      size: role === "title" ? "typography.heading.size" : "typography.body.size",
      font: "font.family",
      ...tokenOverrides,
    },
    accessibility: {
      role: role === "decoration" ? "presentation" : role,
      label: role === "decoration" ? "" : `${role}: ${text}`,
      readingOrder: Number(id.replace(/\D/g, "")) || 0,
    },
    evidence: role === "decoration"
      ? null
      : { fieldPath: `fixture.${id}`, claimIds: [`claim-${id}`] },
  };
}

function draft(elements: readonly LayoutElement[]): LayoutDraft {
  return {
    id: "geometry-fixture:layout",
    slideId: "geometry-fixture",
    layout: "summary",
    canvas: { width: 1280, height: 720 },
    variant: "geometry-contract",
    elements,
  };
}

function compile(
  elements: readonly LayoutElement[],
  rolePolicies: Readonly<Record<string, TextFitPolicy>> = policies,
): GeometryCompileResult {
  return compileGeometrySlide(draft(elements), theme, {
    textMeasurer: new DeterministicTextMeasurer(),
    textPolicies: rolePolicies,
  });
}

function expectDeeplyFrozen(value: unknown, path = "root"): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectDeeplyFrozen(child, `${path}.${key}`);
  }
}

function issueIdentity(issue: CompileIssue): object {
  return {
    code: issue.code,
    severity: issue.severity,
    path: issue.path,
    elementIds: issue.elementIds,
  };
}

function forbiddenRendererFlags(value: unknown, path = "slide"): string[] {
  if (typeof value !== "object" || value === null) return [];
  const forbidden = new Set(["clip", "clipping", "autoFit", "autofit", "fitToBox", "shrinkText"]);
  return Object.entries(value).flatMap(([key, child]) => [
    ...(forbidden.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenRendererFlags(child, `${path}.${key}`),
  ]);
}

function validElements(): readonly LayoutElement[] {
  return [
    element("0-title", "title", "Deterministic geometry", { x: 80, y: 56, width: 500, height: 84 }),
    element("1-body", "body", "alpha beta gamma", { x: 80, y: 180, width: 120, height: 60 }),
  ];
}

describe("deterministic geometry compiler contract", () => {
  test("compiles LayoutDraft + Theme into a deeply frozen 1280x720 integer GeometrySlide", () => {
    const source = draft(validElements());
    const before = structuredClone(source);
    const measurer = new DeterministicTextMeasurer();
    const result = compileGeometrySlide(source, theme, {
      textMeasurer: measurer,
      textPolicies: policies,
    });

    expect(result.issues).toEqual([]);
    expect(result.slide).toMatchObject({
      id: "geometry-fixture:geometry",
      slideId: source.slideId,
      layout: source.layout,
      variant: source.variant,
      canvas: { width: 1280, height: 720 },
    });
    expect(result.slide.elements.map((entry) => entry.id)).toEqual(
      source.elements.map((entry) => entry.id),
    );
    expect(source).toEqual(before);

    for (const [index, entry] of result.slide.elements.entries()) {
      for (const value of Object.values(entry.box)) expect(Number.isInteger(value)).toBe(true);
      expect(entry.tokens).toEqual(source.elements[index]!.tokens);
      expect(entry.resolvedTokens).toEqual(Object.fromEntries(
        Object.entries(entry.tokens).map(([property, token]) => [
          property,
          token === "colors.ink" ? "14213D"
            : token === "typography.heading.size" ? 36
            : token === "typography.body.size" ? 22
            : "Pretendard Variable",
        ]),
      ));
      expect(entry.evidence).toEqual(source.elements[index]!.evidence);
      expect(entry.accessibility).toEqual(source.elements[index]!.accessibility);
      expect(entry.lines.length).toBeGreaterThan(0);
      expect(entry.fitTrace).toMatchObject({
        policy: policies[entry.role as keyof typeof policies].mode,
        requestedFontSize: entry.resolvedTokens.size,
        fontFloor: policies[entry.role as keyof typeof policies].fontFloor,
        outcome: "fit",
      });
      expect(entry.fitTrace.attempts.length).toBeGreaterThan(0);
    }

    expect(measurer.calls.length).toBeGreaterThan(0);
    expect(new Set(measurer.calls.map((call) => call.fontFamily))).toEqual(
      new Set(["Pretendard Variable"]),
    );
    expectDeeplyFrozen(result);
  });

  test("records exact deterministic wrapping and a FitTrace for every text element", () => {
    const result = compile(validElements());
    const title = result.slide.elements[0]!;
    const body = result.slide.elements[1]!;

    expect(title.lines).toEqual(["Deterministic geometry"]);
    expect(body.lines).toEqual(["alpha beta", "gamma"]);
    expect(body.fitTrace).toMatchObject({
      policy: "wrap",
      requestedFontSize: 22,
      finalFontSize: 22,
      fontFloor: 18,
      outcome: "fit",
      lines: ["alpha beta", "gamma"],
    });
    expect(body.fitTrace.attempts.at(-1)).toMatchObject({
      fontSize: 22,
      lines: ["alpha beta", "gamma"],
      fits: true,
    });
  });

  test("applies wrap, shrink, and reject as distinct explicit policies with a font floor", () => {
    const wrapped = compile([
      element("0-body", "body", "alpha beta gamma", { x: 40, y: 40, width: 120, height: 60 }),
    ]);
    const shrunk = compile([
      element("0-label", "label", "ABCDEFGHIJ", { x: 40, y: 40, width: 100, height: 30 }),
    ]);
    const rejected = compile([
      element("0-reject", "reject", "ABCDEFGHIJ", { x: 40, y: 40, width: 100, height: 30 }),
    ]);

    expect(wrapped.slide.elements[0]!.lines).toEqual(["alpha beta", "gamma"]);
    expect(wrapped.slide.elements[0]!.fitTrace.finalFontSize).toBe(22);
    expect(shrunk.slide.elements[0]!.lines).toEqual(["ABCDEFGHIJ"]);
    expect(shrunk.slide.elements[0]!.fitTrace).toMatchObject({
      policy: "shrink",
      requestedFontSize: 22,
      finalFontSize: 20,
      fontFloor: 20,
      outcome: "fit",
    });
    expect(rejected.slide.elements[0]!.fitTrace).toMatchObject({
      policy: "reject",
      requestedFontSize: 22,
      finalFontSize: 22,
      outcome: "rejected",
    });
    expect(rejected.issues.map(issueIdentity)).toEqual([{
      code: "text-overflow",
      severity: "error",
      path: "elements[0].fitTrace",
      elementIds: ["geometry-fixture:0-reject"],
    }]);
  });

  test("is byte-equivalent for identical inputs and does not emit renderer clipping or autofit flags", () => {
    const first: GeometrySlide = compile(structuredClone(validElements())).slide;
    const second: GeometrySlide = compile(structuredClone(validElements())).slide;

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(forbiddenRendererFlags(first)).toEqual([]);
  });

  test("handles Korean keep-all and a long unbroken run at the core compiler boundary", () => {
    const result = compile([
      element("0-body", "body", "출시 결정은 금요일 확정", { x: 40, y: 40, width: 132, height: 60 }),
      element("1-body", "body", "ABCDEFGHIJKL", { x: 240, y: 40, width: 66, height: 60 }),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.slide.elements[0]!.lines).toEqual(["출시 결정은", "금요일 확정"]);
    expect(result.slide.elements[1]!.lines).toEqual(["ABCDEF", "GHIJKL"]);
    expect(result.slide.elements.map((entry) => entry.fitTrace.outcome)).toEqual(["fit", "fit"]);
  });
});

describe("geometry preflight boundary", () => {
  test("reports out-of-bounds boxes and undeclared intersections in stable path-rich order", () => {
    const compiled = compile([
      element("0-body", "body", "alpha", { x: -1, y: 40, width: 100, height: 30 }),
      element("1-body", "body", "beta", { x: 80, y: 40, width: 100, height: 30 }),
    ]);
    const first = preflightGeometrySlide(compiled);
    const second = preflightGeometrySlide(compiled);

    const expected = [
      {
        code: "box-out-of-bounds",
        severity: "error",
        path: "elements[0].box.x",
        elementIds: ["geometry-fixture:0-body"],
      },
      {
        code: "undeclared-intersection",
        severity: "error",
        path: "elements[0].box",
        elementIds: ["geometry-fixture:0-body", "geometry-fixture:1-body"],
      },
    ];
    expect(first.issues.map(issueIdentity)).toEqual(expected);
    expect(second.issues.map(issueIdentity)).toEqual(expected);
    expect(JSON.stringify(second.issues)).toBe(JSON.stringify(first.issues));
    expect(first.status).toBe("blocked");
  });

  test("reports vertical text overflow and a shrink font-floor violation at exact element paths", () => {
    const overflow = preflightGeometrySlide(compile([
      element("0-body", "body", "alpha beta gamma", { x: 40, y: 40, width: 120, height: 30 }),
    ]));
    const belowFloor = preflightGeometrySlide(compile([
      element("0-label", "label", "ABCDEFGHIJ", { x: 40, y: 40, width: 90, height: 30 }),
    ]));

    expect(overflow.issues.map(issueIdentity)).toEqual([{
      code: "text-overflow",
      severity: "error",
      path: "elements[0].fitTrace",
      elementIds: ["geometry-fixture:0-body"],
    }]);
    expect(belowFloor.issues.map(issueIdentity)).toEqual([{
      code: "font-floor-violation",
      severity: "error",
      path: "elements[0].fitTrace.finalFontSize",
      elementIds: ["geometry-fixture:0-label"],
    }]);
    expect(overflow.status).toBe("blocked");
    expect(belowFloor.status).toBe("blocked");
  });

  test("allows only an explicitly declared decorative overlap", () => {
    const compiled = compile([
      element("0-decoration", "decoration", "accent", { x: 40, y: 40, width: 140, height: 30 }),
      element("1-body", "body", "alpha", { x: 80, y: 40, width: 100, height: 30 }),
    ]);

    const undeclared = preflightGeometrySlide(compiled);
    const declared = preflightGeometrySlide(compiled, {
      allowedOverlaps: [{
        elementIds: ["geometry-fixture:0-decoration", "geometry-fixture:1-body"],
        purpose: "decorative",
      }],
    });

    expect(undeclared.issues.map((issue) => issue.code)).toEqual(["undeclared-intersection"]);
    expect(undeclared.status).toBe("blocked");
    expect(declared.issues).toEqual([]);
    expect(declared.status).toBe("publishable");
    expect(declared.slide).toBe(compiled.slide);
  });

  test("any compiler or preflight error prevents publishable status", () => {
    const valid = preflightGeometrySlide(compile(validElements()));
    const compilerError = preflightGeometrySlide(compile([
      element("0-reject", "reject", "ABCDEFGHIJ", { x: 40, y: 40, width: 100, height: 30 }),
    ]));
    const boundaryError = preflightGeometrySlide(compile([
      element("0-body", "body", "alpha", { x: 1240, y: 40, width: 100, height: 30 }),
    ]));

    expect(valid.issues).toEqual([]);
    expect(valid.status).toBe("publishable");
    expect(compilerError.issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(boundaryError.issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(compilerError.status).toBe("blocked");
    expect(boundaryError.status).toBe("blocked");
  });
});
