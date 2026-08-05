// Contract test for the pre-capture attendee registration form (T5).
// Runs the real public/ shell in headless Chromium with a fake WebSocket so the
// assertions read actual DOM state and actual wire payloads, never simulated ones.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PUBLIC_FILES = new Set(["/index.html", "/style.css", "/app.js"]);

type FakeSocket = { emit(value: unknown): void; close(): void };

declare global {
  interface Window {
    __sockets: FakeSocket[];
    __sent: Array<Record<string, unknown>>;
    __attendeeState: { meetingId: number | null; attendees: Array<Record<string, unknown>> };
  }
}

let browser: Browser;
let page: Page;
let server: Server;
let origin: string;

/** Resolves once the freshly created page has a live fake socket bound by app.js. */
async function loadShell(): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sockets.length > 0);
  await emit({ type: "capture", capturing: false, mode: "mic" });
}

const emit = (value: unknown) => page.evaluate((v) => window.__sockets.at(-1)!.emit(v), value);
const sent = () => page.evaluate(() => window.__sent);
const clearSent = () => page.evaluate(() => { window.__sent.length = 0; });

/** Types a draft attendee and commits it with Enter (keyboard-only path). */
async function addAttendee(name: string, crm = ""): Promise<void> {
  await page.focus("#attendee-name");
  await page.type("#attendee-name", name);
  if (crm) {
    await page.focus("#attendee-crm");
    await page.type("#attendee-crm", crm);
  }
  await page.keyboard.press("Enter");
}

const draftNames = () =>
  page.evaluate(() => Array.from(document.querySelectorAll(".attendee-row__name")).map((n) => n.textContent));

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

describe("pre-capture attendee registration form", () => {
  test("the pre-capture shell exposes a keyboard-reachable attendee panel", async () => {
    const shell = await page.evaluate(() => {
      const toggle = document.getElementById("btn-attendees") as HTMLButtonElement | null;
      const panel = document.getElementById("attendee-panel") as HTMLElement | null;
      return {
        toggleExists: !!toggle,
        toggleTag: toggle?.tagName,
        toggleDisabled: toggle?.disabled ?? null,
        toggleLabel: toggle?.getAttribute("aria-label"),
        toggleExpanded: toggle?.getAttribute("aria-expanded"),
        panelExists: !!panel,
        panelHiddenInitially: panel?.hidden ?? null,
        recordStillVisible: !(document.getElementById("btn-record") as HTMLElement).hidden,
      };
    });
    expect(shell).toEqual({
      toggleExists: true,
      toggleTag: "BUTTON",
      toggleDisabled: false,
      toggleLabel: "참석자 지정",
      toggleExpanded: "false",
      panelExists: true,
      panelHiddenInitially: true,
      recordStillVisible: true,
    });
  });

  test("Enter on the toggle opens the panel and focuses the name field", async () => {
    await page.focus("#btn-attendees");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    expect(await page.evaluate(() => ({
      expanded: document.getElementById("btn-attendees")!.getAttribute("aria-expanded"),
      focused: document.activeElement?.id,
    }))).toEqual({ expanded: "true", focused: "attendee-name" });
  });

  test("Escape closes the panel and returns focus to the toggle", async () => {
    await page.click("#btn-attendees");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => ({
      hidden: (document.getElementById("attendee-panel") as HTMLElement).hidden,
      focused: document.activeElement?.id,
    }))).toEqual({ hidden: true, focused: "btn-attendees" });
  });

  test("a click outside the panel closes it, matching the provider-panel pattern", async () => {
    await page.click("#btn-attendees");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    await page.click("#doc-title");
    expect(await page.evaluate(() => (document.getElementById("attendee-panel") as HTMLElement).hidden)).toBe(true);
  });

  test("Enter in the form adds drafts with name and optional crm id, including CJK", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준", "crm-person-001");
    await addAttendee("Sarah O'Connor");
    expect(await page.evaluate(() => Array.from(document.querySelectorAll(".attendee-row")).map((row) => ({
      name: row.querySelector(".attendee-row__name")?.textContent,
      crm: row.querySelector(".attendee-row__crm")?.textContent ?? "",
    })))).toEqual([
      { name: "김현준", crm: "crm-person-001" },
      { name: "Sarah O'Connor", crm: "" },
    ]);
    expect(await page.evaluate(() => ({
      name: (document.getElementById("attendee-name") as HTMLInputElement).value,
      crm: (document.getElementById("attendee-crm") as HTMLInputElement).value,
      focused: document.activeElement?.id,
    }))).toEqual({ name: "", crm: "", focused: "attendee-name" });
  });

  test("an empty or whitespace-only name is rejected without sending anything", async () => {
    await page.click("#btn-attendees");
    await clearSent();
    await page.focus("#attendee-name");
    await page.keyboard.press("Enter");
    const afterEmpty = await page.evaluate(() => ({
      rows: document.querySelectorAll(".attendee-row").length,
      error: document.getElementById("attendee-error")?.textContent,
      errorHidden: (document.getElementById("attendee-error") as HTMLElement).hidden,
    }));
    expect(afterEmpty.rows).toBe(0);
    expect(afterEmpty.errorHidden).toBe(false);
    expect(afterEmpty.error).toBe("이름을 입력하세요");

    await page.type("#attendee-name", "   ");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.querySelectorAll(".attendee-row").length)).toBe(0);
    expect(await sent()).toEqual([]);
  });

  test("a duplicate name is rejected and the existing draft is left untouched", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await addAttendee("  김현준  ");
    expect(await page.evaluate(() => ({
      rows: document.querySelectorAll(".attendee-row").length,
      error: document.getElementById("attendee-error")?.textContent,
    }))).toEqual({ rows: 1, error: "이미 추가된 참석자입니다: 김현준" });
  });

  test("edit loads a draft back into the form and replaces it in place", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준", "crm-1");
    await addAttendee("박지민", "crm-2");
    await page.click('.attendee-row[data-index="0"] .attendee-row__edit');
    expect(await page.evaluate(() => ({
      name: (document.getElementById("attendee-name") as HTMLInputElement).value,
      crm: (document.getElementById("attendee-crm") as HTMLInputElement).value,
      rows: document.querySelectorAll(".attendee-row").length,
      focused: document.activeElement?.id,
    }))).toEqual({ name: "김현준", crm: "crm-1", rows: 1, focused: "attendee-name" });
    // 편집 필드는 값이 미리 채워져 있으므로, 실제 사용자처럼 캐럿을 끝으로 옮긴 뒤 이어 친다.
    await page.keyboard.press("End");
    await page.type("#attendee-name", " 대표");
    await page.keyboard.press("Enter");
    expect(await draftNames()).toEqual(["박지민", "김현준 대표"]);
  });

  test("edit and remove keep the panel open even though they re-render the list", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await addAttendee("박지민");
    await page.click('.attendee-row[data-index="1"] .attendee-row__remove');
    expect(await page.evaluate(() => (document.getElementById("attendee-panel") as HTMLElement).hidden)).toBe(false);
    await page.click('.attendee-row[data-index="0"] .attendee-row__edit');
    expect(await page.evaluate(() => ({
      hidden: (document.getElementById("attendee-panel") as HTMLElement).hidden,
      focused: document.activeElement?.id,
    }))).toEqual({ hidden: false, focused: "attendee-name" });
  });

  test("remove drops exactly one draft", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await addAttendee("박지민");
    await addAttendee("이서연");
    await page.click('.attendee-row[data-index="1"] .attendee-row__remove');
    expect(await draftNames()).toEqual(["김현준", "이서연"]);
  });

  test("submit serializes the exact setAttendees wire payload", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준", "crm-person-001");
    await addAttendee("박지민");
    await clearSent();
    await page.click("#btn-attendee-save");
    expect(await sent()).toEqual([{
      action: "setAttendees",
      attendees: [
        { name: "김현준", crmPersonId: "crm-person-001" },
        { name: "박지민" },
      ],
    }]);
  });

  test("submitting an empty roster is blocked and sends nothing", async () => {
    await page.click("#btn-attendees");
    await clearSent();
    await page.click("#btn-attendee-save");
    expect(await sent()).toEqual([]);
    expect(await page.evaluate(() => document.getElementById("attendee-error")?.textContent))
      .toBe("참석자를 한 명 이상 추가하세요");
  });

  test("an attendees ack stores meeting_id plus the dropdown source and marks rows saved", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준", "crm-person-001");
    await page.click("#btn-attendee-save");
    await emit({
      type: "attendees",
      meeting_id: 4242,
      attendees: [
        { attendee_id: "a-1", display_name: "김현준", crm_person_entity_id: "crm-person-001" },
        { attendee_id: "a-2", display_name: "박지민", crm_person_entity_id: null },
      ],
    });
    await page.waitForFunction(() => document.querySelectorAll(".attendee-row--saved").length === 2);
    expect(await page.evaluate(() => window.__attendeeState)).toEqual({
      meetingId: 4242,
      attendees: [
        { attendeeId: "a-1", displayName: "김현준", crmPersonEntityId: "crm-person-001" },
        { attendeeId: "a-2", displayName: "박지민", crmPersonEntityId: null },
      ],
    });
    expect(await page.evaluate(() => ({
      count: document.getElementById("attendee-count")?.textContent,
      countHidden: (document.getElementById("attendee-count") as HTMLElement).hidden,
      errorHidden: (document.getElementById("attendee-error") as HTMLElement).hidden,
    }))).toEqual({ count: "2", countHidden: false, errorHidden: true });
  });

  test("startCapture carries the prepared meeting_id once attendees are saved", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await page.click("#btn-attendee-save");
    await emit({
      type: "attendees",
      meeting_id: 77,
      attendees: [{ attendee_id: "a-1", display_name: "김현준", crm_person_entity_id: null }],
    });
    await page.waitForFunction(() => window.__attendeeState.meetingId === 77);
    await clearSent();
    await page.click("#btn-record");
    expect(await sent()).toEqual([{ action: "startCapture", meeting_id: 77 }]);
  });

  test("capture is never hard-gated on attendees", async () => {
    await clearSent();
    await page.click("#btn-record");
    expect(await sent()).toEqual([{ action: "startCapture" }]);
  });

  test("an unsaved roster surfaces an error but still starts capture", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await clearSent();
    await page.click("#btn-record");
    expect(await sent()).toEqual([{ action: "startCapture" }]);
    expect(await page.evaluate(() => document.getElementById("attendee-error")?.textContent))
      .toBe("저장하지 않은 참석자가 있습니다 — 저장 후 시작하세요");
  });

  test("capture locks and hides the attendee surface, and release restores it", async () => {
    await page.click("#btn-attendees");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    await emit({ type: "capture", capturing: true, mode: "mic" });
    await page.waitForFunction(() => (document.getElementById("btn-attendees") as HTMLButtonElement).disabled);
    expect(await page.evaluate(() => ({
      panelHidden: (document.getElementById("attendee-panel") as HTMLElement).hidden,
      toggleDisabled: (document.getElementById("btn-attendees") as HTMLButtonElement).disabled,
      saveDisabled: (document.getElementById("btn-attendee-save") as HTMLButtonElement).disabled,
      nameDisabled: (document.getElementById("attendee-name") as HTMLInputElement).disabled,
      crmDisabled: (document.getElementById("attendee-crm") as HTMLInputElement).disabled,
    }))).toEqual({
      panelHidden: true, toggleDisabled: true, saveDisabled: true, nameDisabled: true, crmDisabled: true,
    });

    await emit({ type: "capture", capturing: false, mode: "mic" });
    await page.waitForFunction(() => !(document.getElementById("btn-attendees") as HTMLButtonElement).disabled);
    expect(await page.evaluate(() => (document.getElementById("attendee-name") as HTMLInputElement).disabled)).toBe(false);
  });

  test("a submit racing a capture transition sends at most one setAttendees", async () => {
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await clearSent();
    await page.evaluate(() => {
      (document.getElementById("btn-attendee-save") as HTMLButtonElement).click();
      window.__sockets.at(-1)!.emit({ type: "capture", capturing: true, mode: "mic" });
      (document.getElementById("btn-attendee-save") as HTMLButtonElement).click();
    });
    expect(await sent()).toEqual([{ action: "setAttendees", attendees: [{ name: "김현준" }] }]);
  });

  test("a reconnect asks the server to restore the draft roster", async () => {
    await page.evaluate(() => window.__sockets.at(-1)!.close());
    await page.waitForFunction(() => window.__sockets.length >= 2, { timeout: 10_000 });
    await page.waitForFunction(() => window.__sent.some((m) => m.action === "attendees"), { timeout: 10_000 });
    await emit({
      type: "attendees",
      meeting_id: 4242,
      attendees: [{ attendee_id: "a-1", display_name: "김현준", crm_person_entity_id: null }],
    });
    await page.waitForFunction(() => window.__attendeeState.meetingId === 4242);
    await page.click("#btn-attendees");
    expect(await draftNames()).toEqual(["김현준"]);
  }, 20_000);

  test("malformed attendees payloads leave the panel usable and state coherent", async () => {
    await emit({ type: "attendees", meeting_id: "nope", attendees: "not-an-array" });
    await emit({ type: "attendees" });
    await emit({ type: "attendees", meeting_id: 7, attendees: [{ display_name: null }, 42, null, { attendee_id: "ok", display_name: "박지민" }] });
    expect(await page.evaluate(() => window.__attendeeState)).toEqual({
      meetingId: 7,
      attendees: [{ attendeeId: "ok", displayName: "박지민", crmPersonEntityId: null }],
    });
    await page.click("#btn-attendees");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    expect(await draftNames()).toEqual(["박지민"]);
  });

  test("untrusted attendee text is rendered as text, never as markup", async () => {
    await emit({
      type: "attendees",
      meeting_id: 9,
      attendees: [{
        attendee_id: "x",
        display_name: "<img src=x onerror=\"window.__pwned=1\">",
        crm_person_entity_id: "<script>window.__pwned=1</script>",
      }],
    });
    await page.click("#btn-attendees");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    expect(await page.evaluate(() => ({
      pwned: (window as unknown as { __pwned?: number }).__pwned ?? null,
      injectedNodes: document.querySelectorAll(".attendee-row img, .attendee-row script").length,
      name: document.querySelector(".attendee-row__name")?.textContent,
    }))).toEqual({
      pwned: null,
      injectedNodes: 0,
      name: "<img src=x onerror=\"window.__pwned=1\">",
    });
  });

  test("a reset clears the prepared meeting_id so capture never resends a dead id", async () => {
    // reset은 서버에서 준비된 회의를 종료하고 currentMeetingId를 비운다.
    // 클라이언트가 이전 ID를 계속 들고 있으면 다음 startCapture가 거부당해 녹음이 조용히 실패한다.
    await page.click("#btn-attendees");
    await addAttendee("김현준");
    await page.click("#btn-attendee-save");
    await emit({
      type: "attendees",
      meeting_id: 55,
      attendees: [{ attendee_id: "a-1", display_name: "김현준", crm_person_entity_id: null }],
    });
    await page.waitForFunction(() => window.__attendeeState.meetingId === 55);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("현재 회의를 닫고 새 회의를 준비할까요?");
      await dialog.accept();
    });
    await page.click("#btn-reset");
    await page.waitForFunction(() => window.__attendeeState.meetingId === null);

    await clearSent();
    await page.click("#btn-record");
    expect(await sent()).toEqual([{ action: "startCapture" }]);
  });

  test("the reconnect restore query names an action the real server dispatches", async () => {
    // 재연결 복원은 클라이언트가 보내는 액션 이름과 서버 handlerMap 키가
    // 일치할 때만 성립한다. 어긋나면 요청이 조용히 버려져 복원이 죽는다.
    await page.evaluate(() => window.__sockets.at(-1)!.close());
    await page.waitForFunction(() => window.__sockets.length >= 2, { timeout: 10_000 });
    await page.waitForFunction(() => window.__sent.some((m) => m.action === "attendees"), { timeout: 10_000 });
    const restoreActions = (await sent())
      .map((message) => message.action)
      .filter((action): action is string => typeof action === "string");

    const probe = `
      import { handlerMap } from "./server.ts";
      const actions = ${JSON.stringify(restoreActions)};
      console.log(JSON.stringify(actions.filter((action) => !handlerMap.has(action))));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["-e", probe], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        HTTP_PORT: String(19_800 + (process.pid % 400)),
        OPEN_BROWSER: "false",
        LLM_PROVIDER: "cli",
        LLM_CLI_BIN: "/usr/bin/true",
        LLM_CLI_PRESET: "claude",
        WHISPER_INPUT_MODE: "mic",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const unroutable = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as string[];
    expect(unroutable).toEqual([]);
  }, 40_000);

  test("existing slide rendering and dock controls survive the new panel", async () => {
    await page.click("#btn-attendees");
    await page.waitForSelector("#attendee-panel:not([hidden])");
    // 슬라이드 렌더에 필요한 녹음 중 상태로 전환 — 참석자 패널은 잠기고 닫힌다.
    await emit({ type: "capture", capturing: true, mode: "mic" });
    await emit({
      type: "slide",
      current: { index: 1, title: "출시 일정", bullets: ["베타 금요일"], startedAt: 0, sentenceCount: 3 },
      history: [],
    });
    await page.waitForSelector(".slide__title");
    // 녹음 시작 후에는 라이브 슬라이드가 렌더되고 참석자 패널은 잠금으로 닫힌다.
    expect(await page.evaluate(() => ({
      title: document.querySelector(".slide__title")?.textContent,
      panelLockedClosed: (document.getElementById("attendee-panel") as HTMLElement).hidden,
    }))).toEqual({ title: "출시 일정", panelLockedClosed: true });
    // 도크 버튼은 패널과 무관하게 기존 액션이 그대로 나간다.
    await clearSent();
    await page.click("#btn-export-md");
    expect(await sent()).toEqual([{ action: "saveNotes" }]);
  });
});
