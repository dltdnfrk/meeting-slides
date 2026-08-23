import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../tests/public-test-harness.ts";
const FIXED = 1_710_376_860_000;
const h = createPublicTestHarness();
const b = await puppeteer.launch({ args: ["--no-sandbox","--force-device-scale-factor=1"] });
const settle = (p: any, s: string) => p.evaluate((q: string) => new Promise<void>((r) => {
  const c = new Function(`return (${q});`) as () => boolean;
  if (c()) return r();
  const o = new MutationObserver(() => { if (c()) { o.disconnect(); r(); } });
  o.observe(document.documentElement, {subtree:true,childList:true,attributes:true,characterData:true});
}), s);
const read = () => {
  const per = (el: HTMLElement | null) => {
    if (!el || el.hidden) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const g = (id: string) => document.getElementById(id) as HTMLElement | null;
  const box = (id: string) => { const e = g(id); if (!e) return null; const r = e.getBoundingClientRect();
    return {w: Math.round(r.width), h: Math.round(r.height)}; };
  return {
    shell: (document.querySelector(".app") as HTMLElement).dataset.shell,
    phase: (document.querySelector(".app") as HTMLElement).dataset.capturePhase,
    stops: ["btn-live-stop","btn-record"].filter((i) => per(g(i))),
    stopLabels: ["btn-live-stop","btn-record"].map((i) => ({id:i, per: per(g(i)),
      label: g(i)?.getAttribute("aria-label"), disabled: (g(i) as HTMLButtonElement)?.disabled ?? null})),
    timers: ["live-topbar-timer","capture-timer"].filter((i) => per(g(i))),
    timerTexts: ["live-topbar-timer","capture-timer"].map((i) => ({id:i, per: per(g(i)), text: g(i)?.textContent?.trim()})),
    targets: ["btn-live-stop","btn-settings","btn-attendees","btn-record"].map((i) => ({id:i, per: per(g(i)), box: box(i)})),
  };
};
const out: Record<string, unknown> = {};
for (const [w,hh] of [[1244,836],[375,812],[320,667]] as const) {
  for (const phase of ["library","starting","capturing","stopping"] as const) {
    const p = await b.newPage();
    // Freeze the clock BEFORE any page script, so the rendered timer is the
    // deterministic 02:05 the fixture's startedAt implies rather than real time.
    await p.evaluateOnNewDocument((now: number) => {
      const D = Date;
      class F extends D {
        constructor(...a: unknown[]) { if (a.length === 0) super(now); else super(...(a as ConstructorParameters<typeof Date>)); }
        static override now() { return now; }
      }
      (globalThis as unknown as { Date: DateConstructor }).Date = F as unknown as DateConstructor;
    }, FIXED);
    await p.emulateTimezone("Asia/Seoul");
    await p.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
    await p.setViewport({width:w,height:hh,deviceScaleFactor:1});
    await p.goto(h.origin,{waitUntil:"load"});
    await h.waitForClient();
    await p.evaluate(async()=>{await document.fonts.ready;});
    if (phase !== "library") {
      h.pushMessage({type:"capture",capturing:false,mode:"mic",phase:"starting"});
      await settle(p,'document.querySelector(".app")?.dataset.capturePhase === "starting"');
    }
    if (phase === "capturing" || phase === "stopping") {
      h.pushMessage({type:"capture",capturing:true,mode:"mic",phase:"capturing",startedAt:FIXED-125000});
      await settle(p,'document.querySelector(".app")?.classList.contains("app--capturing") === true');
    }
    if (phase === "stopping") {
      h.pushMessage({type:"capture",capturing:true,mode:"mic",phase:"stopping"});
      await settle(p,'document.querySelector(".app")?.dataset.capturePhase === "stopping"');
    }
    out[`${w}-${phase}`] = await p.evaluate(read);
    const ax = await p.accessibility.snapshot({ interestingOnly: true });
    (out[`${w}-${phase}`] as any).axNamedNodes = (JSON.stringify(ax).match(/"name":"[^"]*"/g) || []).length;
    await p.screenshot({ path: `.omo/evidence/caret-clone-redesign/task-13/green/shots-revised/${w}-${phase}.png` });
    await p.close();
  }
}
console.log(JSON.stringify(out,null,2));
await b.close(); h.stop();
