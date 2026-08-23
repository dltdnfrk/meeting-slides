import puppeteer from "puppeteer";
import { createPublicTestHarness } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/public-test-harness.ts";
const NOW = 1_710_376_860_000;
const h = createPublicTestHarness();
const b = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1"] });
const page = await b.newPage();
const waiters = new Map<string, () => void>();
await page.exposeFunction("__rv", (t: string) => waiters.get(t)?.());
await page.evaluateOnNewDocument((fixed: number) => {
  const O = Date; class F extends O { constructor(...a: any[]) { a.length === 0 ? super(fixed) : super(...(a as [])); } static override now() { return fixed; } }
  (globalThis as any).Date = F;
  (globalThis as any).__arm = (t: string, e: string) => {
    const test = new Function(`return (${e})`);
    const ob = new MutationObserver(() => { if (test()) { ob.disconnect(); (globalThis as any).__rv(t); } });
    ob.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    if (test()) { ob.disconnect(); (globalThis as any).__rv(t); }
  };
}, NOW);
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto(h.origin, { waitUntil: "load" });
await h.waitForClient();
let n = 0;
const act = async (p: string, t: () => void | Promise<void>) => {
  const k = `k${++n}`; const s = new Promise<void>((r) => waiters.set(k, r));
  await page.evaluate((a, e) => (globalThis as any).__arm(a, e), k, p);
  await t();
  let tm: any; try { await Promise.race([s, new Promise<never>((_, rj) => { tm = setTimeout(() => rj(new Error("to:"+p)), 8000); })]); } finally { clearTimeout(tm); waiters.delete(k); }
};
await act('document.querySelector(".app")?.classList.contains("app--capturing") === true', () => h.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing", startedAt: NOW - 125000 }));
console.log(JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("button")).filter((el)=>{
  const s=getComputedStyle(el); if(s.display==="none"||s.visibility==="hidden") return false;
  const m=/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s.backgroundColor); if(!m) return false;
  const [r,g,bl]=[+m[1],+m[2],+m[3]]; return r>180&&g>70&&g<160&&bl>50&&bl<140;
}).map((el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return {id:el.id,cls:el.className,text:(el.textContent??"").trim().slice(0,24),bg:s.backgroundColor,w:+r.width.toFixed(1),h:+r.height.toFixed(1),opacity:s.opacity,inViewport:r.bottom>0&&r.top<window.innerHeight&&r.right>0&&r.left<window.innerWidth};})), null, 2));
await b.close(); h.stop();
