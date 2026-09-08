import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const html = read("public/index.html");

const stylesheetHrefs = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)]
  .map((match) => match[1]);
const scriptSources = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)]
  .map((match) => match[1]);

interface CssPrelude {
  text: string;
}

/** Reads only selector-bearing rule preludes. Declaration bodies are opaque. */
function cssRulePreludes(source: string): CssPrelude[] {
  const preludes: CssPrelude[] = [];

  const matchingBrace = (start: number, end: number): number => {
    let depth = 1;
    let quote = "";
    for (let i = start + 1; i < end; i += 1) {
      const char = source[i]!;
      if (quote) {
        if (char === "\\") i += 1;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === "/" && source[i + 1] === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? end : close + 1;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced CSS block");
  };

  const masked = (text: string): string => {
    let result = "";
    let quote = "";
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      if (quote) {
        result += " ";
        if (char === "\\" && i + 1 < text.length) { result += " "; i += 1; }
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") { quote = char; result += " "; continue; }
      if (char === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        const stop = close === -1 ? text.length : close + 2;
        result += " ".repeat(stop - i);
        i = stop - 1;
        continue;
      }
      result += char;
    }
    return result;
  };

  const walk = (from: number, to: number) => {
    let start = from;
    for (let i = from; i < to; i += 1) {
      if (source[i] === "/" && source[i + 1] === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? to : close + 1;
        continue;
      }
      if (source[i] === '"' || source[i] === "'") {
        const quote = source[i]!;
        for (i += 1; i < to; i += 1) {
          if (source[i] === "\\") i += 1;
          else if (source[i] === quote) break;
        }
        continue;
      }
      if (source[i] === ";") { start = i + 1; continue; }
      if (source[i] !== "{") continue;
      const prelude = source.slice(start, i).trim();
      const normalized = masked(prelude).trim();
      const close = matchingBrace(i, to);
      if (/^@scope\b/i.test(normalized)) {
        preludes.push({ text: prelude });
        walk(i + 1, close);
      } else if (/^@(media|supports|container|layer)\b/i.test(normalized)) {
        walk(i + 1, close);
      } else if (!normalized.startsWith("@")) {
        preludes.push({ text: prelude });
      }
      i = close;
      start = close + 1;
    }
  };

  walk(0, source.length);
  return preludes;
}

/**
 * Lexes class identifiers from a selector prelude. Comments and quoted strings
 * are masked as separators; CSS simple and hexadecimal escapes are decoded.
 */
function selectorClassTokens(prelude: string): string[] {
  let masked = "";
  let quote = "";
  for (let i = 0; i < prelude.length; i += 1) {
    const char = prelude[i]!;
    if (quote) {
      masked += " ";
      if (char === "\\" && i + 1 < prelude.length) { masked += " "; i += 1; }
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; masked += " "; continue; }
    if (prelude.slice(i, i + 4).toLowerCase() === "url(") {
      let depth = 1;
      let urlQuote = "";
      let cursor = i + 4;
      for (; cursor < prelude.length && depth > 0; cursor += 1) {
        const urlChar = prelude[cursor]!;
        if (urlQuote) {
          if (urlChar === "\\") cursor += 1;
          else if (urlChar === urlQuote) urlQuote = "";
        } else if (urlChar === '"' || urlChar === "'") urlQuote = urlChar;
        else if (urlChar === "(") depth += 1;
        else if (urlChar === ")") depth -= 1;
      }
      masked += " ".repeat(cursor - i);
      i = cursor - 1;
      continue;
    }
    if (char === "/" && prelude[i + 1] === "*") {
      const close = prelude.indexOf("*/", i + 2);
      const stop = close === -1 ? prelude.length : close + 2;
      masked += " ".repeat(stop - i);
      i = stop - 1;
      continue;
    }
    masked += char;
  }

  const tokens: string[] = [];
  const identifierChar = (char: string | undefined): boolean =>
    char !== undefined && /[A-Za-z0-9_-]|[^\u0000-\u007f]/.test(char);
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== ".") continue;
    let cursor = i + 1;
    let decoded = "";
    while (cursor < masked.length) {
      const char = masked[cursor]!;
      if (char === "\\") {
        const hex = masked.slice(cursor + 1).match(/^[0-9a-fA-F]{1,6}/)?.[0];
        if (hex) {
          const codePoint = Number.parseInt(hex, 16);
          decoded += codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
          cursor += 1 + hex.length;
          if (/\s/.test(masked[cursor] ?? "")) cursor += 1;
          continue;
        }
        const escaped = masked[cursor + 1];
        if (escaped === undefined || escaped === "\n" || escaped === "\r" || escaped === "\f") break;
        decoded += escaped;
        cursor += 2;
        continue;
      }
      if (!identifierChar(char)) break;
      decoded += char;
      cursor += 1;
    }
    if (decoded) tokens.push(decoded);
    i = Math.max(i, cursor - 1);
  }
  return tokens;
}

const OPERATOR_EXACT_ROOTS = new Set([
  "workspace", "document-surface", "session-rail", "transcript-pane",
  "meeting-chrome", "detail-tabs", "live-topbar", "stage-pane", "notes-panel",
  "meeting-overview", "operator-state", "shell-state", "capture-state",
  "connection-state", "stage-state", "workspace-grid",
]);
const OPERATOR_PREFIX_ROOTS = ["workspace--", "workspace-grid--", "splitter--"];
const operatorOwnedClass = (token: string): boolean =>
  OPERATOR_EXACT_ROOTS.has(token) || OPERATOR_PREFIX_ROOTS.some((root) => token.startsWith(root));
const generatedOwnedClass = (token: string): boolean =>
  token.startsWith("slide__inner--") || token.startsWith("review-panel");

const obsoleteFiles = [
  "public/workspace-shell.css",
  "public/operational-liquid.css",
  "public/caret-shell.css",
  "public/caret-foundation.css",
  "public/transcript-overlay.css",
  "public/transcript-overlay.js",
  "public/transcript-overlay 2.css",
  "public/transcript-overlay 2.js",
  "public/review-panel 2.js",
  "public/review-panel-render 2.js",
] as const;

describe("Todo 18 active shell convergence", () => {
  test("loads one generated-slide source and one operator source", () => {
    expect(stylesheetHrefs).toEqual(["/style.css", "/caret-operator.css"]);
    expect(scriptSources).toEqual([
      "/focus-trap.js",
      "/workspace-split.js",
      "/transcript-resize.js",
      "/review-panel-render.js",
      "/review-panel.js",
      "/app.js",
    ]);
    expect(new Set(stylesheetHrefs).size).toBe(stylesheetHrefs.length);
    expect(new Set(scriptSources).size).toBe(scriptSources.length);
  });

  test("deletes obsolete shell layers, duplicate artifacts, and browser overlay drivers", () => {
    expect(obsoleteFiles.filter((path) => existsSync(join(root, path)))).toEqual([]);
    for (const stale of [
      "workspace-shell.css", "operational-liquid.css", "caret-shell.css",
      "caret-foundation.css", "transcript-overlay",
    ]) {
      expect({ stale, active: html.includes(stale) }).toEqual({ stale, active: false });
    }
  });

  test("the generated-slide source contains no appended TIRO operator shell", () => {
    const slides = read("public/style.css");
    expect(slides).not.toMatch(/TIRO|Operational Liquid|caret-shell/i);
    expect(slides).toContain(".slide__inner--live");
    expect(slides).toContain(".review-panel");
  });

  test("selector lexer finds roots through functional pseudos, scope, commas, comments, and escapes", () => {
    const source = String.raw`
      @scope (:is(.session-rail, .safe)) {
        @layer ownership {
          @media (min-width: 1px) {
            :where(.workspace), .host:has(.workspace--resizing),
            :not(:is(.workspace-grid)), :nth-child(2n of .operator-state),
            .host/**/:is(/**/.document-surface/**/),
            .\77 orkspace, .slide__inner--\6c ive, .review\2d panel { color: red; }
          }
        }
      }
    `;
    const tokens = cssRulePreludes(source).flatMap((prelude) => selectorClassTokens(prelude.text));
    for (const expected of [
      "session-rail", "workspace", "workspace--resizing", "workspace-grid",
      "operator-state", "document-surface", "slide__inner--live", "review-panel",
    ]) expect(tokens).toContain(expected);
    expect(tokens.filter(operatorOwnedClass).length).toBeGreaterThanOrEqual(6);
    expect(tokens.filter(generatedOwnedClass).sort()).toEqual(["review-panel", "slide__inner--live"]);
  });

  test("selector lexer ignores declaration and quoted lookalikes", () => {
    const source = `
      .safe[data-copy=".workspace :is(.review-panel) { }"] {
        --selector-copy: ".workspace .slide__inner--live /* literal */ } {";
        background-image: url("data:image/svg+xml;utf8,<svg class='.review-panel'>{}</svg>");
        content: ".workspace-grid .slide__inner--cover";
      }
    `;
    const preludes = cssRulePreludes(source);
    expect(preludes).toHaveLength(1);
    expect(selectorClassTokens(preludes[0]!.text)).toEqual(["safe"]);
    expect(selectorClassTokens(':where(.safe, :not(url(data:text/plain,.workspace)))'))
      .toEqual(["safe"]);
  });

  test("four is() cross-owner forms normalize to forbidden selector roots", () => {
    const cases = [
      { selector: ":is(.workspace)", owner: operatorOwnedClass },
      { selector: ":is(.workspace--resizing, .safe)", owner: operatorOwnedClass },
      { selector: ":is(.slide__inner--live)", owner: generatedOwnedClass },
      { selector: ":is(.review-panel, .safe)", owner: generatedOwnedClass },
    ];
    for (const { selector, owner } of cases) {
      expect(selectorClassTokens(selector).filter(owner)).toHaveLength(1);
    }
  });

  test("linked stylesheets enforce exclusive selector-root ownership", () => {
    const generatedTokens = cssRulePreludes(read("public/style.css"))
      .flatMap((prelude) => selectorClassTokens(prelude.text));
    const operatorTokens = cssRulePreludes(read("public/caret-operator.css"))
      .flatMap((prelude) => selectorClassTokens(prelude.text));

    expect([...new Set(generatedTokens.filter(operatorOwnedClass))].sort()).toEqual([]);
    expect([...new Set(operatorTokens.filter(generatedOwnedClass))].sort()).toEqual([]);
    expect(generatedTokens).toContain("slide__inner--live");
    expect(generatedTokens).toContain("review-panel");
    expect(operatorTokens).toContain("workspace");
  });

  test("the operator source owns tokens, geometry, narrow failures, and global reduced motion", () => {
    const operator = read("public/caret-operator.css");
    expect(operator).toContain("--cf-target-min: 44px");
    expect(operator).toContain('@media (prefers-reduced-motion: reduce)');
    expect(operator).toMatch(/animation-duration:\s*0s\s*!important/);
    expect(operator).toMatch(/transition-duration:\s*0s\s*!important/);
    expect(operator).toContain('.app .topbar__status > #status-text');
    expect(operator).toContain('@media (max-width: 420px)');
    expect(operator).not.toMatch(/TIRO|Operational Liquid|shallow Caret/i);
    expect(operator).not.toMatch(/body\.caret-shell|\.caret-live/);
  });

  test("the document has one app, topbar, live header, dock, and status owner", () => {
    for (const selector of [
      'class="app"', 'class="topbar"', 'id="live-topbar"', 'class="dock"',
      'id="status-text" role="status"', 'id="transcript-stream" role="log"',
    ]) {
      expect({ selector, count: html.split(selector).length - 1 }).toEqual({ selector, count: 1 });
    }
  });
});

describe("Todo 18 documentation and bundle truth", () => {
  test("README documents the supported local-server Chrome and Aside product surface", () => {
    const readme = read("README.md");
    expect(readme).toContain("bun run dev");
    expect(readme).toContain("Google Chrome");
    expect(readme).toContain("Aside Browser");
    expect(readme).toContain("최소 1024×768");
    expect(readme).toContain("지원하지 않음: 모바일 브라우저, 모바일 앱, macOS 네이티브 앱");
    expect(readme).not.toContain("bash scripts/build-app.sh");
    expect(readme).not.toContain('open -a "Meeting Slides"');
    expect(readme).not.toContain("install-login-item.sh");
    expect(readme).not.toMatch(/private asset|private window|screen.?share.*(hide|hidden|exclude)|화면 공유.*(숨|제외)/i);
  });

  test("DESIGN records the measured privacy result without an exclusion claim", () => {
    const design = read("DESIGN.md");
    expect(design).toContain("single-window");
    expect(design).toContain("`.sharingType = .none`");
    expect(design).toMatch(/enumeration.*unsupported|unsupported.*enumeration/i);
    expect(design).toMatch(/full-display.*inconclusive|inconclusive.*full-display/i);
    expect(design).not.toMatch(/legacy and unhonored/i);
    expect(design).not.toMatch(/scheduled for removal/i);
  });

  test("bundle verification checks the current project asset graph", () => {
    const verifier = read("scripts/verify-app.sh");
    expect(verifier).toContain("public/index.html");
    expect(verifier).toContain("caret-operator.css");
    expect(verifier).toContain("operator-surface.js");
    expect(verifier).toContain("generated/module-manifest.json");
    expect(verifier).toContain("obsolete active shell reference");
  });
});
