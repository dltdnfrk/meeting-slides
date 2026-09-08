import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const style = (await readFile(join(import.meta.dir, "..", "public", "style.css"), "utf8"))
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/\s+/gu, " ");

const CHROMATIC = /var\(--(?:live|warn|err|ok)(?:-|\))|#(?:60a5fa|e85d4c|d4a017)|rgba?\(\s*(?:96\s*,\s*165\s*,\s*250|232\s*,\s*93\s*,\s*76|212\s*,\s*160\s*,\s*23)/iu;

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = style.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`, "u"));
  if (match?.[1] === undefined) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
}

test.each([
  ".review-panel__notice",
  ".review-loading__ring",
  ".review-item--decision",
  ".review-item--action_item",
  ".review-item--open_item",
  ".review-item--dropped",
  ".review-item--decision .review-item__kind",
  ".review-item--action_item .review-item__kind",
  ".review-item--open_item .review-item__kind",
  ".review-item__editor",
  ".review-item__edit:hover:not(:disabled), .review-item__save:hover",
  ".review-item--dropped .review-item__drop",
  ".review-panel__retry:hover",
  ".review-panel__confirm",
  ".review-panel__confirm:hover:not(:disabled)",
  ".review-panel__confirm-count",
  ".review-btn[aria-expanded=\"true\"]",
  ".review-btn[aria-expanded=\"true\"] .review-btn__icon",
  ".review-btn__count",
])("uses only neutral color tokens for %s", (selector) => {
  expect(ruleBody(selector)).not.toMatch(CHROMATIC);
});

test("uses the neutral focus token rather than the recording color", () => {
  expect(ruleBody(":focus-visible")).toContain("var(--focus-ring)");
  expect(ruleBody(":focus-visible")).not.toMatch(CHROMATIC);
});
