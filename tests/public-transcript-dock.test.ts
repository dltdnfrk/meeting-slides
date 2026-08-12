// 도킹된 전사 패널 검증 (todo 3).
// 실제 public/app.js + transcript-resize.js를 브라우저에서 돌리고 WS 메시지를 헤르메틱하게 밀어넣는다.
// 검증 축: (1) 라이브 전사가 .transcript-pane 안에 쌓인다 (2) W/S/SW 다중 모서리 리사이즈
// (3) 중앙 무대가 어떤 경우에도 가려지지 않는다.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const LAYOUT_KEY = "workspace.layout.v1";
const TRANSCRIPT_KEY = "workspace.transcript.v1";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
  // 실서버는 연결 직후 capture 상태를 전송한다. 전사/슬라이드를 렌더하려면 녹음 중(capturing) 상태가 필요하다.
  harness.pushMessage({ type: "capture", capturing: true, mode: "mic" });
  // capture 처리가 끝나기를 기다린다 (버튼이 녹음 중 상태로 전환되면 반영 완료).
  await page.waitForFunction(() =>
    (document.getElementById("btn-record") as HTMLButtonElement)?.textContent?.includes("녹음 중지"),
    { timeout: 5_000 },
  );
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

/**
 * 전사 스트림이 expected줄에 도달할 때까지 기다린다 (고정 sleep 없음).
 * push 이전에 MutationObserver를 무장하므로 이미 흘러간 변경과 혼동되지 않는다.
 */
async function armLineWait(target: Page, expected: number): Promise<void> {
  await target.evaluate((count: number) => {
    const stream = document.getElementById("transcript-stream")!;
    (globalThis as unknown as { __lines: Promise<void> }).__lines = new Promise<void>(
      (resolve, reject) => {
        if (stream.querySelectorAll(".feed-line").length >= count) return resolve();
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`transcript line timeout: expected ${count}`));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (stream.querySelectorAll(".feed-line").length < count) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        observer.observe(stream, { childList: true });
      },
    );
  }, expected);
}

async function awaitLines(target: Page): Promise<void> {
  await target.evaluate(() => (globalThis as unknown as { __lines: Promise<void> }).__lines);
}

/** WS line 메시지 n개를 밀어넣고 DOM에 반영될 때까지 기다린다. */
async function pushLines(texts: string[], startTs = 1_700_000_000_000): Promise<void> {
  const existing = await page.evaluate(
    () => document.querySelectorAll("#transcript-stream .feed-line").length,
  );
  await armLineWait(page, existing + texts.length);
  texts.forEach((text, i) => {
    harness.pushMessage({ type: "line", text, ts: startTs + i * 1_000, speaker: (i % 2) + 1 });
  });
  await awaitLines(page);
}

/** rAF 두 프레임 동안 패널 기하가 그대로면 레이아웃이 정착한 것으로 본다. */
async function waitForStableLayout(target: Page): Promise<void> {
  await target.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 2_000;
        const snapshot = () =>
          [".stage-pane", ".transcript-pane", ".transcript-card"]
            .map((sel) => {
              const rect = document.querySelector(sel)!.getBoundingClientRect();
              return `${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`;
            })
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

async function dragFrom(
  target: Page,
  selector: string,
  dx: number,
  dy: number,
): Promise<void> {
  const origin = await target.evaluate((sel) => {
    const rect = document.querySelector(sel)!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);

  await target.mouse.move(origin.x, origin.y);
  await target.mouse.down();
  // 중간 지점을 거쳐야 pointermove가 실제 드래그로 관측된다
  await target.mouse.move(origin.x + dx / 2, origin.y + dy / 2);
  await target.mouse.move(origin.x + dx, origin.y + dy);
  await target.mouse.up();
  await waitForStableLayout(target);
}

interface Geometry {
  paneW: number;
  paneH: number;
  cardH: number;
  stageW: number;
  stageH: number;
}

async function geometry(target: Page): Promise<Geometry> {
  return target.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const pane = rect(".transcript-pane");
    const card = rect(".transcript-card");
    const stage = rect(".stage-pane");
    return {
      paneW: pane.width,
      paneH: pane.height,
      cardH: card.height,
      stageW: stage.width,
      stageH: stage.height,
    };
  });
}

async function resetWorkspace(): Promise<void> {
  await page.evaluate(
    (keys: string[]) => keys.forEach((key) => localStorage.removeItem(key)),
    [LAYOUT_KEY, TRANSCRIPT_KEY],
  );
  await page.reload({ waitUntil: "load" });
  await reconnectCapture(page);
  await waitForStableLayout(page);
}

/** reload 후 WS가 다시 연결되면 capture 상태를 재전송하고 반영을 기다린다. */
async function reconnectCapture(target: Page): Promise<void> {
  await target.waitForFunction(
    () => document.documentElement.dataset.connection === "connected",
    { timeout: 5_000 },
  );
  harness.pushMessage({ type: "capture", capturing: true, mode: "mic" });
  await target.waitForFunction(
    () =>
      (document.getElementById("btn-record") as HTMLButtonElement)?.textContent?.includes("녹음 중지"),
    { timeout: 5_000 },
  );
}

describe("전사 도킹", () => {
  beforeEach(resetWorkspace);

  test("라이브 전사 줄이 우측 .transcript-pane 안에 쌓인다", async () => {
    await pushLines(["첫 문장입니다", "두 번째 문장입니다"]);

    const docked = await page.evaluate(() => {
      const pane = document.querySelector(".transcript-pane")!;
      const lines = [...pane.querySelectorAll(".feed-line")];
      return {
        count: lines.length,
        texts: lines.map((l) => l.querySelector(".feed-line__text")?.textContent ?? ""),
        // 도크(하단)에는 전사 복제본이 남아 있지 않아야 한다
        outsidePane: document.querySelectorAll(".feed-line").length - lines.length,
        badge: document.getElementById("transcript-count")!.textContent,
        emptyHidden: (document.getElementById("transcript-empty") as HTMLElement).hidden,
        speakerChips: pane.querySelectorAll(".speaker-chip").length,
      };
    });

    expect(docked.count).toBe(2);
    expect(docked.texts).toEqual(["첫 문장입니다", "두 번째 문장입니다"]);
    expect(docked.outsidePane).toBe(0);
    expect(docked.badge).toBe("2");
    expect(docked.emptyHidden).toBe(true);
    expect(docked.speakerChips).toBe(2);
  });

  test("transcript 스냅샷이 패널을 백로그로 다시 채운다", async () => {
    await pushLines(["지워질 문장"]);

    await armLineWait(page, 3);
    harness.pushMessage({
      type: "transcript",
      reason: "snapshot",
      truncated: true,
      entries: [
        { text: "백로그 1", ts: 1_700_000_100_000, speaker: 1 },
        { text: "백로그 2", ts: 1_700_000_101_000, speaker: 2 },
        { text: "백로그 3", ts: 1_700_000_102_000 },
      ],
    });
    await awaitLines(page);

    const state = await page.evaluate(() => {
      const pane = document.querySelector(".transcript-pane")!;
      return {
        texts: [...pane.querySelectorAll(".feed-line__text")].map((n) => n.textContent),
        badge: document.getElementById("transcript-count")!.textContent,
        truncVisible: !(document.getElementById("transcript-trunc") as HTMLElement).hidden,
        truncInsidePane: pane.contains(document.getElementById("transcript-trunc")),
      };
    });

    expect(state.texts).toEqual(["백로그 1", "백로그 2", "백로그 3"]);
    expect(state.badge).toBe("3");
    expect(state.truncVisible).toBe(true);
    expect(state.truncInsidePane).toBe(true);
  });

  test("전사가 쌓여도 중앙 무대는 가려지지 않고 넓이를 지킨다", async () => {
    const before = await geometry(page);
    await pushLines(Array.from({ length: 24 }, (_, i) => `무대를 가리지 않는 문장 ${i}`));
    const after = await geometry(page);

    // 도킹이므로 무대 기하는 그대로 — 떠 있는 오버레이라면 여기서 어긋난다
    expect(after.stageW).toBeCloseTo(before.stageW, 0);
    expect(after.stageH).toBeCloseTo(before.stageH, 0);
    expect(after.stageW).toBeGreaterThan(320);
    expect(after.stageH).toBeGreaterThan(0);

    const stageClear = await page.evaluate(() => {
      const stage = document.querySelector(".stage-pane")!.getBoundingClientRect();
      const pane = document.querySelector(".transcript-pane")!.getBoundingClientRect();
      const sample = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest(".stage-pane") !== null;
      return {
        // 전사 패널은 무대 오른쪽 바깥에 산다
        noOverlap: pane.left >= stage.right - 1,
        // 무대 중앙과 네 귀퉁이 안쪽 지점에서 히트 테스트가 무대를 잡는다
        centerHit: sample(stage.left + stage.width / 2, stage.top + stage.height / 2),
        topLeftHit: sample(stage.left + 8, stage.top + 8),
        bottomRightHit: sample(stage.right - 8, stage.bottom - 8),
        placeholderVisible: document.querySelector(".slide__placeholder") !== null,
      };
    });

    expect(stageClear).toEqual({
      noOverlap: true,
      centerHit: true,
      topLeftHit: true,
      bottomRightHit: true,
      placeholderVisible: true,
    });
  });
});

describe("Caret 라이브 전사 패널 기하", () => {
  beforeEach(resetWorkspace);

  test("전사 카드는 패널의 패딩을 제외한 가용 높이를 사용한다", async () => {
    const geo = await geometry(page);
    expect(geo.paneH - geo.cardH).toBeGreaterThanOrEqual(0);
    expect(geo.paneH - geo.cardH).toBeLessThanOrEqual(32);
  });

  test("폐기된 카드 높이 그립은 DOM 계약만 남고 라이브 기하에서는 비노출이다", async () => {
    const grips = await page.evaluate(() =>
      ["transcript-grip-s", "transcript-grip-sw"].map((id) => {
        const node = document.getElementById(id)!;
        return { id, display: getComputedStyle(node).display, orientation: node.getAttribute("aria-orientation") };
      }),
    );
    expect(grips).toEqual([
      { id: "transcript-grip-s", display: "none", orientation: "horizontal" },
      { id: "transcript-grip-sw", display: "none", orientation: "horizontal" },
    ]);
  });

  test("전사 폭은 현재 워크스페이스 스플리터가 계속 조절한다", async () => {
    const before = await geometry(page);
    await dragFrom(page, "#splitter-transcript", -160, 0);
    const after = await geometry(page);
    expect(after.paneW - before.paneW).toBeGreaterThan(20);
    expect(before.stageW - after.stageW).toBeGreaterThan(20);
    expect(after.stageW).toBeGreaterThan(320);
  });

  test("레거시 높이 저장값은 전체 라이브 전사 기하를 축소하지 않는다", async () => {
    await page.evaluate((key: string) => localStorage.setItem(key, JSON.stringify({ heightPx: 180 })), TRANSCRIPT_KEY);
    await page.reload({ waitUntil: "load" });
    await waitForStableLayout(page);
    const geo = await geometry(page);
    expect(geo.paneH - geo.cardH).toBeGreaterThanOrEqual(0);
    expect(geo.paneH - geo.cardH).toBeLessThanOrEqual(32);
  });

  test("확정 전사는 카드 내부의 단일 스크롤 영역에 계속 쌓인다", async () => {
    await pushLines(Array.from({ length: 30 }, (_, i) => `스크롤 확인 문장 ${i}`));
    const state = await page.evaluate(() => {
      const body = document.getElementById("transcript-body")!;
      const card = document.getElementById("transcript-card")!.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      return {
        count: document.querySelectorAll(".transcript-pane .feed-line").length,
        scrollable: body.scrollHeight > body.clientHeight,
        contained: bodyRect.top >= card.top - 1 && bodyRect.bottom <= card.bottom + 1,
      };
    });
    expect(state).toEqual({ count: 30, scrollable: true, contained: true });
  });
});

describe("좁은 화면", () => {
  beforeEach(async () => {
    await page.setViewport({ width: 820, height: 900 });
    await resetWorkspace();
  });

  afterAll(async () => {
    await page.setViewport({ width: 1440, height: 900 });
  });

  test("좌우 분할이 무리면 전사는 숨지 않고 무대 아래로 쌓인다", async () => {
    await pushLines(["좁은 화면에서도 보여야 합니다"]);

    const stacked = await page.evaluate(() => {
      const stage = document.querySelector(".stage-pane")!.getBoundingClientRect();
      const pane = document.querySelector(".transcript-pane")!.getBoundingClientRect();
      const workspace = document.querySelector(".workspace")!.getBoundingClientRect();
      return {
        transcriptVisible: pane.width > 0 && pane.height > 0,
        stageVisible: stage.width > 0 && stage.height > 0,
        transcriptBelowStage: pane.top >= stage.bottom - 1,
        sameWidth: Math.abs(pane.width - stage.width) <= 1,
        // 두 패널이 워크스페이스 밖으로 넘치지 않는다
        withinWorkspace: pane.bottom <= workspace.bottom + 1,
        lines: document.querySelectorAll(".transcript-pane .feed-line").length,
      };
    });

    expect(stacked).toEqual({
      transcriptVisible: true,
      stageVisible: true,
      transcriptBelowStage: true,
      sameWidth: true,
      withinWorkspace: true,
      lines: 1,
    });
  });
});
