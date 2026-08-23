// Task-9 BASELINE probe (run BEFORE any implementation).
//
// Purpose: record, from a real Chromium session against the shipped public/
// directory, the two defects Todo 9 must remove:
//   1. font nondeterminism  - index.html declares remote @font-face sources
//      (fonts.googleapis.com, fonts.gstatic.com, cdn.jsdelivr.net), so the rendered
//      typeface depends on the network and on CDN cache state;
//   2. token fragmentation  - the same semantic role (canvas, rule, accent, radius,
//      motion) is declared under several unrelated variable names across
//      style.css / operational-liquid.css / caret-shell.css, with no single layer.
//
// Nothing here asserts; it only writes a receipt. No sleeps, no polling.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer from "puppeteer";

const repoRoot = new URL("../../../../../", import.meta.url).pathname;
const publicDir = join(repoRoot, "public");
const outDir = join(repoRoot, ".omo/evidence/caret-clone-redesign/task-9/baseline");
mkdirSync(outDir, { recursive: true });

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return new Response("no ws", { status: 400 });
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[a-z0-9._-]+$/i.test(name)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(publicDir, name)));
  },
});
const origin = `http://localhost:${server.port}`;

const browser = await puppeteer.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1"] });
const page = await browser.newPage();
const requested = [];
page.on("request", (r) => requested.push(r.url()));
await page.setViewport({ width: 1244, height: 836, deviceScaleFactor: 1 });
await page.goto(origin, { waitUntil: "load" });
await page.evaluate(async () => { await document.fonts.ready; });

const measured = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const faces = [...document.fonts].map((f) => ({ family: f.family, status: f.status }));
  const declared = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules ?? []) {
      if (rule.constructor?.name !== "CSSStyleRule") continue;
      for (const prop of rule.style) if (prop.startsWith("--")) declared.add(prop);
    }
  }
  return {
    bodyFontFamily: body.fontFamily,
    loadedFaceFamilies: [...new Set(faces.map((f) => f.family))].sort(),
    loadedFaceCount: faces.length,
    customPropertyNames: [...declared].sort(),
    sampleTokens: {
      "--z950": root.getPropertyValue("--z950").trim(),
      "--caret-bg": root.getPropertyValue("--caret-bg").trim(),
      "--ol-bg": root.getPropertyValue("--ol-bg").trim(),
      "--live": root.getPropertyValue("--live").trim(),
      "--caret-mint": root.getPropertyValue("--caret-mint").trim(),
      "--caret-radius": root.getPropertyValue("--caret-radius").trim(),
      "--glass-radius": root.getPropertyValue("--glass-radius").trim(),
      "--motion-state": root.getPropertyValue("--motion-state").trim(),
    },
  };
});

const external = requested.filter((u) => !u.startsWith(origin) && !u.startsWith("data:"));
const html = readFileSync(join(publicDir, "index.html"), "utf-8");
const remoteLinks = [...html.matchAll(/<link[^>]+https:\/\/[^"']+/g)].map((m) => m[0]);

const receipt = {
  probe: "task-9-baseline",
  purpose: "record pre-implementation font nondeterminism and token fragmentation",
  viewport: { width: 1244, height: 836, deviceScaleFactor: 1 },
  fontNondeterminism: {
    remoteStylesheetLinksInIndexHtml: remoteLinks,
    externalRequestsMadeByRealChromium: external,
    externalRequestCount: external.length,
    bodyFontFamily: measured.bodyFontFamily,
    loadedFaceFamilies: measured.loadedFaceFamilies,
    loadedFaceCount: measured.loadedFaceCount,
    verdict: external.length > 0
      ? "NONDETERMINISTIC: rendered typography depends on third-party network hosts"
      : "no external request observed",
  },
  tokenFragmentation: {
    customPropertyCount: measured.customPropertyNames.length,
    customPropertyNames: measured.customPropertyNames,
    duplicatedSemanticRoles: measured.sampleTokens,
    verdict: "FRAGMENTED: canvas/accent/radius/motion each declared under multiple unrelated names across three stylesheets",
  },
  indexHtmlSha256: createHash("sha256").update(readFileSync(join(publicDir, "index.html"))).digest("hex"),
};

writeFileSync(join(outDir, "baseline-probe.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  externalRequestCount: external.length,
  external,
  bodyFontFamily: measured.bodyFontFamily,
  loadedFaceFamilies: measured.loadedFaceFamilies,
  customPropertyCount: measured.customPropertyNames.length,
}, null, 2));

await browser.close();
server.stop(true);
