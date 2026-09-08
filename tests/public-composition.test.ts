import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;
type Probe = { readonly __caretShell: { transcriptState: { meetingId: number | null; count: number; finalized: { text: string }[] } }; readonly __attendeeState: { meetingId: number | null } };

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  console.log(`composition browser pid=${browser.process()?.pid}`);
  page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});
afterAll(async () => { await browser?.close(); harness.stop(); });

// A status frame fences every preceding frame on this same socket. Subscribe
// before sending, and await the exact DOM mutation rather than a polling loop.
async function deliver(...frames: unknown[]) {
  const marker = `receipt-${harness.sentSequence}`;
  const receipt = await page.evaluateHandle((marker) => ({ done: new Promise<void>((resolve, reject) => {
    const node = document.getElementById("status-text");
    if (!node) throw new TypeError("status surface missing");
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`missing ${marker}`)); }, 5000);
    const observer = new MutationObserver(() => {
      if (node.textContent !== marker) return;
      clearTimeout(timeout); observer.disconnect(); resolve();
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
  }) }), marker);
  for (const frame of frames) harness.pushMessage(frame);
  harness.pushMessage({ type: "status", text: marker });
  await receipt.evaluate((receipt) => receipt.done);
  await receipt.dispose();
}

test("idle hydration drops the stale live snapshot from both transcript projections", async () => {
  await deliver({ type: "capture", capturing: false, mode: "mic", phase: "idle" }, {
    type: "transcript", reason: "snapshot", entries: [{ seq: 91, text: "Old capture", ts: 1000 }],
  });
  expect(await page.$eval("#transcript-count", (node) => node.textContent)).toBe("0");
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__caretShell?.transcriptState.count; })).toBe(0);
});

test("selection activates the transcript meeting and reset clears its canonical content", async () => {
  await deliver({ type: "capture", capturing: false, mode: "mic", phase: "idle" }, {
    type: "meetings", items: [7, 8].map((id) => ({ id, title: `Meeting ${id}`, started_at: 1000, status: "ended" })),
  });
  const selected = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="7"]');
  expect(await selected).toEqual({ action: "selectMeeting", meetingId: 7 });
  await deliver({ type: "meeting", meetingId: 7, title: "Meeting 7", current: null, history: [],
    transcript: [{ seq: 91, text: "Raw   evidence", ts: 1000 }] });
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__caretShell?.transcriptState.meetingId; })).toBe(7);
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__caretShell?.transcriptState.count; })).toBe(1);
  expect(await page.$eval(".feed-line__text", (node) => node.textContent)).toBe("Raw   evidence");
  expect(await page.$eval(".feed-line", (node) => node.getAttribute("data-seq"))).toBe("91");

  const next = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="8"]');
  await next;
  await deliver({ type: "meeting", meetingId: 7, title: "Stale", transcript: [{ text: "stale", ts: 2000 }] },
    { type: "meeting", meetingId: 8, title: "Meeting 8", transcript: [{ text: "Current", ts: 3000 }], current: null, history: [] });
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__caretShell?.transcriptState.finalized.map((line) => line.text); })).toEqual(["Current"]);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.$eval("#btn-reset", (node) => node instanceof HTMLButtonElement && node.click());
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__caretShell?.transcriptState.count; })).toBe(0);
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__caretShell?.transcriptState.meetingId; })).toBeNull();
});

test("nullable attendee identity clears the prepared meeting rather than reusing it", async () => {
  await deliver({ type: "attendees", meeting_id: 77, attendees: [] });
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__attendeeState?.meetingId; })).toBe(77);
  await deliver({ type: "attendees", meeting_id: null, attendees: [] });
  expect(await page.evaluate(() => { const probe: Window & Partial<Probe> = window; return probe.__attendeeState?.meetingId; })).toBeNull();
});

const SHA = "a".repeat(64);
function plan() {
  const theme = {
    id: "meeting-paper-v1", canvas: { width: 1280, height: 720 },
    font: { family: "Pretendard", localPath: "fonts/Pretendard.woff2", sha256: SHA },
    colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: { display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 }, body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 } },
    stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 },
  };
  const source = { transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Friday launch." };
  return {
    schemaVersion: 1, planId: "plan:launch", revision: 4,
    snapshot: { meetingId: 7, transcriptVersionId: "transcript-v1", contentSha256: SHA, lineCount: 1 },
    title: "Launch review", theme,
    claims: [{ id: "claim-launch", kind: "decision", text: "Friday launch.", method: "reviewed", sources: [source] }], assets: [],
    slides: [
      { id: "opening", layout: "hero", storyRole: "opening", title: "Launch review", payload: { variant: "cover", statement: "Friday launch." }, bindings: { title: ["claim-launch"], statement: ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "Welcome the room." },
      { id: "decision", layout: "decision", storyRole: "decision", title: "Ship Friday", payload: { decision: "Friday launch.", rationale: ["Review complete."] }, bindings: { title: ["claim-launch"], decision: ["claim-launch"], "rationale[0]": ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "Confirm the owner." },
    ], createdAt: "2026-08-14T10:00:00.000Z", updatedAt: "2026-08-14T10:05:00.000Z",
  };
}

test("a refine answer from a superseded meeting cannot propose an edit in the new meeting", async () => {
  await deliver({ type: "capture", capturing: false, mode: "mic", phase: "idle" }, {
    type: "meetings", items: [7, 8].map((id) => ({ id, title: `Meeting ${id}`, started_at: 1000, status: "ended" })),
  });
  const selected = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="7"]');
  await selected;
  const slidePlan = { plan: plan(), geometry: [{ slideId: "opening", canvas: { width: 1280, height: 720 }, elements: [{
    id: "opening:title", text: "Launch review", role: "title", box: { x: 80, y: 72, width: 500, height: 180 },
    resolvedTokens: { color: "14213D", size: 42 }, evidence: { fieldPath: "title", claimIds: ["claim-launch"] },
    accessibility: { label: "Launch review", readingOrder: 0 }, lines: ["Launch review"],
  }] }] };
  await deliver({ type: "meeting", meetingId: 7, title: "Meeting 7", current: null, history: [],
    transcript: [{ text: "Friday launch.", ts: 1000 }], slidePlan });
  await page.$eval('[data-geometry-element="opening:title"]', (node) => {
    const rect = node.getBoundingClientRect();
    for (const type of ["pointerdown", "pointerup"]) node.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
      clientX: rect.left + 4, clientY: rect.top + 4, buttons: type === "pointerdown" ? 1 : 0,
    }));
  });
  await page.type("[data-slide-refine-input]", "shorten");
  const pending = harness.nextClientMessage();
  await page.click("[data-slide-refine-submit]");
  const request = await pending;
  if (typeof request !== "object" || request === null || !("requestId" in request)) throw new TypeError("missing request identity");
  const next = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="8"]');
  await next;
  await deliver({ type: "meeting", meetingId: 8, title: "Meeting 8", current: null, history: [],
    transcript: [{ text: "Friday launch.", ts: 1000 }], slidePlan }, {
    type: "refine", requestId: request.requestId, slideId: "opening", path: "title", before: "Launch review",
    after: "Wrong meeting", claimIds: ["claim-launch"],
  });
  expect(await page.$eval("[data-slide-refine-proposal]", (node) => node.hasAttribute("hidden"))).toBe(true);
  expect(await page.$eval("[data-slide-title-input]", (node) => node instanceof HTMLInputElement ? node.value : null)).toBe("Launch review");
});

test("typing in the canvas never invokes the global recording shortcut", async () => {
  await deliver({ type: "capture", capturing: false, mode: "mic", phase: "idle" }, {
    type: "meetings", items: [{ id: 7, title: "Meeting 7", started_at: 1000, status: "ended" }],
  });
  const selected = harness.nextClientMessage();
  await page.click('.session-row[data-meeting-id="7"]');
  await selected;
  await deliver({
    type: "meeting", meetingId: 7, title: "Meeting 7", current: null, history: [],
    transcript: [{ text: "Friday launch.", ts: 1000 }],
    slidePlan: { plan: plan(), geometry: [{
      slideId: "opening", canvas: { width: 1280, height: 720 }, elements: [{
        id: "opening:title", text: "Launch review", role: "title", box: { x: 80, y: 72, width: 500, height: 180 },
        resolvedTokens: { color: "14213D", size: 42 }, evidence: { fieldPath: "title", claimIds: ["claim-launch"] },
        accessibility: { label: "Launch review", readingOrder: 0 }, lines: ["Launch review"],
      }],
    }] },
  });
  const outgoing = await page.evaluateHandle(() => {
    const commands: Array<{ action?: string }> = [];
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") commands.push(JSON.parse(data));
      return original.call(this, data);
    };
    return { commands, restore() { WebSocket.prototype.send = original; } };
  });
  try {
    await page.click('[data-geometry-element="opening:title"]', { count: 2 });
    expect(await page.$eval('[data-geometry-element="opening:title"]', node =>
      node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable)))
      .toBe(true);
    await page.keyboard.press("ArrowLeft");
    expect(await page.$eval('[data-geometry-element="opening:title"]', node =>
      node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable)))
      .toBe(true);
    await page.$eval('[data-geometry-element="opening:title"]', node => {
      if (node instanceof HTMLTextAreaElement) node.select();
    });
    await page.keyboard.type("Friday release review");
    await page.keyboard.press("Enter");
    await deliver({ type: "status", text: "canvas edit committed" });
    expect(await outgoing.evaluate(probe => probe.commands.filter(command =>
      command.action === "startCapture" || command.action === "stopCapture"))).toEqual([]);
    expect(await page.$eval("[data-slide-title-input]", node => node instanceof HTMLInputElement ? node.value : null))
      .toBe("Friday release review");
    await page.click('[data-geometry-element="opening:title"]', { count: 2 });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await deliver({ type: "status", text: "invalid edit rejected" });
    expect(await page.$eval("[data-slide-title-input]", node => node instanceof HTMLInputElement ? node.value : null))
      .toBe("Friday release review");
    expect(await page.$eval('[data-geometry-element="opening:title"]', node => node.textContent))
      .toBe("Friday release review");
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", isComposing: true }));
    });
    expect(await outgoing.evaluate(probe => probe.commands.filter(command =>
      command.action === "startCapture" || command.action === "stopCapture"))).toEqual([]);
    await page.keyboard.press("r");
    expect(await outgoing.evaluate(probe => probe.commands.filter(command => command.action === "startCapture")))
      .toHaveLength(1);
  } finally {
    await outgoing.evaluate(probe => probe.restore());
    await outgoing.dispose();
  }
});
