// Contract test for the review panel overlay (T8).
// Runs the real public/ shell in headless Chromium with a fake WebSocket so the
// assertions read actual DOM state and actual wire payloads, never simulated ones.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PUBLIC_FILES = new Set([
  "/index.html", "/style.css", "/app.js", "/review-panel-render.js", "/review-panel.js",
]);

type FakeSocket = { emit(value: unknown): void; close(): void };

declare global {
  interface Window {
    __sockets: FakeSocket[];
    __sent: Array<Record<string, unknown>>;
  }
}

let browser: Browser;
let page: Page;
let server: Server;
let origin: string;

const VERSION_ID = "tv-9f2c-canonical";

/** A review payload shaped exactly like src/session.ts ReviewUpdate. */
function reviewMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "review",
    reviewId: "rev-001",
    transcriptVersionId: VERSION_ID,
    attendees: [
      { attendeeId: "att-1", displayName: "김현준" },
      { attendeeId: "att-2", displayName: "Sarah O'Connor" },
    ],
    transcript: {
      lines: [
        { seq: 1, speakerTurn: 1, text: "가격 정책은 구독으로 확정합니다." },
        { seq: 2, speakerTurn: 2, text: "제가 계약서 초안을 금요일까지 공유하겠습니다." },
        { seq: 3, speakerTurn: 1, text: "리브랜딩은 다음 회의에서 다시 논의합시다." },
      ],
    },
    items: [
      {
        id: "dec-1",
        kind: "decision",
        description: "가격 정책을 구독 모델로 확정",
        sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 1, end_seq: 1 },
        evidenceQuote: "가격 정책은 구독으로 확정합니다.",
        segment_text: "가격 정책은 구독으로 확정합니다.",
        attributedAttendeeId: "att-1",
      },
      {
        id: "act-1",
        kind: "action_item",
        description: "계약서 초안 공유",
        sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 2, end_seq: 2 },
        evidenceQuote: "제가 계약서 초안을 금요일까지 공유하겠습니다.",
        segment_text: "제가 계약서 초안을 금요일까지 공유하겠습니다.",
        attributedAttendeeId: null,
        assigneeAttendeeId: null,
        deadline: "2026-08-07",
        deadlineText: "금요일까지",
      },
      {
        id: "open-1",
        kind: "open_item",
        description: "리브랜딩 방향 미정",
        sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 3, end_seq: 3 },
        evidenceQuote: "리브랜딩은 다음 회의에서 다시 논의합시다.",
        segment_text: "리브랜딩은 다음 회의에서 다시 논의합시다.",
        attributedAttendeeId: null,
      },
    ],
    ...overrides,
  };
}

async function loadShell(): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sockets.length > 0);
  await emit({ type: "capture", capturing: false, mode: "mic" });
}

const emit = (value: unknown) => page.evaluate((v) => window.__sockets.at(-1)!.emit(v), value);
const sent = () => page.evaluate(() => window.__sent);
const clearSent = () => page.evaluate(() => { window.__sent.length = 0; });

/** Emits a review payload and resolves once the panel has painted its rows. */
async function openReview(overrides: Record<string, unknown> = {}): Promise<void> {
  await emit(reviewMessage(overrides));
  await page.waitForSelector("#review-panel:not([hidden])");
}

const rowData = () => page.evaluate(() =>
  Array.from(document.querySelectorAll(".review-item")).map((row) => ({
    id: (row as HTMLElement).dataset.itemId,
    kind: (row as HTMLElement).dataset.kind,
    description: row.querySelector(".review-item__description")?.textContent?.trim(),
    quote: row.querySelector(".review-item__quote")?.textContent?.trim(),
    coords: row.querySelector(".review-item__coords")?.textContent?.trim(),
    options: Array.from(row.querySelectorAll(".review-item__attribution option")).map((o) => ({
      value: (o as HTMLOptionElement).value,
      label: o.textContent,
    })),
  })));

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const requested = request.url === "/" ? "/index.html" : request.url ?? "";
    const pathname = new URL(requested, "http://127.0.0.1").pathname;
    if (!PUBLIC_FILES.has(pathname)) {
      response.writeHead(404).end("Not found");
      return;
    }
    const type = pathname.endsWith(".css")
      ? "text/css"
      : pathname.endsWith(".js")
        ? "text/javascript"
        : "text/html";
    response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    response.end(await readFile(join(PUBLIC_DIR, pathname.slice(1))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  origin = `http://127.0.0.1:${address.port}`;

  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() {
        window.__sent ??= [];
        window.__sockets ??= [];
        window.__sockets.push(this as unknown as FakeSocket);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      send(raw: string) { window.__sent.push(JSON.parse(raw)); }
      close() { this.readyState = 3; this.onclose?.(new Event("close")); }
      emit(value: unknown) {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
      }
    }
    window.__sent = [];
    window.__sockets = [];
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

beforeEach(async () => {
  await loadShell();
  await clearSent();
});

describe("review panel shell", () => {
  test("the panel mounts hidden and leaves the slide shell intact", async () => {
    expect(await page.evaluate(() => ({
      panelExists: !!document.getElementById("review-panel"),
      hidden: (document.getElementById("review-panel") as HTMLElement).hidden,
      role: document.getElementById("review-panel")?.getAttribute("role"),
      slideFrameVisible: !!document.getElementById("slide-frame"),
      recordVisible: !(document.getElementById("btn-record") as HTMLElement).hidden,
      dockVisible: !!document.querySelector(".dock"),
    }))).toEqual({
      panelExists: true,
      hidden: true,
      role: "dialog",
      slideFrameVisible: true,
      recordVisible: true,
      dockVisible: true,
    });
  });

  test("capture is not hard-gated by the review panel", async () => {
    await openReview();
    expect(await page.evaluate(() => ({
      recordDisabled: (document.getElementById("btn-record") as HTMLButtonElement).disabled,
      recordHidden: (document.getElementById("btn-record") as HTMLElement).hidden,
    }))).toEqual({ recordDisabled: false, recordHidden: false });
  });
});

describe("candidate cards", () => {
  test("a review message renders one card per candidate with quote and version-scoped coordinates", async () => {
    await openReview();
    const rows = await rowData();
    expect(rows.map((r) => ({ id: r.id, kind: r.kind, description: r.description }))).toEqual([
      { id: "dec-1", kind: "decision", description: "가격 정책을 구독 모델로 확정" },
      { id: "act-1", kind: "action_item", description: "계약서 초안 공유" },
      { id: "open-1", kind: "open_item", description: "리브랜딩 방향 미정" },
    ]);
    expect(rows[0]!.quote).toBe("가격 정책은 구독으로 확정합니다.");
    expect(rows[0]!.coords).toContain("1");
    expect(rows[0]!.coords).toContain(VERSION_ID);
  });

  test("every candidate carries the immutable transcript version id, not just a seq", async () => {
    await openReview();
    expect(await page.evaluate(() =>
      Array.from(document.querySelectorAll(".review-item")).map((row) => ({
        version: (row as HTMLElement).dataset.transcriptVersionId,
        start: (row as HTMLElement).dataset.startSeq,
        end: (row as HTMLElement).dataset.endSeq,
      })))).toEqual([
      { version: VERSION_ID, start: "1", end: "1" },
      { version: VERSION_ID, start: "2", end: "2" },
      { version: VERSION_ID, start: "3", end: "3" },
    ]);
  });

  test("a multi-line segment shows the joined evidence text of the whole range", async () => {
    await openReview({
      items: [{
        id: "dec-multi",
        kind: "decision",
        description: "범위 결정",
        sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 1, end_seq: 3 },
        evidenceQuote: "가격 정책은 구독으로 확정합니다.",
        segment_text: "가격 정책은 구독으로 확정합니다.\n제가 계약서 초안을 금요일까지 공유하겠습니다.",
        attributedAttendeeId: null,
      }],
    });
    const coords = await page.evaluate(() => document.querySelector(".review-item__coords")!.textContent!);
    expect(coords).toContain("1");
    expect(coords).toContain("3");
    const segment = await page.evaluate(() => document.querySelector(".review-item__segment")!.textContent!);
    expect(segment).toContain("계약서 초안");
  });

  test("action items surface deadline text alongside the normalized deadline", async () => {
    await openReview();
    const action = await page.evaluate(() => {
      const row = document.querySelector('.review-item[data-item-id="act-1"]')!;
      return {
        deadline: (row.querySelector(".review-item__deadline-input") as HTMLInputElement)?.value,
        deadlineText: row.querySelector(".review-item__deadline-text")?.textContent?.trim(),
        hasAssignee: !!row.querySelector(".review-item__assignee"),
      };
    });
    expect(action).toEqual({ deadline: "2026-08-07", deadlineText: "금요일까지", hasAssignee: true });
  });

  test("decisions and open items have no assignee control — only action items do", async () => {
    await openReview();
    expect(await page.evaluate(() =>
      Array.from(document.querySelectorAll(".review-item")).map((row) =>
        ({ kind: (row as HTMLElement).dataset.kind, assignee: !!row.querySelector(".review-item__assignee") })),
    )).toEqual([
      { kind: "decision", assignee: false },
      { kind: "action_item", assignee: true },
      { kind: "open_item", assignee: false },
    ]);
  });
});

describe("attendee dropdown attribution", () => {
  test("attribution options come only from the review attendees, never free text", async () => {
    await openReview();
    const rows = await rowData();
    expect(rows[0]!.options).toEqual([
      { value: "", label: "미지정" },
      { value: "att-1", label: "김현준" },
      { value: "att-2", label: "Sarah O'Connor" },
    ]);
    expect(await page.evaluate(() =>
      document.querySelectorAll("#review-panel input[type=text]").length)).toBe(0);
  });

  test("the suggested attribution is preselected and a change sends updateItem", async () => {
    await openReview();
    expect(await page.evaluate(() =>
      (document.querySelector('.review-item[data-item-id="dec-1"] .review-item__attribution') as HTMLSelectElement).value,
    )).toBe("att-1");

    await clearSent();
    await page.select('.review-item[data-item-id="dec-1"] .review-item__attribution', "att-2");
    expect(await sent()).toEqual([{
      action: "updateItem",
      reviewId: "rev-001",
      itemId: "dec-1",
      kind: "decision",
      patch: { attributedAttendeeId: "att-2" },
    }]);
  });

  test("assigning an action item sends updateItem with the assignee patch", async () => {
    await openReview();
    await clearSent();
    await page.select('.review-item[data-item-id="act-1"] .review-item__assignee', "att-1");
    expect(await sent()).toEqual([{
      action: "updateItem",
      reviewId: "rev-001",
      itemId: "act-1",
      kind: "action_item",
      patch: { assigneeAttendeeId: "att-1" },
    }]);
  });

  test("with no attendees the dropdowns are disabled and explain why", async () => {
    await openReview({ attendees: [] });
    expect(await page.evaluate(() => ({
      disabled: Array.from(document.querySelectorAll(".review-item__attribution"))
        .every((s) => (s as HTMLSelectElement).disabled),
      options: Array.from(
        document.querySelector(".review-item")!.querySelectorAll(".review-item__attribution option"),
      ).map((o) => o.textContent),
      notice: document.getElementById("review-attendee-notice")?.textContent?.trim(),
      noticeHidden: (document.getElementById("review-attendee-notice") as HTMLElement).hidden,
    }))).toEqual({
      disabled: true,
      options: ["참석자 없음"],
      notice: "참석자를 먼저 추가하면 발언자와 담당자를 연결할 수 있습니다",
      noticeHidden: false,
    });
  });
});

describe("edit and drop controls", () => {
  test("editing a description sends updateItem with the trimmed text", async () => {
    await openReview();
    await page.click('.review-item[data-item-id="dec-1"] .review-item__edit');
    await page.waitForSelector('.review-item[data-item-id="dec-1"] .review-item__editor');
    await page.evaluate(() => {
      const editor = document.querySelector('.review-item[data-item-id="dec-1"] .review-item__editor') as HTMLTextAreaElement;
      editor.value = "  가격 정책을 연간 구독으로 확정  ";
    });
    await clearSent();
    await page.click('.review-item[data-item-id="dec-1"] .review-item__save');
    expect(await sent()).toEqual([{
      action: "updateItem",
      reviewId: "rev-001",
      itemId: "dec-1",
      kind: "decision",
      patch: { description: "가격 정책을 연간 구독으로 확정" },
    }]);
    expect(await page.evaluate(() =>
      document.querySelector('.review-item[data-item-id="dec-1"] .review-item__description')!.textContent!.trim(),
    )).toBe("가격 정책을 연간 구독으로 확정");
  });

  test("an empty edit is rejected without sending anything", async () => {
    await openReview();
    await page.click('.review-item[data-item-id="dec-1"] .review-item__edit');
    await page.waitForSelector('.review-item[data-item-id="dec-1"] .review-item__editor');
    await page.evaluate(() => {
      (document.querySelector('.review-item[data-item-id="dec-1"] .review-item__editor') as HTMLTextAreaElement).value = "   ";
    });
    await clearSent();
    await page.click('.review-item[data-item-id="dec-1"] .review-item__save');
    expect(await sent()).toEqual([]);
    expect(await page.evaluate(() => ({
      error: document.getElementById("review-error")?.textContent?.trim(),
      hidden: (document.getElementById("review-error") as HTMLElement).hidden,
    }))).toEqual({ error: "내용을 입력해 주세요", hidden: false });
  });

  test("dropping a candidate marks it rejected and sends the review_state patch", async () => {
    await openReview();
    await clearSent();
    await page.click('.review-item[data-item-id="open-1"] .review-item__drop');
    expect(await sent()).toEqual([{
      action: "updateItem",
      reviewId: "rev-001",
      itemId: "open-1",
      kind: "open_item",
      patch: { reviewState: "rejected" },
    }]);
    expect(await page.evaluate(() => {
      const row = document.querySelector('.review-item[data-item-id="open-1"]')!;
      return {
        dropped: row.classList.contains("review-item--dropped"),
        state: (row as HTMLElement).dataset.reviewState,
        selectsDisabled: Array.from(row.querySelectorAll("select")).every((s) => (s as HTMLSelectElement).disabled),
      };
    })).toEqual({ dropped: true, state: "rejected", selectsDisabled: true });
  });

  test("a dropped candidate can be restored to candidate state", async () => {
    await openReview();
    await page.click('.review-item[data-item-id="open-1"] .review-item__drop');
    await clearSent();
    await page.click('.review-item[data-item-id="open-1"] .review-item__drop');
    expect(await sent()).toEqual([{
      action: "updateItem",
      reviewId: "rev-001",
      itemId: "open-1",
      kind: "open_item",
      patch: { reviewState: "candidate" },
    }]);
    expect(await page.evaluate(() =>
      (document.querySelector('.review-item[data-item-id="open-1"]') as HTMLElement).dataset.reviewState)).toBe("candidate");
  });
});

describe("confirm action", () => {
  test("the actual browser flow confirms complete candidates, corrects an action deadline, then confirms the review", async () => {
    await openReview();
    expect(await page.$eval("#btn-review-confirm", (button) => (button as HTMLButtonElement).disabled)).toBe(true);

    await page.click('.review-item[data-item-id="dec-1"] .review-item__confirm');
    await page.select('.review-item[data-item-id="act-1"] .review-item__attribution', "att-1");
    await page.select('.review-item[data-item-id="act-1"] .review-item__assignee', "att-2");
    await page.$eval('.review-item[data-item-id="act-1"] .review-item__deadline-input', (input) => {
      (input as HTMLInputElement).value = "2026-08-14";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click('.review-item[data-item-id="act-1"] .review-item__confirm');
    await page.select('.review-item[data-item-id="open-1"] .review-item__attribution', "att-2");
    await page.click('.review-item[data-item-id="open-1"] .review-item__confirm');

    expect(await page.$eval("#btn-review-confirm", (button) => (button as HTMLButtonElement).disabled)).toBe(false);
    await page.click("#btn-review-confirm");
    expect(await sent()).toEqual([
      { action: "updateItem", reviewId: "rev-001", itemId: "dec-1", kind: "decision", patch: { reviewState: "confirmed" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "act-1", kind: "action_item", patch: { attributedAttendeeId: "att-1" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "act-1", kind: "action_item", patch: { assigneeAttendeeId: "att-2" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "act-1", kind: "action_item", patch: { deadline: "2026-08-14" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "act-1", kind: "action_item", patch: { reviewState: "confirmed" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "open-1", kind: "open_item", patch: { attributedAttendeeId: "att-2" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "open-1", kind: "open_item", patch: { reviewState: "confirmed" } },
      { action: "confirmReview", reviewId: "rev-001" },
    ]);
  });

  test("the confirm button reports how many candidates will be kept", async () => {
    await openReview();
    expect(await page.evaluate(() => document.getElementById("review-confirm-count")!.textContent)).toBe("3");
    await page.click('.review-item[data-item-id="open-1"] .review-item__drop');
    expect(await page.evaluate(() => document.getElementById("review-confirm-count")!.textContent)).toBe("2");
  });

  test("a review with every candidate rejected remains confirmable", async () => {
    await openReview({ items: [reviewMessage().items[0]] });
    await page.click('.review-item[data-item-id="dec-1"] .review-item__drop');
    await clearSent();
    await page.click("#btn-review-confirm");
    expect(await sent()).toEqual([{ action: "confirmReview", reviewId: "rev-001" }]);
  });
});

describe("empty, error, and loading states", () => {
  test("an empty candidate list shows the no-candidates notice and no cards", async () => {
    await openReview({ items: [] });
    expect(await page.evaluate(() => ({
      rows: document.querySelectorAll(".review-item").length,
      empty: document.querySelector(".review-list__empty")?.textContent?.trim(),
      confirmDisabled: (document.getElementById("btn-review-confirm") as HTMLButtonElement).disabled,
    }))).toEqual({
      rows: 0,
      empty: "확인할 결정 사항이나 할 일을 찾지 못했습니다",
      confirmDisabled: false,
    });
  });

  test("the extraction status message drives a loading state before the payload lands", async () => {
    await emit({ type: "status", text: "회의록 정리 중…" });
    await page.waitForSelector("#review-panel:not([hidden])");
    expect(await page.evaluate(() => ({
      loading: (document.getElementById("review-panel") as HTMLElement).dataset.state,
      busy: document.getElementById("review-panel")?.getAttribute("aria-busy"),
      confirmDisabled: (document.getElementById("btn-review-confirm") as HTMLButtonElement).disabled,
    }))).toEqual({ loading: "loading", busy: "true", confirmDisabled: true });

    await openReview();
    expect(await page.evaluate(() => ({
      state: (document.getElementById("review-panel") as HTMLElement).dataset.state,
      busy: document.getElementById("review-panel")?.getAttribute("aria-busy"),
    }))).toEqual({ state: "ready", busy: "false" });
  });

  test("an extraction failure status shows a retry affordance instead of stale cards", async () => {
    await emit({ type: "status", text: "회의록을 정리하지 못했습니다" });
    await page.waitForSelector("#review-panel:not([hidden])");
    expect(await page.evaluate(() => ({
      state: (document.getElementById("review-panel") as HTMLElement).dataset.state,
      error: document.getElementById("review-error")?.textContent?.trim(),
      retryVisible: !(document.getElementById("btn-review-retry") as HTMLElement).hidden,
    }))).toEqual({
      state: "error",
      error: "회의록을 정리하지 못했습니다",
      retryVisible: true,
    });

    await clearSent();
    await page.click("#btn-review-retry");
    expect(await sent()).toEqual([{ action: "startReview" }]);
  });
});

describe("keyboard accessibility", () => {
  test("Escape closes the panel and the toggle reopens it without refetching", async () => {
    await openReview();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => (document.getElementById("review-panel") as HTMLElement).hidden)).toBe(true);
    await clearSent();
    await page.click("#btn-review");
    await page.waitForSelector("#review-panel:not([hidden])");
    expect(await sent()).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll(".review-item").length)).toBe(3);
  });

  test("opening the panel moves focus into it and the toggle reflects expansion", async () => {
    await openReview();
    expect(await page.evaluate(() => ({
      expanded: document.getElementById("btn-review")?.getAttribute("aria-expanded"),
      focusInsidePanel: document.getElementById("review-panel")!.contains(document.activeElement),
    }))).toEqual({ expanded: "true", focusInsidePanel: true });
  });

  test("every control is reachable and labelled for assistive tech", async () => {
    await openReview();
    expect(await page.evaluate(() => {
      const row = document.querySelector('.review-item[data-item-id="act-1"]')!;
      return {
        attributionLabelled: !!row.querySelector(".review-item__attribution")?.getAttribute("aria-label"),
        assigneeLabelled: !!row.querySelector(".review-item__assignee")?.getAttribute("aria-label"),
        editLabelled: !!row.querySelector(".review-item__edit")?.getAttribute("aria-label"),
        dropLabelled: !!row.querySelector(".review-item__drop")?.getAttribute("aria-label"),
        listRole: document.getElementById("review-list")?.getAttribute("role"),
        errorLive: document.getElementById("review-error")?.getAttribute("role"),
      };
    })).toEqual({
      attributionLabelled: true,
      assigneeLabelled: true,
      editLabelled: true,
      dropLabelled: true,
      listRole: "list",
      errorLive: "alert",
    });
  });

  test("Enter on the drop control toggles it, so the panel is operable keyboard-only", async () => {
    await openReview();
    await page.focus('.review-item[data-item-id="dec-1"] .review-item__drop');
    await clearSent();
    await page.keyboard.press("Enter");
    expect((await sent())[0]).toMatchObject({ action: "updateItem", patch: { reviewState: "rejected" } });
  });
});

describe("reconnect and update handling", () => {
  test("a second review message replaces the previous candidates rather than appending", async () => {
    await openReview();
    await emit(reviewMessage({
      reviewId: "rev-002",
      items: [{
        id: "dec-9",
        kind: "decision",
        description: "재추출 결정",
        sourceSegment: { transcript_version_id: "tv-second-version", start_seq: 5, end_seq: 5 },
        evidenceQuote: "재추출된 근거",
        segment_text: "재추출된 근거",
        attributedAttendeeId: null,
      }],
      transcriptVersionId: "tv-second-version",
    }));
    await page.waitForFunction(() => document.querySelectorAll(".review-item").length === 1);
    expect(await page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll(".review-item")).map((r) => (r as HTMLElement).dataset.itemId),
      version: (document.querySelector(".review-item") as HTMLElement).dataset.transcriptVersionId,
    }))).toEqual({ ids: ["dec-9"], version: "tv-second-version" });

    await clearSent();
    await page.select('.review-item[data-item-id="dec-9"] .review-item__attribution', "att-1");
    await page.click('.review-item[data-item-id="dec-9"] .review-item__confirm');
    await page.click("#btn-review-confirm");
    expect(await sent()).toEqual([
      { action: "updateItem", reviewId: "rev-002", itemId: "dec-9", kind: "decision", patch: { attributedAttendeeId: "att-1" } },
      { action: "updateItem", reviewId: "rev-002", itemId: "dec-9", kind: "decision", patch: { reviewState: "confirmed" } },
      { action: "confirmReview", reviewId: "rev-002" },
    ]);
  });

  test("a dropped socket disables confirm and reconnect restores it", async () => {
    await openReview({ items: [reviewMessage().items[0]] });
    await page.click('.review-item[data-item-id="dec-1"] .review-item__confirm');
    await page.evaluate(() => window.__sockets.at(-1)!.close());
    await page.waitForFunction(() => (document.getElementById("btn-review-confirm") as HTMLButtonElement).disabled);
    await clearSent();
    await page.click("#btn-review-confirm");
    expect(await sent()).toEqual([]);

    await page.waitForFunction(() => window.__sockets.length > 1, { timeout: 10_000 });
    await page.waitForFunction(() => !(document.getElementById("btn-review-confirm") as HTMLButtonElement).disabled);
    await clearSent();
    await page.click("#btn-review-confirm");
    expect(await sent()).toEqual([{ action: "confirmReview", reviewId: "rev-001" }]);
  }, 20_000);

  test("local edits survive a re-render triggered by an unrelated message", async () => {
    await openReview();
    await page.select('.review-item[data-item-id="dec-1"] .review-item__attribution', "att-2");
    await emit({ type: "capture", capturing: false, mode: "mic" });
    expect(await page.evaluate(() =>
      (document.querySelector('.review-item[data-item-id="dec-1"] .review-item__attribution') as HTMLSelectElement).value,
    )).toBe("att-2");
  });
});

describe("hostile payloads", () => {
  test("markup in descriptions, quotes, and attendee names is escaped as text", async () => {
    await openReview({
      attendees: [{ attendeeId: "att-x", displayName: "<img src=x onerror=window.__xss=1>" }],
      items: [{
        id: "dec-x",
        kind: "decision",
        description: "<script>window.__xss=1</script>결정",
        sourceSegment: { transcript_version_id: "<svg onload=window.__xss=1>", start_seq: 1, end_seq: 1 },
        evidenceQuote: "\"><img src=x onerror=window.__xss=1>",
        segment_text: "<b>bold</b>",
        attributedAttendeeId: null,
      }],
    });
    expect(await page.evaluate(() => ({
      xss: (window as unknown as { __xss?: number }).__xss ?? null,
      injectedImages: document.querySelectorAll("#review-panel img, #review-panel script, #review-panel svg").length,
      description: document.querySelector(".review-item__description")!.textContent,
      optionLabel: document.querySelectorAll(".review-item__attribution option")[1]?.textContent,
      segment: document.querySelector(".review-item__segment")!.textContent,
    }))).toEqual({
      xss: null,
      injectedImages: 0,
      description: "<script>window.__xss=1</script>결정",
      optionLabel: "<img src=x onerror=window.__xss=1>",
      segment: "<b>bold</b>",
    });
  });

  test("a malformed review payload is ignored without tearing down the shell", async () => {
    await openReview();
    await emit({ type: "review", reviewId: null, items: "not-an-array", attendees: null });
    expect(await page.evaluate(() => ({
      rows: document.querySelectorAll(".review-item").length,
      shellAlive: !!document.getElementById("slide-frame"),
      panelHidden: (document.getElementById("review-panel") as HTMLElement).hidden,
    }))).toEqual({ rows: 3, shellAlive: true, panelHidden: false });
  });

  test("a kind outside the updateItem wire contract is refused, not rendered as an actionable card", async () => {
    // server.ts parseReviewKind accepts only decision | action_item | open_item.
    // Rendering any other kind would offer attribution and drop controls whose
    // updateItem the server is guaranteed to reject with INVALID_REVIEW_REQUEST.
    await openReview({
      items: [
        {
          id: "ok-1",
          kind: "decision",
          description: "계약 가능한 결정",
          sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 1, end_seq: 1 },
          evidenceQuote: "가격 정책은 구독으로 확정합니다.",
          segment_text: "가격 정책은 구독으로 확정합니다.",
          attributedAttendeeId: null,
        },
        {
          id: "mat-1",
          kind: "referenced_material",
          description: "참조 자료 후보",
          sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 2, end_seq: 2 },
          evidenceQuote: "제가 계약서 초안을 금요일까지 공유하겠습니다.",
          segment_text: "제가 계약서 초안을 금요일까지 공유하겠습니다.",
          attributedAttendeeId: null,
        },
      ],
    });
    expect(await page.evaluate(() =>
      Array.from(document.querySelectorAll(".review-item")).map((r) => (r as HTMLElement).dataset.itemId),
    )).toEqual(["ok-1"]);

    // Nothing on the refused candidate can reach the wire.
    await clearSent();
    await page.evaluate(() => {
      document.querySelectorAll('.review-item[data-item-id="mat-1"] button, .review-item[data-item-id="mat-1"] select')
        .forEach((control) => (control as HTMLElement).click());
    });
    expect(await sent()).toEqual([]);

    // The kept candidate still transitions and confirms, so one bad kind cannot block the review.
    await clearSent();
    await page.select('.review-item[data-item-id="ok-1"] .review-item__attribution', "att-1");
    await page.click('.review-item[data-item-id="ok-1"] .review-item__confirm');
    await page.click("#btn-review-confirm");
    expect(await sent()).toEqual([
      { action: "updateItem", reviewId: "rev-001", itemId: "ok-1", kind: "decision", patch: { attributedAttendeeId: "att-1" } },
      { action: "updateItem", reviewId: "rev-001", itemId: "ok-1", kind: "decision", patch: { reviewState: "confirmed" } },
      { action: "confirmReview", reviewId: "rev-001" },
    ]);
  });

  test("items missing required evidence or source coordinates are refused rather than rendered uncited", async () => {
    await openReview({
      items: [
        {
          id: "ok-1",
          kind: "decision",
          description: "근거 있는 결정",
          sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 1, end_seq: 1 },
          evidenceQuote: "가격 정책은 구독으로 확정합니다.",
          segment_text: "가격 정책은 구독으로 확정합니다.",
          attributedAttendeeId: null,
        },
        { id: "bad-1", kind: "decision", description: "근거 없는 결정", attributedAttendeeId: null },
        {
          id: "bad-2",
          kind: "decision",
          description: "좌표 깨진 결정",
          sourceSegment: { transcript_version_id: "", start_seq: 0, end_seq: -1 },
          evidenceQuote: "깨진 좌표의 인용",
          segment_text: "깨진 좌표의 인용",
          attributedAttendeeId: null,
        },
        {
          id: "bad-3",
          kind: "decision",
          description: "인용 없는 결정",
          sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 2, end_seq: 2 },
          segment_text: "인용 필드가 없는 구간 전문",
          attributedAttendeeId: null,
        },
        {
          id: "bad-4",
          kind: "decision",
          description: "빈 인용 결정",
          sourceSegment: { transcript_version_id: VERSION_ID, start_seq: 3, end_seq: 3 },
          evidenceQuote: "   ",
          segment_text: "공백 인용의 구간 전문",
          attributedAttendeeId: null,
        },
      ],
    });
    expect(await page.evaluate(() =>
      Array.from(document.querySelectorAll(".review-item")).map((r) => (r as HTMLElement).dataset.itemId),
    )).toEqual(["ok-1"]);
  });
});
