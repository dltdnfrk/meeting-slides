// Official Caret reference capture. Sources are ONLY https://caret.so/en and /en/changelog.
// Captures are evidence-only: nothing is written under public/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";

import {
  COMPUTED_PROBE,
  DETERMINISTIC,
  TASK_ROOT,
  WAIT_FOR_STATE,
  isoNow,
  pngDimensions,
  prepareDeterministicPage,
  sha256File,
  writeJson,
} from "./capture-lib.mjs";

const REFERENCE_ROOT = join(TASK_ROOT, "reference");
const SCREENS = join(REFERENCE_ROOT, "screens");
const COMPUTED = join(REFERENCE_ROOT, "computed");
const NAV_TIMEOUT = 45_000;
const STATE_TIMEOUT = 20_000;

/**
 * Each state names a real, verified anchor in the official markup.
 * `anchor` is the state gate; absence must fail the state, never fall back.
 */
const REFERENCE_STATES = [
  {
    id: "home-hero",
    url: "https://caret.so/en",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: "h1.font-display",
    scrollTo: null,
    selectors: {
      root: ":root",
      body: "body",
      heroHeading: "h1.font-display",
      nav: "header, nav",
      primaryCta: "main a[href*='download'], main a[href*='mac'], header a[href*='download']",
      heroSurface: "main section:first-of-type",
    },
  },
  {
    id: "home-live-suggestion",
    url: "https://caret.so/en",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: null,
    stageMarker: "[01] LIVE SUGGESTION",
    selectors: {
      root: ":root",
      stageLabel: null, // resolved at runtime from stageMarker
    },
  },
  {
    id: "home-before-the-call",
    url: "https://caret.so/en",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: null,
    stageMarker: "[02] BEFORE THE CALL",
    selectors: { root: ":root" },
  },
  {
    id: "home-after-the-call",
    url: "https://caret.so/en",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: null,
    stageMarker: "[03] AFTER THE CALL",
    selectors: { root: ":root" },
  },
  {
    id: "home-narrow",
    url: "https://caret.so/en",
    viewport: { name: "375x812", width: 375, height: 812 },
    anchor: "h1.font-display",
    selectors: {
      root: ":root",
      body: "body",
      heroHeading: "h1.font-display",
    },
  },
  {
    id: "changelog-index",
    url: "https://caret.so/en/changelog",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: "h1.font-display",
    selectors: {
      root: ":root",
      body: "body",
      pageHeading: "h1.font-display",
      entryHeading: "h2#caret-mobile-app-out-now",
      changelogImage: "img[src*='/assets/changelogs/']",
    },
  },
  {
    id: "changelog-mini-recording-popup",
    url: "https://caret.so/en/changelog",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: "h3#mini-recording-popup-invisible-during-screen-sharing",
    scrollToAnchor: true,
    selectors: {
      root: ":root",
      minibarHeading: "h3#mini-recording-popup-invisible-during-screen-sharing",
      backgroundModeHeading: "h2#background-mode",
    },
  },
  {
    id: "changelog-new-ui",
    url: "https://caret.so/en/changelog",
    viewport: { name: "1440x900", width: 1440, height: 900 },
    anchor: "h2#new-ui",
    scrollToAnchor: true,
    selectors: {
      root: ":root",
      newUiHeading: "h2#new-ui",
    },
  },
];

async function captureState(browser, state, log) {
  const page = await browser.newPage();
  const requests = [];
  page.on("requestfailed", (request) => {
    requests.push({ url: request.url(), failure: request.failure()?.errorText ?? "unknown" });
  });

  try {
    await prepareDeterministicPage(page, state.viewport);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    const response = await page.goto(state.url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT });
    if (!response || !response.ok()) {
      throw new Error(`navigation failed for ${state.id}: status ${response?.status() ?? "none"}`);
    }

    // Deterministic web-font readiness - an exact promise, not a delay.
    await page.evaluate(() => document.fonts.ready);

    let anchorSelector = state.anchor;
    if (state.stageMarker) {
      anchorSelector = await page.evaluate((marker) => {
        const nodes = [...document.querySelectorAll("body *")];
        const hit = nodes.find(
          (node) =>
            node.children.length === 0 && (node.textContent ?? "").trim() === marker,
        );
        if (!hit) return null;
        hit.setAttribute("data-omo-state-anchor", "1");
        return "[data-omo-state-anchor='1']";
      }, state.stageMarker);
      if (!anchorSelector) {
        throw new Error(`missing state: ${state.id} (stage marker "${state.stageMarker}" absent)`);
      }
    }

    if (anchorSelector) {
      await page.evaluate(WAIT_FOR_STATE, anchorSelector, state.id, STATE_TIMEOUT);
    }

    if ((state.scrollToAnchor || state.stageMarker) && anchorSelector) {
      // Scroll deterministically, then await the exact scroll-settled event.
      await page.evaluate(async (selector) => {
        const target = document.querySelector(selector);
        if (!target) throw new Error(`anchor vanished: ${selector}`);
        const targetTop = window.scrollY + target.getBoundingClientRect().top - 80;
        if (Math.abs(window.scrollY - targetTop) < 1) return;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            window.removeEventListener("scrollend", onEnd);
            reject(new Error(`scroll never settled for ${selector}`));
          }, 10_000);
          const onEnd = () => {
            clearTimeout(timer);
            window.removeEventListener("scrollend", onEnd);
            resolve(true);
          };
          window.addEventListener("scrollend", onEnd, { once: true });
          window.scrollTo({ top: targetTop, behavior: "instant" });
        });
      }, anchorSelector);
    }

    const selectors = { ...state.selectors };
    if (anchorSelector) selectors.stateAnchor = anchorSelector;
    for (const key of Object.keys(selectors)) {
      if (selectors[key] === null) delete selectors[key];
    }

    const probe = await page.evaluate(COMPUTED_PROBE, selectors);
    const capturedAt = isoNow();
    const screenshotPath = join(SCREENS, `${state.id}.png`);
    mkdirSync(SCREENS, { recursive: true });
    await page.screenshot({ path: screenshotPath, captureBeyondViewport: false });

    const dimensions = pngDimensions(screenshotPath);
    if (dimensions.bytes === 0) throw new Error(`zero-byte screenshot for ${state.id}`);

    const computedPath = join(COMPUTED, `${state.id}.json`);
    const computedReceipt = writeJson(computedPath, {
      stateId: state.id,
      url: state.url,
      finalUrl: page.url(),
      viewport: state.viewport,
      capturedAt,
      deterministic: DETERMINISTIC,
      httpStatus: response.status(),
      anchorSelector,
      stageMarker: state.stageMarker ?? null,
      failedRequests: requests,
      ...probe,
    });

    log.push(`OK ${state.id} ${state.viewport.name} ${dimensions.width}x${dimensions.height}`);

    return {
      stateId: state.id,
      kind: "official-reference",
      sourceUrl: state.url,
      finalUrl: page.url(),
      httpStatus: response.status(),
      viewport: state.viewport,
      capturedAt,
      anchorSelector,
      screenshot: {
        path: `reference/screens/${state.id}.png`,
        width: dimensions.width,
        height: dimensions.height,
        bytes: dimensions.bytes,
        sha256: sha256File(screenshotPath),
      },
      computed: {
        path: `reference/computed/${state.id}.json`,
        sha256: computedReceipt.sha256,
        bytes: computedReceipt.bytes,
        missingSelectors: probe.missing,
      },
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const startedAt = isoNow();
  const log = [];
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars", `--lang=en-US`],
  });

  const states = [];
  const errors = [];
  try {
    for (const state of REFERENCE_STATES) {
      try {
        states.push(await captureState(browser, state, log));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ stateId: state.id, error: message });
        log.push(`FAIL ${state.id}: ${message}`);
      }
    }
  } finally {
    await browser.close();
  }

  writeJson(join(REFERENCE_ROOT, "states.json"), {
    packet: "official-caret-reference",
    startedAt,
    finishedAt: isoNow(),
    chromium: await (async () => "puppeteer-bundled")(),
    sources: ["https://caret.so/en", "https://caret.so/en/changelog"],
    states,
    errors,
  });
  mkdirSync(join(TASK_ROOT, "logs"), { recursive: true });
  writeFileSync(join(TASK_ROOT, "logs", "reference-capture.log"), `${log.join("\n")}\n`);

  if (errors.length > 0) {
    console.error(JSON.stringify(errors, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`captured ${states.length} official reference states`);
}

await main();
