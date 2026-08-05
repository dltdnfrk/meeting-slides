// Verifies persisted STT selection after a real QA-owned app/server restart.
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, shot, readSettingsState, openSettings, DESKTOP } from "./qa-lib.mjs";

const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa");
const SETTINGS = join(ROOT, ".meeting-slides/stt-settings.json");
const STT_DIR = join(ROOT, "models/stt");
const expected = "large-v3";
const browser = await launch();
try {
  const page = await openApp(browser, DESKTOP);
  await openSettings(page);
  await page.waitForFunction((id) => document.querySelector(`.stt-row[data-id="${id}"]`)?.dataset.status === "selected", { timeout: 15000, polling: "mutation" }, expected);
  const state = await readSettingsState(page);
  const persisted = JSON.parse(readFileSync(SETTINGS, "utf8"));
  const partials = readdirSync(STT_DIR).filter((name) => name.includes(".part-") || name.endsWith(".part") || name.endsWith(".partial"));
  const selected = state.stt.filter((row) => row.status === "selected");
  const pass = selected.length === 1 && selected[0].id === expected && persisted.selectedModelId === expected && partials.length === 0;
  const result = {
    capturedAt: new Date().toISOString(),
    status: pass ? "PASS" : "FAIL",
    requirement: "T3.18-selection-survives-real-app-restart",
    expected,
    persisted,
    ui: state.stt.map(({ id, status, badge }) => ({ id, status, badge })),
    partials,
  };
  await shot(page, join(EV, "screens/t3-09-stt-selection-after-restart.png"));
  writeFileSync(join(EV, "artifacts/track3-restart-persistence.json"), JSON.stringify(result, null, 2));
  console.log(`[${result.status}] ${result.requirement}`);
  if (!pass) process.exitCode = 1;
} finally {
  await browser.close();
}
