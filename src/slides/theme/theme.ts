import type { Theme, TextStyle } from "../model/plan.ts";
import {
  MEETING_PAPER_STYLE_PROFILE,
  type StyleProfile,
} from "./meeting-paper.ts";
import { deepFreeze } from "./immutable.ts";

export const THEME_TOKEN_NAMES = Object.freeze([
  "canvas.width", "canvas.height",
  "font.family", "font.localPath", "font.sha256",
  "colors.paper", "colors.raised", "colors.ink", "colors.muted",
  "colors.rule", "colors.coral", "colors.blue", "colors.focus",
  "spacing.xs", "spacing.sm", "spacing.md", "spacing.lg", "spacing.xl",
  "typography.display.size", "typography.display.lineHeight", "typography.display.weight",
  "typography.heading.size", "typography.heading.lineHeight", "typography.heading.weight",
  "typography.body.size", "typography.body.lineHeight", "typography.body.weight",
  "typography.label.size", "typography.label.lineHeight", "typography.label.weight",
  "stroke.thin", "stroke.strong", "radius.small", "radius.large",
] as const);

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokenValue = string | number;
export type ThemeTokenErrorCode =
  | "unknown-profile"
  | "unknown-token"
  | "raw-layout-value"
  | "invalid-override";

export class ThemeTokenError extends TypeError {
  readonly code: ThemeTokenErrorCode;
  readonly path: string;

  constructor(code: ThemeTokenErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ThemeTokenError";
    this.code = code;
    this.path = path;
  }
}

const TOKEN_NAMES: ReadonlySet<string> = new Set(THEME_TOKEN_NAMES);
const OWN = Object.prototype.hasOwnProperty;

function invalid(path: string, detail: string): never {
  throw new ThemeTokenError("invalid-override", path, detail);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function group(
  parent: Record<string, unknown>, key: string, allowed: readonly string[],
): Record<string, unknown> {
  if (!OWN.call(parent, key)) return {};
  const path = `overrides.${key}`;
  const result = record(parent[key], path);
  for (const child of Object.keys(result)) {
    if (!allowed.includes(child)) invalid(`${path}.${child}`, "is not allowed");
  }
  return result;
}

function positive(value: unknown, path: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
      (integer && !Number.isInteger(value))) {
    invalid(path, integer ? "must be a positive integer" : "must be a positive number");
  }
  return value;
}

function applyNumberGroup<K extends string>(
  target: Record<K, number>, values: Record<string, unknown>, keys: readonly K[], path: string,
): void {
  for (const key of keys) {
    if (OWN.call(values, key)) target[key] = positive(values[key], `${path}.${key}`);
  }
}

function applyTextStyle(target: TextStyle, value: unknown, path: string): void {
  const style = record(value, path);
  const keys = ["size", "lineHeight", "weight"] as const;
  for (const key of Object.keys(style)) {
    if (!keys.includes(key as typeof keys[number])) invalid(`${path}.${key}`, "is not allowed");
  }
  for (const key of keys) {
    if (OWN.call(style, key)) target[key] = positive(style[key], `${path}.${key}`, key === "weight");
  }
}

function cloneProfile(profile: StyleProfile): Theme {
  return {
    id: profile.id,
    canvas: { ...profile.canvas },
    font: { ...profile.font },
    colors: { ...profile.colors },
    spacing: { ...profile.spacing },
    typography: {
      display: { ...profile.typography.display },
      heading: { ...profile.typography.heading },
      body: { ...profile.typography.body },
      label: { ...profile.typography.label },
    },
    stroke: { ...profile.stroke },
    radius: { ...profile.radius },
  };
}

function canonicalProfile(id: string): StyleProfile {
  if (id === MEETING_PAPER_STYLE_PROFILE.id) return MEETING_PAPER_STYLE_PROFILE;
  throw new ThemeTokenError("unknown-profile", "profile.id", `unknown style profile '${id}'`);
}

export function createDeckTheme(profile: StyleProfile, overrides?: unknown): Theme {
  const theme = cloneProfile(canonicalProfile(profile.id));
  if (overrides === undefined) return deepFreeze(theme);

  const root = record(overrides, "overrides");
  const allowed = ["colors", "spacing", "typography", "stroke", "radius"] as const;
  for (const key of Object.keys(root)) {
    if (key === "canvas") invalid("overrides.canvas", "canvas is fixed at 1280 x 720");
    if (!allowed.includes(key as typeof allowed[number])) invalid(`overrides.${key}`, "is not allowed");
  }

  const colors = group(root, "colors", [
    "paper", "raised", "ink", "muted", "rule", "coral", "blue", "focus",
  ]);
  for (const key of Object.keys(colors)) {
    const value = colors[key];
    if (typeof value !== "string" || !/^[0-9A-F]{6}$/i.test(value)) {
      invalid(`overrides.colors.${key}`, "must be a six-digit hexadecimal color");
    }
    theme.colors[key as keyof Theme["colors"]] = value;
  }

  applyNumberGroup(theme.spacing, group(root, "spacing", ["xs", "sm", "md", "lg", "xl"]),
    ["xs", "sm", "md", "lg", "xl"], "overrides.spacing");
  applyNumberGroup(theme.stroke, group(root, "stroke", ["thin", "strong"]),
    ["thin", "strong"], "overrides.stroke");
  applyNumberGroup(theme.radius, group(root, "radius", ["small", "large"]),
    ["small", "large"], "overrides.radius");

  const typography = group(root, "typography", ["display", "heading", "body", "label"]);
  for (const key of ["display", "heading", "body", "label"] as const) {
    if (OWN.call(typography, key)) {
      applyTextStyle(theme.typography[key], typography[key], `overrides.typography.${key}`);
    }
  }
  return deepFreeze(theme);
}

export function resolveDeckTheme(profileId: string, overrides?: unknown): Theme {
  return createDeckTheme(canonicalProfile(profileId), overrides);
}

export function resolveThemeToken(theme: Theme, token: string): ThemeTokenValue {
  if (!TOKEN_NAMES.has(token)) {
    throw new ThemeTokenError("unknown-token", "token", `unknown theme token '${token}'`);
  }
  let value: unknown = theme;
  for (const segment of token.split(".")) {
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ThemeTokenError("unknown-token", "token", `theme token '${token}' has no scalar value`);
  }
  return value;
}

export function assertThemeTokenReferences<T extends Record<string, unknown>>(
  references: T, path: string,
): T {
  for (const [key, value] of Object.entries(references)) {
    const valuePath = `${path}.${key}`;
    if (typeof value !== "string") {
      throw new ThemeTokenError("raw-layout-value", valuePath,
        `expected a semantic token name, received ${String(value)}`);
    }
    if (!TOKEN_NAMES.has(value)) {
      throw new ThemeTokenError("unknown-token", valuePath, `unknown theme token '${value}'`);
    }
  }
  return references;
}
