import type { LayoutBox } from "../layouts/contract.ts";

export interface BoxOverride {
  readonly elementId: string;
  readonly box: LayoutBox;
}

export class BoxOverrideError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "BoxOverrideError";
    this.path = path;
  }
}

const CANVAS = { width: 1280, height: 720 } as const;

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BoxOverrideError(path, "must be a finite number");
  }
  return value;
}

export function parseBoxOverrides(value: unknown, path: string): readonly BoxOverride[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BoxOverrideError(path, "must be a non-empty array");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new BoxOverrideError(entryPath, "must be an object");
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "elementId" && key !== "box")) {
      throw new BoxOverrideError(entryPath, "key is not allowed");
    }
    if (typeof record.elementId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(record.elementId)) {
      throw new BoxOverrideError(`${entryPath}.elementId`, "must be a stable ID");
    }
    if (seen.has(record.elementId)) {
      throw new BoxOverrideError(`${entryPath}.elementId`, "duplicate element ID");
    }
    seen.add(record.elementId);
    if (typeof record.box !== "object" || record.box === null || Array.isArray(record.box)) {
      throw new BoxOverrideError(`${entryPath}.box`, "must be an object");
    }
    const raw = record.box as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!["x", "y", "width", "height"].includes(key)) {
        throw new BoxOverrideError(`${entryPath}.box.${key}`, "key is not allowed");
      }
    }
    const x = finite(raw.x, `${entryPath}.box.x`);
    const y = finite(raw.y, `${entryPath}.box.y`);
    const width = finite(raw.width, `${entryPath}.box.width`);
    const height = finite(raw.height, `${entryPath}.box.height`);
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
      throw new BoxOverrideError(`${entryPath}.box`, "must stay inside the 1280x720 canvas");
    }
    if (x + width > CANVAS.width || y + height > CANVAS.height) {
      throw new BoxOverrideError(`${entryPath}.box`, "must stay inside the 1280x720 canvas");
    }
    return {
      elementId: record.elementId,
      box: { x, y, width, height },
    };
  });
}

export function applyElementBoxOverrides<T extends { readonly id: string; readonly box: LayoutBox }>(
  elements: readonly T[],
  overrides: readonly BoxOverride[] | undefined,
): readonly T[] {
  if (overrides === undefined || overrides.length === 0) return elements;
  const byId = new Map(overrides.map((entry) => [entry.elementId, entry.box]));
  return elements.map((element) => {
    const box = byId.get(element.id);
    if (box === undefined) return element;
    return {
      ...element,
      box: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
    };
  });
}
