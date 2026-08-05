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

async function pressHeightSeparatorKey(
  target: Page,
  selector: string,
  key: "ArrowUp" | "ArrowDown" | "Home" | "End",
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

describe("전사 패널 다중 모서리 리사이즈", () => {
  beforeEach(resetWorkspace);

  test("기본 상태에서는 카드가 패널 전체 높이를 쓴다", async () => {
    const geo = await geometry(page);
    expect(geo.cardH).toBeCloseTo(geo.paneH, 0);

    const grips = await page.evaluate(() => ({
      south: document.querySelector(".transcript-grip--s") !== null,
      southWest: document.querySelector(".transcript-grip--sw") !== null,
      // 서쪽 폭은 워크스페이스 스플리터가 담당한다
      west: document.querySelector("#splitter-transcript") !== null,
      // SE 전용 플로팅 손잡이는 존재하지 않는다
      southEast: document.querySelector(".transcript-grip--se") !== null,
    }));
    expect(grips).toEqual({ south: true, southWest: true, west: true, southEast: false });
  });

  test("높이 그립이 방향과 현재·최소·최대 높이를 노출한다", async () => {
    const aria = await page.evaluate(() =>
      ["transcript-grip-s", "transcript-grip-sw"].map((id) => {
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
      expect(value.orientation).toBe("horizontal");
      expect(value.min).toBe(160);
      expect(value.max).toBeGreaterThan(value.min);
      expect(value.now).toBe(value.max);
    }
  });

  test("키보드 Arrow/Home/End가 두 높이 그립과 ARIA 현재값을 동기화한다", async () => {
    const southAfterArrow = await pressHeightSeparatorKey(page, "#transcript-grip-s", "ArrowUp");
    expect(southAfterArrow).toBeCloseTo((await geometry(page)).cardH, 0);

    const atMin = await pressHeightSeparatorKey(page, "#transcript-grip-s", "Home");
    expect(atMin).toBe(160);
    const atMax = await pressHeightSeparatorKey(page, "#transcript-grip-s", "End");
    expect(atMax).toBeCloseTo((await geometry(page)).paneH, 0);

    const southWestAfterArrow = await pressHeightSeparatorKey(
      page,
      "#transcript-grip-sw",
      "ArrowUp",
    );
    expect(southWestAfterArrow).toBeLessThan(atMax);
    expect(southWestAfterArrow).toBeCloseTo((await geometry(page)).cardH, 0);
  });

  test("서(W) 드래그: 스플리터가 전사 폭을 넓힌다", async () => {
    const before = await geometry(page);
    await dragFrom(page, "#splitter-transcript", -160, 0);
    const after = await geometry(page);

    expect(after.paneW - before.paneW).toBeGreaterThan(20);
    expect(before.stageW - after.stageW).toBeGreaterThan(20);
    expect(after.stageW).toBeGreaterThan(320);
  });

  test("남(S) 드래그: 카드 높이만 줄고 폭은 그대로다", async () => {
    const before = await geometry(page);
    await dragFrom(page, "#transcript-grip-s", 0, -240);
    const after = await geometry(page);

    expect(before.cardH - after.cardH).toBeGreaterThan(200);
    expect(after.cardH).toBeGreaterThanOrEqual(160);
    expect(after.paneW).toBeCloseTo(before.paneW, 0);
    expect(
      await page.$eval("#transcript-grip-s", (node) => Number(node.getAttribute("aria-valuenow"))),
    ).toBeCloseTo(after.cardH, 0);
    // 무대는 높이 조절과 무관하다
    expect(after.stageW).toBeCloseTo(before.stageW, 0);
    expect(after.stageH).toBeCloseTo(before.stageH, 0);
  });

  test("남서(SW) 드래그: 높이와 폭이 함께 바뀐다", async () => {
    await dragFrom(page, "#transcript-grip-s", 0, -260);
    const before = await geometry(page);

    await dragFrom(page, "#transcript-grip-sw", -140, 120);
    const after = await geometry(page);

    expect(after.cardH - before.cardH).toBeGreaterThan(80);
    expect(after.paneW - before.paneW).toBeGreaterThan(100);
    expect(after.stageW).toBeGreaterThan(320);
  });

  test("높이 하한과 상한을 넘지 않는다", async () => {
    await dragFrom(page, "#transcript-grip-s", 0, -900);
    const collapsed = await geometry(page);
    expect(collapsed.cardH).toBeGreaterThanOrEqual(160);

    await dragFrom(page, "#transcript-grip-s", 0, 900);
    const expanded = await geometry(page);
    expect(expanded.cardH).toBeLessThanOrEqual(expanded.paneH + 1);
  });

  test("높이가 workspace.transcript.v1에 남고 새로고침 후 복원된다", async () => {
    await dragFrom(page, "#transcript-grip-s", 0, -220);
    const dragged = await geometry(page);
    const stored = await page.evaluate(
      (key: string) => JSON.parse(localStorage.getItem(key) ?? "null") as { heightPx: number } | null,
      TRANSCRIPT_KEY,
    );

    expect(stored).not.toBeNull();
    expect(stored!.heightPx).toBeCloseTo(dragged.cardH, 0);

    await page.reload({ waitUntil: "load" });
    await waitForStableLayout(page);
    const restored = await geometry(page);
    expect(restored.cardH).toBeCloseTo(dragged.cardH, 0);
  });

  test("저장값이 손상돼도 카드가 패널을 꽉 채운 기본으로 뜬다", async () => {
    await page.evaluate((key: string) => localStorage.setItem(key, "{not json"), TRANSCRIPT_KEY);
    await page.reload({ waitUntil: "load" });
    await waitForStableLayout(page);

    const geo = await geometry(page);
    expect(geo.cardH).toBeCloseTo(geo.paneH, 0);
  });

  test("상태가 어떻든 전사 본문은 카드 안쪽에 머무른다", async () => {
    await dragFrom(page, "#transcript-grip-s", 0, -280);
    await pushLines(["경계 확인 문장"]);

    const clipped = await page.evaluate(() => {
      const body = document.getElementById("transcript-body")!.getBoundingClientRect();
      return [...document.querySelectorAll(".transcript-pane .feed-line")].some((line) => {
        const rect = line.getBoundingClientRect();
        // 스크롤 영역 밖으로 완전히 나간 줄은 있을 수 있지만,
        // 스크롤 컸테이너 자체가 카드 밖을 범침하면 안 된다
        return rect.width > body.width + 1;
      });
    });
    expect(clipped).toBe(false);

    const fits = await page.evaluate(() => {
      const card = document.querySelector(".transcript-card")!.getBoundingClientRect();
      const body = document.getElementById("transcript-body")!.getBoundingClientRect();
      return body.bottom <= card.bottom + 1 && body.top >= card.top - 1;
    });
    expect(fits).toBe(true);
  });

  test("높이를 줄여도 전사 줄은 계속 쌓이고 스크롤로 읽힌다", async () => {
    await dragFrom(page, "#transcript-grip-s", 0, -300);
    await pushLines(Array.from({ length: 30 }, (_, i) => `스크롤 확인 문장 ${i}`));

    const scroll = await page.evaluate(() => {
      const body = document.getElementById("transcript-body")!;
      const lines = document.querySelectorAll(".transcript-pane .feed-line");
      const last = lines[lines.length - 1]!.getBoundingClientRect();
      const card = document.querySelector(".transcript-card")!.getBoundingClientRect();
      return {
        count: lines.length,
        scrollable: body.scrollHeight > body.clientHeight,
        // 최신 문장이 카드 안쪽에 보이도록 자동 스크롤된다
        latestVisible: last.bottom <= card.bottom + 1 && last.top >= card.top - 1,
      };
    });

    expect(scroll.count).toBe(30);
    expect(scroll.scrollable).toBe(true);
    expect(scroll.latestVisible).toBe(true);
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
