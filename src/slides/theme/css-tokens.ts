import type { Theme } from "../model/plan.ts";
import { deepFreeze } from "./immutable.ts";
import {
  THEME_TOKEN_NAMES,
  resolveThemeToken,
  type ThemeTokenName,
  type ThemeTokenValue,
} from "./theme.ts";

export function cssCustomPropertyName(token: ThemeTokenName | string): string {
  return `--theme-${token.replaceAll(".", "-")}`;
}

function cssValue(token: ThemeTokenName, value: ThemeTokenValue): string {
  if (token.startsWith("colors.")) return `#${value}`;
  if (token.endsWith(".weight") || token === "font.sha256") return `${value}`;
  if (token === "font.family") return `"${value}"`;
  if (token === "font.localPath") return `url("${value}")`;
  return `${value}px`;
}

export function toCssCustomProperties(theme: Theme): Readonly<Record<string, string>> {
  const properties: Record<string, string> = {};
  for (const token of THEME_TOKEN_NAMES) {
    properties[cssCustomPropertyName(token)] = cssValue(token, resolveThemeToken(theme, token));
  }
  return deepFreeze(properties);
}

export function toPptxThemeTokens(
  theme: Theme,
): Readonly<Record<ThemeTokenName, ThemeTokenValue>> {
  const tokens: Partial<Record<ThemeTokenName, ThemeTokenValue>> = {};
  for (const token of THEME_TOKEN_NAMES) tokens[token] = resolveThemeToken(theme, token);
  return deepFreeze(tokens) as Readonly<Record<ThemeTokenName, ThemeTokenValue>>;
}
