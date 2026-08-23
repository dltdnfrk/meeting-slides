// Real Chromium keyboard QA: no synthetic .click(), no sleeps.
// The operator TABS to Start, presses a real key, and we read the AX-relevant
// focus state after the authoritative live frame arrives.
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/public-test-harness.ts";

const h = createPublicTestHarness();
const b = await puppeteer.launch({ args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN });
const p = await b.newPage();
const waiters = new Map<string, () => void>();
await p.exposeFunction("__qaSettle", (t: string) => { waiters.get(t)?.(); });
await p.evaluateOnNewDocument(() => {
  (window as any).__qaAwait = (token: string, predicate: string) => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = () => {
      if (done) return true;
      let ok = false; try { ok = check() === true; } catch { ok = false; }
      if (!ok) return false;
      done = true; (window as any).__qaSettle(token); return true;
    };
    if (settle()) return;
    const o = new MutationObserver(() => { if (settle()) o.disconnect(); });
    o.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  };
});
await p.setViewport({ width: 1244, height: 836, deviceScaleFactor: 1 });
await p.goto(h.origin, { waitUntil: "load" });
await h.waitForClient();

let n = 0;
async function act(predicate: string, trigger: () => any, ms = 4000) {
  const token = `qa-${++n}`;
  const settled = new Promise<void>((r) => waiters.set(token, r));
  await p.evaluate((t, pr) => (window as any).__qaAwait(t, pr), token, predicate);
  await trigger();
  let timer: any;
  const bounded = new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`QA timeout: ${predicate}`)), ms); });
  try { await Promise.race([settled, bounded]); } finally { clearTimeout(timer); waiters.delete(token); }
}

const report: any = { steps: [] };

await act('document.querySelector(".app")?.dataset.capturePhase === "idle"',
  () => h.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" }));
report.steps.push({ step: "hydrated idle", ok: true });

// Real keyboard traversal to the Start control.
await p.evaluate(() => (document.body as HTMLElement).focus());
let tabs = 0, reached = false;
while (tabs < 40) {
  await p.keyboard.press("Tab"); tabs++;
  if (await p.evaluate(() => document.activeElement?.id) === "btn-record") { reached = true; break; }
}
report.steps.push({ step: "tabbed to Start with real Tab keys", tabPresses: tabs, reachedStart: reached });
if (!reached) { console.log(JSON.stringify(report, null, 2)); await b.close(); h.stop(); process.exit(1); }

// Focus ring must be visible on the keyboard-focused Start control.
report.startFocusVisible = await p.evaluate(() => {
  const el = document.getElementById("btn-record")!;
  const s = getComputedStyle(el);
  return { matchesFocusVisible: el.matches(":focus-visible"), outlineWidth: s.outlineWidth, boxShadow: s.boxShadow !== "none" };
});

// REAL key activation, and the real outbound product command.
const outbound = h.nextClientMessage();
await act('document.querySelector(".app")?.dataset.capturePhase === "starting"',
  () => p.keyboard.press("Enter"));
report.outboundCommand = await outbound;

await act('document.querySelector(".app")?.classList.contains("app--capturing") === true',
  () => h.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: Date.now() - 5000 }));

report.afterStart = await p.evaluate(() => {
  const stop = document.getElementById("btn-live-stop")!;
  const r = stop.getBoundingClientRect();
  const a = document.activeElement;
  const s = getComputedStyle(stop);
  return {
    activeTag: a?.tagName ?? null,
    activeId: a instanceof HTMLElement ? a.id : "",
    stopVisible: r.width > 0 && r.height > 0,
    stopFocused: a === stop,
    stopFocusVisible: stop.matches(":focus-visible"),
    stopAccessibleName: stop.getAttribute("aria-label"),
    stopTargetPx: { w: Math.round(r.width), h: Math.round(r.height) },
    focusRing: { outlineWidth: s.outlineWidth, boxShadow: s.boxShadow !== "none" },
    shell: (document.querySelector(".app") as HTMLElement).dataset.shell,
  };
});

// The focused Stop must actually end the recording via the keyboard alone.
const stopCmd = h.nextClientMessage();
await act('document.querySelector(".app")?.dataset.capturePhase === "stopping"',
  () => p.keyboard.press("Enter"));
report.stopCommand = await stopCmd;

report.verdict =
  report.afterStart.stopFocused === true &&
  report.afterStart.stopVisible === true &&
  (report.outboundCommand as any).action === "startCapture" &&
  (report.stopCommand as any).action === "stopCapture" ? "PASS" : "FAIL";

console.log(JSON.stringify(report, null, 2));
await b.close(); h.stop();
