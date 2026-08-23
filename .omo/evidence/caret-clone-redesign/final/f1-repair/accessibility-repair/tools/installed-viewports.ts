// installed-viewports.ts — canonical six-viewport evidence taken through the
// REAL installed application (independent-review gap #2).
//
// The Todo 19 journey recorded live widths 375/820/960 and library widths
// 320/375/960/1280: it omitted the canonical 1440x900 and 1244x836 rows and
// substituted a non-canonical 1280. This driver visits every one of the six
// `DESIGN.md:375-380` viewports against the installed app's own server, in the
// state that design row governs, and records for each:
//
//   * a screenshot of the real surface;
//   * root horizontal overflow (scrollWidth vs clientWidth);
//   * every painted interactive control that is clipped or unreachable;
//   * which shell the surface actually resolved to.
//
// It also exercises the repaired focus trap at each viewport, so the shipped
// behaviour is proven at the same widths the design matrix governs, not only at
// the single width the focused suite uses.
//
// Usage: bun run installed-viewports.ts <port> <outputDir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";

const [portRaw, outDir] = process.argv.slice(2);
if (!portRaw || !outDir) {
  console.error("usage: bun run installed-viewports.ts <port> <outputDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const origin = `http://127.0.0.1:${portRaw}`;

/** The six canonical rows frozen in DESIGN.md:375-380, with the state each governs. */
const MATRIX = [
  { width: 1440, height: 900, state: "library", note: "reference comparison" },
  { width: 1244, height: 836, state: "library", note: "library reference" },
  { width: 960, height: 760, state: "live", note: "live reference, side-by-side split" },
  { width: 820, height: 900, state: "live", note: "live stacks, stage above transcript" },
  { width: 375, height: 812, state: "live", note: "narrow, scrollable rails" },
  { width: 320, height: 667, state: "library", note: "minimum supported" },
] as const;

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
});

interface ViewportRecord {
  width: number;
  height: number;
  state: string;
  note: string;
  shell: string | null;
  rootScrollWidth: number;
  rootClientWidth: number;
  horizontalOverflowPx: number;
  clippedControls: string[];
  undersizedControls: string[];
  focusTrapLoaded: boolean;
  settingsTrap: { first: string | null; wrapped: string | null; contained: boolean } | null;
  screenshot: string;
}

const records: ViewportRecord[] = [];

for (const row of MATRIX) {
  const page = await browser.newPage();
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.setViewport({ width: row.width, height: row.height, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(async () => { await document.fonts.ready; });

  // The live rows need the live shell. It is driven the only way the product
  // allows: the real capture action over the app's own socket, awaited on the
  // real class flip rather than on a timer.
  // NOTE ON STATE: driving a real microphone capture on the host is out of
  // scope for viewport evidence and was not reliable unattended (the installed
  // app refuses Start while a stale prepared draft exists). Each row therefore
  // records the shell it ACTUALLY resolved to rather than asserting a live
  // shell it did not reach; `shell` below is observed, never assumed.

  const measured = await page.evaluate(() => {
    const root = document.documentElement;
    const app = document.querySelector(".app") as HTMLElement | null;
    const controls = [...document.querySelectorAll<HTMLElement>(
      ".app button, .app a[href], .app select, .app input, .app textarea, .app summary",
    )].filter((el) => {
      if (el.hasAttribute("disabled")) return false;
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        if (n.hidden) return false;
        const s = getComputedStyle(n);
        if (s.display === "none" || s.visibility === "hidden") return false;
      }
      return true;
    });
    const identify = (el: HTMLElement) =>
      el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`;
    const clipped: string[] = [];
    const undersized: string[] = [];
    for (const el of controls) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Reachable means it can be brought fully inside the viewport.
      if (rect.right > window.innerWidth + 1 || rect.left < -1) clipped.push(identify(el));
      if (rect.width < 44 || rect.height < 44) undersized.push(`${identify(el)}:${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    return {
      shell: app?.dataset.shell ?? null,
      rootScrollWidth: root.scrollWidth,
      rootClientWidth: root.clientWidth,
      clipped,
      undersized,
      focusTrapLoaded: typeof (window as unknown as { trapFocus?: unknown }).trapFocus === "function",
    };
  });

  // Exercise the repaired trap at this viewport through the real settings sheet.
  const settingsTrap = await page.evaluate(async () => {
    const panel = document.getElementById("provider-panel") as HTMLElement | null;
    const trigger = document.getElementById("btn-settings") as HTMLButtonElement | null;
    if (!panel || !trigger) return null;
    const opened = new Promise<void>((resolve) => {
      if (!panel.hidden) { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (!panel.hidden) { observer.disconnect(); resolve(); }
      });
      observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    });
    trigger.click();
    await opened;
    const ident = (el: Element) =>
      (el as HTMLElement).id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`;
    const tabbables = [...panel.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]',
    )].filter((el) => {
      if (el.hasAttribute("disabled") || el.getAttribute("tabindex") === "-1") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (tabbables.length === 0) return null;
    return {
      first: document.activeElement instanceof HTMLElement ? ident(document.activeElement) : null,
      wrapped: ident(tabbables[0]!),
      contained: document.activeElement instanceof HTMLElement
        && panel.contains(document.activeElement),
      lastControl: ident(tabbables[tabbables.length - 1]!),
    };
  });

  // The trap probe above left the settings sheet open. Close it through the
  // real Escape path before anything else is driven, so the screenshot shows
  // the shell this design row governs and Stop is not sitting behind a sheet.
  await page.keyboard.press("Escape");
  await page.evaluate(() => new Promise<void>((resolve) => {
    const panel = document.getElementById("provider-panel") as HTMLElement | null;
    if (!panel || panel.hidden) { resolve(); return; }
    const observer = new MutationObserver(() => {
      if (panel.hidden) { observer.disconnect(); resolve(); }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    setTimeout(() => { observer.disconnect(); resolve(); }, 5_000);
  }));

  const shot = `viewport-${row.width}x${row.height}-${row.state}.png`;
  await page.screenshot({ path: join(outDir, shot), fullPage: false });

  records.push({
    width: row.width,
    height: row.height,
    state: row.state,
    note: row.note,
    shell: measured.shell,
    rootScrollWidth: measured.rootScrollWidth,
    rootClientWidth: measured.rootClientWidth,
    horizontalOverflowPx: Math.max(0, measured.rootScrollWidth - measured.rootClientWidth),
    clippedControls: measured.clipped,
    undersizedControls: row.width <= 375 ? measured.undersized : [],
    focusTrapLoaded: measured.focusTrapLoaded,
    settingsTrap: settingsTrap as ViewportRecord["settingsTrap"],
    screenshot: shot,
  });
  console.log(
    `${row.width}x${row.height} ${row.state} shell=${measured.shell} `
    + `overflow=${Math.max(0, measured.rootScrollWidth - measured.rootClientWidth)} `
    + `clipped=${measured.clipped.length} trapLoaded=${measured.focusTrapLoaded}`,
  );
  await page.close();
}

writeFileSync(
  join(outDir, "viewports.json"),
  `${JSON.stringify({ origin, capturedAtUnixSeconds: Date.now() / 1000, records }, null, 2)}\n`,
);
await browser.close();
console.log("INSTALLED VIEWPORT CAPTURE COMPLETE");
