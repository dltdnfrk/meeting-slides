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
  // 실서버는 연결 직후 capture 상태를 전송한다. 슬라이드를 렌더하려면 녹음 중(capturing) 상태가 필요하다.
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

describe("워크스페이스 셸 구조", () => {
  // MIGRATED (Todo 11). Was: "워크스페이스가 좌/중앙/우 세 패널을 담는다" — asserted that
  // #workspace directly owns three side-by-side panes. That is the superseded
  // three-pane library layout: DESIGN.md §9.7 and Todo 11 require a meetings rail
  // plus exactly ONE document surface, with the transcript as a tab rather than a
  // permanent column. The structural intent (rail and stage are real, ordered,
  // workspace-owned regions; the transcript is still reachable and still owns its
  // binding IDs) is preserved below against the single-document shell.
  test("워크스페이스가 레일과 단일 문서 표면을 담고 전사는 탭으로 도달된다", async () => {
    const panes = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace");
      if (!workspace) return null;
      const owns = (selector: string) =>
        workspace.querySelector(selector)?.parentElement === workspace;
      const surface = document.getElementById("document-surface");
      return {
        rail: owns(".session-rail"),
        documentSurface: owns("#document-surface"),
        // The stage and the transcript are the document surface's own panels.
        stageInSurface: surface?.contains(document.getElementById("stage-pane")) ?? false,
        transcriptInSurface: surface?.contains(document.getElementById("transcript-pane")) ?? false,
        // Meeting rail, one document surface, then the library-only context rail.
        order: [...workspace.children]
          .map((child) => child.id || child.className.split(" ")[0])
          .filter((name) => !name.startsWith("splitter")),
        // The transcript is a real tabpanel controlled by a real tab.
        transcriptIsPanel:
          document.getElementById("transcript-pane")?.getAttribute("role") === "tabpanel",
        transcriptTabControls:
          document.getElementById("detail-tab-transcript")?.getAttribute("aria-controls"),
      };
    });

    expect(panes).not.toBeNull();
    expect(panes!.rail).toBe(true);
    expect(panes!.documentSurface).toBe(true);
    expect(panes!.stageInSurface).toBe(true);
    expect(panes!.transcriptInSurface).toBe(true);
    expect(panes!.order).toEqual(["session-rail", "document-surface", "context-rail"]);
    expect(panes!.transcriptIsPanel).toBe(true);
    expect(panes!.transcriptTabControls).toBe("transcript-pane");
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

  // MIGRATED (Todo 11). Was: "세 패널이 가로로 나란히 놓이고 하단 도크가 보존된다" — required
  // stage.right <= transcript.left, i.e. a permanent transcript COLUMN beside the
  // stage. Todo 11 replaces that with one document surface. Everything that is
  // not transcript-column geometry (rail left of the document, same row, document
  // is the widest slot, dock preserved below the workspace) is asserted verbatim.
  test("레일과 문서 표면이 가로로 나란히 놓이고 하단 도크가 보존된다", async () => {
    await enterLibraryMode(page);
    const layout = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      };
      const rail = box(".session-rail")!;
      const surface = box("#document-surface")!;
      const dock = box(".dock")!;
      const workspace = box(".workspace")!;
      return {
        railLeftOfDocument: rail.right <= surface.left + 1,
        sameRow: Math.abs(rail.top - surface.top) <= 1,
        // The document is the dominant slot; the rail is navigation beside it.
        documentWidest: surface.width > rail.width,
        railVisible: rail.width > 0,
        documentUsable: surface.width >= 280,
        dockBelowWorkspace: dock.top >= workspace.bottom - 1,
        dockHasCompileButton: document.querySelector(".dock #btn-compile-deck") !== null,
      };
    });

    expect(layout).toEqual({
      railLeftOfDocument: true,
      sameRow: true,
      documentWidest: true,
      railVisible: true,
      documentUsable: true,
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

/**
 * Drives the shell into LIVE mode with a real authoritative capture frame.
 * Todo 11 made the shell server-authoritative, so state is never faked by
 * toggling `.app--capturing`; the transcript column only exists in live shell,
 * which is where the transcript splitter is a real, resizable separator.
 */
async function enterLiveMode(target: Page): Promise<void> {
  await target.evaluate(() => {
    const app = document.querySelector(".app")!;
    (globalThis as unknown as { __liveMode: Promise<void> }).__liveMode = new Promise<void>(
      (resolve, reject) => {
        const done = () => app.classList.contains("app--capturing");
        if (done()) { resolve(); return; }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("live mode did not start"));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (!done()) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        observer.observe(app, { attributes: true, attributeFilter: ["class"] });
      },
    );
  });
  harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing" });
  await target.evaluate(() => (globalThis as unknown as { __liveMode: Promise<void> }).__liveMode);
  await waitForStableLayout(target);
}

async function paneWidths(target: Page): Promise<PaneWidths> {
  return target.evaluate(() => {
    const width = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().width;
    return {
      left: width(".session-rail"),
      right: width(".transcript-pane"),
      // #stage-pane is the slot that yields in BOTH shells: to the rail in
      // library, to the transcript column in live. Reading the wrapper instead
      // would be constant in live, where the wrapper spans the whole workspace.
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

/** 3-pane library layout assertions need capture off (live mode hides the meetings rail). */
async function enterLibraryMode(target: Page): Promise<void> {
  const capturing = await target.evaluate(() =>
    document.querySelector(".app")?.classList.contains("app--capturing") ?? false,
  );
  if (!capturing) return;
  await target.evaluate(() => {
    const app = document.querySelector(".app");
    (globalThis as unknown as { __libraryMode: Promise<void> }).__libraryMode = new Promise<void>(
      (resolve, reject) => {
        let observer: MutationObserver;
        const timer = setTimeout(() => {
          observer?.disconnect();
          reject(new Error("library mode did not restore"));
        }, 5_000);
        observer = new MutationObserver(() => {
          if (app?.classList.contains("app--capturing")) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        if (!app?.classList.contains("app--capturing")) {
          clearTimeout(timer);
          resolve();
          return;
        }
        observer.observe(app, { attributes: true, attributeFilter: ["class"] });
      },
    );
  });
  harness.pushMessage({ type: "capture", capturing: false, mode: "mic" });
  await target.evaluate(
    () => (globalThis as unknown as { __libraryMode: Promise<void> }).__libraryMode,
  );
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
    await reconnectCapture(page);
    await enterLibraryMode(page);
    await waitForStableLayout(page);
  });

  // MIGRATED (Todo 11). Was: the five #workspace children of the three-pane
  // layout. In the single-document shell #splitter-transcript moved inside
  // #document-surface with the two panes it separates in LIVE shell. Both
  // splitters keep their binding IDs, their separator role and their position
  // between the panes they resize — asserted here against the real structure.
  test("스플리터가 자신이 나누는 패널 사이 DOM 순서에 놓인다", async () => {
    const structure = await page.evaluate(() => {
      const workspace = document.querySelector(".workspace")!;
      const surface = document.getElementById("document-surface")!;
      const ids = (root: Element) => [...root.children].map((child) => child.id || child.className);
      return {
        workspaceOrder: ids(workspace),
        // Inside the document surface the transcript splitter still sits between
        // the stage and the transcript, which is what it resizes in live shell.
        surfaceOrder: ids(surface).filter((name) =>
          ["stage-pane", "splitter-transcript", "transcript-pane"].includes(name)),
        railRole: document.getElementById("splitter-rail")?.getAttribute("role"),
        transcriptRole: document.getElementById("splitter-transcript")?.getAttribute("role"),
      };
    });

    expect(structure.workspaceOrder).toEqual([
      "session-rail",
      "splitter-rail",
      "document-surface",
      "context-rail",
    ]);
    expect(structure.surfaceOrder).toEqual(["stage-pane", "splitter-transcript", "transcript-pane"]);
    expect(structure.railRole).toBe("separator");
    expect(structure.transcriptRole).toBe("separator");
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

  // MIGRATED (Todo 11). Rail half unchanged. The transcript half moved to live
  // shell, the only shell where the transcript column exists; in library shell
  // #splitter-transcript has no adjacent pane and DESIGN §9.9 makes it inert.
  test("키보드 Arrow/Home/End가 레일 스플리터 폭과 ARIA 현재값을 동기화한다", async () => {
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
  });

  test("라이브 셸에서 키보드가 전사 스플리터 폭과 ARIA 현재값을 동기화한다", async () => {
    await enterLiveMode(page);
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

  // MIGRATED (Todo 11): identical assertions, exercised in live shell where this
  // splitter actually separates the stage from the transcript column.
  test("라이브 셸에서 우 스플리터를 왼쪽으로 끌면 전사 패널이 넓어진다", async () => {
    await enterLiveMode(page);
    const before = await paneWidths(page);
    await dragSplitter(page, "#splitter-transcript", -140);
    const after = await paneWidths(page);

    expect(after.right - before.right).toBeGreaterThan(120);
    expect(before.stage - after.stage).toBeGreaterThan(120);
    expect(after.left).toBeCloseTo(before.left, 0);
  });

  // MIGRATED (Todo 11). Split in two so BOTH minimums keep real coverage: the
  // transcript minimum belongs to live shell, the rail minimum to library shell.
  test("라이브 셸에서 전사는 최소 폭 밑으로 접히지 않는다", async () => {
    await enterLiveMode(page);
    await dragSplitter(page, "#splitter-transcript", 600);
    const collapsed = await paneWidths(page);
    expect(collapsed.right).toBeGreaterThanOrEqual(240);

    await dragSplitter(page, "#splitter-transcript", -900);
    const expanded = await paneWidths(page);
    expect(expanded.stage).toBeGreaterThanOrEqual(320);
    expect(expanded.right + expanded.stage).toBeLessThanOrEqual(
      await page.evaluate(() => document.querySelector(".workspace")!.clientWidth),
    );
  });

  test("라이브러리에서 레일은 최소 폭 밑으로 접히지 않는다", async () => {
    await dragSplitter(page, "#splitter-rail", -600);
    const collapsed = await paneWidths(page);
    expect(collapsed.left).toBeGreaterThanOrEqual(180);

    // 반대로 최대한 벌려도 문서 표면은 읽힐 폭을 지킨다
    await dragSplitter(page, "#splitter-rail", 900);
    const expanded = await paneWidths(page);
    expect(expanded.stage).toBeGreaterThanOrEqual(320);
    expect(expanded.left + expanded.stage).toBeLessThanOrEqual(
      await page.evaluate(() => document.querySelector(".workspace")!.clientWidth),
    );
  });

  test("드래그 결과가 workspace.layout.v1에 JSON으로 남는다", async () => {
    await dragSplitter(page, "#splitter-rail", 90);
    const widths = await paneWidths(page);
    const stored = await readStoredLayout(page);

    expect(stored).not.toBeNull();
    expect(stored!.leftPx).toBeCloseTo(widths.left, 0);
    // MIGRATED (Todo 11): key and BOTH payload keys are unchanged. `rightPx` is
    // still written and restored by workspace-split.js; it is simply not rendered
    // as a column in library shell, so it is checked as persisted state.
    expect(Number.isFinite(stored!.rightPx)).toBe(true);
    expect(stored!.rightPx).toBeGreaterThanOrEqual(240);
  });

  test("새로고침 후 저장된 폭이 복원된다", async () => {
    await dragSplitter(page, "#splitter-rail", 110);
    await dragSplitter(page, "#splitter-transcript", -80);
    const dragged = await paneWidths(page);

    await page.reload({ waitUntil: "load" });
    await reconnectCapture(page);
    await enterLibraryMode(page);
    await waitForStableLayout(page);
    const restored = await paneWidths(page);

    expect(restored.left).toBeCloseTo(dragged.left, 0);
    expect(restored.right).toBeCloseTo(dragged.right, 0);
  });

  test("저장값이 손상돼도 기본 레이아웃으로 뜬다", async () => {
    await page.evaluate((key) => localStorage.setItem(key, "{not json"), STORAGE_KEY);
    await page.reload({ waitUntil: "load" });
    await reconnectCapture(page);
    await enterLibraryMode(page);
    await waitForStableLayout(page);

    // MIGRATED (Todo 11): the corrupted-payload fallback is unchanged. In library
    // shell the transcript is a tabpanel, so its restored width is asserted on the
    // persisted layout state that workspace-split.js still writes, rather than on
    // a rendered column this shell deliberately does not paint.
    const widths = await paneWidths(page);
    expect(widths.left).toBeGreaterThanOrEqual(180);
    expect(widths.stage).toBeGreaterThan(widths.left);

    const transcriptWidth = await page.evaluate(() =>
      Number.parseFloat(
        getComputedStyle(document.querySelector(".workspace")!).getPropertyValue("--transcript-w"),
      ),
    );
    expect(transcriptWidth).toBeGreaterThanOrEqual(240);
  });
});


describe("중앙 무대 잠금과 반응형", () => {
  test("MeetingCard가 .stage-pane 안에만 렌더되고 무대 중앙 hit가 stage다", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.removeItem("workspace.layout.v1"));
    await page.reload({ waitUntil: "load" });
    await reconnectCapture(page);
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
    await reconnectCapture(page);
    await waitForStableLayout(page);

    const narrow = await page.evaluate(() => {
      const rail = document.querySelector(".session-rail") as HTMLElement;
      const stage = document.querySelector(".stage-pane") as HTMLElement;
      const transcript = document.querySelector(".transcript-pane") as HTMLElement;
      const dock = document.querySelector(".dock") as HTMLElement;
      const railStyle = getComputedStyle(rail);
      const sr = stage.getBoundingClientRect();
      const tr = transcript.getBoundingClientRect();
      const dr = dock.getBoundingClientRect();
      return {
        railDisplay: railStyle.display,
        stageVisible: sr.width > 0 && sr.height > 0,
        transcriptVisible: tr.width > 0 && tr.height > 0,
        transcriptBelow: tr.top >= sr.bottom - 1,
        docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyScrollX: document.body.scrollWidth - document.body.clientWidth,
        dockFullyVisible: dr.height > 0 && dr.top >= 0 && dr.bottom <= window.innerHeight + 1,
        compileVisible: document.querySelector(".dock #btn-compile-deck") !== null,
      };
    });

    expect(narrow.railDisplay).toBe("none");
    expect(narrow.stageVisible).toBe(true);
    // The live stage/transcript HEIGHT split below the 900px seam is Todo 12's
    // contract (focused live geometry). Todo 11 owns the library shell, so it
    // asserts only that both regions stay visible, ordered and non-overflowing;
    // it deliberately pins no live height ratio.
    expect(narrow.transcriptVisible).toBe(true);
    expect(narrow.transcriptBelow).toBe(true);
    expect(narrow.docScrollX).toBeLessThanOrEqual(1);
    expect(narrow.bodyScrollX).toBeLessThanOrEqual(1);
    expect(narrow.dockFullyVisible).toBe(true);
    expect(narrow.compileVisible).toBe(true);
  });

  // MIGRATED (Todo 11). Was: "375px에서 도크 액션이 내부 스크롤되고 …" — required the
  // action row to be a nowrap horizontal SCROLLER. DESIGN.md §9.9 forbids a label
  // ending as a partial glyph behind an overflow fade at 375/320, which is exactly
  // what that scroller produced. The row now wraps instead. The real intent of the
  // test — every action reachable, nothing clipped, no document overflow — is
  // asserted below and strengthened: no label may be truncated at all.
  test("375px에서 도크 액션이 줄바꿈으로 모두 도달되고 문서는 가로로 넘치지 않는다", async () => {
    await page.setViewport({ width: 375, height: 720 });
    await page.evaluate(() => localStorage.removeItem("workspace.layout.v1"));
    await page.reload({ waitUntil: "load" });
    await reconnectCapture(page);
    await enterLibraryMode(page);
    await waitForStableLayout(page);

    const tiny = await page.evaluate(() => {
      const tabs = document.querySelector(".dock__tabs") as HTMLElement;
      const viewportWidth = document.documentElement.clientWidth;
      const buttons = [...tabs.querySelectorAll(".dock__btn")] as HTMLElement[];
      return {
        // Every action stays inside the viewport …
        offscreen: buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.right > viewportWidth + 1 || r.left < -1;
        }).length,
        // … and no label is cut off or ellipsized.
        truncated: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
        buttonCount: buttons.length,
        docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyScrollX: document.body.scrollWidth - document.body.clientWidth,
        compileVisible: document.querySelector(".dock #btn-compile-deck") !== null,
        stageVisible: (document.querySelector(".stage-pane") as HTMLElement).getBoundingClientRect().width > 0,
      };
    });

    expect(tiny.offscreen).toBe(0);
    expect(tiny.truncated).toBe(0);
    expect(tiny.buttonCount).toBeGreaterThan(0);
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
    await reconnectCapture(page);
    await enterLibraryMode(page);
    await waitForStableLayout(page);

    const panes = await page.evaluate(() => ({
      rail: !!document.querySelector(".session-rail"),
      stage: !!document.querySelector(".stage-pane"),
      transcript: !!document.querySelector(".transcript-pane"),
    }));
    expect(panes).toEqual({ rail: true, stage: true, transcript: true });

    const before = await paneWidths(page);
    await dragSplitter(page, "#splitter-rail", 100);
    const afterDrag = await paneWidths(page);
    expect(afterDrag.left - before.left).toBeGreaterThan(50);
    const dragged = await paneWidths(page);

    harness.pushMessage({ type: "capture", capturing: true, mode: "mic" });
    await page.waitForFunction(
      () => document.querySelector(".app")?.classList.contains("app--capturing") ?? false,
      { timeout: 5_000 },
    );
    await waitForStableLayout(page);

    const liveShell = await page.evaluate(() => {
      const rail = document.querySelector(".session-rail") as HTMLElement;
      const stage = document.querySelector(".stage-pane") as HTMLElement;
      const transcript = document.querySelector(".transcript-pane") as HTMLElement;
      const sr = stage.getBoundingClientRect();
      const tr = transcript.getBoundingClientRect();
      return {
        railDisplay: getComputedStyle(rail).display,
        stageW: sr.width,
        transcriptW: tr.width,
        sideBySide: Math.abs(sr.top - tr.top) < 48,
      };
    });
    expect(liveShell.railDisplay).toBe("none");
    expect(liveShell.stageW).toBeGreaterThan(200);
    expect(liveShell.transcriptW).toBeGreaterThan(200);
    expect(liveShell.sideBySide).toBe(true);

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

    await enterLibraryMode(page);
    await page.reload({ waitUntil: "load" });
    await reconnectCapture(page);
    await enterLibraryMode(page);
    await waitForStableLayout(page);
    const restored = await paneWidths(page);
    expect(restored.left).toBeCloseTo(dragged.left, 0);
    expect(restored.right).toBeCloseTo(dragged.right, 0);

    const emptyOk = await page.evaluate(() => document.getElementById("transcript-empty") !== null);
    expect(emptyOk).toBe(true);
  });
});
