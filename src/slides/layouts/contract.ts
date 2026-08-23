import type { PlanSlide } from "../model/plan.ts";

export type LayoutRegistryErrorCode = "unknown-layout" | "invalid-slide" | "invalid-payload";

export class LayoutRegistryError extends TypeError {
  readonly code: LayoutRegistryErrorCode;
  readonly path: string;

  constructor(code: LayoutRegistryErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "LayoutRegistryError";
    this.code = code;
    this.path = path;
  }
}

export interface LayoutBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEvidence {
  readonly fieldPath: string;
  readonly claimIds: readonly string[];
}

export interface LayoutElement {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly box: LayoutBox;
  readonly tokens: Readonly<Record<string, string>>;
  readonly accessibility: {
    readonly role: string;
    readonly label: string;
    readonly readingOrder: number;
  };
  readonly evidence: LayoutEvidence | null;
}

export interface LayoutDraft {
  readonly id: string;
  readonly slideId: string;
  readonly layout: PlanSlide["layout"];
  readonly canvas: { readonly width: 1280; readonly height: 720 };
  readonly variant: string;
  readonly elements: readonly LayoutElement[];
}

export interface LayoutDefinition {
  readonly family: PlanSlide["layout"];
  readonly draft: (slide: unknown) => LayoutDraft;
}
