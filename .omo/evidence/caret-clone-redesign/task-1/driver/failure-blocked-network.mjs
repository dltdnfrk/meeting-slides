// FAILURE SCENARIO: after navigating to the official reference, block every external
// request and prove the driver reports a NAMED missing official state instead of silently
// falling back to a cached page, a third-party redesign, or a stale screenshot.
import { existsSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";

import {
  TASK_ROOT,
  WAIT_FOR_STATE,
  isoNow,
  prepareDeterministicPage,
  writeJson,
} from "./capture-lib.mjs";

const URL = "https://caret.so/en/changelog";
const VIEWPORT = { name: "1440x900", width: 1440, height: 900 };
// A real, verified anchor on the official page. Reachable when the network is up;
// unreachable once external requests are blocked and the document is reloaded.
const REQUIRED_STATE = {
  name: "changelog-mini-recording-popup",
  selector: "h3#mini-recording-popup-invisible-during-screen-sharing",
};
const STATE_TIMEOUT = 8_000;

const scenarios = [];

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars", "--lang=en-US"],
});

try {
  const page = await browser.newPage();
  await prepareDeterministicPage(page, VIEWPORT);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // 1) Control: with the network available the required official state resolves.
  const response = await page.goto(URL, { waitUntil: "networkidle2", timeout: 45_000 });
  const controlOk = Boolean(response?.ok());
  await page.evaluate(() => document.fonts.ready);
  let controlResolved = false;
  let controlError = null;
  try {
    await page.evaluate(WAIT_FOR_STATE, REQUIRED_STATE.selector, REQUIRED_STATE.name, STATE_TIMEOUT);
    controlResolved = true;
  } catch (error) {
    controlError = error instanceof Error ? error.message : String(error);
  }
  scenarios.push({
    scenario: "control-network-available",
    url: URL,
    httpOk: controlOk,
    requiredState: REQUIRED_STATE,
    resolved: controlResolved,
    error: controlError,
    expectation: "official state resolves",
    pass: controlOk && controlResolved,
  });

  // 2) Failure: block ALL external requests AFTER navigation, then force a reload so the
  //    document itself must come from the network. Nothing may be served from a fallback.
  const blocked = [];
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    blocked.push({ url: request.url(), resourceType: request.resourceType() });
    request.abort("failed").catch(() => {});
  });

  let navigationError = null;
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  let missingStateError = null;
  let falselyResolved = false;
  try {
    await page.evaluate(WAIT_FOR_STATE, REQUIRED_STATE.selector, REQUIRED_STATE.name, STATE_TIMEOUT);
    falselyResolved = true;
  } catch (error) {
    missingStateError = error instanceof Error ? error.message : String(error);
  }

  const namesMissingState =
    typeof missingStateError === "string" &&
    missingStateError.includes("missing state") &&
    missingStateError.includes(REQUIRED_STATE.name);

  // The driver must not have written a screenshot for a state it could not reach.
  const screenshotPath = join(TASK_ROOT, "reference", "screens", `${REQUIRED_STATE.name}-blocked.png`);
  const wroteBlockedArtifact = existsSync(screenshotPath);

  scenarios.push({
    scenario: "external-requests-blocked-after-navigation",
    url: URL,
    blockedRequestCount: blocked.length,
    blockedSample: blocked.slice(0, 5),
    navigationError,
    requiredState: REQUIRED_STATE,
    falselyResolved,
    reportedError: missingStateError,
    namesMissingState,
    wroteFallbackArtifact: wroteBlockedArtifact,
    expectation:
      "driver reports the named missing official state; no cached/third-party fallback, no artifact written",
    pass: !falselyResolved && namesMissingState && !wroteBlockedArtifact,
  });
} finally {
  await browser.close();
}

const allPass = scenarios.every((scenario) => scenario.pass);
const receipt = writeJson(join(TASK_ROOT, "failure.json"), {
  packet: "caret-clone-redesign/task-1",
  scenario: "blocked-network reference capture",
  ranAt: isoNow(),
  claim:
    "When external requests are blocked after navigation, the reference driver fails loudly with the named missing official state rather than silently using cached or third-party content.",
  scenarios,
  result: allPass ? "PASS" : "FAIL",
});

console.log(`failure scenario ${allPass ? "PASS" : "FAIL"} sha256=${receipt.sha256}`);
if (!allPass) process.exitCode = 1;
