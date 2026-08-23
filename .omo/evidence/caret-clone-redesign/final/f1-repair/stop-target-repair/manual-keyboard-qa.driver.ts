// Real Chromium keyboard/focus QA for the #btn-live-stop 44px target repair.
// No synthetic .click(), no sleeps: every awaited state is armed with a
// MutationObserver BEFORE its trigger and bounded by a named timeout.
//
// Proves at BOTH canonical desktop widths that:
//   - the user-Start focus handoff still lands on Stop (preserved behaviour),
//   - the focused Stop is >= 44x44 CSS px and hit-testable at its edges,
//   - the glyph/label did NOT inflate with the hit area,
//   - Enter on the focused Stop still emits the real stopCapture command,
//   - the shell gains no horizontal overflow.
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/public-test-harness.ts";

const OUT = "/Users/hyunjun/Documents/MUNI/meeting-slides/.omo/evidence/caret-clone-redesign/final/f1-repair/stop-target-repair/screenshots";
const WIDTHS = [{ width: 1244, height: 836 }, { width: 1440, height: 900 }];

const h = createPublicTestHarness();
const b = await puppeteer.launch({ args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN });

const report: any = { viewports: [] };

for (const vp of WIDTHS) {
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
  await p.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
  await p.goto(h.origin, { waitUntil: "load" });
  await h.waitForClient();
  await p.evaluate(async () => { await document.fonts.ready; });

  let n = 0;
  async function act(predicate: string, trigger: () => any, ms = 4000) {
    const token = `qa-${vp.width}-${++n}`;
    const settled = new Promise<void>((r) => waiters.set(token, r));
    await p.evaluate((t, pr) => (window as any).__qaAwait(t, pr), token, predicate);
    await trigger();
    let timer: any;
    const bounded = new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`QA timeout: ${predicate}`)), ms); });
    try { await Promise.race([settled, bounded]); } finally { clearTimeout(timer); waiters.delete(token); }
  }

  const entry: any = { viewport: `${vp.width}x${vp.height}`, steps: [] };

  await act('document.querySelector(".app")?.dataset.capturePhase === "idle"',
    () => h.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" }));
  entry.steps.push({ step: "hydrated idle", ok: true });

  // Real keyboard traversal to the Start control.
  await p.evaluate(() => (document.body as HTMLElement).focus());
  let tabs = 0, reached = false;
  while (tabs < 40) {
    await p.keyboard.press("Tab"); tabs++;
    if (await p.evaluate(() => document.activeElement?.id) === "btn-record") { reached = true; break; }
  }
  entry.steps.push({ step: "tabbed to Start with real Tab keys", tabPresses: tabs, reachedStart: reached });
  if (!reached) { entry.verdict = "FAIL"; report.viewports.push(entry); await p.close(); continue; }

  // REAL key activation, and the real outbound product command.
  const outbound = h.nextClientMessage();
  await act('document.querySelector(".app")?.dataset.capturePhase === "starting"',
    () => p.keyboard.press("Enter"));
  entry.outboundCommand = await outbound;

  await act('document.querySelector(".app")?.classList.contains("app--capturing") === true',
    () => h.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: Date.now() - 5000 }));
  await act('document.querySelector("#current-slide .slide__title") !== null',
    () => h.pushMessage({
      type: "slide",
      current: {
        index: 3, startedAt: Date.now() - 60000, sentenceCount: 9, kind: "topic",
        title: "온보딩 지표 점검과 다음 스프린트 범위 확정", kicker: "제품 로드맵",
        bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
        emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
      },
      history: [],
    }));

  entry.afterStart = await p.evaluate(() => {
    const stop = document.getElementById("btn-live-stop")!;
    const dot = document.querySelector<HTMLElement>(".live-topbar__stop-dot")!;
    const capsule = document.querySelector<HTMLElement>(".live-topbar__capsule")!;
    const topbar = document.getElementById("live-topbar")!;
    const stage = document.getElementById("stage-pane")!;
    const r = stop.getBoundingClientRect();
    const d = dot.getBoundingClientRect();
    const a = document.activeElement;
    const s = getComputedStyle(stop);
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const probes = [
      { name: "top", x: cx, y: r.y + 1 },
      { name: "bottom", x: cx, y: r.bottom - 1 },
      { name: "left", x: r.x + 1, y: cy },
      { name: "right", x: r.right - 1, y: cy },
    ];
    const edgeMisses = probes.filter((pr) => {
      const stack = document.elementsFromPoint(Math.round(pr.x), Math.round(pr.y));
      return !stack.some((node) => node === stop || stop.contains(node));
    }).map((pr) => pr.name);
    return {
      activeId: a instanceof HTMLElement ? a.id : "",
      stopFocused: a === stop,
      stopFocusVisible: stop.matches(":focus-visible"),
      stopAccessibleName: stop.getAttribute("aria-label"),
      stopTargetPx: { w: Math.round(r.width), h: Math.round(r.height) },
      meets44: r.width >= 43.5 && r.height >= 43.5,
      edgeMisses,
      // Visual density guards.
      glyphPx: { w: Math.round(d.width), h: Math.round(d.height) },
      labelFontSizePx: Math.round(parseFloat(s.fontSize)),
      capsuleHeightPx: Math.round(capsule.getBoundingClientRect().height),
      // Layout guards.
      topbarOverflow: topbar.scrollWidth - topbar.clientWidth,
      capsuleWithinStage:
        capsule.getBoundingClientRect().right <= stage.getBoundingClientRect().right + 1,
      rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      focusRing: { outlineWidth: s.outlineWidth },
      shell: (document.querySelector(".app") as HTMLElement).dataset.shell,
    };
  });

  await p.screenshot({ path: `${OUT}/live-stop-${vp.width}x${vp.height}.png` });
  const stopBox = await p.evaluate(() => {
    const r = document.getElementById("live-topbar")!.getBoundingClientRect();
    return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await p.screenshot({ path: `${OUT}/live-topbar-closeup-${vp.width}x${vp.height}.png`, clip: stopBox });

  // The focused Stop must still end the recording via the keyboard alone.
  const stopCmd = h.nextClientMessage();
  await act('document.querySelector(".app")?.dataset.capturePhase === "stopping"',
    () => p.keyboard.press("Enter"));
  entry.stopCommand = await stopCmd;

  entry.verdict =
    entry.afterStart.stopFocused === true &&
    entry.afterStart.meets44 === true &&
    entry.afterStart.edgeMisses.length === 0 &&
    entry.afterStart.glyphPx.w === 8 && entry.afterStart.glyphPx.h === 8 &&
    entry.afterStart.labelFontSizePx <= 13 &&
    entry.afterStart.topbarOverflow <= 0 &&
    entry.afterStart.rootOverflow <= 0 &&
    entry.afterStart.capsuleWithinStage === true &&
    (entry.outboundCommand as any).action === "startCapture" &&
    (entry.stopCommand as any).action === "stopCapture" ? "PASS" : "FAIL";

  report.viewports.push(entry);
  await p.close();
}

report.verdict = report.viewports.every((v: any) => v.verdict === "PASS") ? "PASS" : "FAIL";
console.log(JSON.stringify(report, null, 2));
await b.close(); h.stop();
