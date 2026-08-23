import type { LayoutDraft, LayoutElement } from "../layouts/contract.ts";
import type { Theme } from "../model/plan.ts";
import { deepFreeze } from "../theme/immutable.ts";
import { resolveThemeToken, ThemeTokenError } from "../theme/theme.ts";
import type {
  CompileIssue,
  GeometryCompileResult,
  GeometryCompilerOptions,
  GeometryElement,
  TextFitPolicy,
} from "./contract.ts";
import { fitText } from "./text-fit.ts";

const FALLBACK_POLICY: TextFitPolicy = {
  mode: "reject",
  wordBreak: "normal",
  overflowWrap: "normal",
  fontFloor: 1,
};

function issue(
  code: CompileIssue["code"],
  path: string,
  elementId: string,
  message: string,
): CompileIssue {
  return { code, severity: "error", path, elementIds: [elementId], message };
}

function resolveTokens(
  element: LayoutElement,
  index: number,
  theme: Theme,
  issues: CompileIssue[],
): Readonly<Record<string, string | number>> {
  const resolved: Record<string, string | number> = {};
  for (const [property, token] of Object.entries(element.tokens)) {
    try {
      resolved[property] = resolveThemeToken(theme, token);
    } catch (error) {
      if (!(error instanceof ThemeTokenError)) throw error;
      issues.push(issue(
        "invalid-token",
        `elements[${index}].tokens.${property}`,
        element.id,
        error.message,
      ));
    }
  }
  return resolved;
}

function tokenTypeIssue(
  element: LayoutElement,
  index: number,
  property: "font" | "size",
  expected: string,
): CompileIssue {
  return issue(
    "invalid-token",
    `elements[${index}].tokens.${property}`,
    element.id,
    `resolved ${property} token must be ${expected}`,
  );
}

function compileElement(
  element: LayoutElement,
  index: number,
  theme: Theme,
  options: GeometryCompilerOptions,
  issues: CompileIssue[],
): GeometryElement {
  const resolvedTokens = resolveTokens(element, index, theme, issues);
  const resolvedFont = resolvedTokens.font;
  const resolvedSize = resolvedTokens.size;
  const fontResolutionFailed = resolvedFont === undefined &&
    Object.hasOwn(element.tokens, "font");
  const sizeResolutionFailed = resolvedSize === undefined &&
    Object.hasOwn(element.tokens, "size");
  if (typeof resolvedFont !== "string" && !fontResolutionFailed) {
    issues.push(tokenTypeIssue(element, index, "font", "a string"));
  }
  if ((typeof resolvedSize !== "number" || !Number.isFinite(resolvedSize) || resolvedSize <= 0) &&
      !sizeResolutionFailed) {
    issues.push(tokenTypeIssue(element, index, "size", "a positive number"));
  }

  const box = {
    x: Math.round(element.box.x),
    y: Math.round(element.box.y),
    width: Math.round(element.box.width),
    height: Math.round(element.box.height),
  };
  const fitTrace = fitText({
    text: element.text,
    width: box.width,
    height: box.height,
    fontFamily: typeof resolvedFont === "string" ? resolvedFont : theme.font.family,
    fontSize: typeof resolvedSize === "number" && Number.isFinite(resolvedSize) && resolvedSize > 0
      ? resolvedSize
      : theme.typography.body.size,
    policy: options.textPolicies[element.role] ?? FALLBACK_POLICY,
    measurer: options.textMeasurer,
  });

  if (fitTrace.outcome === "below-floor") {
    issues.push(issue(
      "font-floor-violation",
      `elements[${index}].fitTrace.finalFontSize`,
      element.id,
      `text requires ${fitTrace.finalFontSize}px, below the ${fitTrace.fontFloor}px floor`,
    ));
  } else if (fitTrace.outcome !== "fit") {
    issues.push(issue(
      "text-overflow",
      `elements[${index}].fitTrace`,
      element.id,
      `text does not fit under the ${fitTrace.policy} policy`,
    ));
  }

  return {
    id: element.id,
    role: element.role,
    text: element.text,
    box,
    tokens: { ...element.tokens },
    resolvedTokens,
    accessibility: {
      role: element.accessibility.role,
      label: element.accessibility.label,
      readingOrder: element.accessibility.readingOrder,
    },
    evidence: element.evidence === null ? null : {
      fieldPath: element.evidence.fieldPath,
      claimIds: [...element.evidence.claimIds],
    },
    lines: fitTrace.lines,
    fitTrace,
  };
}

export function compileGeometrySlide(
  draft: LayoutDraft,
  theme: Theme,
  options: GeometryCompilerOptions,
): GeometryCompileResult {
  const issues: CompileIssue[] = [];
  const elements = draft.elements.map((element, index) =>
    compileElement(element, index, theme, options, issues));
  return deepFreeze({
    slide: {
      id: `${draft.slideId}:geometry`,
      slideId: draft.slideId,
      layout: draft.layout,
      canvas: { width: 1280 as const, height: 720 as const },
      variant: draft.variant,
      elements,
    },
    issues,
  });
}
