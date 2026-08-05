// Track 3: STT model lifecycle through the real settings UI.
// Real downloads against the official artifacts. No mocks, no substituted files.
// Every wait is armed on an exact DOM/WS/file predicate and bounded.
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
  launch, openApp, shot, frameCursor, waitForFrame, collectFrames,
  readSettingsState, openSettings, DESKTOP,
} from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa");
const SHOTS = join(EV, "screens");
const STT_DIR = join(ROOT, "models/stt");
const STT_SETTINGS = join(ROOT, ".meeting-slides/stt-settings.json");

const CATALOG = {
  small: { file: "ggml-small-q8_0.bin", size: 264_464_607, sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f", label: "Small (Q8_0)", license: "MIT" },
  medium: { file: "ggml-medium-q8_0.bin", size: 823_369_779, sha256: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502", label: "Medium (Q8_0)", license: "MIT" },
  "large-v3-turbo": { file: "ggml-large-v3-turbo-q8_0.bin", size: 874_188_075, sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1", label: "Large v3 Turbo (Q8_0)", license: "MIT" },
  "large-v3": { file: "ggml-large-v3-q8_0.bin", size: 1_656_538_283, sha256: "24bc434f372355688ab9a623077a63e5361a1c41f4d8d648977e39f9b060f09e", label: "Large v3 (Q8_0)", license: "Apache-2.0" },
};
const ORDER = ["small", "medium", "large-v3-turbo", "large-v3"];

const results = [];
const rec = (id, ok, detail) => {
  const status = ok === true ? "PASS" : ok === false ? "FAIL" : String(ok);
  results.push({ id, status, detail });
  console.log(`[${status}] ${id} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
};
const partials = () => readdirSync(STT_DIR).filter((n) => n.includes(".part-"));
const sha256File = (p) => new Promise((res, rej) => {
  const h = createHash("sha256");
  createReadStream(p).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej);
});
const readSttSettings = () => (existsSync(STT_SETTINGS) ? JSON.parse(readFileSync(STT_SETTINGS, "utf-8")) : null);

const browser = await launch();
let page = await openApp(browser, DESKTOP);
const timeline = [];

try {
  await openSettings(page);
  await page.waitForFunction(() => document.querySelectorAll("#stt-list .stt-row").length >= 4,
    { timeout: 15_000, polling: "mutation" });

  // ── 3.1 all four cards + metadata ──
  const s0 = await readSettingsState(page);
  await shot(page, join(SHOTS, "t3-01-stt-all-four-absent.png"));
  rec("T3.1-four-cards-present",
    s0.stt.length === 4 && ORDER.every((id, i) => s0.stt[i].id === id),
    s0.stt.map((r) => ({ id: r.id, status: r.status, badge: r.badge })));
  rec("T3.2-card-metadata-truthful",
    s0.stt.every((r) => {
      const c = CATALOG[r.id];
      return r.name === c.label && r.meta.includes(c.license);
    }),
    s0.stt.map((r) => ({ id: r.id, name: r.name, meta: r.meta })));
  rec("T3.3-absent-state-matches-disk",
    s0.stt.every((r) => (existsSync(join(STT_DIR, CATALOG[r.id].file)) ? r.status !== "absent" : r.status === "absent")),
    { diskFiles: readdirSync(STT_DIR), uiStatuses: s0.stt.map((r) => `${r.id}:${r.status}`) });

  // ── 3.2 cancel an active download and verify cleanup (do it on large-v3 first) ──
  const cancelId = "large-v3";
  let cur = await frameCursor(page);
  await page.click(`.stt-row[data-id="${cancelId}"] .stt-row__install`);
  // Armed on real progress bytes, not a timer: wait until the stream is genuinely flowing.
  await waitForFrame(page, cur,
    `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${cancelId}" && m.status === "downloading" && m.receivedBytes > 4000000)`,
    90_000);
  await page.waitForFunction((id) => document.querySelector(`.stt-row[data-id="${id}"]`)?.dataset.status === "downloading",
    { timeout: 10_000, polling: "mutation" }, cancelId);
  const dlState = await readSettingsState(page);
  const partialsDuring = partials();
  await shot(page, join(SHOTS, "t3-02-stt-downloading-progress.png"));
  rec("T3.4-download-progress-observable",
    dlState.stt.find((r) => r.id === cancelId)?.status === "downloading"
    && dlState.stt.find((r) => r.id === cancelId)?.progressNow !== null,
    { row: dlState.stt.find((r) => r.id === cancelId), partialFilesOnDisk: partialsDuring });
  rec("T3.5-partial-file-is-hidden-temp",
    partialsDuring.length === 1 && partialsDuring[0].startsWith(`.${CATALOG[cancelId].file}.part-`),
    { partials: partialsDuring });

  cur = await frameCursor(page);
  await page.click(`.stt-row[data-id="${cancelId}"] .stt-row__cancel`);
  await waitForFrame(page, cur,
    `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${cancelId}" && m.status === "absent")`,
    30_000);
  await page.waitForFunction((id) => document.querySelector(`.stt-row[data-id="${id}"]`)?.dataset.status === "absent",
    { timeout: 10_000, polling: "mutation" }, cancelId);
  const afterCancel = await readSettingsState(page);
  await shot(page, join(SHOTS, "t3-03-stt-cancelled-cleanup.png"));
  rec("T3.6-cancel-returns-to-absent",
    afterCancel.stt.find((r) => r.id === cancelId)?.status === "absent"
    && afterCancel.stt.find((r) => r.id === cancelId)?.badge === "미설치",
    afterCancel.stt.find((r) => r.id === cancelId));
  rec("T3.7-cancel-cleans-partial-and-installs-nothing",
    partials().length === 0 && !existsSync(join(STT_DIR, CATALOG[cancelId].file)),
    { partialsAfter: partials(), finalFileExists: existsSync(join(STT_DIR, CATALOG[cancelId].file)), dir: readdirSync(STT_DIR) });

  // ── 3.3 real downloads of all four, verified byte-exact + SHA-256 ──
  for (const id of ORDER) {
    const c = CATALOG[id];
    const dest = join(STT_DIR, c.file);
    const t0 = Date.now();
    cur = await frameCursor(page);
    await page.click(`.stt-row[data-id="${id}"] .stt-row__install`);
    // Bounded wait armed on the real installed/failed transition.
    const done = await waitForFrame(page, cur,
      `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${id}" && (m.status === "installed" || m.status === "selected" || m.status === "failed"))`,
      600_000);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const model = done.models.find((m) => m.id === id);
    const progressFrames = await collectFrames(page, cur,
      `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${id}" && m.status === "downloading")`);
    const maxPct = progressFrames.reduce((a, f) => {
      const m = f.models.find((x) => x.id === id);
      return Math.max(a, m?.totalBytes ? Math.round((m.receivedBytes / m.totalBytes) * 100) : 0);
    }, 0);

    if (model.status === "failed") {
      rec(`T3.8-download-${id}`, false, { status: "failed", error: model.error, elapsedSec: elapsed });
      timeline.push({ id, status: "failed", error: model.error, elapsedSec: elapsed });
      continue;
    }

    await page.waitForFunction((mid) => ["installed", "selected"].includes(document.querySelector(`.stt-row[data-id="${mid}"]`)?.dataset.status),
      { timeout: 15_000, polling: "mutation" }, id);
    const size = statSync(dest).size;
    const digest = await sha256File(dest);
    const leftover = partials();
    timeline.push({ id, elapsedSec: elapsed, size, sha256: digest, maxProgressPct: maxPct, progressFrames: progressFrames.length });

    rec(`T3.8-download-${id}`, model.status === "installed" || model.status === "selected",
      { wsStatus: model.status, elapsedSec: elapsed, progressFrameCount: progressFrames.length, maxProgressPct: maxPct });
    rec(`T3.9-size-exact-${id}`, size === c.size, { onDisk: size, expected: c.size });
    rec(`T3.10-sha256-exact-${id}`, digest === c.sha256, { onDisk: digest, expected: c.sha256 });
    rec(`T3.11-no-partial-${id}`, leftover.length === 0, { partials: leftover });
    await shot(page, join(SHOTS, `t3-04-installed-${id}.png`));
  }

  const allInstalled = await readSettingsState(page);
  await shot(page, join(SHOTS, "t3-05-stt-all-installed.png"));
  rec("T3.12-all-four-installed-in-ui",
    allInstalled.stt.every((r) => ["installed", "selected"].includes(r.status)),
    allInstalled.stt.map((r) => ({ id: r.id, status: r.status, badge: r.badge })));

  // ── 3.4 select a model through the UI; verify persistence file + selected-only-one ──
  const selectId = "medium";
  cur = await frameCursor(page);
  await page.click(`.stt-row[data-id="${selectId}"] .stt-row__select`);
  await waitForFrame(page, cur,
    `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${selectId}" && m.status === "selected")`,
    30_000);
  await page.waitForFunction((id) => document.querySelector(`.stt-row[data-id="${id}"]`)?.dataset.status === "selected",
    { timeout: 10_000, polling: "mutation" }, selectId);
  const sel = await readSettingsState(page);
  await shot(page, join(SHOTS, "t3-06-stt-selected-medium.png"));
  rec("T3.13-select-model-ui",
    sel.stt.find((r) => r.id === selectId)?.status === "selected"
    && sel.stt.find((r) => r.id === selectId)?.badge === "사용 중"
    && sel.stt.find((r) => r.id === selectId)?.actions[0]?.disabled === true,
    sel.stt.find((r) => r.id === selectId));
  rec("T3.14-exactly-one-selected",
    sel.stt.filter((r) => r.status === "selected").length === 1,
    sel.stt.map((r) => `${r.id}:${r.status}`));
  rec("T3.15-selection-persisted-to-disk",
    readSttSettings()?.selectedModelId === selectId,
    { file: STT_SETTINGS, contents: readSttSettings() });

  // switch selection to prove the previous card returns to installed
  const selectId2 = "large-v3-turbo";
  cur = await frameCursor(page);
  await page.click(`.stt-row[data-id="${selectId2}"] .stt-row__select`);
  await waitForFrame(page, cur,
    `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${selectId2}" && m.status === "selected")`,
    30_000);
  await page.waitForFunction((a, b) => document.querySelector(`.stt-row[data-id="${b}"]`)?.dataset.status === "selected"
    && document.querySelector(`.stt-row[data-id="${a}"]`)?.dataset.status === "installed",
    { timeout: 10_000, polling: "mutation" }, selectId, selectId2);
  const sel2 = await readSettingsState(page);
  await shot(page, join(SHOTS, "t3-07-stt-selection-switched.png"));
  rec("T3.16-selection-switch-releases-previous",
    sel2.stt.find((r) => r.id === selectId)?.status === "installed"
    && sel2.stt.find((r) => r.id === selectId2)?.status === "selected"
    && readSttSettings()?.selectedModelId === selectId2,
    { previous: sel2.stt.find((r) => r.id === selectId)?.status, now: sel2.stt.find((r) => r.id === selectId2)?.status, persisted: readSttSettings() });

  // ── 3.5 recheck reflects disk truth ──
  cur = await frameCursor(page);
  await page.click("#btn-recheck-stt");
  const reFrame = await waitForFrame(page, cur, `(f) => f.type === "sttModels"`, 30_000);
  const re = await readSettingsState(page);
  await shot(page, join(SHOTS, "t3-08-stt-after-recheck.png"));
  rec("T3.17-recheck-matches-disk",
    reFrame.models.every((m) => {
      const onDisk = existsSync(join(STT_DIR, CATALOG[m.id].file)) && statSync(join(STT_DIR, CATALOG[m.id].file)).size === CATALOG[m.id].size;
      return onDisk ? ["installed", "selected"].includes(m.status) : m.status === "absent";
    }),
    { wsStatuses: reFrame.models.map((m) => `${m.id}:${m.status}`), diskFiles: readdirSync(STT_DIR).sort() });

  writeFileSync(join(EV, "artifacts/track3-stt-timeline.json"), JSON.stringify({ timeline, results }, null, 2));
  writeFileSync(join(EV, "artifacts/track3-stt-selection-before-restart.json"),
    JSON.stringify({ selected: readSttSettings(), uiStatuses: re.stt.map((r) => ({ id: r.id, status: r.status })) }, null, 2));
} catch (err) {
  rec("T3-FATAL", false, err.message);
  writeFileSync(join(EV, "artifacts/track3-stt-timeline.json"), JSON.stringify({ timeline, results, fatal: err.message, stack: err.stack }, null, 2));
  await shot(page, join(SHOTS, "t3-99-fatal.png")).catch(() => {});
} finally {
  await browser.close();
}

console.log("\n=== TRACK 3 SUMMARY ===");
for (const r of results) console.log(`${String(r.status).padEnd(6)} ${r.id}`);
