import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root=resolve(process.cwd());
const base=join(root,".omo/evidence/caret-clone-redesign/final/f3-manual-qa-final");
const manifest=JSON.parse(readFileSync(join(base,"tools/interaction-manifest.json"),"utf8")) as Array<Record<string,string>>;
const harness=readFileSync(join(base,"tools/f3-journey.ts"),"utf8");
const html=readFileSync(join(root,"public/index.html"),"utf8");
const app=readFileSync(join(root,"public/app.js"),"utf8");
const native=readFileSync(join(root,"macos/MinibarProjection.swift"),"utf8")+readFileSync(join(root,"macos/MinibarWindowController.swift"),"utf8")+readFileSync(join(root,"macos/launcher.swift"),"utf8");
const failures:string[]=[];
const allowed=new Set(["pointer","keyboard-enter","keyboard-type","AXPress","real-command-q","installed-app","focus-observation","controlled-transport","browser-lifecycle","native-dialog"]);
for(const [i,item] of manifest.entries()){
  for(const key of ["phase","action","owner","mode","requirement"])if(!item[key])failures.push(`manifest[${i}] missing ${key}`);
  if(!allowed.has(item.mode))failures.push(`manifest[${i}] unsupported mode ${item.mode}`);
  const owner=item.owner;
  if(owner.startsWith("#")){
    const ids=[...owner.matchAll(/#([A-Za-z0-9_-]+)/g)].map(m=>m[1]);
    for(const id of ids)if(!html.includes(`id="${id}"`)&&!app.includes(`id="${id}"`)&&!app.includes(`$("${id}")`))failures.push(`${owner}: #${id} absent from shipped owner sources`);
  }else if(/[가-힣]/.test(owner)&&!native.includes(owner)&&!html.includes(owner))failures.push(`${owner}: accessible owner absent from shipped sources`);
}
const forbidden=["#thumbnails .thumbnail","#btn-return-live"];
for(const selector of forbidden)if(harness.includes(`"${selector}"`)||harness.includes(`'${selector}'`))failures.push(`forbidden hidden/non-owner target remains: ${selector}`);
const requiredSelectors=["#btn-record","#dock-more > summary","#btn-compile-deck","#current-slide .slide__notice","#btn-export-md","#btn-export-json","#btn-export-transcript","#btn-export-deck","#btn-review","#btn-review-close","#btn-ask","#ask-input","#btn-ask-send","#btn-ask-close","#btn-reset"];
for(const selector of requiredSelectors){if(!manifest.some(x=>x.owner===selector))failures.push(`unmanifested selector ${selector}`);if(!harness.includes(`"${selector}"`))failures.push(`manifest selector unused by harness ${selector}`)}
for(const guarantee of ["requireOwner(before","requireOwner(focused","page.once(\"dialog\"","observerSubscribedBeforeTrigger"]){
  if(!harness.includes(guarantee)&&!readFileSync(join(base,"tools/quit-protection.swift"),"utf8").includes(guarantee))failures.push(`runtime guarantee absent: ${guarantee}`);
}
const result={verdict:failures.length?"FAIL":"PASS",kind:"static interaction-owner preflight; not a product journey",manifestCount:manifest.length,forbiddenTargetsAbsent:forbidden,ownerPolicy:"Every browser pointer/keyboard action is rejected before dispatch unless its actual runtime owner has non-zero visible geometry, viewport inclusion, center hit-test ownership, enabled state, role, and accessible name. Native actions require named AX owners; browser lifecycle/transport/dialog actions require their event owner.",failures,manifest};
writeFileSync(join(base,"runtime/preflight.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({verdict:result.verdict,manifestCount:manifest.length,failures},null,2));
if(failures.length)process.exit(1);
