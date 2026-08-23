import puppeteer from "puppeteer";
import { createPublicTestHarness } from "../tests/public-test-harness.ts";
const h=createPublicTestHarness();
const b=await puppeteer.launch({args:["--no-sandbox"]});
const p=await b.newPage();
await p.setViewport({width:375,height:812,deviceScaleFactor:1});
await p.goto(h.origin,{waitUntil:"load"});
await h.waitForClient();
await p.evaluate(async()=>{await document.fonts.ready;});
await p.evaluate(()=>{(document.querySelector("#dock-more > summary") as HTMLElement).click();});
// Let the disclosure's layout settle before ANY rect is read: opening it grows
// the action surface and can scroll the dock, which invalidates cached rects.
await p.evaluate(()=>new Promise<void>((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
console.log(JSON.stringify(await p.evaluate(()=>{
  const ids=["btn-export-md","btn-export-transcript","btn-ask","btn-settings","btn-attendees","detail-tab-notes"];
  return ids.map((id)=>{
    const el=document.getElementById(id)!;
    const r=el.getBoundingClientRect();
    const cx=r.x+r.width/2, cy=r.y+r.height/2;
    const probe=(x:number,y:number)=>{const hit=document.elementFromPoint(Math.round(x),Math.round(y));
      return hit===el||(hit instanceof Node&&el.contains(hit));};
    const who=(x:number,y:number)=>{const t=document.elementFromPoint(Math.round(x),Math.round(y)); return t instanceof Element?(t.id||t.className||t.tagName):null;};
    return {id, w:Math.round(r.width), h:Math.round(r.height), blockers:{top:who(cx,r.y+1),bottom:who(cx,r.bottom-1),left:who(r.x+1,cy),right:who(r.right-1,cy)},
      // within its OWN box (1px inside each edge)
      ownEdges:{top:probe(cx,r.y+1),bottom:probe(cx,r.bottom-1),left:probe(r.x+1,cy),right:probe(r.right-1,cy)},
      // within the required 44px box centred on it
      reqEdges:{top:probe(cx,cy-21),bottom:probe(cx,cy+21),left:probe(cx-21,cy),right:probe(cx+21,cy)}};
  });
}),null,2));
await b.close();h.stop();
