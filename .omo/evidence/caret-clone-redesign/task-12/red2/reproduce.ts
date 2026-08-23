// Reproduce the verifier's rejection: are the 9 library dock capabilities
// actually reachable (hit-test + focusable) at the three wide widths?
//
// Deterministic: frozen clock, ko-KR/Asia/Seoul, DPR 1, off-origin refused,
// every awaited state subscribed to before its trigger. No sleeps.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";

import { createPublicTestHarness } from "../../../../../tests/public-test-harness.ts";

const FIXED = 1_710_376_860_000;
const WIDTHS_UNUSED = [];
const WIDTHS = [
  { name: "reference", width: 1440, height: 900 },
  { name: "library", width: 1244, height: 836 },
  { name: "seam1100", width: 1100, height: 800 },
] as const;

/** The nine real dock capabilities Todo 13 will later re-home. */
const DOCK_IDS = [
  "btn-compile-deck", "btn-export-md", "btn-export-json", "btn-export-transcript",
  "btn-export-deck", "btn-export-pdf", "btn-export-png", "btn-ask", "btn-reset",
] as const;

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
});

const report: Record<string, unknown> = {};

for (const vp of WIDTHS) {
  const page = await browser.newPage();
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument((now: number) => {
    const O = Date;
    class F extends O {
      constructor(...a: unknown[]) {
        if (a.length === 0) super(now); else super(...(a as ConstructorParameters<typeof Date>));
      }
      static override now() { return now; }
    }
    (globalThis as unknown as { Date: DateConstructor }).Date = F as unknown as DateConstructor;
  }, FIXED);
  await page.setViewport({ ...vp, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith(harness.origin) || u.startsWith("data:")) return void r.continue();
    if (r.resourceType() === "stylesheet") {
      return void r.respond({ status: 200, contentType: "text/css", body: ":root{}" });
    }
    void r.abort();
  });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => { await document.fonts.ready; });

  // Library shell, meeting selected: the state in which the dock is the action set.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const app = document.querySelector(".app") as HTMLElement;
    if (app.dataset.capturePhase === "idle") return resolve();
    const o = new MutationObserver(() => {
      if (app.dataset.capturePhase === "idle") { o.disconnect(); resolve(); }
    });
    o.observe(app, { attributes: true, attributeFilter: ["data-capture-phase"] });
  }));
  harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
  await page.waitForFunction(() =>
    (document.querySelector(".app") as HTMLElement).dataset.shell === "library");

  // Open the disclosure the way a user does, then measure.
  await page.evaluate(() => {
    const d = document.getElementById("dock-more") as HTMLDetailsElement | null;
    if (d && !d.open) (document.querySelector(".dock__more-summary") as HTMLElement).click();
  });

  const result = await page.evaluate((ids: readonly string[]) => {
    const vh = document.documentElement.clientHeight;
    const vw = document.documentElement.clientWidth;
    const details = document.getElementById("dock-more") as HTMLDetailsElement | null;
    const summary = document.querySelector(".dock__more-summary") as HTMLElement | null;

    const dockEl = document.querySelector(".dock") as HTMLElement;
    const probe = (id: string) => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (!el) return { id, present: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rr = el.getBoundingClientRect();
      const painted = rr.width > 0 && rr.height > 0;
      // Hit-test at the control's own centre: what does the user actually click?
      const cx = rr.left + rr.width / 2;
      const cy = rr.top + rr.height / 2;
      const hit = painted ? document.elementFromPoint(cx, cy) : null;
      return {
        id, present: true, painted,
        display: cs.display, visibility: cs.visibility,
        contentVisibility: (cs as unknown as { contentVisibility?: string }).contentVisibility ?? "",
        x: Math.round(rr.x), y: Math.round(rr.y),
        w: Math.round(rr.width), h: Math.round(rr.height),
        // Below an unscrollable fold?
        belowFold: rr.top >= vh && !(dockEl.scrollHeight > dockEl.clientHeight),
        offscreenRight: rr.right > vw + 1,
        hitIsSelf: hit !== null && (hit === el || el.contains(hit)),
      };
    };

    return {
      docScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      viewport: { vw, vh },
      detailsPresent: details !== null,
      detailsOpen: details?.open ?? null,
      detailsDisplay: details ? getComputedStyle(details).display : null,
      summaryPresent: summary !== null,
      summaryDisplay: summary ? getComputedStyle(summary).display : null,
      summaryPainted: summary
        ? summary.getBoundingClientRect().width > 0 && summary.getBoundingClientRect().height > 0
        : false,
      controls: ids.map(probe),
    };
  }, DOCK_IDS);

  const unreachable = (result.controls as Array<{ id: string; painted?: boolean; hitIsSelf?: boolean }>)
    .filter((c) => !c.painted || !c.hitIsSelf).map((c) => c.id);
  const belowFold = (result.controls as Array<{ id: string; belowFold?: boolean }>)
    .filter((c) => c.belowFold).map((c) => c.id);

  report[vp.name] = { ...result, unreachable, belowFold };
  console.log(
    `${vp.width}x${vp.height}  summaryPainted=${result.summaryPainted}  detailsDisplay=${result.detailsDisplay}  ` +
    `unreachable=${unreachable.length}/9 ${JSON.stringify(unreachable)}  belowFold=${belowFold.length}/9`,
  );
  await page.close();
}

await writeFile(join(import.meta.dir, "reachability.json"), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
harness.stop();
