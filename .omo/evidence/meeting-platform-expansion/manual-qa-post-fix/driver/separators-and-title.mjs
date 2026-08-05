import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, selectMeeting, DESKTOP } from "./qa-lib.mjs";
const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa-post-fix");
const browser = await launch();
const page = await openApp(browser, DESKTOP);
const output = { capturedAt: new Date().toISOString(), separators: [], koreanTitle: null };
async function attrs(id) {
  return page.$eval(`#${id}`, el => ({ id: el.id, role: el.getAttribute("role"), orientation: el.getAttribute("aria-orientation"), min: Number(el.getAttribute("aria-valuemin")), max: Number(el.getAttribute("aria-valuemax")), now: Number(el.getAttribute("aria-valuenow")), active: document.activeElement === el }));
}
async function pressAndAwait(id, key) {
  const before = await attrs(id);
  await page.evaluate((target, oldNow) => {
    const el = document.getElementById(target);
    window.__qaSeparatorChange = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`${target} ${oldNow} did not change`)); }, 5000);
      const observer = new MutationObserver(() => {
        const now = Number(el.getAttribute("aria-valuenow"));
        if (now !== oldNow) { clearTimeout(timer); observer.disconnect(); resolve(now); }
      });
      observer.observe(el, { attributes: true, attributeFilter: ["aria-valuenow"] });
    });
  }, id, before.now);
  await page.keyboard.press(key);
  await page.evaluate(() => window.__qaSeparatorChange);
  return attrs(id);
}
try {
  await selectMeeting(page, 28);
  output.koreanTitle = await page.evaluate(() => {
    const row = document.querySelector('.session-row[data-meeting-id="28"] .session-row__title');
    const text = row.textContent.trim();
    const idx = text.lastIndexOf("논의");
    const charRect = (i) => { const r = document.createRange(); r.setStart(row.firstChild, i); r.setEnd(row.firstChild, i + 1); const b = r.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
    const non = charRect(idx), ui = charRect(idx + 1);
    return { text, idx, non, ui, sameLine: Math.abs(non.top - ui.top) < 1, contiguous: ui.left >= non.right - 1 };
  });
  if (!output.koreanTitle.sameLine || !output.koreanTitle.contiguous) throw new Error(`Korean title split: ${JSON.stringify(output.koreanTitle)}`);
  const arrowKeys = {
    "splitter-rail": "ArrowRight",
    "splitter-transcript": "ArrowLeft",
    "transcript-grip-s": "ArrowUp",
    "transcript-grip-sw": "ArrowUp",
  };
  for (const id of Object.keys(arrowKeys)) {
    await page.evaluate(() => {
      localStorage.removeItem("workspace.layout.v1");
      localStorage.removeItem("workspace.transcript.v1");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__qa?.socket?.readyState === 1 && window.__qa.frames.some((f) => f.type === "meetings"), { timeout: 20000, polling: "mutation" });
    await page.focus(`#${id}`);
    const initial = await attrs(id);
    const arrowKey = arrowKeys[id];
    const arrow = await pressAndAwait(id, arrowKey);
    const home = await pressAndAwait(id, "Home");
    const end = await pressAndAwait(id, "End");
    const valid = initial.role === "separator" && initial.active && initial.min < initial.max && arrow.now !== initial.now && home.now === home.min && end.now === end.max;
    output.separators.push({ id, arrowKey, initial, arrow, home, end, valid });
    if (!valid) throw new Error(`separator contract failed: ${id}`);
  }
  output.status = "PASS";
} catch (error) {
  output.status = "FAIL"; output.error = error.message; output.stack = error.stack; process.exitCode = 1;
} finally {
  writeFileSync(join(EV, "artifacts/separator-keyboard-aria.json"), JSON.stringify(output, null, 2));
  await browser.close();
}
console.log(JSON.stringify(output, null, 2));
