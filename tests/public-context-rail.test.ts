import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

declare global {
  interface Window {
    __contextRailAwait?: (token: string, predicate: string) => void;
    __contextRailSettle?: (token: string) => void;
  }
}

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;
const shellWaiters = new Map<string, () => void>();

function contextRailBootstrap(): void {
  window.__contextRailAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    const settle = (): boolean => {
      let ready = false;
      try { ready = check() === true; } catch { ready = false; }
      if (!ready) return false;
      void window.__contextRailSettle?.(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => {
      if (settle()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  };
}

async function act(predicate: string, trigger: () => void): Promise<void> {
  const token = `context-rail-${crypto.randomUUID()}`;
  const settled = new Promise<void>((resolve) => shellWaiters.set(token, resolve));
  await page.evaluate((nextToken, nextPredicate) => {
    window.__contextRailAwait?.(nextToken, nextPredicate);
  }, token, predicate);
  trigger();
  await settled;
  shellWaiters.delete(token);
}

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.exposeFunction("__contextRailSettle", (token: string) => shellWaiters.get(token)?.());
  await page.evaluateOnNewDocument(contextRailBootstrap);
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("desktop meeting context rail", () => {
  test("library shell reserves a quiet right rail without changing the live surface", async () => {
    const library = await page.evaluate(() => {
      const rail = document.getElementById("context-rail");
      const workspace = document.getElementById("workspace");
      const stage = document.getElementById("stage-pane");
      const rect = rail?.getBoundingClientRect();
      return {
        parentId: rail?.parentElement?.id,
        parentClass: rail?.parentElement?.className,
      documentParent: document.getElementById("document-surface")?.parentElement?.id,
        directChild: rail?.parentElement === workspace,
        painted: Boolean(rect && rect.width >= 280 && rect.width <= 360 && rect.height > 500),
        labelled: rail?.getAttribute("aria-label"),
        stageContainsRail: stage?.contains(rail) ?? false,
      };
    });

    expect(library).toEqual({
      parentId: "workspace",
      parentClass: "workspace",
      documentParent: "workspace",
      directChild: true,
      painted: true,
      labelled: "회의 컨텍스트",
      stageContainsRail: false,
    });

    await act(
      `document.querySelector(".app")?.dataset.shell === "live"`,
      () => harness.pushMessage({
      type: "capture",
      capturing: true,
      phase: "capturing",
      mode: "mic",
      startedAt: 1710376860000,
      }),
    );

    expect(await page.evaluate(() => {
      const rail = document.getElementById("context-rail");
      return {
        shell: document.querySelector<HTMLElement>(".app")?.dataset.shell,
        hidden: rail?.hidden,
        transcriptPainted: (document.getElementById("transcript-pane")?.getBoundingClientRect().width ?? 0) > 0,
      };
    })).toEqual({ shell: "live", hidden: true, transcriptPainted: true });

    await act(
      `document.querySelector(".app")?.dataset.shell === "library"`,
      () => harness.pushMessage({
      type: "capture",
      capturing: false,
      phase: "idle",
      mode: "mic",
      }),
    );
  });

  test("the draft canvas stays centered inside the middle workspace column", async () => {
    expect(await page.evaluate(() => {
      const stage = document.getElementById("stage-pane");
      const draft = document.getElementById("slide-frame");
      if (!stage || !draft) throw new Error("draft workspace is missing");

      const stageRect = stage.getBoundingClientRect();
      const draftRect = draft.getBoundingClientRect();
      const style = getComputedStyle(stage);
      const contentLeft = stageRect.left + Number.parseFloat(style.paddingLeft);
      const contentRight = stageRect.right - Number.parseFloat(style.paddingRight);

      return {
        centerDelta: Math.round(
          (draftRect.left + draftRect.width / 2)
          - (contentLeft + (contentRight - contentLeft) / 2),
        ),
        motion: style.animationDuration,
        sideSpaceDelta: Math.round(
          (draftRect.left - contentLeft)
          - (contentRight - draftRect.right),
        ),
      };
    })).toEqual({
      centerDelta: 0,
      motion: "0.2s",
      sideSpaceDelta: 0,
    });
  });

  test("recent meetings and readiness use server truth instead of demo data", async () => {
    await act(
      `document.getElementById("context-recent-list")?.textContent?.includes("제품 전략 점검") === true`,
      () => harness.pushMessage({
      type: "meetings",
      items: [
        { id: 22, title: "제품 전략 점검", started_at: "2026-08-12T09:00:00.000Z", status: "ended" },
        { id: 21, title: "파트너 미팅", started_at: "2026-08-11T05:30:00.000Z", status: "ended" },
        { id: 20, title: "주간 리뷰", started_at: "2026-08-10T01:00:00.000Z", status: "ended" },
        { id: 19, title: "보이면 안 되는 네 번째", started_at: "2026-08-09T01:00:00.000Z", status: "ended" },
      ],
      }),
    );

    await act(
      `document.getElementById("context-ai-status")?.textContent?.includes("GPT-5.6") === true`,
      () => harness.pushMessage({
      type: "providers",
      current: "cli:codex",
      currentModel: "gpt-5.6-sol",
      currentEffort: "medium",
      list: [{
        id: "cli:codex",
        label: "GPT",
        detail: "Codex CLI",
        available: true,
        installed: true,
        auth: "connected",
        models: ["gpt-5.6-sol"],
        efforts: ["medium"],
      }],
      }),
    );

    await act(
      `document.getElementById("context-stt-status")?.textContent === "Large v3 Turbo"`,
      () => harness.pushMessage({
      type: "sttModels",
      selectedModelId: "large-v3-turbo",
      models: [{
        id: "large-v3-turbo",
        label: "Large v3 Turbo",
        sizeBytes: 874_188_075,
        license: "MIT",
        status: "selected",
        path: "/models/ggml-large-v3-turbo-q8_0.bin",
      }],
      }),
    );

    expect(await page.evaluate(() => ({
      recent: [...document.querySelectorAll<HTMLElement>("#context-recent-list [data-meeting-id]")]
        .map((item) => ({ id: item.dataset.meetingId, title: item.querySelector(".context-recent__title")?.textContent })),
      ai: document.getElementById("context-ai-status")?.textContent,
      stt: document.getElementById("context-stt-status")?.textContent,
      connection: document.getElementById("context-server-status")?.textContent,
      fakeCalendar: document.body.textContent?.includes("다음 일정"),
    }))).toEqual({
      recent: [
        { id: "22", title: "제품 전략 점검" },
        { id: "21", title: "파트너 미팅" },
        { id: "20", title: "주간 리뷰" },
      ],
      ai: "GPT-5.6 Sol",
      stt: "Large v3 Turbo",
      connection: "연결됨",
      fakeCalendar: false,
    });
  });

  test("recent meeting buttons retain the existing selectMeeting protocol", async () => {
    const inbound = harness.nextClientMessage();
    await page.click('#context-recent-list [data-meeting-id="21"]');
    expect(await inbound).toEqual({ action: "selectMeeting", meetingId: 21 });
  });

  test("narrow desktop windows degrade to the existing two-region workspace", async () => {
    await page.setViewport({ width: 1180, height: 820 });
    expect(await page.evaluate(() => {
      const rail = document.getElementById("context-rail");
      return {
        display: rail ? getComputedStyle(rail).display : null,
        rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })).toEqual({ display: "none", rootOverflow: 0 });
  });
});
