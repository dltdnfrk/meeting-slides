import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../tests/public-test-harness.ts";
const FIXED=1710376860000;
const h=createPublicTestHarness();
const b=await puppeteer.launch({args:["--no-sandbox"]});
for (const [w,hh] of [[375,812],[320,667]] as const) {
  const p=await b.newPage();
  await p.setViewport({width:w,height:hh,deviceScaleFactor:1});
  await p.goto(h.origin,{waitUntil:"load"});
  await h.waitForClient();
  await p.evaluate(async()=>{await document.fonts.ready;});
  h.pushMessage({type:"meetings",items:[{id:7,title:"온보딩",started_at:FIXED,status:"ended"}]});
  await p.evaluate(()=>new Promise<void>((r)=>{const e=document.getElementById("session-list")!;
    if(e.querySelector(".session-row"))return r();
    const o=new MutationObserver(()=>{if(e.querySelector(".session-row")){o.disconnect();r();}});o.observe(e,{childList:true,subtree:true});}));
  await p.evaluate(()=>(document.querySelector("#session-list .session-row") as HTMLElement).click());
  h.pushMessage({type:"meeting",meetingId:7,title:"온보딩",current:null,history:[],transcript:[],notes:""});
  await p.evaluate(()=>new Promise<void>((r)=>{const e=document.getElementById("btn-ask") as HTMLButtonElement;
    if(!e.disabled)return r();
    const o=new MutationObserver(()=>{if(!e.disabled){o.disconnect();r();}});o.observe(e,{attributes:true});}));
  // A user scrolls the control into view before clicking it; the dock is a
  // legitimate scroll owner at 320px. Scroll, let layout settle, THEN click.
  await p.evaluate(()=>{document.getElementById("btn-ask")!.scrollIntoView({block:"nearest"});});
  await p.evaluate(()=>new Promise<void>((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  const r=await p.evaluate(()=>{const q=document.getElementById("btn-ask")!.getBoundingClientRect();
    return {x:q.x+q.width/2,y:q.y+q.height/2};});
  await p.mouse.click(r.x,r.y);
  const opened=await p.evaluate(()=>document.getElementById("ask-panel")?.hidden===false);
  console.log(w,"real pointer click at own centre -> ask panel open:",opened);
  await p.close();
}
await b.close();h.stop();
