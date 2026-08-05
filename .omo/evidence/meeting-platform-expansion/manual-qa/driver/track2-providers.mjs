// Track 2: provider controls through the real settings overlay.
// Ground truth (measured out-of-band, see logs/provider-cli-ground-truth.txt):
//   cli:codex   installed=true  auth=connected  (codex login status exit 0)
//   cli:grok    installed=true  auth=unknown    (no authProbe declared)
//   cli:claude  installed=true  auth=connected  (auth status --json loggedIn:true)
//   cli:gemini  installed=true  auth=unknown    (no authProbe declared)
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  launch, openApp, shot, frameCursor, waitForFrame,
  readSettingsState, openSettings, DESKTOP, NARROW,
} from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa");
const SHOTS = join(EV, "screens");
const SETTINGS = join(ROOT, ".meeting-slides/settings.json");

const GROUND_TRUTH = {
  "cli:codex": { installed: true, auth: "connected", badge: "연결됨", selectable: true },
  "cli:grok": { installed: true, auth: "unknown", badge: "인증 미확인", selectable: true },
  "cli:claude": { installed: true, auth: "connected", badge: "연결됨", selectable: true },
  "cli:gemini": { installed: true, auth: "unknown", badge: "인증 미확인", selectable: true },
};

const results = [];
const rec = (id, ok, detail) => {
  const status = ok === true ? "PASS" : ok === false ? "FAIL" : String(ok);
  results.push({ id, status, detail });
  console.log(`[${status}] ${id} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const readSettingsFile = () => (existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf-8")) : null);

const browser = await launch();
let page = await openApp(browser, DESKTOP);

try {
  // ── 2.1 open settings at desktop; verify truthful status for all four ──
  await openSettings(page);
  await page.waitForFunction(() => document.querySelectorAll("#provider-list .provider-row").length >= 4,
    { timeout: 10_000, polling: "mutation" });
  const s0 = await readSettingsState(page);
  await shot(page, join(SHOTS, "t2-01-settings-desktop-open.png"));

  rec("T2.1-settings-opens-desktop", s0.panelHidden === false && s0.settingsAriaExpanded === "true",
    { panelHidden: s0.panelHidden, ariaExpanded: s0.settingsAriaExpanded, providerRows: s0.providers.length });

  const byId = Object.fromEntries(s0.providers.map((p) => [p.id, p]));
  for (const [id, want] of Object.entries(GROUND_TRUTH)) {
    const got = byId[id];
    const ok = !!got
      && got.installed === String(want.installed)
      && got.auth === want.auth
      && got.badge === want.badge
      && got.selectDisabled === !want.selectable;
    rec(`T2.2-truthful-status-${id}`, ok, { expected: want, actual: got });
  }
  rec("T2.3-no-optimistic-connected",
    s0.providers.filter((p) => p.badge === "연결됨").every((p) => GROUND_TRUTH[p.id]?.auth === "connected"),
    { claimingConnected: s0.providers.filter((p) => p.badge === "연결됨").map((p) => p.id) });

  // ── 2.2 recheck button uses the real detector ──
  let cur = await frameCursor(page);
  await page.click("#btn-recheck");
  const reFrame = await waitForFrame(page, cur, `(f) => f.type === "providers"`, 30_000);
  const sRe = await readSettingsState(page);
  await shot(page, join(SHOTS, "t2-02-settings-desktop-after-recheck.png"));
  const reById = Object.fromEntries((reFrame.list ?? []).map((p) => [p.id, p]));
  rec("T2.4-recheck-returns-real-state",
    Object.entries(GROUND_TRUTH).every(([id, w]) => reById[id]?.installed === w.installed
      && (reById[id]?.auth === w.auth || (id === reFrame.current && reById[id]?.auth === "connected"))),
    { current: reFrame.current, wsList: (reFrame.list ?? []).map((p) => ({ id: p.id, installed: p.installed, auth: p.auth })) });
  rec("T2.5-recheck-preserves-truth-in-ui",
    sRe.providers.every((p) => !GROUND_TRUTH[p.id] || p.installed === String(GROUND_TRUTH[p.id].installed)),
    sRe.providers.map((p) => ({ id: p.id, auth: p.auth, badge: p.badge })));

  // ── 2.3 select EVERY selectable provider through the UI ──
  const selectable = s0.providers.filter((p) => p.selectDisabled === false).map((p) => p.id);
  rec("T2.6-selectable-set", selectable.length >= 4, { selectable });
  const selectionLog = [];
  for (const id of selectable) {
    const c = await frameCursor(page);
    await page.click(`.provider-row[data-id="${id}"] .provider-row__select`);
    const pf = await waitForFrame(page, c, `(f) => f.type === "providers" && f.current === "${id}"`, 25_000);
    await page.waitForFunction((pid) => document.querySelector(`.provider-row[data-id="${pid}"]`)?.classList.contains("provider-row--current"),
      { timeout: 8_000, polling: "mutation" }, id);
    const st = await readSettingsState(page);
    const file = readSettingsFile();
    selectionLog.push({ id, wsCurrent: pf.current, wsModel: pf.currentModel, wsEffort: pf.currentEffort,
      uiAriaPressed: st.providers.find((p) => p.id === id)?.ariaPressed,
      glance: st.glanceProvider, persistedFile: file, modelOptions: st.model.options, effortHidden: st.effort.rowHidden });
    await shot(page, join(SHOTS, `t2-03-selected-${id.replace(":", "-")}.png`));
    rec(`T2.7-select-${id}`,
      pf.current === id && st.providers.find((p) => p.id === id)?.ariaPressed === "true" && file?.providerId === id,
      { wsCurrent: pf.current, ariaPressed: st.providers.find((p) => p.id === id)?.ariaPressed, persisted: file?.providerId });
  }
  writeFileSync(join(EV, "artifacts/track2-selection-log.json"), JSON.stringify(selectionLog, null, 2));

  // ── 2.4 change model + effort where exposed (codex exposes both) ──
  let c = await frameCursor(page);
  await page.click(`.provider-row[data-id="cli:codex"] .provider-row__select`);
  await waitForFrame(page, c, `(f) => f.type === "providers" && f.current === "cli:codex"`, 25_000);
  const sCodex = await readSettingsState(page);
  rec("T2.8-model-and-effort-exposed",
    sCodex.model.disabled === false && sCodex.model.options.length > 1 && sCodex.effort.rowHidden === false && sCodex.effort.options.length > 1,
    { model: sCodex.model, effort: sCodex.effort });

  const altModel = sCodex.model.options.find((o) => o && o !== sCodex.model.value);
  c = await frameCursor(page);
  await page.select("#select-model", altModel);
  const mFrame = await waitForFrame(page, c, `(f) => f.type === "providers" && f.currentModel === "${altModel}"`, 25_000);
  await shot(page, join(SHOTS, "t2-04-model-changed.png"));
  rec("T2.9-change-model", mFrame.currentModel === altModel && readSettingsFile()?.model === altModel,
    { requested: altModel, wsCurrentModel: mFrame.currentModel, persisted: readSettingsFile()?.model });

  const altEffort = sCodex.effort.options.find((o) => o && o !== mFrame.currentEffort);
  c = await frameCursor(page);
  await page.select("#select-effort", altEffort);
  const eFrame = await waitForFrame(page, c, `(f) => f.type === "providers" && f.currentEffort === "${altEffort}"`, 25_000);
  await shot(page, join(SHOTS, "t2-05-effort-changed.png"));
  const persistedAfter = readSettingsFile();
  rec("T2.10-change-effort", eFrame.currentEffort === altEffort && persistedAfter?.effort === altEffort,
    { requested: altEffort, wsCurrentEffort: eFrame.currentEffort, persisted: persistedAfter });

  writeFileSync(join(EV, "artifacts/track2-selection-before-reload.json"), JSON.stringify(persistedAfter, null, 2));

  // ── 2.5 keyboard open + Escape focus restoration ──
  // Close first, then reopen purely by keyboard.
  await page.evaluate(() => document.getElementById("btn-settings").click());
  await page.waitForFunction(() => document.getElementById("provider-panel").hidden === true,
    { timeout: 5_000, polling: "mutation" });
  await openSettings(page, { viaKeyboard: true });
  const kOpen = await readSettingsState(page);
  await shot(page, join(SHOTS, "t2-06-keyboard-opened.png"));
  rec("T2.11-keyboard-open", kOpen.panelHidden === false && kOpen.settingsAriaExpanded === "true",
    { panelHidden: kOpen.panelHidden, ariaExpanded: kOpen.settingsAriaExpanded });

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("provider-panel").hidden === true,
    { timeout: 5_000, polling: "mutation" });
  const focusAfter = await page.evaluate(() => ({
    activeId: document.activeElement?.id,
    ariaExpanded: document.getElementById("btn-settings").getAttribute("aria-expanded"),
    hidden: document.getElementById("provider-panel").hidden,
  }));
  await shot(page, join(SHOTS, "t2-07-escape-focus-restored.png"));
  rec("T2.12-escape-closes-and-restores-focus",
    focusAfter.hidden === true && focusAfter.activeId === "btn-settings" && focusAfter.ariaExpanded === "false",
    focusAfter);

  // ── 2.6 narrow viewport (360px) ──
  await page.setViewport(NARROW);
  await page.waitForFunction(() => window.innerWidth === 360, { timeout: 5_000, polling: "mutation" });
  await openSettings(page);
  await page.waitForFunction(() => document.querySelectorAll("#provider-list .provider-row").length >= 4,
    { timeout: 10_000, polling: "mutation" });
  const narrow = await page.evaluate(() => {
    const panel = document.getElementById("provider-panel");
    const pr = panel.getBoundingClientRect();
    const overflowing = [];
    for (const el of panel.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        overflowing.push({ cls: el.className?.toString?.().slice(0, 60), right: Math.round(r.right), left: Math.round(r.left) });
      }
    }
    const clipped = [];
    for (const el of panel.querySelectorAll(".provider-row__name, .provider-row__detail, .provider-row__badge, .stt-row__name, .stt-row__meta, .stt-row__badge, .provider-panel__hint")) {
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
        clipped.push({ cls: el.className, text: el.textContent.trim().slice(0, 40),
          scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight });
      }
    }
    return {
      innerWidth: window.innerWidth,
      panel: { left: Math.round(pr.left), right: Math.round(pr.right), width: Math.round(pr.width) },
      panelWithinViewport: pr.left >= -1 && pr.right <= window.innerWidth + 1,
      docScrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      overflowing, clipped,
      allButtonsReachable: [...panel.querySelectorAll("button")].every((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1;
      }),
      buttonHitTargets: [...panel.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent.trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    };
  });
  await shot(page, join(SHOTS, "t2-08-settings-narrow-360-open.png"));
  rec("T2.13-narrow-360-panel-in-viewport", narrow.panelWithinViewport && !narrow.horizontalOverflow,
    { panel: narrow.panel, innerWidth: narrow.innerWidth, docScrollWidth: narrow.docScrollWidth, overflowing: narrow.overflowing });
  rec("T2.14-narrow-360-no-cjk-clipping", narrow.clipped.length === 0, { clipped: narrow.clipped });
  rec("T2.15-narrow-360-controls-reachable", narrow.allButtonsReachable,
    { buttons: narrow.buttonHitTargets.length, smallest: narrow.buttonHitTargets.reduce((a, b) => (a && a.h <= b.h ? a : b), null) });
  writeFileSync(join(EV, "artifacts/track2-narrow-layout.json"), JSON.stringify(narrow, null, 2));

  // narrow: escape focus restoration must also hold
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("provider-panel").hidden === true,
    { timeout: 5_000, polling: "mutation" });
  const nFocus = await page.evaluate(() => ({ activeId: document.activeElement?.id, hidden: document.getElementById("provider-panel").hidden }));
  rec("T2.16-narrow-escape-focus-restored", nFocus.hidden === true && nFocus.activeId === "btn-settings", nFocus);

  // ── 2.7 reload persistence (same server process) ──
  await page.setViewport(DESKTOP);
  await page.close();
  page = await openApp(browser, DESKTOP);
  await openSettings(page);
  await page.waitForFunction(() => document.querySelectorAll("#provider-list .provider-row").length >= 4,
    { timeout: 10_000, polling: "mutation" });
  const afterReload = await readSettingsState(page);
  const reloadFrame = await page.evaluate(() => window.__qa.frames.filter((f) => f.type === "providers").at(-1));
  await shot(page, join(SHOTS, "t2-09-settings-after-reload.png"));
  rec("T2.17-persistence-across-reload",
    reloadFrame.current === persistedAfter.providerId && reloadFrame.currentModel === persistedAfter.model
    && reloadFrame.currentEffort === persistedAfter.effort,
    { expected: persistedAfter, wsAfterReload: { current: reloadFrame.current, model: reloadFrame.currentModel, effort: reloadFrame.currentEffort },
      uiCurrentRow: afterReload.providers.find((p) => p.current)?.id, uiModelValue: afterReload.model.value, uiEffortValue: afterReload.effort.value });

  writeFileSync(join(EV, "artifacts/track2-results.json"), JSON.stringify({ results, groundTruth: GROUND_TRUTH, persistedAfter }, null, 2));
} catch (err) {
  rec("T2-FATAL", false, err.message);
  writeFileSync(join(EV, "artifacts/track2-results.json"), JSON.stringify({ results, fatal: err.message, stack: err.stack }, null, 2));
  await shot(page, join(SHOTS, "t2-99-fatal.png")).catch(() => {});
} finally {
  await browser.close();
}

console.log("\n=== TRACK 2 SUMMARY ===");
for (const r of results) console.log(`${String(r.status).padEnd(6)} ${r.id}`);
