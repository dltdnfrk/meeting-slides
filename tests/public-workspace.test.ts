// Tiro 스타일 3분할 워크스페이스 셸 검증 (todo 1 레이아웃 + todo 2 스플리터).
// 전사 도킹/리사이즈는 public-transcript-dock.test.ts, 세션 목록(todo 4)은 범위 밖.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("워크스페이스 셸 구조", () => {
  test("워크스페이스가 좌/중앙/우 세 패널을 담는다", async () => {
    const panes = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace");
      if (!workspace) return null;
      const owns = (selector: string) =>
        workspace.querySelector(selector)?.parentElement === workspace;
      return {
        rail: owns(".session-rail"),
        stage: owns(".stage-pane"),
        transcript: owns(".transcript-pane"),
        // 스플리터를 거르면 좌 → 중앙 → 우 패널 순서가 그대로 남아야 한다
        order: [...workspace.children]
          .map((child) => child.className.split(" ")[0])
          .filter((name) => name !== "splitter"),
      };
    });

    expect(panes).not.toBeNull();
    expect(panes!.rail).toBe(true);
    expect(panes!.stage).toBe(true);
    expect(panes!.transcript).toBe(true);
    expect(panes!.order).toEqual(["session-rail", "stage", "transcript-pane"]);
  });

  test("중앙 패널이 기존 시각 자료 무대를 그대로 품는다", async () => {
    const stage = await page.evaluate(() => {
      const pane = document.querySelector(".stage-pane");
      if (!pane) return null;
      const slideRoot = document.getElementById("current-slide");
      return {
        // 슬라이드 렌더 루트(#current-slide)가 중앙 패널 안에 살아 있어야 app.js가 그대로 동작한다
        slideRootInside: slideRoot !== null && pane.contains(slideRoot),
        frameInside: pane.querySelector("#slide-frame") !== null,
        islandInside: pane.querySelector("#island") !== null,
        placeholder: pane.querySelector(".slide__placeholder") !== null,
        // 대시보드가 아니라 실제 무대여야 한다
        dashboardCopy: (pane.textContent ?? "").includes("오늘 미팅을 한눈에"),
      };
    });

    expect(stage).not.toBeNull();
    expect(stage!.slideRootInside).toBe(true);
    expect(stage!.frameInside).toBe(true);
    expect(stage!.islandInside).toBe(true);
    expect(stage!.placeholder).toBe(true);
    expect(stage!.dashboardCopy).toBe(false);
  });

  test("세 패널이 가로로 나란히 놓이고 하단 도크가 보존된다", async () => {
    const layout = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      };
      const rail = box(".session-rail")!;
      const stage = box(".stage-pane")!;
      const transcript = box(".transcript-pane")!;
      const dock = box(".dock")!;
      const workspace = box(".workspace")!;
      return {
        railLeftOfStage: rail.right <= stage.left + 1,
        stageLeftOfTranscript: stage.right <= transcript.left + 1,
        sameRow: Math.abs(rail.top - stage.top) <= 1 && Math.abs(stage.top - transcript.top) <= 1,
        // 히어로가 가장 넓은 슬롯이어야 Tiro 배치가 성립한다
        stageWidest: stage.width > rail.width && stage.width > transcript.width,
        railVisible: rail.width > 0,
        transcriptVisible: transcript.width > 0,
        dockBelowWorkspace: dock.top >= workspace.bottom - 1,
        dockHasCompileButton: document.querySelector(".dock #btn-compile-deck") !== null,
      };
    });

    expect(layout).toEqual({
      railLeftOfStage: true,
      stageLeftOfTranscript: true,
      sameRow: true,
      stageWidest: true,
      railVisible: true,
      transcriptVisible: true,
      dockBelowWorkspace: true,
      dockHasCompileButton: true,
    });
  });

  test("워크스페이스가 가로 오버플로 없이 뷰포트에 맞는다", async () => {
    const overflow = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace")!;
      return {
        horizontal: workspace.scrollWidth - workspace.clientWidth,
        beyondViewport: workspace.getBoundingClientRect().right - window.innerWidth,
      };
    });
    expect(overflow.horizontal).toBeLessThanOrEqual(0);
    expect(overflow.beyondViewport).toBeLessThanOrEqual(1);
  });
});

// ── todo 2: 스플리터 드래그 + 저장 ──────────────────────────

const STORAGE_KEY = "workspace.layout.v1";

interface PaneWidths {
  left: number;
  right: number;
  stage: number;
}

async function paneWidths(target: Page): Promise<PaneWidths> {
  return target.evaluate(() => {
    const width = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().width;
    return {
      left: width(".session-rail"),
      right: width(".transcript-pane"),
      stage: width(".stage-pane"),
    };
  });
}

/** 스플리터 중심을 dx만큼 끌고 놓는다. 놓은 뒤 레이아웃이 멎을 때까지 기다린다. */
async function dragSplitter(target: Page, selector: string, dx: number): Promise<void> {
  const box = await target.evaluate((sel) => {
    const rect = document.querySelector(sel)!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);

  await target.mouse.move(box.x, box.y);
  await target.mouse.down();
  // 중간 지점을 거쳐야 pointermove가 실제 드래그로 관측된다
  await target.mouse.move(box.x + dx / 2, box.y);
  await target.mouse.move(box.x + dx, box.y);
  await target.mouse.up();
  await waitForStableLayout(target);
}

/** rAF 두 프레임 동안 세 패널 폭이 그대로면 레이아웃이 정착한 것으로 본다. */
async function waitForStableLayout(target: Page): Promise<void> {
  await target.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 2_000;
        const snapshot = () =>
          [".session-rail", ".stage-pane", ".transcript-pane"]
            .map((sel) => document.querySelector(sel)!.getBoundingClientRect().width.toFixed(2))
            .join("|");
        let previous = snapshot();
        let stableFrames = 0;
        const tick = () => {
          const current = snapshot();
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 2) return resolve();
          if (performance.now() > deadline) return reject(new Error("layout never settled"));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function readStoredLayout(target: Page): Promise<{ leftPx: number; rightPx: number } | null> {
  return target.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { leftPx: number; rightPx: number }) : null;
  }, STORAGE_KEY);
}

async function pressSeparatorKey(
  target: Page,
  selector: string,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): Promise<number> {
  await target.focus(selector);
  await target.evaluate((sel) => {
    const separator = document.querySelector(sel)!;
    (globalThis as unknown as { __separatorValue: Promise<number> }).__separatorValue =
      new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`separator value did not change: ${sel}`));
        }, 2_000);
        const observer = new MutationObserver(() => {
          const value = Number(separator.getAttribute("aria-valuenow"));
          clearTimeout(timer);
          observer.disconnect();
          resolve(value);
        });
        observer.observe(separator, { attributes: true, attributeFilter: ["aria-valuenow"] });
      });
  }, selector);
  await target.keyboard.press(key);
  return target.evaluate(
    () => (globalThis as unknown as { __separatorValue: Promise<number> }).__separatorValue,
  );
}

describe("워크스페이스 스플리터", () => {
  beforeEach(async () => {
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
    await page.reload({ waitUntil: "load" });
    await waitForStableLayout(page);
  });

  test("두 스플리터가 패널 사이 DOM 순서에 놓인다", async () => {
    const order = await page.evaluate(() =>
      [...document.querySelector(".workspace")!.children].map((child) => child.id || child.className),
    );
    expect(order).toEqual([
      "session-rail",
      "splitter-rail",
      "stage-pane",
      "splitter-transcript",
      "transcript-pane",
    ]);
  });

  test("포커스 가능한 스플리터가 방향과 현재·최소·최대 폭을 노출한다", async () => {
    const aria = await page.evaluate(() =>
      ["splitter-rail", "splitter-transcript"].map((id) => {
        const separator = document.getElementById(id)!;
        return {
          orientation: separator.getAttribute("aria-orientation"),
          min: Number(separator.getAttribute("aria-valuemin")),
          max: Number(separator.getAttribute("aria-valuemax")),
          now: Number(separator.getAttribute("aria-valuenow")),
        };
      }),
    );

    for (const value of aria) {
      expect(value.orientation).toBe("vertical");
      expect(value.min).toBeGreaterThan(0);
      expect(value.max).toBeGreaterThan(value.min);
      expect(value.now).toBeGreaterThanOrEqual(value.min);
      expect(value.now).toBeLessThanOrEqual(value.max);
    }
  });

  test("키보드 Arrow/Home/End가 양쪽 스플리터 폭과 ARIA 현재값을 동기화한다", async () => {
    const before = await paneWidths(page);
    const railAfterArrow = await pressSeparatorKey(page, "#splitter-rail", "ArrowRight");
    const afterRailArrow = await paneWidths(page);
    expect(afterRailArrow.left).toBeGreaterThan(before.left);
    expect(railAfterArrow).toBeCloseTo(afterRailArrow.left, 0);

    const railAtMin = await pressSeparatorKey(page, "#splitter-rail", "Home");
    expect(railAtMin).toBe(180);
    const railAtMax = await pressSeparatorKey(page, "#splitter-rail", "End");
    const railMax = await page.$eval("#splitter-rail", (node) =>
      Number(node.getAttribute("aria-valuemax")),
    );
    expect(railAtMax).toBe(railMax);

    const transcriptBefore = (await paneWidths(page)).right;
    const transcriptAfterArrow = await pressSeparatorKey(
      page,
      "#splitter-transcript",
      "ArrowLeft",
    );
    const afterTranscriptArrow = await paneWidths(page);
    expect(afterTranscriptArrow.right).toBeGreaterThan(transcriptBefore);
    expect(transcriptAfterArrow).toBeCloseTo(afterTranscriptArrow.right, 0);
  });

  test("좌 스플리터를 끌면 레일이 넓어지고 무대가 그만큼 줄어든다", async () => {
    const before = await paneWidths(page);
    await dragSplitter(page, "#splitter-rail", 120);
    const after = await paneWidths(page);

    expect(after.left - before.left).toBeGreaterThan(100);
    expect(before.stage - after.stage).toBeGreaterThan(100);
    expect(after.right).toBeCloseTo(before.right, 0);
    expect(
      await page.$eval("#splitter-rail", (node) => Number(node.getAttribute("aria-valuenow"))),
    ).toBeCloseTo(after.left, 0);
  });

  test("우 스플리터를 왼쪽으로 끌면 전사 패널이 넓어진다", async () => {
    const before = await paneWidths(page);
    await dragSplitter(page, "#splitter-transcript", -140);
    const after = await paneWidths(page);

    expect(after.right - before.right).toBeGreaterThan(120);
    expect(before.stage - after.stage).toBeGreaterThan(120);
    expect(after.left).toBeCloseTo(before.left, 0);
  });

  test("최소 폭 밑으로는 접히지 않는다", async () => {
    await dragSplitter(page, "#splitter-rail", -600);
    await dragSplitter(page, "#splitter-transcript", 600);
    const collapsed = await paneWidths(page);
    expect(collapsed.left).toBeGreaterThanOrEqual(180);
    expect(collapsed.right).toBeGreaterThanOrEqual(240);

    // 반대로 최대한 벌려도 중앙 무대는 320px를 지킨다
    await dragSplitter(page, "#splitter-rail", 900);
    await dragSplitter(page, "#splitter-transcript", -900);
    const expanded = await paneWidths(page);
    expect(expanded.stage).toBeGreaterThanOrEqual(320);
    expect(expanded.left + expanded.right + expanded.stage).toBeLessThanOrEqual(
      await page.evaluate(() => document.querySelector(".workspace")!.clientWidth),
    );
  });

  test("드래그 결과가 workspace.layout.v1에 JSON으로 남는다", async () => {
    await dragSplitter(page, "#splitter-rail", 90);
    const widths = await paneWidths(page);
    const stored = await readStoredLayout(page);

    expect(stored).not.toBeNull();
    expect(stored!.leftPx).toBeCloseTo(widths.left, 0);
    expect(stored!.rightPx).toBeCloseTo(widths.right, 0);
  });

  test("새로고침 후 저장된 폭이 복원된다", async () => {
    await dragSplitter(page, "#splitter-rail", 110);
    await dragSplitter(page, "#splitter-transcript", -80);
    const dragged = await paneWidths(page);

    await page.reload({ waitUntil: "load" });
    await waitForStableLayout(page);
    const restored = await paneWidths(page);

    expect(restored.left).toBeCloseTo(dragged.left, 0);
    expect(restored.right).toBeCloseTo(dragged.right, 0);
  });

  test("저장값이 손상돼도 기본 레이아웃으로 뜬다", async () => {
    await page.evaluate((key) => localStorage.setItem(key, "{not json"), STORAGE_KEY);
    await page.reload({ waitUntil: "load" });
    await waitForStableLayout(page);

    const widths = await paneWidths(page);
    expect(widths.left).toBeGreaterThanOrEqual(180);
    expect(widths.right).toBeGreaterThanOrEqual(240);
    expect(widths.stage).toBeGreaterThan(widths.left);
  });
});


describe("중앙 무대 잠금과 반응형", () => {
  test("MeetingCard가 .stage-pane 안에만 렌더되고 무대 중앙 hit가 stage다", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.removeItem("workspace.layout.v1"));
    await page.reload({ waitUntil: "load" });
    await harness.clientConnected;
    await waitForStableLayout(page);

    // 렌더 대기 무장 후 슬라이드 push
    await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      (globalThis as unknown as { __card: Promise<void> }).__card = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("MeetingCard render timeout"));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (root.querySelector(".slide__title")?.textContent === "중앙 무대 카드") {
            clearTimeout(timer);
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(root, { childList: true, subtree: true });
      });
    });
    harness.pushMessage({
      type: "slide",
      current: {
        index: 1,
        title: "중앙 무대 카드",
        bullets: ["무대 잠금"],
        startedAt: 1_700_000_000_000,
        sentenceCount: 1,
      },
      history: [],
    });
    await page.evaluate(() => (globalThis as unknown as { __card: Promise<void> }).__card);

    const lock = await page.evaluate(() => {
      const stage = document.querySelector(".stage-pane") as HTMLElement;
      const root = document.getElementById("current-slide")!;
      const title = root.querySelector(".slide__title");
      const box = stage.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        titleInStage: stage.contains(title),
        titleText: title?.textContent ?? null,
        hitInStage: hit?.closest(".stage-pane") !== null,
        compileVisible: document.querySelector(".dock #btn-compile-deck") !== null,
        exportVisible: document.querySelector(".dock #btn-export-deck") !== null,
      };
    });

    expect(lock).toEqual({
      titleInStage: true,
      titleText: "중앙 무대 카드",
      hitInStage: true,
      compileVisible: true,
      exportVisible: true,
    });
  });

  test("820px에서 레일은 접히고 무대/전사는 살아 있으며 문서 가로 스크롤이 없다", async () => {
    await page.setViewport({ width: 820, height: 900 });
    await page.evaluate(() => localStorage.removeItem("workspace.layout.v1"));
    await page.reload({ waitUntil: "load" });
    await harness.clientConnected;
    await waitForStableLayout(page);

    const narrow = await page.evaluate(() => {
      const rail = document.querySelector(".session-rail") as HTMLElement;
      const stage = document.querySelector(".stage-pane") as HTMLElement;
      const transcript = document.querySelector(".transcript-pane") as HTMLElement;
      const railStyle = getComputedStyle(rail);
      const sr = stage.getBoundingClientRect();
      const tr = transcript.getBoundingClientRect();
      return {
        railDisplay: railStyle.display,
        stageVisible: sr.width > 0 && sr.height > 0,
        transcriptVisible: tr.width > 0 && tr.height > 0,
        transcriptBelowOrBeside: tr.top >= sr.bottom - 1 || tr.left >= sr.right - 1,
        docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyScrollX: document.body.scrollWidth - document.body.clientWidth,
        compileVisible: document.querySelector(".dock #btn-compile-deck") !== null,
      };
    });

    expect(narrow.railDisplay).toBe("none");
    expect(narrow.stageVisible).toBe(true);
    expect(narrow.transcriptVisible).toBe(true);
    expect(narrow.transcriptBelowOrBeside).toBe(true);
    expect(narrow.docScrollX).toBeLessThanOrEqual(1);
    expect(narrow.bodyScrollX).toBeLessThanOrEqual(1);
    expect(narrow.compileVisible).toBe(true);
  });

  test("375px에서 도크 줄바꿈으로 문서 가로 스크롤이 생기지 않는다", async () => {
    await page.setViewport({ width: 375, height: 720 });
    await page.evaluate(() => localStorage.removeItem("workspace.layout.v1"));
    await page.reload({ waitUntil: "load" });
    await harness.clientConnected;
    await waitForStableLayout(page);

    const tiny = await page.evaluate(() => {
      const tabs = document.querySelector(".dock__tabs") as HTMLElement;
      const style = getComputedStyle(tabs);
      return {
        flexWrap: style.flexWrap,
        docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyScrollX: document.body.scrollWidth - document.body.clientWidth,
        compileVisible: document.querySelector(".dock #btn-compile-deck") !== null,
        stageVisible: (document.querySelector(".stage-pane") as HTMLElement).getBoundingClientRect().width > 0,
      };
    });

    expect(tiny.flexWrap).toBe("wrap");
    expect(tiny.docScrollX).toBeLessThanOrEqual(1);
    expect(tiny.bodyScrollX).toBeLessThanOrEqual(1);
    expect(tiny.compileVisible).toBe(true);
    expect(tiny.stageVisible).toBe(true);

    // 후속 테스트 오염 방지
    await page.setViewport({ width: 1440, height: 900 });
  });
});


describe("헤르메틱 워크스페이스 E2E", () => {
  test("세 패널·스플리터·전사 줄·MeetingCard·레이아웃 복원을 한 흐름으로 통과한다", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
    await page.reload({ waitUntil: "load" });
    await harness.clientConnected;
    await waitForStableLayout(page);

    // 1) three panes
    const panes = await page.evaluate(() => ({
      rail: !!document.querySelector(".session-rail"),
      stage: !!document.querySelector(".stage-pane"),
      transcript: !!document.querySelector(".transcript-pane"),
    }));
    expect(panes).toEqual({ rail: true, stage: true, transcript: true });

    // 2) splitter drag changes widths
    const before = await paneWidths(page);
    await dragSplitter(page, "#splitter-rail", 100);
    const afterDrag = await paneWidths(page);
    expect(afterDrag.left - before.left).toBeGreaterThan(50);

    // 3) transcript line in dock
    await page.evaluate(() => {
      const body = document.getElementById("transcript-body")!;
      (globalThis as unknown as { __line: Promise<void> }).__line = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("line timeout")); }, 5_000);
        const observer = new MutationObserver(() => {
          if ([...body.querySelectorAll(".feed-line")].some((el) => el.textContent?.includes("E2E 전사 줄"))) {
            clearTimeout(timer); observer.disconnect(); resolve();
          }
        });
        observer.observe(body, { childList: true, subtree: true });
      });
    });
    harness.pushMessage({ type: "line", text: "E2E 전사 줄", ts: Date.now(), speaker: 1 });
    await page.evaluate(() => (globalThis as unknown as { __line: Promise<void> }).__line);
    const lineInPane = await page.evaluate(() => {
      const pane = document.querySelector(".transcript-pane")!;
      const line = [...pane.querySelectorAll(".feed-line")].find((el) => el.textContent?.includes("E2E 전사 줄"));
      return !!line && pane.contains(line);
    });
    expect(lineInPane).toBe(true);

    // 4) MeetingCard in center after line
    await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      (globalThis as unknown as { __card: Promise<void> }).__card = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("card timeout")); }, 5_000);
        const observer = new MutationObserver(() => {
          if (root.querySelector(".slide__title")?.textContent === "E2E 중앙 카드") {
            clearTimeout(timer); observer.disconnect(); resolve();
          }
        });
        observer.observe(root, { childList: true, subtree: true });
      });
    });
    harness.pushMessage({
      type: "slide",
      current: {
        index: 7,
        title: "E2E 중앙 카드",
        bullets: ["한 흐름"],
        startedAt: Date.now(),
        sentenceCount: 1,
      },
      history: [],
    });
    await page.evaluate(() => (globalThis as unknown as { __card: Promise<void> }).__card);
    const card = await page.evaluate(() => {
      const stage = document.querySelector(".stage-pane")!;
      const title = document.querySelector(".slide__title");
      return {
        inStage: stage.contains(title),
        text: title?.textContent ?? null,
      };
    });
    expect(card).toEqual({ inStage: true, text: "E2E 중앙 카드" });

    // 5) layout persist roundtrip
    const dragged = await paneWidths(page);
    await page.reload({ waitUntil: "load" });
    await harness.clientConnected;
    await waitForStableLayout(page);
    const restored = await paneWidths(page);
    expect(restored.left).toBeCloseTo(dragged.left, 0);
    expect(restored.right).toBeCloseTo(dragged.right, 0);

    // edge: empty transcript state still ok
    const emptyOk = await page.evaluate(() => {
      const empty = document.getElementById("transcript-empty");
      return empty !== null;
    });
    expect(emptyOk).toBe(true);
  });
});

