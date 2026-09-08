import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;
const MEETING_ID = 909;
const SHA = "a".repeat(64);
const DIALOG_TITLE = "확정본을 새로 만들까요?";
const DIALOG_BODY = "검토가 확정되어 현재 초안의 로컬 편집은 확정본에 저장할 수 없습니다. 새 확정본은 확정된 검토 내용으로 다시 만들며, 저장된 초안은 그대로 남습니다. 현재 로컬 편집은 확정본에 포함되지 않습니다.";
const evidenceDirectory = resolve(process.env.VISUAL_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "draft-final-evidence-")));
const retainedEvidence = process.env.VISUAL_EVIDENCE_DIR !== undefined;
const runtimeRoot = mkdtempSync(join(tmpdir(), "meeting-slides-draft-final-"));
const browserProfile = join(runtimeRoot, "browser-profile");
const databasePath = join(runtimeRoot, "database", "meetings.db");
const exportRoot = join(runtimeRoot, "exports");
const settingsRoot = join(runtimeRoot, "settings");
const harness: PublicTestHarness = createPublicTestHarness();
const externalRequests: string[] = [];
const sourceFiles = ["public/app.js", "public/index.html", "public/slide-plan-workspace.js", "public/style.css"] as const;
let browser: Browser;
let page: Page;

const json = (name: string, value: unknown): void => writeFileSync(join(evidenceDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function plan(planId: string, revision: number, title: string) {
  const theme = {
    id: "meeting-paper-v1", canvas: { width: 1280, height: 720 },
    font: { family: "Pretendard", localPath: "fonts/Pretendard.woff2", sha256: SHA },
    colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: { display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 }, body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 } },
    stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 },
  };
  const source = { transcriptVersionId: "transcript-final", startSeq: 1, endSeq: 1, evidenceQuote: "금요일에 출시합니다." };
  return {
    schemaVersion: 1, planId, revision,
    snapshot: { meetingId: MEETING_ID, transcriptVersionId: "transcript-final", contentSha256: SHA, lineCount: 1 },
    title, theme, claims: [{ id: "claim-launch", kind: "decision", text: "금요일에 출시합니다.", method: "reviewed", sources: [source] }], assets: [],
    slides: [
      { id: "opening", layout: "hero", storyRole: "opening", title, payload: { variant: "cover", statement: "확정된 검토 내용으로 금요일에 출시합니다." }, bindings: { title: ["claim-launch"], statement: ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "출시 결정을 공유합니다." },
      { id: "decision", layout: "decision", storyRole: "decision", title: "출시 일정 확정", payload: { decision: "금요일 출시", rationale: ["검토 완료"] }, bindings: { title: ["claim-launch"], decision: ["claim-launch"], "rationale[0]": ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "담당자를 확인합니다." },
    ], createdAt: "2026-08-29T09:00:00.000Z", updatedAt: "2026-08-29T09:05:00.000Z",
  };
}

const meetingFrame = (publicationStatus: "draft" | "final", publishedPlan: ReturnType<typeof plan>) => ({
  type: "meeting", meetingId: MEETING_ID, title: "출시 검토 회의",
  transcript: [{ text: "금요일에 출시합니다.", ts: 1_777_000_000_000 }], current: null, history: [], compiled: null,
  review: { type: "review", meetingId: MEETING_ID, reviewId: "review-final", transcriptVersionId: "transcript-final", status: "confirmed", confirmedAt: 1_777_000_100_000, attendees: [], transcript: { lines: [] }, items: [] },
  slidePlan: { plan: publishedPlan, path: `exports/${publishedPlan.planId}`, publicationSha256: SHA, publicationStatus, publishedAt: 1_777_000_200_000 },
});

async function capture(name: string): Promise<Record<string, unknown>> {
  const state = await page.evaluate(() => {
    const selectors = ["#slide-final-rebuild-dialog", "#slide-final-rebuild-title", "#slide-final-rebuild-body", "#btn-slide-final-rebuild-cancel", "#btn-slide-final-rebuild-confirm", "#btn-compile-deck", "[data-slide-plan-workspace]", "[data-slide-plan-title]", "[data-slide-plan-body]", "[data-slide-plan-status]", "[data-slide-title-input]", "[data-slide-layout]"];
    const dimensions = selectors.map((selector) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node || node.hidden || getComputedStyle(node).display === "none") return { selector, visible: false };
      const rect = node.getBoundingClientRect();
      return { selector, visible: true, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, bounds: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }, clipped: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight, insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
    });
    const lines = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return [];
      const grouped = new Map<number, string>();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
        [...(textNode.textContent ?? "")].forEach((character, index) => {
          const range = document.createRange(); range.setStart(textNode, index); range.setEnd(textNode, index + 1);
          const top = Math.round(range.getBoundingClientRect().top); grouped.set(top, `${grouped.get(top) ?? ""}${character}`);
        });
      }
      return [...grouped.values()].map((value) => value.trim()).filter(Boolean);
    };
    const phrase = document.querySelector<HTMLElement>(".slide-final-rebuild-dialog__keep");
    const phraseTops = phrase ? [...(phrase.textContent ?? "")].map((_character, index) => {
      const range = document.createRange(); range.setStart(phrase.firstChild ?? phrase, index); range.setEnd(phrase.firstChild ?? phrase, index + 1);
      return range.getBoundingClientRect().top;
    }) : [];
    const workspace = (window as typeof window & { __slidePlanWorkspace?: { currentPlan(): { planId: string; revision: number; slides: Array<{ title: string; layout: string }> } | null; isDirty(): boolean; currentPublicationStatus(): string | null } }).__slidePlanWorkspace;
    return {
      root: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }, dimensions,
      semanticPhrase: { text: phrase?.textContent?.trim() ?? null, lineTops: [...new Set(phraseTops)], sameVisualLine: phraseTops.length > 0 && new Set(phraseTops).size === 1 },
      cjk: ["#slide-final-rebuild-title", "#slide-final-rebuild-body", "[data-slide-plan-title]", "[data-slide-plan-body]"].map((selector) => ({ selector, lines: lines(selector) })),
      labels: { title: document.getElementById("slide-final-rebuild-title")?.textContent?.trim(), body: document.getElementById("slide-final-rebuild-body")?.textContent?.trim(), cancel: document.getElementById("btn-slide-final-rebuild-cancel")?.textContent?.trim(), confirm: document.getElementById("btn-slide-final-rebuild-confirm")?.textContent?.trim(), compile: document.getElementById("btn-compile-deck")?.textContent?.trim(), compileTitle: document.getElementById("btn-compile-deck")?.getAttribute("title"), compileAria: document.getElementById("btn-compile-deck")?.getAttribute("aria-label"), workspaceAria: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("aria-label") },
      visibleCompileActions: [...document.querySelectorAll<HTMLElement>("#btn-compile-deck")].filter((node) => !node.hidden && getComputedStyle(node).display !== "none").length,
      focus: document.activeElement?.id ?? null,
      workspace: { plan: workspace?.currentPlan() ?? null, dirty: workspace?.isDirty() ?? false, publicationStatus: workspace?.currentPublicationStatus() ?? null },
    };
  });
  await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), fullPage: false, captureBeyondViewport: false });
  const accessibility = await page.accessibility.snapshot({ interestingOnly: false });
  json(`${name}-accessibility.json`, accessibility);
  return { ...state, accessibility: { dialogNameExact: JSON.stringify(accessibility).includes(DIALOG_TITLE), dialogBodyExact: JSON.stringify(accessibility).includes(DIALOG_BODY) } };
}

beforeAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  for (const path of [join(runtimeRoot, "database"), exportRoot, settingsRoot, browserProfile]) mkdirSync(path, { recursive: true });
  writeFileSync(databasePath, "");
  browser = await puppeteer.launch({ headless: true, userDataDir: browserProfile, args: ["--no-sandbox", "--force-device-scale-factor=1", "--lang=ko-KR", "--font-render-hinting=none"] });
  page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.evaluateOnNewDocument(() => {
    const originalSend = WebSocket.prototype.send;
    (globalThis as typeof globalThis & { __visualFrames?: unknown[] }).__visualFrames = [];
    WebSocket.prototype.send = function send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (typeof data === "string") (globalThis as typeof globalThis & { __visualFrames: unknown[] }).__visualFrames.push(JSON.parse(data));
      originalSend.call(this, data);
    };
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(harness.origin)) void request.continue();
    else { externalRequests.push(request.url()); void request.abort(); }
  });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => document.fonts.ready);
}, 120_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  harness.stop();
  const port = new URL(harness.origin).port;
  rmSync(runtimeRoot, { recursive: true, force: true });
  const lsof = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  json("cleanup.json", { browserClosed: true, pageClosed: true, harnessStopped: true, port, portListeners: lsof.stdout.toString().trim(), runtimeRootRemoved: !existsSync(runtimeRoot), databaseRemoved: !existsSync(databasePath), walRemoved: !existsSync(`${databasePath}-wal`), shmRemoved: !existsSync(`${databasePath}-shm`), exportRootRemoved: !existsSync(exportRoot), settingsRootRemoved: !existsSync(settingsRoot), browserProfileRemoved: !existsSync(browserProfile) });
  if (!retainedEvidence) rmSync(evidenceDirectory, { recursive: true, force: true });
});

describe("Todo 9 draft-to-final visual evidence", () => {
  test("captures the confirmed rebuild decision, cancellation, and authoritative final", async () => {
    const draft = plan("draft-plan-retained", 4, "출시 검토 초안");
    const final = plan("final-plan-authoritative", 0, "확정 검토 기반 출시 계획");
    harness.pushMessage({ type: "meetings", items: [{ id: MEETING_ID, title: "출시 검토 회의", started_at: 1_777_000_000_000, status: "ended" }] });
    await page.waitForSelector(`.session-row[data-meeting-id="${MEETING_ID}"]`);
    const select = harness.nextClientMessage(); await page.click(`.session-row[data-meeting-id="${MEETING_ID}"]`); expect(await select).toEqual({ action: "selectMeeting", meetingId: MEETING_ID });
    harness.pushMessage({ ...meetingFrame("draft", draft), review: { ...meetingFrame("draft", draft).review, status: "draft" } });
    await page.waitForSelector("[data-slide-plan-workspace]:not([hidden])");
    await page.$eval("[data-slide-title-input]", (node) => { const input = node as HTMLInputElement; input.value = "로컬 편집: 금요일 출시 준비"; input.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.select("[data-slide-layout]", "timeline");
    harness.pushMessage({ type: "reviewConfirmed", meetingId: MEETING_ID, reviewId: "review-final", confirmedAt: 1_777_000_100_000 });
    await page.waitForFunction(() => document.getElementById("btn-compile-deck")?.textContent?.trim() === "슬라이드 확정본 만들기");
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck"); await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    const focusOrder = [await page.evaluate(() => document.activeElement?.id)];
    await page.keyboard.down("Shift"); await page.keyboard.press("Tab"); await page.keyboard.up("Shift"); focusOrder.push(await page.evaluate(() => document.activeElement?.id));
    await page.keyboard.press("Tab"); focusOrder.push(await page.evaluate(() => document.activeElement?.id));
    const dialogState = await capture("dirty-confirmed-dialog");
    expect(dialogState.root).toEqual({ clientWidth: 1440, scrollWidth: 1440 });
    expect(dialogState.labels).toMatchObject({ title: DIALOG_TITLE, body: DIALOG_BODY, cancel: "취소", confirm: "확정본 새로 만들기" });
    expect(dialogState.accessibility).toEqual({ dialogNameExact: true, dialogBodyExact: true });
    expect(dialogState.semanticPhrase).toMatchObject({ text: "저장할 수 없습니다", sameVisualLine: true });
    expect((dialogState.semanticPhrase as { lineTops: number[] }).lineTops).toHaveLength(1);
    expect(dialogState.visibleCompileActions).toBe(1);
    expect((dialogState.dimensions as Array<{ clipped?: boolean; insideViewport?: boolean }>).filter((item) => item.insideViewport === false || item.clipped === true)).toEqual([]);
    expect((dialogState.dimensions as Array<{ selector: string; clientHeight?: number; scrollHeight?: number }>).find((item) => item.selector === "[data-slide-plan-title]")).toMatchObject({ clientHeight: 62, scrollHeight: 62 });
    await page.keyboard.press("Escape"); await page.waitForFunction(() => (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden && document.activeElement?.id === "btn-compile-deck"); focusOrder.push("btn-compile-deck");
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __visualFrames: unknown[] }).__visualFrames.filter((frame: unknown) => ["compileSlidePlan", "persistSlidePlan"].includes((frame as { action?: string }).action ?? "")))).toEqual([]);
    await page.click("#btn-compile-deck"); await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])"); await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() => (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden && document.activeElement?.id === "btn-compile-deck");
    const cancelledState = await capture("after-cancel");
    expect((cancelledState.dimensions as Array<{ selector: string; clientHeight?: number; scrollHeight?: number }>).find((item) => item.selector === "[data-slide-plan-title]")).toMatchObject({ clientHeight: 62, scrollHeight: 62 });
    expect(cancelledState.workspace).toMatchObject({ dirty: true, publicationStatus: "draft", plan: { planId: "draft-plan-retained" } });
    expect((cancelledState.workspace as { plan: { slides: Array<{ title: string; layout: string }> } }).plan.slides[0]).toMatchObject({ title: "로컬 편집: 금요일 출시 준비", layout: "timeline" });
    await page.click("#btn-compile-deck"); await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    const compile = harness.nextClientMessage();
    const disabled = await page.$eval("#btn-slide-final-rebuild-confirm", (node) => { const button = node as HTMLButtonElement; button.click(); button.click(); return [button.disabled, (document.getElementById("btn-slide-final-rebuild-cancel") as HTMLButtonElement).disabled]; });
    await page.keyboard.press("Enter"); expect(disabled).toEqual([true, true]); expect(await compile).toEqual({ action: "compileSlidePlan", meetingId: MEETING_ID });
    harness.pushMessage({ type: "compile", status: "started", jobId: "final-job", meetingId: MEETING_ID });
    const refresh = harness.nextClientMessage(); harness.pushMessage({ type: "compile", status: "success", jobId: "final-job", meetingId: MEETING_ID, publicationStatus: "final", outline: { slideCount: 2, usedFallback: false } }); expect(await refresh).toEqual({ action: "selectMeeting", meetingId: MEETING_ID });
    harness.pushMessage(meetingFrame("final", final));
    await page.waitForFunction(() => document.querySelector("[data-slide-plan-workspace]")?.getAttribute("data-publication-status") === "final" && document.querySelector("[data-slide-plan-title]")?.textContent === "확정 검토 기반 출시 계획");
    const finalState = await capture("final-workspace");
    const frames = await page.evaluate(() => (globalThis as typeof globalThis & { __visualFrames: Array<{ action?: string; meetingId?: number }> }).__visualFrames);
    const lifecycleFrames = frames.filter((frame) => frame.action === "compileSlidePlan" || frame.action === "persistSlidePlan");
    expect(lifecycleFrames).toEqual([{ action: "compileSlidePlan", meetingId: MEETING_ID }]);
    expect(finalState.workspace).toMatchObject({ dirty: false, publicationStatus: "final", plan: { planId: "final-plan-authoritative", revision: 0 } });
    expect(finalState.labels).toMatchObject({ compile: "슬라이드 확정본 만들기", compileTitle: "확정된 검토 내용으로 슬라이드 확정본 만들기", compileAria: "확정된 검토 내용으로 슬라이드 확정본 만들기", workspaceAria: "편집 가능한 슬라이드 확정본" });
    expect((finalState.dimensions as Array<{ clipped?: boolean; insideViewport?: boolean }>).filter((item) => item.insideViewport === false || item.clipped === true)).toEqual([]);
    expect((finalState.dimensions as Array<{ selector: string; clientHeight?: number; scrollHeight?: number }>).find((item) => item.selector === "[data-slide-plan-title]")).toMatchObject({ clientHeight: 62, scrollHeight: 62 });
    json("overflow-cjk.json", { pass: true, strictOverflow: true, semanticPhraseSameVisualLine: true, states: { dialog: dialogState, afterCancel: cancelledState, final: finalState } });
    json("focus-order.json", { dialog: focusOrder, escapeRestored: true, cancelRestored: cancelledState.focus === "btn-compile-deck" });
    json("action-frame-log.json", { frames, lifecycle: { compileSlidePlan: 1, persistSlidePlan: 0 }, cancel: 0, escape: 0, identities: { retainedDraft: { planId: draft.planId, revision: draft.revision }, authoritativeFinal: { planId: final.planId, revision: final.revision } } });
    json("environment.json", { viewport: VIEWPORT, locale: "ko-KR", timezone: "Asia/Seoul", reducedMotion: true, bun: Bun.version, roots: { databasePath, exportRoot, settingsRoot, browserProfile }, externalRequests });
    json("command.json", { command: "VISUAL_EVIDENCE_DIR=$PWD/.omo/evidence/ulw-execute/draft-final-review-fixes/task-9 bun test tests/public-draft-final-visual-qa.test.ts", focusedSubsetImmediatelyBeforeCapture: "bun test tests/public-compile-control.test.ts tests/public-slide-plan-workspace.test.ts tests/public-review.test.ts" });
    json("hashes.json", { capturedAt: new Date().toISOString(), sources: Object.fromEntries(sourceFiles.map((path) => [path, { sha256: sha256(path), mtimeMs: statSync(path).mtimeMs }])), captures: Object.fromEntries(["dirty-confirmed-dialog.png", "after-cancel.png", "final-workspace.png"].map((name) => [name, { sha256: sha256(join(evidenceDirectory, name)), bytes: statSync(join(evidenceDirectory, name)).size, mtimeMs: statSync(join(evidenceDirectory, name)).mtimeMs }])) });
    expect(externalRequests).toEqual([]);
    for (const name of ["dirty-confirmed-dialog.png", "after-cancel.png", "final-workspace.png"]) { expect(statSync(join(evidenceDirectory, name)).size).toBeGreaterThan(0); expect(statSync(join(evidenceDirectory, name)).mtimeMs).toBeGreaterThanOrEqual(Math.max(...sourceFiles.map((path) => statSync(path).mtimeMs))); }
  }, 120_000);
});
