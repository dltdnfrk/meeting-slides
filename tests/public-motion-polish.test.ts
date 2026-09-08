import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  console.log(`motion browser pid=${browser.process()?.pid}`);
  page = await browser.newPage();
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});
afterAll(async () => { await browser?.close(); harness.stop(); });

async function deliver(frames: readonly unknown[]) {
  const marker = `motion-${harness.sentSequence}`;
  const receipt = await page.evaluateHandle((marker) => ({ done: new Promise<void>((resolve, reject) => {
    const node = document.getElementById("status-text");
    if (!node) throw new TypeError("status surface missing");
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("frame timeout")); }, 5000);
    const observer = new MutationObserver(() => {
      if (node.textContent !== marker) return;
      clearTimeout(timeout); observer.disconnect(); resolve();
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
  }) }), marker);
  for (const frame of frames) harness.pushMessage(frame);
  harness.pushMessage({ type: "status", text: marker });
  await receipt.evaluate((receipt) => receipt.done);
  await receipt.dispose();
}

test("navigation exposes loading and status feedback uses compositor-safe animation", async () => {
  await deliver([{ type: "capture", capturing: false, mode: "mic", phase: "idle" }, {
    type: "meetings", items: [{ id: 7, title: "Fixture", started_at: 1000, status: "ended" }],
  }]);
  const selected = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="7"]');
  expect(await selected).toEqual({ action: "selectMeeting", meetingId: 7 });
  expect(await page.$eval("#document-surface", (node) => node.getAttribute("aria-busy"))).toBe("true");
  const motion = await page.$eval("#status-text", (node) => node.getAnimations().map((animation) => {
    const effect = animation.effect;
    return effect instanceof KeyframeEffect ? {
      duration: effect.getTiming().duration,
      fields: [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))],
    } : null;
  }));
  expect(motion.length).toBeGreaterThan(0);
  for (const effect of motion) {
    expect(effect?.duration).toBeGreaterThan(0);
    expect(effect?.duration).toBeLessThanOrEqual(250);
    expect(effect?.fields.filter((field) => !["opacity", "transform", "offset", "computedOffset", "easing", "composite"].includes(field))).toEqual([]);
  }
  await deliver([{ type: "meeting", meetingId: 7, title: "Fixture", current: null, history: [], transcript: [] }]);
  expect(await page.$eval("#document-surface", (node) => node.hasAttribute("aria-busy"))).toBe(false);
});

test("reduced motion disables nonessential shell animation", async () => {
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await deliver([]);
  const durations = await page.$eval("#status-text", (node) =>
    getComputedStyle(node).animationDuration.split(",").map((value) => parseFloat(value)));
  expect(durations.every((seconds) => seconds <= 0.001)).toBe(true);
});

test("all four dialog controls close on Escape and restore their trigger focus", async () => {
  await deliver([{ type: "review", meetingId: 7, reviewId: "motion-review", transcriptVersionId: "motion-version",
    status: "draft", items: [], attendees: [], transcript: { lines: [] } }]);
  for (const [trigger, panel] of [["btn-settings", "provider-panel"], ["btn-attendees", "attendee-panel"],
    ["btn-ask", "ask-panel"], ["btn-review", "review-panel"]]) {
    if (!trigger || !panel) throw new TypeError("dialog fixture incomplete");
    await page.$eval(`#${trigger}`, (node) => { if (node instanceof HTMLButtonElement) node.click(); });
    expect(await page.$eval(`#${panel}`, (node) => node.hasAttribute("hidden"))).toBe(false);
    const receipt = await page.evaluateHandle(({ panel, trigger }) => ({ done: new Promise<void>((resolve, reject) => {
      const root = document.getElementById(panel);
      if (!root) throw new TypeError("dialog missing");
      const finish = () => {
        if (!root.hidden || document.activeElement?.id !== trigger) return;
        clearTimeout(timeout); observer.disconnect(); document.removeEventListener("focusin", finish); resolve();
      };
      const timeout = setTimeout(() => {
        observer.disconnect(); document.removeEventListener("focusin", finish); reject(new Error(`dialog close timeout: ${panel}`));
      }, 5000);
      const observer = new MutationObserver(finish);
      observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });
      document.addEventListener("focusin", finish);
    }) }), { panel, trigger });
    await page.keyboard.press("Escape");
    await receipt.evaluate((receipt) => receipt.done);
    await receipt.dispose();
  }
});
