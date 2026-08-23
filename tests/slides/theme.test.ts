import { describe, expect, test } from "bun:test";

import { parseSlidePlan } from "../../src/slides/model/plan-parser.ts";
import {
  THEME_TOKEN_NAMES,
  ThemeTokenError,
  assertThemeTokenReferences,
  createDeckTheme,
  resolveDeckTheme,
  resolveThemeToken,
} from "../../src/slides/theme/theme.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import {
  cssCustomPropertyName,
  toCssCustomProperties,
  toPptxThemeTokens,
} from "../../src/slides/theme/css-tokens.ts";

const PRETENDARD_SHA256 = "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4";
const SNAPSHOT_SHA256 = "a".repeat(64);

const EXPECTED_MEETING_PAPER_THEME = {
  id: "meeting-paper-v1",
  canvas: { width: 1280, height: 720 },
  font: {
    family: "Pretendard Variable",
    localPath: "fonts/pretendard-variable.woff2",
    sha256: PRETENDARD_SHA256,
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
} as const;

const EXPECTED_TOKEN_NAMES = [
  "canvas.width",
  "canvas.height",
  "font.family",
  "font.localPath",
  "font.sha256",
  "colors.paper",
  "colors.raised",
  "colors.ink",
  "colors.muted",
  "colors.rule",
  "colors.coral",
  "colors.blue",
  "colors.focus",
  "spacing.xs",
  "spacing.sm",
  "spacing.md",
  "spacing.lg",
  "spacing.xl",
  "typography.display.size",
  "typography.display.lineHeight",
  "typography.display.weight",
  "typography.heading.size",
  "typography.heading.lineHeight",
  "typography.heading.weight",
  "typography.body.size",
  "typography.body.lineHeight",
  "typography.body.weight",
  "typography.label.size",
  "typography.label.lineHeight",
  "typography.label.weight",
  "stroke.thin",
  "stroke.strong",
  "radius.small",
  "radius.large",
] as const;

function expectDeeplyFrozen(value: unknown, path = "root"): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectDeeplyFrozen(child, `${path}.${key}`);
  }
}

function expectThemeError(
  operation: () => unknown,
  expected: { code: string; path: string; message: RegExp },
): void {
  try {
    operation();
    throw new Error("expected a ThemeTokenError");
  } catch (error) {
    expect(error).toBeInstanceOf(ThemeTokenError);
    const typed = error as ThemeTokenError;
    expect(typed.code).toBe(expected.code);
    expect(typed.path).toBe(expected.path);
    expect(typed.message).toMatch(expected.message);
  }
}

function cssValue(token: string, value: string | number): string {
  if (token.startsWith("colors.")) return `#${value}`;
  if (token.endsWith(".weight")) return String(value);
  if (token === "font.family") return `"${value}"`;
  if (token === "font.localPath") return `url("${value}")`;
  if (token === "font.sha256") return String(value);
  return `${value}px`;
}

function planWithTheme(theme: typeof EXPECTED_MEETING_PAPER_THEME): unknown {
  return {
    schemaVersion: 1,
    planId: "plan-theme-round-trip",
    revision: 0,
    snapshot: {
      meetingId: 42,
      transcriptVersionId: "transcript-theme-v1",
      contentSha256: SNAPSHOT_SHA256,
      lineCount: 1,
    },
    title: "Theme round trip",
    theme,
    claims: [{
      id: "claim-theme",
      kind: "fact",
      text: "The deck uses the meeting paper theme.",
      sources: [{
        transcriptVersionId: "transcript-theme-v1",
        startSeq: 1,
        endSeq: 1,
        evidenceQuote: "The deck uses the meeting paper theme.",
      }],
      method: "extractive",
    }],
    assets: [],
    slides: [{
      id: "slide-theme",
      layout: "hero",
      storyRole: "opening",
      title: "One visual source",
      payload: { variant: "cover", statement: "The deck uses the meeting paper theme." },
      bindings: { title: ["claim-theme"], statement: ["claim-theme"] },
      editorialPaths: [],
      assetIds: [],
    }],
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:00:00.000Z",
  };
}

describe("per-deck semantic theme generation", () => {
  test("an explicit style profile deterministically resolves the complete meeting-paper theme", () => {
    const first = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);
    const second = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

    expect(first).toEqual(EXPECTED_MEETING_PAPER_THEME);
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(first.canvas).toEqual({ width: 1280, height: 720 });
    expect(first.font).toEqual({
      family: "Pretendard Variable",
      localPath: "fonts/pretendard-variable.woff2",
      sha256: PRETENDARD_SHA256,
    });
    expectDeeplyFrozen(first);
    expectDeeplyFrozen(second);
  });

  test("all semantic color, spacing, typography, stroke, and radius values are declared", () => {
    const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

    expect(theme.colors).toEqual(EXPECTED_MEETING_PAPER_THEME.colors);
    expect(theme.spacing).toEqual(EXPECTED_MEETING_PAPER_THEME.spacing);
    expect(theme.typography).toEqual(EXPECTED_MEETING_PAPER_THEME.typography);
    expect(theme.stroke).toEqual(EXPECTED_MEETING_PAPER_THEME.stroke);
    expect(theme.radius).toEqual(EXPECTED_MEETING_PAPER_THEME.radius);
    expect(THEME_TOKEN_NAMES).toEqual(EXPECTED_TOKEN_NAMES);
    expect(new Set(THEME_TOKEN_NAMES).size).toBe(THEME_TOKEN_NAMES.length);
  });

  test("validated overrides are deterministic, isolated, and do not mutate the profile", () => {
    const overrides = {
      colors: { coral: "B84E36" },
      spacing: { sm: 18 },
      typography: { body: { weight: 450 } },
    } as const;
    const before = structuredClone(MEETING_PAPER_STYLE_PROFILE);
    const first = createDeckTheme(MEETING_PAPER_STYLE_PROFILE, overrides);
    const second = createDeckTheme(MEETING_PAPER_STYLE_PROFILE, structuredClone(overrides));

    expect(first).toEqual(second);
    expect(first).toEqual({
      ...EXPECTED_MEETING_PAPER_THEME,
      colors: { ...EXPECTED_MEETING_PAPER_THEME.colors, coral: "B84E36" },
      spacing: { ...EXPECTED_MEETING_PAPER_THEME.spacing, sm: 18 },
      typography: {
        ...EXPECTED_MEETING_PAPER_THEME.typography,
        body: { ...EXPECTED_MEETING_PAPER_THEME.typography.body, weight: 450 },
      },
    });
    expect(MEETING_PAPER_STYLE_PROFILE).toEqual(before);
    expectDeeplyFrozen(first);
  });
});

describe("theme token references and target lowering", () => {
  test("layout styling accepts declared semantic names and rejects raw layout values", () => {
    const references = {
      padding: "spacing.xl",
      gap: "spacing.md",
      background: "colors.paper",
      foreground: "colors.ink",
      accent: "colors.coral",
      headingSize: "typography.heading.size",
      headingLineHeight: "typography.heading.lineHeight",
      headingWeight: "typography.heading.weight",
      borderColor: "colors.rule",
      borderWidth: "stroke.thin",
      cornerRadius: "radius.large",
    } as const;

    expect(assertThemeTokenReferences(references, "layouts.summary.tokens")).toEqual(references);

    expectThemeError(
      () => assertThemeTokenReferences({ ...references, padding: 80 }, "layouts.summary.tokens"),
      {
        code: "raw-layout-value",
        path: "layouts.summary.tokens.padding",
        message: /layouts\.summary\.tokens\.padding.*token name.*80/i,
      },
    );
    expectThemeError(
      () => assertThemeTokenReferences({ ...references, gap: "spacing.huge" }, "layouts.summary.tokens"),
      {
        code: "unknown-token",
        path: "layouts.summary.tokens.gap",
        message: /layouts\.summary\.tokens\.gap.*spacing\.huge/i,
      },
    );
  });

  test("CSS custom properties and PPTX tokens lower every value from the same theme source", () => {
    const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);
    const css = toCssCustomProperties(theme);
    const pptx = toPptxThemeTokens(theme);

    expect(Object.keys(css)).toHaveLength(THEME_TOKEN_NAMES.length);
    expect(Object.keys(pptx)).toHaveLength(THEME_TOKEN_NAMES.length);
    for (const token of THEME_TOKEN_NAMES) {
      const source = resolveThemeToken(theme, token);
      expect(pptx[token], `PPTX ${token}`).toBe(source);
      expect(css[cssCustomPropertyName(token)], `CSS ${token}`).toBe(cssValue(token, source));
    }
    expectDeeplyFrozen(css);
    expectDeeplyFrozen(pptx);
  });
});

describe("theme contract failures", () => {
  test("unknown profiles and tokens fail with typed, path-rich errors", () => {
    expectThemeError(
      () => resolveDeckTheme("newsprint-neon"),
      {
        code: "unknown-profile",
        path: "profile.id",
        message: /profile\.id.*newsprint-neon/i,
      },
    );

    const theme = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);
    expectThemeError(
      () => resolveThemeToken(theme, "colors.warning"),
      {
        code: "unknown-token",
        path: "token",
        message: /token.*colors\.warning/i,
      },
    );
  });

  test("malformed overrides identify the exact invalid path and never partially apply", () => {
    const baseline = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);

    expectThemeError(
      () => createDeckTheme(MEETING_PAPER_STYLE_PROFILE, { colors: { coral: "tomato" } }),
      {
        code: "invalid-override",
        path: "overrides.colors.coral",
        message: /overrides\.colors\.coral.*six-digit hexadecimal/i,
      },
    );
    expectThemeError(
      () => createDeckTheme(MEETING_PAPER_STYLE_PROFILE, { spacing: { gutter: 32 } }),
      {
        code: "invalid-override",
        path: "overrides.spacing.gutter",
        message: /overrides\.spacing\.gutter.*not allowed/i,
      },
    );
    expectThemeError(
      () => createDeckTheme(MEETING_PAPER_STYLE_PROFILE, { typography: { body: { lineHeight: 0 } } }),
      {
        code: "invalid-override",
        path: "overrides.typography.body.lineHeight",
        message: /overrides\.typography\.body\.lineHeight.*positive/i,
      },
    );
    expectThemeError(
      () => createDeckTheme(MEETING_PAPER_STYLE_PROFILE, { canvas: { width: 1920 } }),
      {
        code: "invalid-override",
        path: "overrides.canvas",
        message: /overrides\.canvas.*fixed.*1280.*720/i,
      },
    );
    expect(createDeckTheme(MEETING_PAPER_STYLE_PROFILE)).toEqual(baseline);
  });
});

describe("SlidePlan integration", () => {
  test("a generated theme round-trips through parseSlidePlan without value or immutability drift", () => {
    const generated = createDeckTheme(MEETING_PAPER_STYLE_PROFILE);
    const parsed = parseSlidePlan(JSON.stringify(planWithTheme(generated)));

    expect(parsed.theme).toEqual(generated);
    expect(parsed.theme).not.toBe(generated);
    expectDeeplyFrozen(parsed.theme);
  });
});
