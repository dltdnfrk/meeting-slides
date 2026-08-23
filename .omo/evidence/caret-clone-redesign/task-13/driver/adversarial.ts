import { writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../tests/public-test-harness.ts";
const FIXED=1710376860000;
const STARTING={type:"capture",capturing:false,mode:"mic",phase:"starting"} as const;
const LIVE={type:"capture",capturing:true,mode:"mic",phase:"capturing",startedAt:FIXED-125000} as const;
const IDLE={type:"capture",capturing:false,mode:"mic",phase:"idle"} as const;
const h=createPublicTestHarness();
const b=await puppeteer.launch({args:["--no-sandbox"]});
const R:Record<string,unknown>={};
const mk=async(w=1244,hh=836)=>{const p=await b.newPage();
  await p.evaluateOnNewDocument((n:number)=>{const D=Date;class F extends D{
    constructor(...a:unknown[]){if(a.length===0)super(n);else super(...(a as ConstructorParameters<typeof Date>));}
    static override now(){return n;}}
    (globalThis as unknown as {Date:DateConstructor}).Date=F as unknown as DateConstructor;},FIXED);
  await p.setViewport({width:w,height:hh,deviceScaleFactor:1});
  await p.goto(h.origin,{waitUntil:"load"}); await h.waitForClient();
  await p.evaluate(async()=>{await document.fonts.ready;}); return p;};
const st=(p:any,s:string)=>p.evaluate((q:string)=>new Promise<void>((r)=>{const c=new Function(`return (${q});`) as ()=>boolean;
  if(c())return r();const o=new MutationObserver(()=>{if(c()){o.disconnect();r();}});
  o.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});}),s);
try{
 {const p=await mk(); const ids=["btn-record","btn-live-stop","btn-settings","btn-attendees","btn-review","btn-ask",
   "btn-compile-deck","btn-export-md","btn-export-json","btn-export-transcript","btn-export-deck","btn-export-pdf",
   "btn-export-png","btn-reset","dock-more","ask-panel","provider-panel","attendee-panel","review-panel",
   "current-slide","transcript-stream","session-list","notes-input","live-topbar-timer","capture-timer"];
  R["1-duplicate-ids"]=await p.evaluate((l:string[])=>({duplicates:l.filter((i)=>document.querySelectorAll(`#${CSS.escape(i)}`).length!==1),
   slideSurfaces:document.querySelectorAll("#current-slide").length,disclosures:document.querySelectorAll(".dock details").length}),ids);
  await p.close();}
 {const p=await mk(); await p.evaluate(()=>(document.querySelector("#dock-more > summary") as HTMLElement).click());
  R["2-hidden-capability"]=await p.evaluate(()=>["btn-compile-deck","btn-export-md","btn-export-json","btn-export-transcript",
   "btn-export-deck","btn-export-pdf","btn-export-png","btn-ask","btn-reset"].filter((id)=>{const e=document.getElementById(id)!;
   const s=getComputedStyle(e);return s.display==="none"||s.visibility==="hidden"||e.hidden;}));
  await p.close();}
 {const p=await mk(); await st(p,'document.documentElement.dataset.connection === "connected"');
  h.pushMessage(STARTING); await st(p,'document.querySelector(".app")?.dataset.capturePhase === "starting"');
  await p.evaluate(()=>(document.querySelector("#dock-more > summary") as HTMLElement).click());
  const opened=await p.evaluate(()=>(document.getElementById("dock-more") as HTMLDetailsElement).open);
  for(let i=0;i<3;i++) h.pushMessage(LIVE);
  await st(p,'document.querySelector(".app")?.classList.contains("app--capturing") === true');
  const after=await p.evaluate(()=>(document.getElementById("dock-more") as HTMLDetailsElement).open);
  R["3-stale-disclosure-toggle"]={opened,after,preserved:opened&&after}; await p.close();}
 {const p=await mk(); const o:Record<string,unknown>={};
  for(const [t,pa] of [["btn-settings","provider-panel"],["btn-attendees","attendee-panel"]] as const){
   await p.evaluate((x:string)=>{const e=document.getElementById(x) as HTMLElement;e.focus();e.click();},t);
   await st(p,`document.getElementById(${JSON.stringify(pa)})?.hidden === false`);
   const inside=await p.evaluate((x:string)=>document.getElementById(x)!.contains(document.activeElement),pa);
   await p.keyboard.press("Escape"); await st(p,`document.getElementById(${JSON.stringify(pa)})?.hidden === true`);
   o[pa]={focusMovedInside:inside,restoredTo:await p.evaluate(()=>document.activeElement?.id??null)};}
  R["4-focus-restore"]=o; await p.close();}
 {const p=await mk(); await st(p,'document.documentElement.dataset.connection === "connected"');
  h.pushMessage({type:"meetings",items:[{id:7,title:"온보딩",started_at:FIXED,status:"ended"}]});
  await st(p,'document.querySelectorAll("#session-list .session-row").length === 1');
  const sel=h.nextClientMessage();
  await p.evaluate(()=>(document.querySelector("#session-list .session-row") as HTMLElement).click());
  const sm=await sel as Record<string,unknown>;
  h.pushMessage({type:"meeting",meetingId:7,title:"온보딩",current:null,history:[],transcript:[],notes:""});
  await st(p,'document.getElementById("btn-ask")?.disabled === false');
  await p.evaluate(()=>(document.getElementById("btn-ask") as HTMLElement).click());
  await st(p,'document.getElementById("ask-panel")?.hidden === false');
  const aw=h.nextClientMessage();
  await p.evaluate(()=>{const i=document.getElementById("ask-input") as HTMLInputElement;
   i.value="마감일?";i.dispatchEvent(new Event("input",{bubbles:true}));
   (document.getElementById("btn-ask-send") as HTMLButtonElement).disabled=false;
   (document.getElementById("btn-ask-send") as HTMLElement).click();});
  const am=await aw as Record<string,unknown>;
  R["5-payload-keys"]={selectMeeting:sm,ask:am,selectUsesMeetingId:"meetingId" in sm,askUsesMeetingId:"meetingId" in am};
  await p.close();}
 {const p=await mk(320,667); await p.evaluate(()=>(document.querySelector("#dock-more > summary") as HTMLElement).click());
  R["6-narrow-overflow"]=await p.evaluate(()=>({rootOverflowX:document.documentElement.scrollWidth-document.documentElement.clientWidth,
   bodyOverflowX:document.body.scrollWidth-document.body.clientWidth,
   clipped:[...document.querySelectorAll<HTMLElement>(".dock button")].filter((e)=>{const r=e.getBoundingClientRect();
    return r.width>0&&(r.right>321||r.left<-1);}).map((e)=>e.id)})); await p.close();}
 {const p=await mk(); await st(p,'document.documentElement.dataset.connection === "connected"');
  for(let i=0;i<4;i++){h.pushMessage(STARTING);await st(p,'document.querySelector(".app")?.dataset.capturePhase === "starting"');
   h.pushMessage(LIVE);await st(p,'document.querySelector(".app")?.classList.contains("app--capturing") === true');
   h.pushMessage(IDLE);await st(p,'document.querySelector(".app")?.dataset.shell === "library"');}
  R["7-repeated-transitions"]=await p.evaluate(()=>({shell:(document.querySelector(".app") as HTMLElement).dataset.shell,
   disclosures:document.querySelectorAll(".dock details").length,compileHomes:document.querySelectorAll("#btn-compile-deck").length,
   askHomes:document.querySelectorAll("#btn-ask").length,
   perceivableStops:["btn-live-stop","btn-record"].filter((id)=>{const e=document.getElementById(id)!;
    const r=e.getBoundingClientRect();return !e.hidden&&getComputedStyle(e).display!=="none"&&r.height>0;})}));
  await p.close();}
 {const p=await mk(); await st(p,'document.documentElement.dataset.connection === "connected"');
  h.disconnectClients(); await st(p,'document.documentElement.dataset.connection === "disconnected"');
  R["8-network-block"]=await p.evaluate(()=>["btn-export-md","btn-export-json","btn-export-transcript","btn-export-deck",
   "btn-export-pdf","btn-export-png","btn-compile-deck","btn-reset","btn-record"].map((id)=>{const e=document.getElementById(id) as HTMLButtonElement;
   return {id,disabled:e.disabled,painted:e.getBoundingClientRect().height>0,
    reasonMatches:e.getAttribute("title")===e.getAttribute("aria-label"),reason:e.getAttribute("title")};}));
  await p.close();}
}finally{await b.close();h.stop();}
await writeFile(".omo/evidence/caret-clone-redesign/task-13/green/adversarial.json",JSON.stringify(R,null,2)+"\n");
console.log(JSON.stringify(R,null,2));
