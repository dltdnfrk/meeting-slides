// Current Meeting Slides baseline packet - characterization of the EXISTING rendered UI
// before any product change. Deterministic clock/locale/timezone, event-driven waits only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

import {
  BASELINE_VIEWPORTS,
  COMPUTED_PROBE,
  DETERMINISTIC,
  TASK_ROOT,
  isoNow,
  pngDimensions,
  prepareDeterministicPage,
  sha256File,
  writeJson,
} from "./capture-lib.mjs";
import { startHarness } from "./harness.mjs";
import {
  CAPTURE_STARTED_AT,
  FIXED_NOW,
  MEETINGS,
  PROVISIONAL_CAPTION,
  SLIDE,
  SLIDE_HISTORY,
  transcriptEntries,
} from "./baseline-fixture.mjs";

const REPO_ROOT = resolve(TASK_ROOT, "../../../..");
const PUBLIC_DIR = join(REPO_ROOT, "public");
const BASELINE_ROOT = join(TASK_ROOT, "baseline");
const SCREENS = join(BASELINE_ROOT, "screens");
const COMPUTED = join(BASELINE_ROOT, "computed");
const STATE_TIMEOUT = 15_000;

/** Runtime selectors of the CURRENT shell - measured, not aspirational. */
const BASELINE_SELECTORS = {
  root: ":root",
  body: "body",
  app: ".app",
  topbar: ".topbar",
  workspace: ".workspace",
  sessionRail: ".session-rail",
  stagePane: "#stage-pane",
  currentSlide: "#current-slide",
  transcriptPane: "#transcript-pane",
  transcriptStream: "#transcript-stream",
  recordButton: "#btn-record",
  dock: ".dock",
  detailTabs: ".detail-tabs",
};

/** Freezes Date/performance so the timer text is byte-stable across runs. */
const FREEZE_CLOCK = function freezeClock(fixedNow) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedNow);
      else super(...args);
    }
    static now() {
      return fixedNow;
    }
  }
  globalThis.Date = FrozenDate;
  globalThis.performance.now = () => 0;
};

/** Waits for an exact DOM predicate via MutationObserver - never a delay. */
function waitForDomState(page, predicateSource, stateName) {
  return page.evaluate(
    (source, name, timeout) => {
      const predicate = new Function(`return (${source})`)();
      return new Promise((resolvePromise, reject) => {
        if (predicate()) {
          resolvePromise(true);
          return;
        }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`missing state: ${name}`));
        }, timeout);
        const observer = new MutationObserver(() => {
          if (!predicate()) return;
          clearTimeout(timer);
          observer.disconnect();
          resolvePromise(true);
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      });
    },
    predicateSource,
    stateName,
    STATE_TIMEOUT,
  );
}

// Library readiness is data hydration + idle capture. Rail VISIBILITY is deliberately not
// asserted: the current shell hides .session-rail below 1244px, and that measured fact is
// part of the baseline this packet characterizes rather than a state to wait for.
const LIBRARY_PREDICATE = `() => {
  const app = document.querySelector(".app");
  return Boolean(app) && !app.classList.contains("app--capturing")
    && document.querySelectorAll("#session-list > li").length === 3;
}`;

const LIVE_PREDICATE = `() => {
  const app = document.querySelector(".app");
  const stream = document.getElementById("transcript-stream");
  const slide = document.getElementById("current-slide");
  return Boolean(app) && app.classList.contains("app--capturing")
    && Boolean(stream) && stream.children.length >= 15
    && Boolean(slide) && slide.textContent.trim().length > 0;
}`;

async function captureShot(page, id, viewport, url, log, extra) {
  const probe = await page.evaluate(COMPUTED_PROBE, BASELINE_SELECTORS);
  const surfaceVisibility = await page.evaluate(() => {
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        display: style.display,
        visibility: style.visibility,
        perceivable: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden",
      };
    };
    return {
      sessionRail: visible(".session-rail"),
      stagePane: visible("#stage-pane"),
      transcriptPane: visible("#transcript-pane"),
      dock: visible(".dock"),
      transcriptLineCount: document.querySelectorAll("#transcript-stream > *").length,
      meetingRowCount: document.querySelectorAll("#session-list > li").length,
      recordButtonLabel: document.getElementById("btn-record")?.textContent?.trim() ?? null,
    };
  });
  const capturedAt = isoNow();
  mkdirSync(SCREENS, { recursive: true });
  const screenshotPath = join(SCREENS, `${id}.png`);
  await page.screenshot({ path: screenshotPath, captureBeyondViewport: false });
  const dimensions = pngDimensions(screenshotPath);
  if (dimensions.bytes === 0) throw new Error(`zero-byte screenshot for ${id}`);
  if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) {
    throw new Error(
      `dimension mismatch for ${id}: png ${dimensions.width}x${dimensions.height} vs viewport ${viewport.width}x${viewport.height}`,
    );
  }

  const computedReceipt = writeJson(join(COMPUTED, `${id}.json`), {
    stateId: id,
    url,
    viewport,
    capturedAt,
    deterministic: { ...DETERMINISTIC, fixedNow: FIXED_NOW, captureStartedAt: CAPTURE_STARTED_AT },
    ...extra,
    surfaceVisibility,
    ...probe,
  });

  log.push(`OK ${id} ${viewport.name} ${dimensions.width}x${dimensions.height}`);

  return {
    stateId: id,
    kind: "meeting-slides-baseline",
    sourceUrl: url,
    viewport,
    capturedAt,
    shell: extra.shell,
    rootOverflow: probe.documentScrollWidth > probe.documentClientWidth,
    surfaceVisibility,
    screenshot: {
      path: `baseline/screens/${id}.png`,
      width: dimensions.width,
      height: dimensions.height,
      bytes: dimensions.bytes,
      sha256: sha256File(screenshotPath),
    },
    computed: {
      path: `baseline/computed/${id}.json`,
      sha256: computedReceipt.sha256,
      bytes: computedReceipt.bytes,
      missingSelectors: probe.missing,
    },
  };
}

async function main() {
  const startedAt = isoNow();
  const log = [];
  const harness = await startHarness(PUBLIC_DIR);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars"],
  });

  const states = [];
  const errors = [];
  try {
    for (const viewport of BASELINE_VIEWPORTS) {
      const page = await browser.newPage();
      try {
        await prepareDeterministicPage(page, viewport);
        await page.emulateTimezone(DETERMINISTIC.timezone);
        await page.evaluateOnNewDocument(FREEZE_CLOCK, FIXED_NOW);
        await page.goto(harness.origin, { waitUntil: "load", timeout: 30_000 });
        await harness.connected;
        await page.evaluate(() => document.fonts.ready);

        // --- Library (idle) state -------------------------------------------------
        harness.push({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
        harness.push({ type: "meetings", items: MEETINGS });
        await waitForDomState(page, LIBRARY_PREDICATE, `library@${viewport.name}`);
        states.push(
          await captureShot(page, `library-${viewport.name}`, viewport, harness.origin, log, {
            shell: "library",
            fixture: "3 meetings, idle capture",
          }),
        );

        // --- Live (capturing) state ----------------------------------------------
        harness.push({
          type: "capture",
          capturing: true,
          mode: "mic",
          phase: "capturing",
          startedAt: CAPTURE_STARTED_AT,
        });
        harness.push({ type: "slide", current: SLIDE, history: SLIDE_HISTORY });
        harness.push({ type: "transcript", entries: transcriptEntries(), reason: "snapshot" });
        harness.push({ type: "caption", text: PROVISIONAL_CAPTION, ts: FIXED_NOW, speaker: 2 });
        await waitForDomState(page, LIVE_PREDICATE, `live@${viewport.name}`);
        states.push(
          await captureShot(page, `live-${viewport.name}`, viewport, harness.origin, log, {
            shell: "live",
            fixture: "capturing, 3 slides, 15 finalized lines, 1 provisional caption",
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ viewport: viewport.name, error: message });
        log.push(`FAIL ${viewport.name}: ${message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await harness.stop();
  }

  writeJson(join(BASELINE_ROOT, "states.json"), {
    packet: "meeting-slides-current-baseline",
    characterization: "existing rendered UI before any product change",
    startedAt,
    finishedAt: isoNow(),
    viewports: BASELINE_VIEWPORTS,
    states,
    errors,
  });
  mkdirSync(join(TASK_ROOT, "logs"), { recursive: true });
  writeFileSync(join(TASK_ROOT, "logs", "baseline-capture.log"), `${log.join("\n")}\n`);

  if (errors.length > 0) {
    console.error(JSON.stringify(errors, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`captured ${states.length} baseline states`);
}

await main();
