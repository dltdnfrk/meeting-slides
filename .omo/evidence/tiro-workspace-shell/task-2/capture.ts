// todo 2 증거 캡처: 기본 → 드래그 → 새로고침 복원 스크린샷 + 측정값.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import puppeteer from "puppeteer";

import { createPublicTestHarness } from "../../../../tests/public-test-harness.ts";

const outDir = join(import.meta.dir);
await mkdir(outDir, { recursive: true });

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(harness.origin, { waitUntil: "load" });
await harness.clientConnected;

const widths = () =>
  page.evaluate(() => {
    const w = (sel: string) => Math.round(document.querySelector(sel)!.getBoundingClientRect().width);
    return {
      rail: w(".session-rail"),
      stage: w(".stage-pane"),
      transcript: w(".transcript-pane"),
      stored: localStorage.getItem("workspace.layout.v1"),
    };
  });

const settle = () =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const drag = async (selector: string, dx: number) => {
  const box = await page.evaluate((sel) => {
    const rect = document.querySelector(sel)!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + dx / 2, box.y);
  await page.mouse.move(box.x + dx, box.y);
  await page.mouse.up();
  await settle();
};

const log: string[] = [];
const record = async (label: string, file: string) => {
  const measured = await widths();
  log.push(`${label}: ${JSON.stringify(measured)}`);
  await page.screenshot({ path: join(outDir, file) });
};

await record("default", "splitters-default.png");
await drag("#splitter-rail", 120);
await drag("#splitter-transcript", -120);
await record("after-drag", "splitters-dragged.png");

await page.reload({ waitUntil: "load" });
await settle();
await record("after-reload", "splitters-restored.png");

await drag("#splitter-rail", -600);
await drag("#splitter-transcript", 600);
await record("min-clamped", "splitters-min-clamped.png");

await writeFile(join(outDir, "measurements.txt"), `${log.join("\n")}\n`, "utf-8");
console.log(log.join("\n"));

await browser.close();
harness.stop();
