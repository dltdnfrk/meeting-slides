import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import puppeteer from "puppeteer";

const evidenceDir = import.meta.dir;
const publicDir = join(evidenceDir, "..", "..", "..", "..", "public");
const files = new Set(["/index.html", "/style.css", "/app.js", "/review-panel.js"]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url === "/" ? "/index.html" : request.url ?? "", "http://127.0.0.1").pathname;
  if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
  if (!files.has(pathname)) { response.writeHead(404).end("Not found"); return; }
  const type = pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".js") ? "text/javascript" : "text/html";
  response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
  response.end(await readFile(join(publicDir, pathname.slice(1))));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("QA server did not bind");

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.evaluateOnNewDocument(() => {
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor() {
      (window as any).__sent ??= [];
      (window as any).__sockets ??= [];
      (window as any).__sockets.push(this);
      queueMicrotask(() => this.onopen?.(new Event("open")));
    }
    send(raw: string) { (window as any).__sent.push(JSON.parse(raw)); }
    emit(value: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
    emitRaw(raw: string) { this.onmessage?.(new MessageEvent("message", { data: raw })); }
  }
  Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
});

const origin = `http://127.0.0.1:${address.port}`;
const emit = (value: unknown) => page.evaluate((payload) => (window as any).__sockets.at(-1).emit(payload), value as any);
const sent = () => page.evaluate(() => (window as any).__sent as unknown[]);
const clearSent = () => page.evaluate(() => { (window as any).__sent.length = 0; });
const version = "tv-task-8-immutable";
const item = (id: string, kind: string, seq: number, quote = `Evidence ${seq}`) => ({
  id, kind, description: `Candidate ${id}`,
  sourceSegment: { transcript_version_id: version, start_seq: seq, end_seq: seq },
  evidenceQuote: quote, segment_text: quote, attributedAttendeeId: null,
  ...(kind === "action_item" ? { assigneeAttendeeId: null } : {}),
});
const review = (overrides: Record<string, unknown> = {}) => ({
  type: "review", reviewId: "review-task-8", transcriptVersionId: version,
  attendees: [{ attendeeId: "att-1", displayName: "Alice" }, { attendeeId: "att-2", displayName: "Bob" }],
  transcript: { lines: [] },
  items: [item("decision-1", "decision", 11), item("action-1", "action_item", 12), item("open-1", "open_item", 13)],
  ...overrides,
});
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

await page.setViewport({ width: 1440, height: 950 });
await page.goto(origin, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as any).__sockets?.length === 1);
await clearSent();
await emit(review());
await page.waitForFunction(() => document.querySelectorAll(".review-item").length === 3);
const desktop = await page.evaluate(() => ({
  rows: Array.from(document.querySelectorAll(".review-item")).map((row) => ({
    id: (row as HTMLElement).dataset.itemId,
    quote: row.querySelector(".review-item__quote")?.textContent,
    coords: row.querySelector(".review-item__coords")?.textContent,
    attributionTag: row.querySelector(".review-item__attribution")?.tagName,
    assigneeTag: row.querySelector(".review-item__assignee")?.tagName ?? null,
  })),
  freeTextAttributionSurfaces: document.querySelectorAll("#review-panel input, #review-panel [contenteditable=true], #review-panel datalist").length,
}));
assert(desktop.rows.length === 3 && desktop.rows.every((row) => row.quote && row.coords?.includes("seq")), "desktop evidence/seq rendering failed");
assert(desktop.rows.every((row) => row.attributionTag === "SELECT") && desktop.freeTextAttributionSurfaces === 0, "attribution is not dropdown-only");
await page.screenshot({ path: join(evidenceDir, "qa-desktop.png") as `${string}.png` });

await page.select('.review-item[data-item-id="decision-1"] .review-item__attribution', "att-2");
await page.select('.review-item[data-item-id="action-1"] .review-item__assignee', "att-1");
await page.click("#btn-review-confirm");
const wires = await sent();
assert(JSON.stringify(wires).includes('"action":"updateItem"') && JSON.stringify(wires).includes('"action":"confirmReview"'), "review WS actions were not emitted");

await emit({ type: "review", reviewId: null, items: "bad" });
const afterMalformedObject = await page.evaluate(() => document.querySelectorAll(".review-item").length);
assert(afterMalformedObject === 3, "malformed review replaced valid state");
await page.evaluate(() => (window as any).__sockets.at(-1).emitRaw("{not-json"));
const shellAliveAfterMalformedJson = await page.evaluate(() => !!document.getElementById("slide-frame") && document.querySelectorAll(".review-item").length === 3);
assert(shellAliveAfterMalformedJson, "malformed JSON tore down shell");

await emit(review({ items: [item("valid-1", "decision", 20), item("unsupported-1", "referenced_material", 21)] }));
await page.waitForFunction(() => document.querySelectorAll(".review-item").length === 1);
const unsupported = await page.evaluate(() => Array.from(document.querySelectorAll(".review-item")).map((row) => (row as HTMLElement).dataset.itemId));
assert(unsupported.length === 1 && unsupported[0] === "valid-1", "unsupported item became actionable");

await emit(review({ items: [item("valid-2", "open_item", 30), { ...item("missing-quote", "decision", 31), evidenceQuote: undefined }, item("blank-quote", "decision", 32, "   ")] }));
await page.waitForFunction(() => document.querySelectorAll(".review-item").length === 1);
const malformedEvidence = await page.evaluate(() => Array.from(document.querySelectorAll(".review-item")).map((row) => (row as HTMLElement).dataset.itemId));
assert(malformedEvidence.length === 1 && malformedEvidence[0] === "valid-2", "candidate without evidence became actionable");

await emit(review({ items: [] }));
await page.waitForFunction(() => !!document.querySelector(".review-list__empty"));
const empty = await page.evaluate(() => ({
  text: document.querySelector(".review-list__empty")?.textContent?.trim(),
  confirmDisabled: (document.getElementById("btn-review-confirm") as HTMLButtonElement).disabled,
  rows: document.querySelectorAll(".review-item").length,
}));
assert(!!empty.text && empty.confirmDisabled && empty.rows === 0, "empty state failed");

await page.setViewport({ width: 430, height: 932, isMobile: true, deviceScaleFactor: 2 });
await emit(review());
await page.waitForFunction(() => document.querySelectorAll(".review-item").length === 3);
const mobile = await page.evaluate(() => {
  const box = document.getElementById("review-panel")!.getBoundingClientRect();
  return { left: box.left, right: box.right, width: box.width, viewport: window.innerWidth, horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth };
});
assert(mobile.left >= 0 && mobile.right <= mobile.viewport && !mobile.horizontalOverflow, "mobile panel overflows viewport");
await page.screenshot({ path: join(evidenceDir, "qa-mobile.png") as `${string}.png` });

const expectedMalformedJsonConsole = consoleErrors.filter((line) => line.startsWith("parse error"));
const expectedExternalFontErrors = consoleErrors.filter((line) => line.includes("ERR_CERT_AUTHORITY_INVALID"));
const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.startsWith("parse error") && !line.includes("ERR_CERT_AUTHORITY_INVALID"));
if (pageErrors.length > 0 || unexpectedConsoleErrors.length > 0) {
  console.error(JSON.stringify({ pageErrors, consoleErrors, unexpectedConsoleErrors }, null, 2));
}
assert(pageErrors.length === 0 && unexpectedConsoleErrors.length === 0, "unexpected browser runtime error");
console.log(JSON.stringify({
  chromium: await browser.version(), desktop, wires, afterMalformedObject, shellAliveAfterMalformedJson,
  unsupported, malformedEvidence, empty, mobile,
  browserDiagnostics: { pageErrors, unexpectedConsoleErrors, expectedMalformedJsonConsoleCount: expectedMalformedJsonConsole.length, expectedExternalFontErrorCount: expectedExternalFontErrors.length },
}, null, 2));
await browser.close();
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
