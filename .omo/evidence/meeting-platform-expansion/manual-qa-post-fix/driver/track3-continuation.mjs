// Continuation-only QA for the interrupted Track 3 boundary.
// Drives the real browser UI; does not redownload already-installed artifacts.
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
  launch, openApp, shot, frameCursor, waitForFrame,
  readSettingsState, openSettings, DESKTOP,
} from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa-post-fix");
const STT_DIR = join(ROOT, "models/stt");
const SETTINGS = join(ROOT, ".meeting-slides/stt-settings.json");
const ORDER = ["small", "medium", "large-v3-turbo", "large-v3"];
const CATALOG = {
  small: { file: "ggml-small-q8_0.bin", size: 264464607, sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f" },
  medium: { file: "ggml-medium-q8_0.bin", size: 823369779, sha256: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502" },
  "large-v3-turbo": { file: "ggml-large-v3-turbo-q8_0.bin", size: 874188075, sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1" },
  "large-v3": { file: "ggml-large-v3-q8_0.bin", size: 1656538283, sha256: "24bc434f372355688ab9a623077a63e5361a1c41f4d8d648977e39f9b060f09e" },
};
const sha256File = (path) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
});
const results = [];
const record = (id, pass, detail) => {
  results.push({ id, status: pass ? "PASS" : "FAIL", detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id}`);
};

const disk = {};
for (const id of ORDER) {
  const expected = CATALOG[id];
  const path = join(STT_DIR, expected.file);
  disk[id] = {
    path,
    exists: existsSync(path),
    size: existsSync(path) ? statSync(path).size : null,
    sha256: existsSync(path) ? await sha256File(path) : null,
  };
}
const partials = readdirSync(STT_DIR).filter((name) => name.includes(".part-") || name.endsWith(".part") || name.endsWith(".partial"));
record("T3.8-download-large-v3-final-present", disk["large-v3"].exists, disk["large-v3"]);
record("T3.9-size-exact-large-v3", disk["large-v3"].size === CATALOG["large-v3"].size, { onDisk: disk["large-v3"].size, expected: CATALOG["large-v3"].size });
record("T3.10-sha256-exact-large-v3", disk["large-v3"].sha256 === CATALOG["large-v3"].sha256, { onDisk: disk["large-v3"].sha256, expected: CATALOG["large-v3"].sha256 });
record("T3.11-no-partial-large-v3", partials.length === 0, { partials });

const browser = await launch();
try {
  const page = await openApp(browser, DESKTOP);
  await openSettings(page);
  await page.waitForFunction(() => document.querySelectorAll("#stt-list .stt-row").length === 4, { timeout: 15000, polling: "mutation" });
  const initial = await readSettingsState(page);
  record("T3.12-all-four-installed-in-ui", initial.stt.every((row) => ["installed", "selected"].includes(row.status)), initial.stt.map(({ id, status, badge }) => ({ id, status, badge })));
  await shot(page, join(EV, "screens/t3-05-stt-all-installed.png"));

  const selectionCycle = [];
  for (const id of ORDER) {
    const cursor = await frameCursor(page);
    await page.click(`.stt-row[data-id="${id}"] .stt-row__select`);
    await waitForFrame(page, cursor, `(f) => f.type === "sttModels" && f.models.some((m) => m.id === "${id}" && m.status === "selected")`, 30000);
    await page.waitForFunction((selectedId) => {
      const rows = [...document.querySelectorAll("#stt-list .stt-row")];
      return rows.find((row) => row.dataset.id === selectedId)?.dataset.status === "selected"
        && rows.filter((row) => row.dataset.status === "selected").length === 1;
    }, { timeout: 10000, polling: "mutation" }, id);
    const state = await readSettingsState(page);
    const persisted = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const detail = { id, selectedCount: state.stt.filter((row) => row.status === "selected").length, persisted };
    selectionCycle.push(detail);
    record(`T3.13-select-${id}-through-ui`, detail.selectedCount === 1 && persisted.selectedModelId === id, detail);
  }
  await shot(page, join(EV, "screens/t3-06-stt-all-model-selection-final.png"));

  const cursor = await frameCursor(page);
  await page.click("#btn-recheck-stt");
  const recheckFrame = await waitForFrame(page, cursor, `(f) => f.type === "sttModels" && f.models.length === 4`, 30000);
  await page.waitForFunction(() => [...document.querySelectorAll("#stt-list .stt-row")].every((row) => ["installed", "selected"].includes(row.dataset.status)), { timeout: 10000, polling: "mutation" });
  const afterRecheck = await readSettingsState(page);
  const recheckPass = recheckFrame.models.every((model) => ["installed", "selected"].includes(model.status))
    && afterRecheck.stt.filter((row) => row.status === "selected").length === 1
    && JSON.parse(readFileSync(SETTINGS, "utf8")).selectedModelId === "large-v3";
  record("T3.17-recheck-matches-disk-and-keeps-selection", recheckPass, { ws: recheckFrame.models.map(({ id, status }) => ({ id, status })), ui: afterRecheck.stt.map(({ id, status }) => ({ id, status })) });
  await shot(page, join(EV, "screens/t3-08-stt-after-recheck.png"));

  writeFileSync(join(EV, "artifacts/track3-continuation.json"), JSON.stringify({ capturedAt: new Date().toISOString(), disk, partials, selectionCycle, selectedBeforeRestart: JSON.parse(readFileSync(SETTINGS, "utf8")), results }, null, 2));
  if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
} finally {
  await browser.close();
}
