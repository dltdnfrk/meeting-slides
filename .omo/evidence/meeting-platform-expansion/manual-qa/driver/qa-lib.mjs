// Manual-QA browser harness. Read-only against product code; drives the real
// browser surface of the running signed app at http://127.0.0.1:8787/.
// No sleeps: every wait is armed on an exact DOM / WebSocket / file predicate
// before the triggering action, and every wait is bounded.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import puppeteer from "puppeteer";

export const APP_URL = "http://127.0.0.1:8787/";
export const DESKTOP = { width: 1512, height: 950, deviceScaleFactor: 1 };
export const NARROW = { width: 360, height: 780, deviceScaleFactor: 1 };

export async function launch() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    defaultViewport: DESKTOP,
  });
  return browser;
}

/**
 * Opens the app and installs a WebSocket tap that records every inbound frame
 * before the page's own handlers run, so later waits can assert on real traffic.
 */
export async function openApp(browser, viewport = DESKTOP) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page-console-error]", m.text());
  });
  page.on("pageerror", (e) => console.error("[page-error]", e.message));

  // Tap must be installed before any app script runs.
  await page.evaluateOnNewDocument(() => {
    window.__qa = { frames: [], sent: [] };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__qa.socket = this;
        this.addEventListener("message", (ev) => {
          try { window.__qa.frames.push(JSON.parse(ev.data)); } catch { /* non-JSON */ }
        });
      }
      send(data) {
        try { window.__qa.sent.push(JSON.parse(data)); } catch { window.__qa.sent.push(String(data)); }
        return super.send(data);
      }
    };
  });

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  // Armed on the real socket-open + first server payload, not on a timer.
  await page.waitForFunction(
    () => window.__qa?.socket?.readyState === 1 && window.__qa.frames.some((f) => f.type === "meetings"),
    { timeout: 20_000, polling: "mutation" },
  );
  return page;
}

/** Frame count snapshot, used to arm "a NEW frame of type X" waits. */
export function frameCursor(page) {
  return page.evaluate(() => window.__qa.frames.length);
}

/**
 * Waits for a new inbound WS frame matching `predicateSource` (a function body
 * string evaluated in the page) that arrived after `cursor`. Bounded.
 */
export async function waitForFrame(page, cursor, predicateSource, timeout = 30_000) {
  const handle = await page.waitForFunction(
    (from, src) => {
      const pred = new Function("f", `return (${src})(f);`);
      const hit = window.__qa.frames.slice(from).find((f) => { try { return pred(f); } catch { return false; } });
      return hit ? { hit } : false;
    },
    { timeout, polling: "mutation" },
    cursor,
    predicateSource,
  );
  const value = await handle.jsonValue();
  await handle.dispose();
  return value.hit;
}

/** Collect all frames after cursor matching predicate (no wait). */
export async function collectFrames(page, cursor, predicateSource) {
  return page.evaluate(
    (from, src) => {
      const pred = new Function("f", `return (${src})(f);`);
      return window.__qa.frames.slice(from).filter((f) => { try { return pred(f); } catch { return false; } });
    },
    cursor,
    predicateSource,
  );
}

export async function shot(page, path) {
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: false });
  return path;
}

export async function openSettings(page, { viaKeyboard = false } = {}) {
  if (viaKeyboard) {
    await page.focus("#btn-settings");
    await page.keyboard.press("Enter");
  } else {
    await page.click("#btn-settings");
  }
  await page.waitForFunction(
    () => document.getElementById("provider-panel")?.hidden === false,
    { timeout: 5_000, polling: "mutation" },
  );
}

export async function readSettingsState(page) {
  return page.evaluate(() => {
    const panel = document.getElementById("provider-panel");
    const rows = [...document.querySelectorAll("#provider-list .provider-row")].map((r) => ({
      id: r.dataset.id,
      auth: r.dataset.auth,
      installed: r.dataset.installed,
      current: r.classList.contains("provider-row--current"),
      disabledClass: r.classList.contains("provider-row--disabled"),
      name: r.querySelector(".provider-row__name")?.textContent?.trim(),
      detail: r.querySelector(".provider-row__detail")?.textContent?.trim(),
      badge: r.querySelector(".provider-row__badge")?.textContent?.trim(),
      selectDisabled: r.querySelector(".provider-row__select")?.disabled ?? null,
      ariaPressed: r.querySelector(".provider-row__select")?.getAttribute("aria-pressed"),
      connectLabel: r.querySelector(".provider-row__connect")?.textContent?.trim() ?? null,
      hasKeyInput: !!r.querySelector(".provider-row__key"),
    }));
    const stt = [...document.querySelectorAll("#stt-list .stt-row")].map((r) => ({
      id: r.dataset.id,
      status: r.dataset.status,
      name: r.querySelector(".stt-row__name")?.textContent?.trim(),
      badge: r.querySelector(".stt-row__badge")?.textContent?.trim(),
      meta: r.querySelector(".stt-row__meta")?.textContent?.trim(),
      error: r.querySelector(".stt-row__error")?.textContent?.trim() ?? null,
      progressNow: r.querySelector(".stt-progress")?.getAttribute("aria-valuenow") ?? null,
      actions: [...r.querySelectorAll(".stt-row__actions button")].map((b) => ({
        cls: b.className, text: b.textContent.trim(), disabled: b.disabled,
      })),
    }));
    const modelSel = document.getElementById("select-model");
    const effortSel = document.getElementById("select-effort");
    return {
      panelHidden: panel.hidden,
      settingsAriaExpanded: document.getElementById("btn-settings")?.getAttribute("aria-expanded"),
      providers: rows,
      stt,
      model: { disabled: modelSel.disabled, value: modelSel.value, options: [...modelSel.options].map((o) => o.value) },
      effort: { rowHidden: document.getElementById("effort-row").hidden, value: effortSel.value, options: [...effortSel.options].map((o) => o.value) },
      glanceProvider: document.getElementById("glance-provider")?.textContent?.trim(),
      statusText: document.getElementById("status-text")?.textContent?.trim(),
    };
  });
}

export async function readMainState(page) {
  return page.evaluate(() => ({
    docTitle: document.getElementById("doc-title")?.textContent?.trim(),
    docMeta: document.getElementById("doc-meta")?.textContent?.trim(),
    sessionCount: document.getElementById("session-count")?.textContent?.trim(),
    sessionRows: [...document.querySelectorAll(".session-row")].map((r) => ({
      id: r.dataset.meetingId,
      title: r.querySelector(".session-row__title")?.textContent?.trim(),
      selected: r.classList.contains("session-row--selected"),
      ariaPressed: r.getAttribute("aria-pressed"),
    })),
    historyCount: document.getElementById("history-count")?.textContent?.trim(),
    thumbnails: [...document.querySelectorAll("#thumbnails .thumbnail")].map((t) => ({
      index: t.dataset.index,
      title: t.querySelector(".thumbnail__title")?.textContent?.trim(),
    })),
    filmstripEmpty: !!document.querySelector("#thumbnails .filmstrip__empty"),
    transcriptCount: document.getElementById("transcript-count")?.textContent?.trim(),
    transcriptLines: [...document.querySelectorAll("#transcript-stream .transcript-line, #transcript-stream .transcript-row, #transcript-stream > *")]
      .slice(0, 200).map((n) => n.textContent.trim()).filter(Boolean),
    transcriptEmptyHidden: document.getElementById("transcript-empty")?.hidden,
    currentSlideTitle: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
    currentSlidePlaceholder: !!document.querySelector("#current-slide .slide__placeholder"),
    compileStatus: {
      hidden: document.getElementById("compile-status")?.hidden,
      state: document.getElementById("compile-status")?.dataset.state ?? null,
      text: document.getElementById("compile-status")?.textContent?.trim(),
    },
    jobControls: ["btn-compile-deck", "btn-export-pdf", "btn-export-png"].map((id) => ({
      id, disabled: document.getElementById(id)?.disabled,
    })),
    lastSaved: {
      hidden: document.getElementById("last-saved")?.hidden,
      text: document.getElementById("last-saved")?.textContent?.trim(),
    },
    statusText: document.getElementById("status-text")?.textContent?.trim(),
    retryButton: document.querySelector(".job-retry")
      ? { text: document.querySelector(".job-retry").textContent.trim(), action: document.querySelector(".job-retry").dataset.action }
      : null,
  }));
}

/** Selects a historical meeting row and waits for the real `meeting` hydration frame. */
export async function selectMeeting(page, meetingId) {
  const cursor = await frameCursor(page);
  await page.click(`.session-row[data-meeting-id="${meetingId}"]`);
  const frame = await waitForFrame(
    page, cursor,
    `(f) => f.type === "meeting" && f.meetingId === ${meetingId}`,
    15_000,
  );
  // DOM settle armed on the rendered title, not a timer.
  await page.waitForFunction(
    (id) => document.querySelector(`.session-row[data-meeting-id="${id}"]`)?.classList.contains("session-row--selected"),
    { timeout: 5_000, polling: "mutation" },
    meetingId,
  );
  return frame;
}
