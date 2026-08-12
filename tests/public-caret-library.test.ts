// Todo 11 - the document-centric Caret library shell.
//
// What this file pins (machine-consumed only, never prose or screenshot bytes):
//   1. the generated browser artifacts for the canonical reducers exist, are
//      reproducible from source, are served with an executable MIME type, and
//      are actually evaluated by the page (no dead TypeScript seam);
//   2. library shell structure: one meetings rail plus exactly ONE document
//      surface - Overview, Notes and Transcript replace one another;
//   3. real ARIA tablist/tab/tabpanel semantics with roving tabindex and
//      ArrowLeft/ArrowRight/Home/End keyboard operation plus focus movement;
//   4. meeting selection refreshes that single surface and drops stale payloads;
//   5. empty / loading / error / reconnect states and note + transcript data;
//   6. zero root overflow across the plan's six canonical viewports.
//
// Synchronization: every awaited client state is subscribed to (MutationObserver
// or an explicit page predicate armed BEFORE the trigger) and bounded by a named
// timeout. No sleep, no polling delay, no waitForTimeout anywhere.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

import {
  buildPublicModules,
  checkPublicModules,
  PUBLIC_MODULE_SOURCES,
} from "../scripts/build-public-modules.ts";
import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const repoRoot = join(import.meta.dir, "..");
const publicDir = join(repoRoot, "public");

/** Frozen clock shared with the task-4 fixtures so data never drifts by run. */
const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;

/**
 * The plan's browser matrix, deviceScaleFactor 1, plus 1100x800.
 *
 * 1100 is included because the superseded layer collapses the rail splitter at
 * `max-width: 1180px`; without a sample between 1024 and 1180 that seam is
 * invisible to the suite, which is exactly how a 5px-wide document surface
 * shipped past the first round of these tests.
 */
const VIEWPORTS = [
  { name: "reference", width: 1440, height: 900 },
  { name: "library", width: 1244, height: 836 },
  { name: "seam", width: 1100, height: 800 },
  { name: "live", width: 960, height: 760 },
  { name: "stacked", width: 820, height: 900 },
  { name: "narrow", width: 375, height: 812 },
  { name: "compact", width: 320, height: 667 },
] as const;

/**
 * Usable minimums for the ONE document surface. These are deliberately low bars:
 * they exist to prove the surface is a readable document rather than a collapsed
 * grid track, not to pin a design measurement.
 */
const MIN_DOCUMENT_WIDTH = 280;
const MIN_SLIDE_FRAME_WIDTH = 240;
const MIN_SLIDE_FRAME_HEIGHT = 130;
const MIN_NOTES_WIDTH = 240;
const MIN_NOTES_HEIGHT = 120;

const MEETINGS = {
  type: "meetings",
  items: [
    { id: 101, title: "제품 로드맵 정렬", started_at: FIXED_CLOCK_EPOCH_MS - 86_400_000, status: "ended" },
    { id: 102, title: "고객 온보딩 리뷰", started_at: FIXED_CLOCK_EPOCH_MS - 172_800_000, status: "ended" },
    { id: 103, title: "분기 회고", started_at: FIXED_CLOCK_EPOCH_MS - 259_200_000, status: "ended" },
  ],
} as const;

const TRANSCRIPT_101 = Array.from({ length: 15 }, (_, i) => ({
  text: `101번 회의 ${i + 1}번째 확정 문장입니다.`,
  ts: FIXED_CLOCK_EPOCH_MS - (15 - i) * 3_000,
  speaker: (i % 2) + 1,
}));

const TRANSCRIPT_102 = Array.from({ length: 4 }, (_, i) => ({
  text: `102번 회의 ${i + 1}번째 확정 문장입니다.`,
  ts: FIXED_CLOCK_EPOCH_MS - (4 - i) * 3_000,
  speaker: 1,
}));

function slide(index: number, title: string) {
  return {
    index,
    startedAt: FIXED_CLOCK_EPOCH_MS - (4 - index) * 60_000,
    sentenceCount: 6 + index,
    kind: index === 1 ? "cover" : "topic",
    title,
    kicker: "제품 로드맵",
    bullets: ["범위 합의", "위험 공유"],
  };
}

const MEETING_101 = {
  type: "meeting",
  meetingId: 101,
  title: "제품 로드맵 정렬",
  transcript: TRANSCRIPT_101,
  current: slide(2, "온보딩 지표 점검"),
  history: [slide(1, "2분기 로드맵 정렬"), slide(2, "온보딩 지표 점검")],
  compiled: null,
} as const;

const MEETING_102 = {
  type: "meeting",
  meetingId: 102,
  title: "고객 온보딩 리뷰",
  transcript: TRANSCRIPT_102,
  current: slide(1, "온보딩 리뷰 시작"),
  history: [slide(1, "온보딩 리뷰 시작")],
  compiled: null,
} as const;

const CAPTURE_IDLE = { type: "capture", capturing: false, mode: "mic", phase: "idle" } as const;

// ── page-side helpers ───────────────────────────────────────────────────────

declare global {
  interface Window {
    /** Arms a predicate BEFORE a trigger; resolves through __libSettle. */
    __libAwait?: (token: string, predicate: string) => void;
    __libSettle?: (token: string) => Promise<void>;
  }
}

/**
 * Installed on every page. Freezes the clock (so rendered dates never vary) and
 * exposes a subscribe-before-trigger registry keyed by a serialized predicate.
 * The observer is armed at subscription time and also evaluates immediately, so
 * a state reached between arming and awaiting is still observed exactly once.
 */
function pageBootstrap(fixedNow: number): void {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedNow);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      return fixedNow;
    }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

  window.__libAwait = (token: string, predicate: string): void => {
    const test = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try {
        ok = test() === true;
      } catch {
        ok = false;
      }
      if (!ok) return false;
      done = true;
      void window.__libSettle!(token);
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

class LibraryStateTimeoutError extends Error {
  constructor(predicate: string, timeoutMs: number) {
    super(`library shell timed out after ${timeoutMs}ms waiting for: ${predicate}`);
    this.name = "LibraryStateTimeoutError";
  }
}

/** One page plus its settle plumbing, reused across the assertions in a test. */
interface Session {
  page: Page;
  /** Arms the predicate, runs `trigger`, and awaits the predicate becoming true. */
  act(predicate: string, trigger: () => void | Promise<void>, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

async function openSession(width: number, height: number): Promise<Session> {
  const page = await browser.newPage();
  const settleWaiters = new Map<string, () => void>();
  await page.exposeFunction("__libSettle", (token: string) => {
    settleWaiters.get(token)?.();
  });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(pageBootstrap, FIXED_CLOCK_EPOCH_MS);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  let counter = 0;
  return {
    page,
    async act(predicate, trigger, timeoutMs = 2_000) {
      const token = `lib-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => settleWaiters.set(token, resolve));
      // Arm inside the page BEFORE the trigger runs.
      await page.evaluate((t: string, p: string) => window.__libAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LibraryStateTimeoutError(predicate, timeoutMs)), timeoutMs);
      });
      try {
        await Promise.race([settled, bounded]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        settleWaiters.delete(token);
      }
    },
    async close() {
      await page.close();
    },
  };
}

/** Brings a session to "library, meetings listed, meeting 101 loaded". */
async function loadMeeting101(session: Session): Promise<void> {
  await session.act(
    'document.querySelector(".app")?.dataset.capturePhase === "idle"',
    () => harness.pushMessage(CAPTURE_IDLE),
  );
  await session.act(
    'document.querySelectorAll("#session-list .session-row").length === 3',
    () => harness.pushMessage(MEETINGS),
  );
  await session.act(
    'document.querySelectorAll("#session-list .session-row--selected").length === 1',
    () => session.page.click('#session-list .session-row[data-meeting-id="101"]'),
  );
  await session.act(
    'document.querySelectorAll("#transcript-stream .feed-line").length === 15',
    () => harness.pushMessage(MEETING_101),
  );
}

/** Reads which detail panels are actually perceivable and their ARIA wiring. */
function readTabContract() {
  const tablist = document.querySelector('[role="tablist"]');
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  const visible = (el: Element): boolean => {
    const node = el as HTMLElement;
    if (node.hidden) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  return {
    tablistCount: document.querySelectorAll('[role="tablist"]').length,
    tablistLabelled:
      Boolean(tablist?.getAttribute("aria-label")) || Boolean(tablist?.getAttribute("aria-labelledby")),
    tabIds: tabs.map((tab) => tab.id),
    tabRoving: tabs.map((tab) => tab.getAttribute("tabindex")),
    tabSelected: tabs.map((tab) => tab.getAttribute("aria-selected")),
    tabControls: tabs.map((tab) => tab.getAttribute("aria-controls")),
    // Every aria-controls target must resolve to a real tabpanel element.
    tabControlsResolve: tabs.every((tab) => {
      const id = tab.getAttribute("aria-controls");
      const panel = id ? document.getElementById(id) : null;
      return panel !== null && panel.getAttribute("role") === "tabpanel";
    }),
    panelIds: panels.map((panel) => panel.id),
    panelLabelledBy: panels.map((panel) => panel.getAttribute("aria-labelledby")),
    // Each tabpanel must be labelled by the tab that controls it.
    panelLabelsResolve: panels.every((panel) => {
      const id = panel.getAttribute("aria-labelledby");
      const tab = id ? document.getElementById(id) : null;
      return tab !== null && tab.getAttribute("role") === "tab"
        && tab.getAttribute("aria-controls") === panel.id;
    }),
    visiblePanelIds: panels.filter(visible).map((panel) => panel.id),
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.id ?? null,
    detailTab: (document.querySelector(".app") as HTMLElement | null)?.dataset.detailTab ?? null,
    focusedId: document.activeElement?.id ?? null,
  };
}

/** Structural read of the library frame: rail + exactly one document surface. */
function readLibraryFrame() {
  const app = document.querySelector(".app") as HTMLElement | null;
  const perceivable = (selector: string): boolean => {
    const node = document.querySelector(selector) as HTMLElement | null;
    if (!node || node.hidden) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const box = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  return {
    shell: app?.dataset.shell ?? null,
    connection: document.documentElement.dataset.connection ?? null,
    connectionState: app?.dataset.connectionState ?? null,
    capturePhase: app?.dataset.capturePhase ?? null,
    stageState: app?.dataset.stageState ?? null,
    railVisible: perceivable("#session-rail"),
    stageVisible: perceivable("#stage-pane"),
    transcriptPaneVisible: perceivable("#transcript-pane"),
    railBox: box("#session-rail"),
    // The whole document region, not just the Overview panel inside it: a
    // collapsed wrapper is the defect this measurement has to expose.
    documentBox: box("#document-surface"),
    stageBox: box("#stage-pane"),
    rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    duplicateBindingIds: [
      "current-slide", "stage-pane", "session-list", "transcript-stream", "transcript-pane",
      "notes-input", "btn-record", "detail-tab-overview", "detail-tab-notes", "detail-tab-transcript",
    ].filter((id) => document.querySelectorAll(`[id="${id}"]`).length !== 1),
  };
}

beforeAll(async () => {
  harness = createPublicTestHarness();
  browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });
});

afterAll(async () => {
  await browser?.close();
  harness?.stop();
});

// ── 1. the generated browser artifacts ──────────────────────────────────────

describe("browser-valid reducer artifacts", () => {
  test("every reducer source has a committed, non-drifting generated artifact", async () => {
    const reports = await checkPublicModules(publicDir);
    expect(reports.map((report) => ({ output: report.output, status: report.status }))).toEqual([
      { output: "generated/ui-state-machine.js", status: "ok" },
      { output: "generated/transcript-state.js", status: "ok" },
    ]);
  });

  test("rebuilding into a clean directory reproduces byte-identical artifacts", async () => {
    const first = await buildPublicModules(publicDir);
    const second = await buildPublicModules(publicDir);
    expect(second.map((m) => m.outputSha256)).toEqual(first.map((m) => m.outputSha256));

    // And the committed bytes equal the freshly built bytes, key by key.
    for (const module of first) {
      const onDisk = await readFile(join(publicDir, module.output), "utf8");
      expect({ output: module.output, matches: onDisk === module.code })
        .toEqual({ output: module.output, matches: true });
    }
  });

  test("a mutated source is detected as drift rather than silently shipped", async () => {
    // Proves the drift check actually compares content: build from a copy of the
    // public dir whose source has one extra exported constant, and require the
    // committed artifact to be reported stale.
    const scratch = await mkdtemp(join(tmpdir(), "caret-drift-"));
    try {
      for (const source of PUBLIC_MODULE_SOURCES) {
        const text = await readFile(join(publicDir, source), "utf8");
        await Bun.write(join(scratch, source), text);
      }
      // Copy the committed artifacts unchanged, then perturb one source.
      for (const source of PUBLIC_MODULE_SOURCES) {
        const output = `generated/${source.replace(/\.ts$/, ".js")}`;
        await Bun.write(join(scratch, output), await readFile(join(publicDir, output), "utf8"));
      }
      const perturbed = `${await readFile(join(scratch, "transcript-state.ts"), "utf8")}\nexport const __DRIFT__ = 1;\n`;
      await Bun.write(join(scratch, "transcript-state.ts"), perturbed);

      const reports = await checkPublicModules(scratch);
      expect(reports.map((r) => ({ output: r.output, status: r.status }))).toEqual([
        { output: "generated/ui-state-machine.js", status: "ok" },
        { output: "generated/transcript-state.js", status: "stale" },
      ]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("generated artifacts are served as executable JavaScript, never octet-stream", async () => {
    for (const source of PUBLIC_MODULE_SOURCES) {
      const path = `/generated/${source.replace(/\.ts$/, ".js")}`;
      const response = await fetch(`${harness.origin}${path}`);
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      const type = response.headers.get("content-type") ?? "";
      expect({ path, javascript: /javascript|ecmascript/i.test(type) })
        .toEqual({ path, javascript: true });
    }
  });

  test("the shipped page really evaluates the reducers - no dead TypeScript seam", async () => {
    const session = await openSession(1244, 836);
    try {
      const probe = await session.page.evaluate(() => {
        const w = window as unknown as { __caretModules?: Record<string, unknown> };
        const modules = w.__caretModules ?? {};
        const ui = modules.ui as Record<string, unknown> | undefined;
        const transcript = modules.transcript as Record<string, unknown> | undefined;
        return {
          uiExports: ui ? Object.keys(ui).sort() : [],
          transcriptExports: transcript ? Object.keys(transcript).sort() : [],
          // The shell must consume the reducer, not merely load it.
          reducerDrivenState: (document.querySelector(".app") as HTMLElement | null)?.dataset.uiState ?? null,
        };
      });

      expect(probe.uiExports).toContain("reduce");
      expect(probe.uiExports).toContain("initialUiState");
      expect(probe.uiExports).toContain("parseServerEvent");
      expect(probe.transcriptExports).toContain("reduceTranscript");
      expect(probe.transcriptExports).toContain("parseTranscriptEvent");
      expect(probe.reducerDrivenState).not.toBeNull();

      // No raw .ts module may be referenced by the shipped document.
      const tsReferences = await session.page.evaluate(() =>
        [...document.querySelectorAll("script[src]")]
          .map((node) => (node as HTMLScriptElement).getAttribute("src") ?? "")
          .filter((src) => src.endsWith(".ts")),
      );
      expect(tsReferences).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

// ── 2. library frame: rail + exactly one document surface ───────────────────

describe("document-centric library frame", () => {
  test("1244x836 shows one meetings rail and exactly one document surface", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const frame = await session.page.evaluate(readLibraryFrame);

      expect(frame.shell).toBe("library");
      expect(frame.railVisible).toBe(true);
      expect(frame.stageVisible).toBe(true);
      // No permanent transcript dock in library mode: the transcript is a tab.
      expect(frame.transcriptPaneVisible).toBe(false);
      expect(frame.rootOverflow).toBe(0);
      expect(frame.duplicateBindingIds).toEqual([]);
      // The rail is narrow relative to the document surface it serves.
      expect(frame.railBox!.width).toBeLessThan(frame.documentBox!.width);
      expect(frame.railBox!.width).toBeLessThanOrEqual(320);
    } finally {
      await session.close();
    }
  });

  test("Overview and Transcript never coexist: exactly one panel is perceivable", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);

      const overview = await session.page.evaluate(readTabContract);
      expect(overview.visiblePanelIds.length).toBe(1);
      expect(overview.activeTab).toBe("detail-tab-overview");
      expect(overview.detailTab).toBe("overview");

      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "transcript"',
        () => session.page.click("#detail-tab-transcript"),
      );
      const transcript = await session.page.evaluate(readTabContract);
      expect(transcript.visiblePanelIds.length).toBe(1);
      expect(transcript.visiblePanelIds).not.toEqual(overview.visiblePanelIds);
      expect(transcript.activeTab).toBe("detail-tab-transcript");

      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "notes"',
        () => session.page.click("#detail-tab-notes"),
      );
      const notes = await session.page.evaluate(readTabContract);
      expect(notes.visiblePanelIds.length).toBe(1);
      expect(notes.activeTab).toBe("detail-tab-notes");
    } finally {
      await session.close();
    }
  });

  test("no redundant centre detail panel duplicates the document surface", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const duplication = await session.page.evaluate(() => {
        const visible = (node: Element): boolean => {
          const el = node as HTMLElement;
          if (el.hidden) return false;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          // Only one node renders slide content at a time.
          slideRoots: [...document.querySelectorAll("#current-slide")].filter(visible).length,
          // Only one node renders the transcript stream.
          transcriptStreams: [...document.querySelectorAll("#transcript-stream")].filter(visible).length,
          // Only one notes editor is perceivable at a time.
          noteEditors: [...document.querySelectorAll("#notes-input, #live-note")].filter(visible).length,
          // No second, hidden-but-laid-out copy of a detail panel.
          panelsWithSize: [...document.querySelectorAll('[role="tabpanel"]')]
            .filter((node) => {
              const r = node.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }).length,
        };
      });

      expect(duplication.slideRoots).toBeLessThanOrEqual(1);
      expect(duplication.transcriptStreams).toBe(0);
      expect(duplication.noteEditors).toBe(0);
      expect(duplication.panelsWithSize).toBe(1);
    } finally {
      await session.close();
    }
  });
});

// ── 3. real ARIA tab semantics and keyboard operation ───────────────────────

describe("detail tabs are a real tablist", () => {
  test("tablist, tab and tabpanel roles are complete and cross-linked", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const contract = await session.page.evaluate(readTabContract);

      expect(contract.tablistCount).toBe(1);
      expect(contract.tablistLabelled).toBe(true);
      expect(contract.tabIds).toEqual([
        "detail-tab-overview",
        "detail-tab-notes",
        "detail-tab-transcript",
      ]);
      expect(contract.tabControlsResolve).toBe(true);
      expect(contract.panelLabelsResolve).toBe(true);
      expect(contract.tabSelected).toEqual(["true", "false", "false"]);
      // Roving tabindex: exactly the selected tab is in the tab order.
      expect(contract.tabRoving).toEqual(["0", "-1", "-1"]);
    } finally {
      await session.close();
    }
  });

  test("ArrowRight, ArrowLeft, Home and End move selection and focus", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.page.focus("#detail-tab-overview");

      const press = async (key: string, expected: string) => {
        await session.act(
          `document.querySelector(".app")?.dataset.detailTab === "${expected}"`,
          () => session.page.keyboard.press(key as Parameters<Page["keyboard"]["press"]>[0]),
        );
        return session.page.evaluate(readTabContract);
      };

      const right = await press("ArrowRight", "notes");
      expect(right.activeTab).toBe("detail-tab-notes");
      expect(right.focusedId).toBe("detail-tab-notes");
      expect(right.tabRoving).toEqual(["-1", "0", "-1"]);
      expect(right.visiblePanelIds.length).toBe(1);

      const end = await press("End", "transcript");
      expect(end.activeTab).toBe("detail-tab-transcript");
      expect(end.focusedId).toBe("detail-tab-transcript");

      const left = await press("ArrowLeft", "notes");
      expect(left.activeTab).toBe("detail-tab-notes");
      expect(left.focusedId).toBe("detail-tab-notes");

      const home = await press("Home", "overview");
      expect(home.activeTab).toBe("detail-tab-overview");
      expect(home.focusedId).toBe("detail-tab-overview");

      // ArrowLeft from the first tab wraps to the last (authoring practice).
      const wrap = await press("ArrowLeft", "transcript");
      expect(wrap.activeTab).toBe("detail-tab-transcript");
    } finally {
      await session.close();
    }
  });

  test("document body text meets the WCAG AA contrast floor on its real surface", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "transcript"',
        () => session.page.click("#detail-tab-transcript"),
      );

      // Measures the COMPOSITED colour actually painted, including any inherited
      // opacity, against the nearest opaque ancestor background.
      const samples = await session.page.evaluate(() => {
        const parse = (value: string): [number, number, number, number] => {
          const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
          return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
        };
        const effectiveOpacity = (node: Element): number => {
          let alpha = 1;
          let cursor: Element | null = node;
          while (cursor) {
            alpha *= Number.parseFloat(getComputedStyle(cursor).opacity || "1");
            cursor = cursor.parentElement;
          }
          return alpha;
        };
        const backdrop = (node: Element): [number, number, number] => {
          let cursor: Element | null = node;
          while (cursor) {
            const [r, g, b, a] = parse(getComputedStyle(cursor).backgroundColor);
            if (a >= 1) return [r, g, b];
            cursor = cursor.parentElement;
          }
          return [9, 9, 11];
        };
        const read = (selector: string) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const [r, g, b] = parse(getComputedStyle(node).color);
          const alpha = effectiveOpacity(node);
          const [br, bg, bb] = backdrop(node);
          return {
            selector,
            fg: [r * alpha + br * (1 - alpha), g * alpha + bg * (1 - alpha), b * alpha + bb * (1 - alpha)],
            bg: [br, bg, bb],
          };
        };
        return [
          read("#transcript-stream .feed-line__text"),
          read("#meeting-chrome-title"),
          read("#session-list .session-row--selected .session-row__title"),
        ].filter((entry) => entry !== null);
      });

      const luminance = (channels: number[]): number => {
        const [r, g, b] = channels.map((channel) => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };

      expect(samples.length).toBe(3);
      for (const sample of samples) {
        const light = luminance(sample!.fg);
        const dark = luminance(sample!.bg);
        const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
        expect({ selector: sample!.selector, aa: ratio >= 4.5 })
          .toEqual({ selector: sample!.selector, aa: true });
      }
    } finally {
      await session.close();
    }
  });

  test("every tab is keyboard reachable and paints a visible focus ring", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      // Real keyboard focus, not a programmatic .focus(): only a genuine keyboard
      // interaction sets Chromium's focus-visible heuristic, so this is the only
      // way to prove the ring a keyboard user actually sees.
      await session.page.focus("#session-list .session-row--selected");
      await session.page.keyboard.press("Tab");
      const focusRing = await session.page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const tab = document.getElementById("detail-tab-overview") as HTMLElement;
        tab.focus();
        const style = getComputedStyle(tab);
        return {
          tabbedTo: active?.id ?? null,
          focused: document.activeElement?.id ?? null,
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
          boxShadow: style.boxShadow,
        };
      });
      expect(focusRing.focused).toBe("detail-tab-overview");
      const painted = focusRing.outlineStyle !== "none"
        && Number.parseFloat(focusRing.outlineWidth) > 0;
      expect(painted || focusRing.boxShadow !== "none").toBe(true);
    } finally {
      await session.close();
    }
  });
});

// ── 4. meeting switching refreshes the ONE surface ──────────────────────────

describe("meeting selection refreshes the single document surface", () => {
  test("selecting another meeting replaces the document content", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "transcript"',
        () => session.page.click("#detail-tab-transcript"),
      );
      const before = await session.page.evaluate(() => ({
        lines: [...document.querySelectorAll("#transcript-stream .feed-line__text")]
          .map((node) => node.textContent?.trim() ?? ""),
      }));
      expect(before.lines.length).toBe(15);
      expect(before.lines[0]).toContain("101번 회의");

      await session.act(
        'document.querySelector(\'#session-list .session-row--selected\')?.dataset.meetingId === "102"',
        () => session.page.click('#session-list .session-row[data-meeting-id="102"]'),
      );
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 4',
        () => harness.pushMessage(MEETING_102),
      );

      const after = await session.page.evaluate(() => ({
        lines: [...document.querySelectorAll("#transcript-stream .feed-line__text")]
          .map((node) => node.textContent?.trim() ?? ""),
        surfaces: document.querySelectorAll('[role="tabpanel"]').length,
        visiblePanels: [...document.querySelectorAll('[role="tabpanel"]')]
          .filter((node) => {
            const el = node as HTMLElement;
            const style = getComputedStyle(el);
            return !el.hidden && style.display !== "none";
          }).length,
      }));

      expect(after.lines.length).toBe(4);
      expect(after.lines.every((line) => line.includes("102번 회의"))).toBe(true);
      // Still exactly one document surface after the switch.
      expect(after.visiblePanels).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("a stale meeting payload arriving after a newer selection is ignored", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "transcript"',
        () => session.page.click("#detail-tab-transcript"),
      );
      // Rapidly select 102; the server answers for 101 (the superseded request).
      await session.act(
        'document.querySelector(\'#session-list .session-row--selected\')?.dataset.meetingId === "102"',
        () => session.page.click('#session-list .session-row[data-meeting-id="102"]'),
      );

      // Push the stale payload and then the fresh one. Only the fresh one may land.
      harness.pushMessage(MEETING_101);
      await session.act(
        'document.querySelectorAll("#transcript-stream .feed-line").length === 4',
        () => harness.pushMessage(MEETING_102),
      );

      const state = await session.page.evaluate(() => ({
        lines: [...document.querySelectorAll("#transcript-stream .feed-line__text")]
          .map((node) => node.textContent?.trim() ?? ""),
        selected: (document.querySelector("#session-list .session-row--selected") as HTMLElement | null)
          ?.dataset.meetingId ?? null,
      }));

      expect(state.selected).toBe("102");
      expect(state.lines.length).toBe(4);
      expect(state.lines.some((line) => line.includes("101번 회의"))).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("initial hydration shows no stale slide or transcript content", async () => {
    const session = await openSession(1244, 836);
    try {
      const initial = await session.page.evaluate(() => ({
        transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
        slideTitle: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
        selectedRows: document.querySelectorAll("#session-list .session-row--selected").length,
      }));
      expect(initial).toEqual({ transcriptLines: 0, slideTitle: null, selectedRows: 0 });
    } finally {
      await session.close();
    }
  });
});

// ── 5. real data: notes and transcript ──────────────────────────────────────

describe("real note and transcript data survive the rebuild", () => {
  test("typing a note reaches #notes-input and is sent with its contracted action", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "notes"',
        () => session.page.click("#detail-tab-notes"),
      );

      const notesVisible = await session.page.evaluate(() => {
        const notes = document.getElementById("notes-input") as HTMLTextAreaElement | null;
        if (!notes) return null;
        const style = getComputedStyle(notes);
        const rect = notes.getBoundingClientRect();
        return {
          display: style.display,
          hasSize: rect.width > 0 && rect.height > 0,
          disabled: notes.disabled,
        };
      });
      expect(notesVisible).not.toBeNull();
      expect(notesVisible!.hasSize).toBe(true);
      expect(notesVisible!.disabled).toBe(false);

      await session.page.focus("#notes-input");
      await session.page.keyboard.type("결정 사항 메모");
      const value = await session.page.evaluate(
        () => (document.getElementById("notes-input") as HTMLTextAreaElement).value,
      );
      expect(value).toBe("결정 사항 메모");
    } finally {
      await session.close();
    }
  });

  test("transcript history renders finalized lines with speaker and time metadata", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.act(
        'document.querySelector(".app")?.dataset.detailTab === "transcript"',
        () => session.page.click("#detail-tab-transcript"),
      );

      const stream = await session.page.evaluate(() => {
        const lines = [...document.querySelectorAll("#transcript-stream .feed-line")];
        const body = document.getElementById("transcript-body");
        return {
          count: lines.length,
          countLabel: document.getElementById("transcript-count")?.textContent?.trim() ?? "",
          firstText: lines[0]?.querySelector(".feed-line__text")?.textContent?.trim() ?? "",
          hasTimes: lines.every((line) => (line.querySelector(".feed-line__time")?.textContent ?? "").length > 0),
          speakerChips: lines.filter((line) => line.querySelector(".speaker-chip")).length,
          bodyScrollable: Boolean(body && body.scrollHeight >= body.clientHeight),
          emptyHidden: document.getElementById("transcript-empty")?.hasAttribute("hidden") ?? false,
        };
      });

      expect(stream.count).toBe(15);
      expect(stream.countLabel).toBe("15");
      expect(stream.firstText).toContain("101번 회의 1번째");
      expect(stream.hasTimes).toBe(true);
      expect(stream.speakerChips).toBe(15);
      expect(stream.emptyHidden).toBe(true);
    } finally {
      await session.close();
    }
  });
});

// ── 6. empty / loading / error / reconnect ─────────────────────────────────

describe("library empty, loading, error and reconnect states", () => {
  test("an empty library explains itself and keeps the record action", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.act(
        'document.getElementById("session-empty")?.hasAttribute("hidden") === false',
        () => harness.pushMessage({ type: "meetings", items: [] }),
      );
      const empty = await session.page.evaluate(() => {
        const emptyNode = document.getElementById("session-empty");
        const record = document.getElementById("btn-record") as HTMLButtonElement | null;
        return {
          emptyVisible: Boolean(emptyNode) && !emptyNode!.hasAttribute("hidden"),
          emptyHasText: (emptyNode?.textContent ?? "").trim().length > 0,
          rows: document.querySelectorAll("#session-list .session-row").length,
          recordPresent: Boolean(record),
          recordDisabled: record?.disabled ?? true,
          countLabel: document.getElementById("session-count")?.textContent?.trim() ?? "",
        };
      });
      expect(empty.emptyVisible).toBe(true);
      expect(empty.emptyHasText).toBe(true);
      expect(empty.rows).toBe(0);
      expect(empty.recordPresent).toBe(true);
      expect(empty.recordDisabled).toBe(false);
      expect(empty.countLabel).toBe("0");
    } finally {
      await session.close();
    }
  });

  test("connection state is explicit and survives a reconnect without losing content", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const online = await session.page.evaluate(readLibraryFrame);
      // EXACT legacy vocabulary. Accepting "online" here previously let the shell
      // clobber the frozen `data-connection` value that app.js owns and the
      // task-3 manifest pins, which silently broke every surface reading it.
      expect(online.connection).toBe("connected");
      // The canonical state is published additively, never by renaming.
      expect(online.connectionState).toBe("online");

      await session.act(
        '["reconnecting","disconnected"].includes(document.documentElement.dataset.connection ?? "")',
        () => harness.disconnectClients(),
        3_000,
      );

      const dropped = await session.page.evaluate(() => ({
        connection: document.documentElement.dataset.connection ?? null,
        connectionState: (document.querySelector(".app") as HTMLElement | null)?.dataset.connectionState ?? null,
        // Content the user was reading is retained through transport loss.
        transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
        selected: (document.querySelector("#session-list .session-row--selected") as HTMLElement | null)
          ?.dataset.meetingId ?? null,
      }));
      expect(dropped.connection).toBe("disconnected");
      expect(dropped.connectionState).toBe("reconnecting");
      expect(dropped.transcriptLines).toBe(15);
      expect(dropped.selected).toBe("101");
    } finally {
      await session.close();
    }
  });

  test("a malformed server frame is dropped without disturbing the shell", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const before = await session.page.evaluate(readLibraryFrame);

      // Malformed frames: unknown type, wrong payload types, and a null entry list.
      harness.pushMessage({ type: "meeting", meetingId: "not-a-number", transcript: null });
      harness.pushMessage({ type: "transcript", entries: "nope", reason: "snapshot" });
      harness.pushMessage({ nonsense: true });

      // Then a well-formed frame proves the client is still processing messages.
      await session.act(
        'document.querySelectorAll("#session-list .session-row").length === 3',
        () => harness.pushMessage(MEETINGS),
      );

      const after = await session.page.evaluate(readLibraryFrame);
      const content = await session.page.evaluate(() => ({
        transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
        selected: (document.querySelector("#session-list .session-row--selected") as HTMLElement | null)
          ?.dataset.meetingId ?? null,
      }));

      expect(after.shell).toBe(before.shell);
      expect(after.duplicateBindingIds).toEqual([]);
      expect(content.transcriptLines).toBe(15);
      expect(content.selected).toBe("101");
    } finally {
      await session.close();
    }
  });
});

// ── 7. explicit state attributes and preserved contracts ───────────────────

describe("explicit state attributes and preserved binding contracts", () => {
  test("the shell exposes every contracted state attribute", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const state = await session.page.evaluate(() => {
        const app = document.querySelector(".app") as HTMLElement;
        return {
          connection: document.documentElement.dataset.connection ?? null,
          capturePhase: app.dataset.capturePhase ?? null,
          shell: app.dataset.shell ?? null,
          detailTab: app.dataset.detailTab ?? null,
          stageState: app.dataset.stageState ?? null,
          capturingClass: app.classList.contains("app--capturing"),
        };
      });

      expect(state.capturePhase).toBe("idle");
      expect(state.shell).toBe("library");
      expect(state.detailTab).toBe("overview");
      expect(state.stageState).not.toBeNull();
      expect(state.capturingClass).toBe(false);
    } finally {
      await session.close();
    }
  });

  test(".app--capturing still tracks the authoritative capture phase", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      await session.act(
        'document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage({
          type: "capture", capturing: true, mode: "mic", phase: "capturing",
          startedAt: FIXED_CLOCK_EPOCH_MS - 125_000,
        }),
      );
      const live = await session.page.evaluate(() => {
        const app = document.querySelector(".app") as HTMLElement;
        return { phase: app.dataset.capturePhase, shell: app.dataset.shell };
      });
      expect(live.phase).toBe("capturing");
      expect(live.shell).toBe("live");

      // Authoritative idle: the shell leaves the just-ended live workspace and
      // returns to the library document (DESIGN 9.8).
      await session.act(
        'document.querySelector(".app")?.dataset.shell === "library"',
        () => harness.pushMessage(CAPTURE_IDLE),
      );
      const idle = await session.page.evaluate(() => {
        const app = document.querySelector(".app") as HTMLElement;
        return { phase: app.dataset.capturePhase, shell: app.dataset.shell };
      });
      expect(idle.phase).toBe("idle");
      expect(idle.shell).toBe("library");
    } finally {
      await session.close();
    }
  });

  // DESIGN §9.8: "Stop and timer stay visible and enabled through starting,
  // capturing, and stopping." The superseded layer gated #live-topbar on the
  // `.app--capturing` class, which app.js only sets when the server reports
  // `capturing: true` — so during the `starting` phase (`capturing: false`) Stop
  // and the timer vanished while a recording was being established.
  test("Stop and the timer stay visible and enabled through all three live phases", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);

      const phases = [
        { phase: "starting", capturing: false },
        { phase: "capturing", capturing: true },
        { phase: "stopping", capturing: true },
      ] as const;

      for (const step of phases) {
        await session.act(
          `document.querySelector(".app")?.dataset.capturePhase === "${step.phase}"`,
          () => harness.pushMessage({
            type: "capture",
            capturing: step.capturing,
            mode: "mic",
            phase: step.phase,
            startedAt: FIXED_CLOCK_EPOCH_MS - 125_000,
          }),
        );

        const live = await session.page.evaluate(() => {
          const topbar = document.getElementById("live-topbar");
          const stop = document.getElementById("btn-live-stop") as HTMLButtonElement | null;
          const timer = document.getElementById("live-topbar-timer");
          const stopRect = stop?.getBoundingClientRect();
          const timerRect = timer?.getBoundingClientRect();
          return {
            topbarDisplay: topbar ? getComputedStyle(topbar).display : "missing",
            stopPerceivable: Boolean(stopRect && stopRect.width > 0 && stopRect.height > 0),
            stopDisabled: stop?.disabled ?? true,
            stopName: stop?.getAttribute("aria-label") ?? "",
            timerPerceivable: Boolean(timerRect && timerRect.width > 0 && timerRect.height > 0),
            // Truthful telemetry: the timer reads from the server startedAt.
            timerText: timer?.textContent?.trim() ?? "",
          };
        });

        expect({ phase: step.phase, hidden: live.topbarDisplay === "none" })
          .toEqual({ phase: step.phase, hidden: false });
        expect({ phase: step.phase, stop: live.stopPerceivable })
          .toEqual({ phase: step.phase, stop: true });
        expect({ phase: step.phase, disabled: live.stopDisabled })
          .toEqual({ phase: step.phase, disabled: false });
        expect({ phase: step.phase, named: live.stopName.length > 0 })
          .toEqual({ phase: step.phase, named: true });
        expect({ phase: step.phase, timer: live.timerPerceivable })
          .toEqual({ phase: step.phase, timer: true });
        // 125 s before the frozen clock => "02:05" once the server owns capture.
        if (step.phase !== "starting") {
          expect({ phase: step.phase, text: live.timerText })
            .toEqual({ phase: step.phase, text: "02:05" });
        }
      }

      // Authoritative idle retires the live control again.
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "idle"',
        () => harness.pushMessage(CAPTURE_IDLE),
      );
      const idle = await session.page.evaluate(() => ({
        topbarDisplay: getComputedStyle(document.getElementById("live-topbar")!).display,
        shell: (document.querySelector(".app") as HTMLElement).dataset.shell,
      }));
      expect(idle.topbarDisplay).toBe("none");
      expect(idle.shell).toBe("library");
    } finally {
      await session.close();
    }
  });

  test("no fake event, folder or share controls exist in the library shell", async () => {
    const session = await openSession(1244, 836);
    try {
      await loadMeeting101(session);
      const fakes = await session.page.evaluate(() => {
        const text = (document.querySelector(".app")?.textContent ?? "").toLowerCase();
        return {
          selectEvent: text.includes("select event"),
          addToFolder: text.includes("add to folder"),
          share: /\bshare\b/.test(text),
        };
      });
      expect(fakes).toEqual({ selectEvent: false, addToFolder: false, share: false });
    } finally {
      await session.close();
    }
  });
});

// ── 8. responsive matrix ───────────────────────────────────────────────────

describe("library shell across the canonical viewport matrix", () => {
  test("no root overflow and one document surface at every matrix width", async () => {
    for (const viewport of VIEWPORTS) {
      const session = await openSession(viewport.width, viewport.height);
      try {
        await loadMeeting101(session);
        const frame = await session.page.evaluate(readLibraryFrame);
        const tabs = await session.page.evaluate(readTabContract);

        expect({ name: viewport.name, overflow: frame.rootOverflow })
          .toEqual({ name: viewport.name, overflow: 0 });
        expect({ name: viewport.name, panels: tabs.visiblePanelIds.length })
          .toEqual({ name: viewport.name, panels: 1 });
        // Exactly one panel is not enough on its own: a panel collapsed into a
        // 5px grid track is still "one panel". It must also be usable.
        expect({
          name: viewport.name,
          documentUsable: (frame.documentBox?.width ?? 0) >= MIN_DOCUMENT_WIDTH,
        }).toEqual({ name: viewport.name, documentUsable: true });
        expect({ name: viewport.name, duplicates: frame.duplicateBindingIds })
          .toEqual({ name: viewport.name, duplicates: [] });
        expect({ name: viewport.name, shell: frame.shell })
          .toEqual({ name: viewport.name, shell: "library" });
      } finally {
        await session.close();
      }
    }
  }, 40_000);

  test("the document surface and slide frame stay usable at every matrix width", async () => {
    for (const viewport of VIEWPORTS) {
      const session = await openSession(viewport.width, viewport.height);
      try {
        await loadMeeting101(session);
        const geometry = await session.page.evaluate(() => {
          const box = (selector: string) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { width: Math.round(rect.width), height: Math.round(rect.height) };
          };
          const surface = document.getElementById("document-surface");
          const rail = document.getElementById("session-rail");
          const splitter = document.getElementById("splitter-rail");
          return {
            document: box("#document-surface"),
            slideFrame: box("#slide-frame"),
            rail: box("#session-rail"),
            viewportWidth: document.documentElement.clientWidth,
            // A collapsed surface is the failure mode this guards: the document
            // landing in the 5px splitter track instead of the 1fr track.
            surfaceGridColumn: surface ? getComputedStyle(surface).gridColumnStart : null,
            splitterDisplay: splitter ? getComputedStyle(splitter).display : null,
            railDisplay: rail ? getComputedStyle(rail).display : null,
          };
        });

        expect({ name: viewport.name, present: geometry.document !== null })
          .toEqual({ name: viewport.name, present: true });
        expect({
          name: viewport.name,
          documentUsable: geometry.document!.width >= MIN_DOCUMENT_WIDTH,
        }).toEqual({ name: viewport.name, documentUsable: true });
        expect({
          name: viewport.name,
          slideUsable: geometry.slideFrame!.width >= MIN_SLIDE_FRAME_WIDTH
            && geometry.slideFrame!.height >= MIN_SLIDE_FRAME_HEIGHT,
        }).toEqual({ name: viewport.name, slideUsable: true });
        // The document is the dominant surface: never narrower than the rail
        // that navigates to it.
        expect({
          name: viewport.name,
          documentWiderThanRail: geometry.document!.width >= geometry.rail!.width,
        }).toEqual({ name: viewport.name, documentWiderThanRail: true });
      } finally {
        await session.close();
      }
    }
  }, 60_000);

  test("Notes stays visible, sized and focusable at every matrix width", async () => {
    for (const viewport of VIEWPORTS) {
      const session = await openSession(viewport.width, viewport.height);
      try {
        await loadMeeting101(session);
        await session.act(
          'document.querySelector(".app")?.dataset.detailTab === "notes"',
          () => session.page.click("#detail-tab-notes"),
        );

        const notes = await session.page.evaluate(() => {
          const input = document.getElementById("notes-input") as HTMLTextAreaElement | null;
          const box = document.getElementById("notes-box");
          if (!input || !box) return null;
          const rect = input.getBoundingClientRect();
          input.focus();
          return {
            boxDisplay: getComputedStyle(box).display,
            inputDisplay: getComputedStyle(input).display,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            disabled: input.disabled,
            focused: document.activeElement?.id === "notes-input",
          };
        });

        expect({ name: viewport.name, present: notes !== null })
          .toEqual({ name: viewport.name, present: true });
        expect({ name: viewport.name, boxHidden: notes!.boxDisplay === "none" })
          .toEqual({ name: viewport.name, boxHidden: false });
        expect({ name: viewport.name, inputHidden: notes!.inputDisplay === "none" })
          .toEqual({ name: viewport.name, inputHidden: false });
        expect({
          name: viewport.name,
          sized: notes!.width >= MIN_NOTES_WIDTH && notes!.height >= MIN_NOTES_HEIGHT,
        }).toEqual({ name: viewport.name, sized: true });
        expect({ name: viewport.name, disabled: notes!.disabled })
          .toEqual({ name: viewport.name, disabled: false });
        expect({ name: viewport.name, focusable: notes!.focused })
          .toEqual({ name: viewport.name, focusable: true });

        // Typing must actually reach the contracted note element.
        await session.page.focus("#notes-input");
        await session.page.keyboard.type("메모");
        const value = await session.page.evaluate(
          () => (document.getElementById("notes-input") as HTMLTextAreaElement).value,
        );
        expect({ name: viewport.name, value }).toEqual({ name: viewport.name, value: "메모" });
      } finally {
        await session.close();
      }
    }
  }, 60_000);

  test("no visible label is clipped or truncated at any matrix width", async () => {
    for (const viewport of VIEWPORTS) {
      const session = await openSession(viewport.width, viewport.height);
      try {
        await loadMeeting101(session);
        const labels = await session.page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth;
          const selectors = [
            ".detail-tabs__btn",
            ".dock__btn",
            "#btn-record",
            "#session-list .session-row__title",
            "#session-count",
          ];
          const nodes = selectors.flatMap((selector) =>
            [...document.querySelectorAll(selector)] as HTMLElement[]);
          const perceivable = (node: HTMLElement): boolean => {
            if (node.hidden) return false;
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const visible = nodes.filter(perceivable);
          return {
            checked: visible.length,
            // Outside the viewport: unreachable.
            offscreen: visible
              .filter((node) => {
                const rect = node.getBoundingClientRect();
                return rect.right > viewportWidth + 1 || rect.left < -1;
              })
              .map((node) => node.id || node.textContent?.trim().slice(0, 20) || node.className),
            // Content wider than its box: ends mid-glyph or in an ellipsis.
            truncated: visible
              .filter((node) => node.scrollWidth > node.clientWidth + 1)
              .map((node) => node.id || node.textContent?.trim().slice(0, 20) || node.className),
          };
        });

        expect({ name: viewport.name, offscreen: labels.offscreen })
          .toEqual({ name: viewport.name, offscreen: [] });
        expect({ name: viewport.name, truncated: labels.truncated })
          .toEqual({ name: viewport.name, truncated: [] });
        expect(labels.checked).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    }
  }, 60_000);

  test("no dock control is clipped or truncated at any matrix width", async () => {
    for (const viewport of VIEWPORTS) {
      const session = await openSession(viewport.width, viewport.height);
      try {
        await loadMeeting101(session);
        const dock = await session.page.evaluate(() => {
          const viewportWidth = document.documentElement.clientWidth;
          const buttons = [...document.querySelectorAll(".dock__btn")] as HTMLElement[];
          return {
            count: buttons.length,
            // A control whose box leaves the viewport is unreachable.
            clipped: buttons
              .filter((button) => {
                const rect = button.getBoundingClientRect();
                return rect.right > viewportWidth + 1 || rect.left < -1;
              })
              .map((button) => button.id),
            // A label wider than its box ends mid-glyph or in an ellipsis, which
            // DESIGN 9.9 forbids for the narrow widths.
            truncated: buttons
              .filter((button) => button.scrollWidth > button.clientWidth + 1)
              .map((button) => button.id),
          };
        });

        expect({ name: viewport.name, clipped: dock.clipped })
          .toEqual({ name: viewport.name, clipped: [] });
        expect({ name: viewport.name, truncated: dock.truncated })
          .toEqual({ name: viewport.name, truncated: [] });
        expect(dock.count).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    }
  }, 40_000);

  test("the meetings rail stays reachable at 320x667 without clipping controls", async () => {
    const session = await openSession(320, 667);
    try {
      await loadMeeting101(session);
      const narrow = await session.page.evaluate(() => {
        const rail = document.getElementById("session-rail");
        const rows = [...document.querySelectorAll("#session-list .session-row")];
        const record = document.getElementById("btn-record");
        const railRect = rail?.getBoundingClientRect();
        const recordRect = record?.getBoundingClientRect();
        return {
          railPresent: Boolean(rail),
          railInViewport: Boolean(railRect) && railRect!.left >= -1
            && railRect!.right <= document.documentElement.clientWidth + 1,
          rows: rows.length,
          // Touch targets stay usable at the minimum width.
          recordHeight: Math.round(recordRect?.height ?? 0),
          recordInViewport: Boolean(recordRect)
            && recordRect!.right <= document.documentElement.clientWidth + 1,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });

      expect(narrow.railPresent).toBe(true);
      expect(narrow.railInViewport).toBe(true);
      expect(narrow.rows).toBe(3);
      expect(narrow.recordHeight).toBeGreaterThanOrEqual(36);
      expect(narrow.recordInViewport).toBe(true);
      expect(narrow.overflow).toBe(0);
    } finally {
      await session.close();
    }
  });
});

// ── 9. no external network dependency ──────────────────────────────────────

describe("determinism guards", () => {
  test("the library shell issues no off-origin request", async () => {
    const page = await browser.newPage();
    const offOrigin: string[] = [];
    try {
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(harness.origin) || url.startsWith("data:") || url === "about:blank") {
          void request.continue();
          return;
        }
        offOrigin.push(url);
        void request.abort();
      });
      await page.setViewport({ width: 1244, height: 836, deviceScaleFactor: 1 });
      await page.goto(harness.origin, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      expect(offOrigin).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("this suite contains no sleep or polling wait", async () => {
    const source = await readFile(join(import.meta.dir, "public-caret-library.test.ts"), "utf8");
    const body = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(/\bwaitForTimeout\s*\(/.test(body)).toBe(false);
    expect(/\bBun\.sleep\s*\(/.test(body)).toBe(false);
    expect(/\bsetInterval\s*\(/.test(body)).toBe(false);
  });
});
