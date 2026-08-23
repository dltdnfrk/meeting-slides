import type { LayoutBox, LayoutElement } from "../layouts/contract.ts";
import type { PlanSlide } from "../model/plan.ts";
import type { ThemeTokenValue } from "../theme/theme.ts";

export type TextFitMode = "wrap" | "shrink" | "reject";
export type WordBreakPolicy = "normal" | "keep-all";
export type OverflowWrapPolicy = "normal" | "break-word";

export interface TextFitPolicy {
  readonly mode: TextFitMode;
  readonly wordBreak: WordBreakPolicy;
  readonly overflowWrap: OverflowWrapPolicy;
  readonly fontFloor: number;
}

export interface TextMeasureInput {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
}

export interface TextMeasurement {
  readonly width: number;
  readonly height: number;
}

export interface TextMeasurer {
  measure(input: TextMeasureInput): TextMeasurement;
}

export interface FitAttempt {
  readonly fontSize: number;
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly fits: boolean;
}

export type FitOutcome = "fit" | "overflow" | "rejected" | "below-floor";

export interface FitTrace {
  readonly policy: TextFitMode;
  readonly requestedFontSize: number;
  readonly finalFontSize: number;
  readonly fontFloor: number;
  readonly outcome: FitOutcome;
  readonly lines: readonly string[];
  readonly attempts: readonly FitAttempt[];
}

export interface GeometryElement extends Omit<LayoutElement, "box"> {
  readonly box: LayoutBox;
  readonly resolvedTokens: Readonly<Record<string, ThemeTokenValue>>;
  readonly lines: readonly string[];
  readonly fitTrace: FitTrace;
}

export interface GeometrySlide {
  readonly id: string;
  readonly slideId: string;
  readonly layout: PlanSlide["layout"];
  readonly canvas: { readonly width: 1280; readonly height: 720 };
  readonly variant: string;
  readonly elements: readonly GeometryElement[];
}

export type CompileIssueCode =
  | "invalid-token"
  | "text-overflow"
  | "font-floor-violation"
  | "box-out-of-bounds"
  | "undeclared-intersection";

export interface CompileIssue {
  readonly code: CompileIssueCode;
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly elementIds: readonly string[];
  readonly message: string;
}

export interface GeometryCompileResult {
  readonly slide: GeometrySlide;
  readonly issues: readonly CompileIssue[];
}

export interface GeometryCompilerOptions {
  readonly textMeasurer: TextMeasurer;
  readonly textPolicies: Readonly<Record<string, TextFitPolicy>>;
}

export interface AllowedOverlap {
  readonly elementIds: readonly [string, string];
  readonly purpose: "decorative";
}

export interface GeometryPreflightOptions {
  readonly allowedOverlaps?: readonly AllowedOverlap[];
}

export interface GeometryPreflightResult {
  readonly slide: GeometrySlide;
  readonly issues: readonly CompileIssue[];
  readonly status: "publishable" | "blocked";
}
