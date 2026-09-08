import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  console.log(`escape browser pid=${browser.process()?.pid}`);
  page = await browser.newPage();
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});
afterAll(async () => { await browser?.close(); harness.stop(); });

async function deliver(frames: readonly unknown[]) {
  const marker = `escape-${harness.sentSequence}`;
  const receipt = await page.evaluateHandle((marker) => {
    const node = document.getElementById("status-text");
    if (!node) throw new TypeError("status surface missing");
    return { done: new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("frame timeout")); }, 5000);
      const observer = new MutationObserver(() => {
        if (node.textContent !== marker) return;
        clearTimeout(timeout); observer.disconnect(); resolve();
      });
      observer.observe(node, { childList: true, characterData: true, subtree: true });
    }) };
  }, marker);
  for (const frame of frames) harness.pushMessage(frame);
  harness.pushMessage({ type: "status", text: marker });
  await receipt.evaluate((receipt) => receipt.done);
  await receipt.dispose();
}

test("scene markup sanitizes CSS attribute values before interpolation", async () => {
  await deliver([
    { type: "capture", mode: "mic", capturing: true, phase: "capturing" },
    { type: "slide", history: [], current: { title: "Hostile", index: 1, scene: {
      background: 'fff" onmouseover="alert(1)',
      elements: [{ type: "text", text: "<img src=x onerror=alert(1)>", role: 'body" autofocus onfocus="alert(1)',
        color: 'fff" onmouseover="alert(1)', x: 10, y: 10, w: 80, h: 10, fontSize: 20 }],
    } } },
  ]);
  expect(await page.$eval(".live-scene__text", (node) => ({
    injected: node.hasAttribute("autofocus") || node.hasAttribute("onfocus") || node.hasAttribute("onmouseover"),
    children: node.childElementCount, text: node.textContent, color: getComputedStyle(node).color,
  }))).toEqual({ injected: false, children: 0, text: "<img src=x onerror=alert(1)>", color: "rgb(0, 0, 0)" });
});

test("provider effort options escape their value attribute", async () => {
  const effort = 'high" onmouseover="alert(1)';
  await deliver([{ type: "providers", current: "cli:codex", currentEffort: effort, list: [{
    id: "cli:codex", label: "Fixture", available: true, auth: "connected", installed: true,
    models: ["fixture"], efforts: [effort],
  }] }]);
  await page.click("#btn-settings");
  await page.click(".provider-row__open");
  expect(await page.$eval("#select-effort", (node) => [...node.querySelectorAll("option")].map((option) => ({
    value: option.value, injected: option.hasAttribute("onmouseover"),
  })))).toEqual([{ value: "", injected: false }, { value: effort, injected: false }]);
});
