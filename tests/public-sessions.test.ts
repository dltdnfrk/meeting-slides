// 세션 레일 listMeetings — 실제 public/app.js 를 헤르메틱 WS 스텁으로 검증.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();

type MeetingItem = {
  id: number;
  title: string;
  started_at: number;
  status: "open" | "ended";
};

/** 렌더 대기 Promise를 먼저 무장한다 (push 전에 호출). */
async function armMeetingsRender(page: Page, count: number): Promise<void> {
  await page.evaluate((expected) => {
    const list = document.getElementById("session-list")!;
    const empty = document.getElementById("session-empty")!;
    const countEl = document.getElementById("session-count")!;
    const matches = () => {
      const rows = list.querySelectorAll(".session-row").length;
      if (expected === 0) {
        return rows === 0 && empty.hidden === false && countEl.textContent === "0";
      }
      return rows === expected && empty.hidden === true && countEl.textContent === String(expected);
    };
    (globalThis as unknown as { __meetingsRendered: Promise<void> }).__meetingsRendered =
      new Promise<void>((resolve, reject) => {
        if (matches()) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`meetings render timeout count=${expected}`));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (!matches()) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        observer.observe(document.getElementById("session-rail")!, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      });
  }, count);
}

async function awaitMeetingsRender(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { __meetingsRendered: Promise<void> }).__meetingsRendered,
  );
}

async function pushMeetings(page: Page, items: MeetingItem[]): Promise<void> {
  await armMeetingsRender(page, items.length);
  harness.pushMessage({ type: "meetings", items });
  await awaitMeetingsRender(page);
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  // listMeetings 요청이 open 직후 오므로 waiter를 먼저 건다 (드롭 방지).
  const firstMessage = harness.nextClientMessage() as Promise<{ action?: string }>;
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
  const first = await firstMessage;
  expect(first.action).toBe("listMeetings");
}, 20_000);

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("세션 레일 listMeetings", () => {
  test("빈 목록이면 empty state 를 보여준다", async () => {
    await pushMeetings(page, []);
    const state = await page.evaluate(() => ({
      count: document.getElementById("session-count")!.textContent,
      emptyHidden: (document.getElementById("session-empty") as HTMLElement).hidden,
      rows: document.querySelectorAll(".session-row").length,
    }));
    expect(state).toEqual({ count: "0", emptyHidden: false, rows: 0 });
  });

  test("회의 목록을 렌더하고 클릭 시 선택 하이라이트한다", async () => {
    const items: MeetingItem[] = [
      { id: 2, title: "출시 일정", started_at: 1_700_000_100_000, status: "open" },
      { id: 1, title: "킥오프", started_at: 1_700_000_000_000, status: "ended" },
    ];
    await pushMeetings(page, items);

    const before = await page.evaluate(() => ({
      count: document.getElementById("session-count")!.textContent,
      emptyHidden: (document.getElementById("session-empty") as HTMLElement).hidden,
      titles: [...document.querySelectorAll(".session-row__title")].map((el) => el.textContent),
      selected: document.querySelectorAll(".session-row--selected").length,
    }));
    expect(before.count).toBe("2");
    expect(before.emptyHidden).toBe(true);
    expect(before.titles).toEqual(["출시 일정", "킥오프"]);
    expect(before.selected).toBe(0);

    await page.evaluate(() => {
      const rail = document.getElementById("session-rail")!;
      (globalThis as unknown as { __selected: Promise<void> }).__selected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("selection timeout"));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (rail.querySelector(".session-row--selected")) {
            clearTimeout(timer);
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(rail, { childList: true, subtree: true, attributes: true });
      });
    });
    await page.click('.session-row[data-meeting-id="1"]');
    await page.evaluate(() =>
      (globalThis as unknown as { __selected: Promise<void> }).__selected,
    );

    const after = await page.evaluate(() => {
      const selected = document.querySelector(".session-row--selected") as HTMLElement | null;
      return {
        selectedId: selected?.dataset.meetingId ?? null,
        statusText: document.getElementById("status-text")?.textContent ?? "",
      };
    });
    expect(after.selectedId).toBe("1");
    expect(after.statusText).toContain("회의 기록을 불러오는 중");
    expect(after.statusText).toContain("킥오프");
  });

  test("히스토리 삭제 버튼은 선택과 분리된 삭제 명령을 보낸다", async () => {
    const items: MeetingItem[] = [
      { id: 7, title: "삭제할 회의", started_at: 1_700_000_200_000, status: "ended" },
    ];
    await pushMeetings(page, items);
    page.once("dialog", (dialog) => dialog.accept());
    const command = harness.nextClientMessage() as Promise<{ action?: string; meetingId?: number }>;

    await page.click('.session-delete[data-meeting-id="7"]');

    await expect(command).resolves.toEqual({ action: "deleteMeeting", meetingId: 7 });
  });

  test("malformed meetings payload 도 빈 목록으로 복구된다", async () => {
    await armMeetingsRender(page, 0);
    harness.pushMessage({ type: "meetings", items: null });
    await awaitMeetingsRender(page);
    const state = await page.evaluate(() => ({
      count: document.getElementById("session-count")!.textContent,
      rows: document.querySelectorAll(".session-row").length,
      emptyHidden: (document.getElementById("session-empty") as HTMLElement).hidden,
    }));
    expect(state).toEqual({ count: "0", rows: 0, emptyHidden: false });
  });
});
