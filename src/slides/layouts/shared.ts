import type { PlanSlide } from "../model/plan.ts";
import type { ThemeTokenName } from "../theme/theme.ts";
import { assertThemeTokenReferences } from "../theme/theme.ts";
import { deepFreeze } from "../theme/immutable.ts";
import {
  LayoutRegistryError,
  type LayoutBox,
  type LayoutDraft,
  type LayoutElement,
  type LayoutEvidence,
  type LayoutRegistryErrorCode,
} from "./contract.ts";

export interface SlideFields<L extends PlanSlide["layout"]> {
  readonly id: string;
  readonly layout: L;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly bindings: Readonly<Record<string, readonly string[]>>;
}

function fail(code: LayoutRegistryErrorCode, path: string, detail: string): never {
  throw new LayoutRegistryError(code, path, detail);
}

export function objectValue(
  value: unknown,
  path: string,
  code: LayoutRegistryErrorCode = "invalid-payload",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(code, path, "must be an object");
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) result[key] = child;
  return result;
}

export function textValue(
  value: unknown,
  path: string,
  code: LayoutRegistryErrorCode = "invalid-payload",
): string {
  if (value === undefined) return fail(code, path, "is required");
  if (typeof value !== "string") return fail(code, path, "must be a string");
  if (value.trim().length === 0) return fail(code, path, "must not be empty");
  return value;
}

export function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail("invalid-payload", path, "must be an array");
  if (value.length === 0) return fail("invalid-payload", path, "must not be empty");
  return value;
}

export function enumValue<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return fail("invalid-payload", path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseBindings(value: unknown): Readonly<Record<string, readonly string[]>> {
  const source = objectValue(value, "slide.bindings", "invalid-slide");
  const bindings: Record<string, readonly string[]> = {};
  for (const [fieldPath, rawIds] of Object.entries(source)) {
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      fail("invalid-slide", `slide.bindings.${fieldPath}`, "must contain claim IDs");
    }
    bindings[fieldPath] = rawIds.map((claimId, index) =>
      textValue(claimId, `slide.bindings.${fieldPath}[${index}]`, "invalid-slide"));
  }
  return bindings;
}

export function slideFields<L extends PlanSlide["layout"]>(
  value: unknown,
  family: L,
): SlideFields<L> {
  const slide = objectValue(value, "slide", "invalid-slide");
  if (slide.layout !== family) {
    fail("invalid-slide", "slide.layout", `must be '${family}'`);
  }
  return {
    id: textValue(slide.id, "slide.id", "invalid-slide"),
    layout: family,
    title: textValue(slide.title, "slide.title", "invalid-slide"),
    payload: objectValue(slide.payload, "slide.payload"),
    bindings: parseBindings(slide.bindings),
  };
}

export function evidenceFor(
  slide: SlideFields<PlanSlide["layout"]>,
  fieldPath: string,
): LayoutEvidence {
  const claimIds = slide.bindings[fieldPath];
  if (claimIds === undefined || claimIds.length === 0) {
    fail("invalid-slide", `slide.bindings.${fieldPath}`, "is required and must contain claim IDs");
  }
  return { fieldPath, claimIds: [...claimIds] };
}

export interface ElementInput {
  readonly key: string;
  readonly role: string;
  readonly text: string;
  readonly box: LayoutBox;
  readonly tokens: Record<string, ThemeTokenName>;
  readonly evidence: LayoutEvidence | null;
  readonly accessibilityLabel?: string;
}

export function element(slideId: string, order: number, input: ElementInput): LayoutElement {
  const tokens = { ...input.tokens };
  assertThemeTokenReferences(tokens, `elements[${order}].tokens`);
  return {
    id: `${slideId}:${input.key}`,
    role: input.role,
    text: input.text,
    box: { ...input.box },
    tokens,
    accessibility: {
      role: input.role,
      label: input.accessibilityLabel ?? `${input.role}: ${input.text}`,
      readingOrder: order,
    },
    evidence: input.evidence === null ? null : {
      fieldPath: input.evidence.fieldPath,
      claimIds: [...input.evidence.claimIds],
    },
  };
}

export function titleElement(slide: SlideFields<PlanSlide["layout"]>): LayoutElement {
  return element(slide.id, 0, {
    key: "title",
    role: "title",
    text: slide.title,
    box: { x: 80, y: 56, width: 1120, height: 92 },
    tokens: { color: "colors.ink", size: "typography.heading.size", font: "font.family" },
    evidence: evidenceFor(slide, "title"),
    accessibilityLabel: `Slide title: ${slide.title}`,
  });
}

export function draft(
  slide: SlideFields<PlanSlide["layout"]>,
  variant: string,
  elements: readonly LayoutElement[],
): LayoutDraft {
  return deepFreeze({
    id: `${slide.id}:layout`,
    slideId: slide.id,
    layout: slide.layout,
    canvas: { width: 1280 as const, height: 720 as const },
    variant,
    elements: [...elements],
  });
}
