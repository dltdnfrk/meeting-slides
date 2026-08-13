import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const css = readFileSync(join(import.meta.dir, "..", "public", "caret-operator.css"), "utf8");
const app = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");

test("interaction polish covers navigation, content, controls and status with compositor-safe motion", () => {
  for (const selector of [".session-row", ".detail-tabs__btn", ".detail-panel:not([hidden])", "#current-slide > .slide__inner", ".thumbnail", ".dock__btn", ".feed-line", "#status-text[data-motion-key]"]) {
    expect(css).toContain(selector);
  }
  expect(css).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
  expect(css).not.toMatch(/@keyframes cf-[^{]+\{[^}]*(?:width|height|top|left|margin|padding):/s);
  expect(app).toContain("statusTextEl.dataset.motionKey");
  expect(app).toContain('documentSurfaceEl.setAttribute("aria-busy", "true")');
});

test("motion remains brief and has a complete reduced-motion token override", () => {
  expect(css).toContain("--cf-motion-quick: 160ms");
  expect(css).toContain("--cf-motion-state: 200ms");
  expect(css).toContain("--cf-motion-enter: 200ms");
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reduced).toContain("--cf-motion-quick: 0ms");
  expect(reduced).toContain("--cf-motion-state: 0ms");
  expect(reduced).toContain("--cf-motion-enter: 0ms");
});

test("all four shipped dialogs share a symmetric open and close transition helper", () => {
  const focus = readFileSync(join(import.meta.dir, "..", "public", "focus-trap.js"), "utf8");
  const review = readFileSync(join(import.meta.dir, "..", "public", "review-panel.js"), "utf8");
  expect(focus).toContain("function openDialog(root)");
  expect(focus).toContain("function closeDialog(root, onClosed)");
  expect(focus).toContain('root.dataset.motionState = "closing"');
  for (const panel of ["providerPanelEl", "attendeePanelEl", "askPanelEl"]) {
    expect(app).toContain(`window.closeDialog(${panel}`);
  }
  expect(review).toContain("window.closeDialog(panelEl");
  expect(css).toContain('[data-motion-state="closing"]');
});
