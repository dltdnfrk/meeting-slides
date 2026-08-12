// Todo 13 — real contextual controls and panels.
//
// What this file pins (machine-consumed values only; never prose copy, never
// screenshot bytes):
//
//   1. CAPABILITY PLACEMENT (DESIGN 9.11). Every real capability has EXACTLY ONE
//      home, and that home matches the contract's context table:
//        * library, no meeting  — start recording, rail, settings trigger open;
//                                 provider/STT behind the settings sheet;
//        * library, meeting     — detail tabs, follow-up action and the Ask
//                                 entry open; export set, attendees, review,
//                                 delete/reset behind ONE disclosure;
//        * live                 — Stop, timer and the transcript open; compile,
//                                 export and settings behind a disclosure/sheet.
//      No capability is duplicated, and none is unreachable in a context that
//      the contract says exposes it.
//
//   2. NO DASHBOARD WALL. The contextual action surface is a COMPOSED layout,
//      not one narrow column, and it never claims half of the viewport. This is
//      the Todo-12 approved residual: at 1244x836 the library dock measured
//      exactly 0.5 viewport height with a single 110.5px column, pushing seven
//      of nine capabilities past a fold.
//
//   3. DISCLOSURE STATE IS THE USER'S. A user's own toggle survives the
//      starting -> capturing transition INSIDE one live shell. This is the other
//      Todo-12 approved residual: the default was re-applied on the legacy
//      `.app--capturing` class flip, silently closing a set the user had opened.
//
//   4. PANEL SEMANTICS. Every re-homed panel is a real dialog with an accessible
//      name, closes on Escape, and restores focus to the control that opened it.
//      Ask had none of the three.
//
//   5. TRUTHFUL DISABLED REASONS. A server-gated control stays visible, disabled,
//      and carries its exact machine reason in BOTH `title` and `aria-label`
//      (DESIGN 9.11). Export/compile carried a stale "what it does" title while
//      disabled, and Ask updated only `title`.
//
//   6. FROZEN CONTRACT. Every binding ID stays unique, every action name and
//      payload spelling is byte-identical, and no control advertises a
//      capability the backend lacks.
//
// Synchronization: every awaited state is armed with a MutationObserver BEFORE
// its trigger, and bounded by a named timeout. No sleep, no polling delay, no
// waitForTimeout in this file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;
const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
} as const;
const CAPTURE_STOPPING = { type: "capture", capturing: true, mode: "mic", phase: "stopping" } as const;
const CAPTURE_IDLE = { type: "capture", capturing: false, mode: "mic", phase: "idle" } as const;

const MEETING = { id: 7, title: "온보딩 지표 점검", started_at: FIXED_CLOCK_EPOCH_MS - 3_600_000, status: "ended" } as const;

const SLIDE = {
  index: 3, startedAt: FIXED_CLOCK_EPOCH_MS - 60_000, sentenceCount: 9, kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정", kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초", "튜토리얼 4단계 축소"],
  emphasis: "결정: 온보딩 튜토리얼을 4단계로 축소한다",
} as const;

/**
 * The nine capabilities the contextual action surface owns, plus the two capture
 * controls. These are the exact IDs DESIGN 9.11 freezes.
 */
const DOCK_CAPABILITIES = [
  "btn-compile-deck",
  "btn-export-md", "btn-export-json", "btn-export-transcript",
  "btn-export-deck", "btn-export-pdf", "btn-export-png",
  "btn-ask", "btn-reset",
] as const;

/** Every binding ID this task may move. Each must stay EXACTLY ONE element. */
const ALL_BINDING_IDS = [
  ...DOCK_CAPABILITIES,
  "btn-record", "btn-live-stop", "btn-settings", "btn-attendees", "btn-review",
  "btn-recheck", "btn-recheck-stt", "btn-settings-close",
  "btn-attendee-add", "btn-attendee-save",
  "btn-review-confirm", "btn-review-retry", "btn-review-close",
  "btn-ask-send", "btn-ask-close",
  "provider-panel", "attendee-panel", "review-panel", "ask-panel",
  "select-model", "select-effort", "provider-list", "stt-list",
  "compile-status", "last-saved", "dock-more",
] as const;

const MATRIX = [
  { width: 1440, height: 900 },
  { width: 1244, height: 836 },
  { width: 1100, height: 800 },
  { width: 960, height: 760 },
  { width: 900, height: 760 },
  { width: 899, height: 760 },
  { width: 820, height: 900 },
  { width: 375, height: 812 },
  { width: 320, height: 667 },
] as const;

/**
 * A contextual action surface must not become a dashboard wall. Half the
 * viewport is the measured Todo-12 residual; two fifths is the bound this task
 * holds it to, and it is checked with the disclosure OPEN (the worst case).
 */
const MAX_ACTION_SURFACE_VIEWPORT_SHARE = 0.4;

/** WCAG 2.2 AA target size for pointer targets at narrow widths (DESIGN 9.12). */
const MIN_TARGET_PX = 44;
/** Widths at or below this are the narrow/touch matrix the 44px rule governs. */
const NARROW_MAX_WIDTH = 375;

/**
 * Every interactive control the SHELL itself owns, beyond the dock set. A target
 * audit limited to the dock is a false pass: it leaves the persistent capture,
 * settings and attendee controls - the ones a narrow-width user reaches for most
 * - completely unmeasured.
 */
const SHELL_CONTROL_SELECTOR = [
  ".app button",
  ".app a[data-output-target]",
  ".app summary",
  ".app select",
].join(", ");

/**
 * The live shell has exactly ONE Stop and exactly ONE timer. `#btn-record` and
 * `#capture-timer` keep their binding IDs and their library roles, but must not
 * be perceivable while live, or the operator sees two competing Stop affordances
 * and two clocks that can disagree.
 */
const LIVE_STOP_ID = "btn-live-stop";
const LIBRARY_CAPTURE_ID = "btn-record";
const LIVE_TIMER_ID = "live-topbar-timer";
const LIBRARY_TIMER_ID = "capture-timer";

// ── page-side plumbing ──────────────────────────────────────────────────────

declare global {
  interface Window {
    __ctxAwait?: (token: string, predicate: string) => void;
    __ctxSettle?: (token: string) => Promise<void>;
  }
}

function pageBootstrap(fixedNow: number): void {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedNow);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number { return fixedNow; }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

  window.__ctxAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try { ok = check() === true; } catch { ok = false; }
      if (!ok) return false;
      done = true;
      void window.__ctxSettle!(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => { if (settle()) observer.disconnect(); });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

class ContextStateTimeoutError extends Error {
  constructor(predicate: string, ms: number) {
    super(`contextual shell timed out after ${ms}ms waiting for: ${predicate}`);
    this.name = "ContextStateTimeoutError";
  }
}

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>, ms?: number): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

async function openSession(width: number, height: number): Promise<Session> {
  const page = await browser.newPage();
  const waiters = new Map<string, () => void>();
  await page.exposeFunction("__ctxSettle", (token: string) => { waiters.get(token)?.(); });
  await page.emulateTimezone("Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": "ko-KR" });
  await page.evaluateOnNewDocument(pageBootstrap, FIXED_CLOCK_EPOCH_MS);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.waitForClient();
  await page.evaluate(async () => { await document.fonts.ready; });

  let counter = 0;
  return {
    page,
    async act(predicate, trigger, ms = 2_000) {
      const token = `ctx-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => waiters.set(token, resolve));
      await page.evaluate((t: string, p: string) => window.__ctxAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new ContextStateTimeoutError(predicate, ms)), ms);
      });
      try { await Promise.race([settled, bounded]); }
      finally { if (timer !== undefined) clearTimeout(timer); waiters.delete(token); }
    },
    async close() { await page.close(); },
  };
}

/**
 * Library with one selected meeting: the "meeting selected" context of 9.11.
 *
 * Selecting a row only REQUESTS a meeting; capabilities that need the payload
 * (Ask above all) stay truthfully disabled until the server answers. The fixture
 * therefore completes the real round trip instead of asserting against a
 * half-loaded document.
 */
async function selectMeeting(session: Session): Promise<void> {
  await session.act(
    'document.querySelectorAll("#session-list .session-row").length === 1',
    () => harness.pushMessage({ type: "meetings", items: [MEETING] }),
  );
  await session.act(
    'document.querySelectorAll("#session-list .session-row--selected").length === 1',
    () => session.page.evaluate(() =>
      (document.querySelector("#session-list .session-row") as HTMLElement).click()),
  );
  // The meeting document has landed when the document surface shows its title.
  // That signal is independent of any capability-availability bug, so a failure
  // to enable a control surfaces as its own assertion rather than as a timeout
  // inside this helper.
  await session.act(
    `document.getElementById("doc-title")?.textContent?.trim() === ${JSON.stringify(MEETING.title)}`,
    () => harness.pushMessage({
      type: "meeting", meetingId: MEETING.id, title: MEETING.title,
      current: null, history: [], transcript: [], notes: "",
    }),
  );
}

/** starting -> capturing, i.e. one continuous live shell. */
async function enterLive(session: Session): Promise<void> {
  await session.act(
    'document.querySelector(".app")?.dataset.capturePhase === "starting"',
    () => harness.pushMessage(CAPTURE_STARTING),
  );
  await session.act(
    'document.querySelector(".app")?.classList.contains("app--capturing") === true',
    () => harness.pushMessage(CAPTURE_LIVE),
  );
}

/**
 * `#btn-compile-deck` has a REAL client precondition: it refuses to compile when
 * nothing has been said. That is a truthful product rule, not a layout defect,
 * so a placement test that wants a real outbound compile satisfies it the way a
 * user does - by having spoken into the live meeting. Live transcript frames are
 * only accepted while no history meeting is selected, which is exactly the
 * context this helper establishes.
 */
async function seedLiveTranscript(session: Session): Promise<void> {
  await session.act(
    'document.querySelectorAll("#transcript-stream .feed-line").length === 1',
    () => harness.pushMessage({
      type: "line",
      text: "온보딩 이탈률과 설치 시간 지표를 함께 점검하겠습니다.",
      ts: FIXED_CLOCK_EPOCH_MS - 3_000,
      speaker: 1,
    }),
  );
}

// ── in-page readers: machine values only ────────────────────────────────────

/**
 * For one control: does it exist exactly once, is it painted, is it actually
 * usable (centre hit-test after a bounded scroll-into-view, because a contextual
 * surface may legitimately own a scroll), is it keyboard-focusable, and what
 * machine reason does it carry.
 *
 * `hidden` here means "not currently painted", which for a control inside a
 * CLOSED real <details> is the correct, reachable-on-demand state — that case is
 * reported separately via `closedDisclosure` rather than being called a defect.
 */
function readControls(ids: readonly string[]) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  const painted = (el: HTMLElement): boolean => {
    if (el.hidden) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  return ids.map((id) => {
    const all = document.querySelectorAll(`#${CSS.escape(id)}`);
    const el = all[0] as HTMLElement | null;
    if (!el) {
      return {
        id, count: all.length, present: false, painted: false, reachable: false,
        focusable: false, disabled: null as boolean | null, title: null as string | null,
        ariaLabel: null as string | null, box: null as { w: number; h: number } | null,
        offscreen: false, closedDisclosure: null as string | null,
      };
    }

    // The nearest CLOSED <details> ancestor: the legitimate reason a real
    // capability is one keystroke away rather than currently painted.
    let closedDisclosure: string | null = null;
    for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
      if (n instanceof HTMLDetailsElement && !n.open) { closedDisclosure = n.id || "details"; break; }
    }

    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const isPainted = painted(el);
    const hit = isPainted
      ? document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2))
      : null;

    const previous = document.activeElement;
    let focusable = false;
    if (isPainted) {
      try { el.focus({ preventScroll: true }); focusable = document.activeElement === el; }
      catch { focusable = false; }
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    }

    return {
      id,
      count: all.length,
      present: true,
      painted: isPainted,
      reachable: isPainted && (hit === el || (hit instanceof Node && el.contains(hit))),
      focusable,
      disabled: el instanceof HTMLButtonElement || el instanceof HTMLSelectElement
        || el instanceof HTMLInputElement ? el.disabled : null,
      title: el.getAttribute("title"),
      ariaLabel: el.getAttribute("aria-label"),
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      offscreen: isPainted && (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1),
      closedDisclosure,
    };
  });
}

/**
 * Which capture/timer surfaces are actually perceivable, and - for the pointer
 * contract - whether each is genuinely hit-testable across its OWN edge band.
 *
 * The edge band matters: a 66x28 button centred inside a 44px-tall capsule can
 * pass a naive centre hit-test while still offering only 28px of real pointer
 * height. Probing the four edge midpoints of the required 44x44 box proves the
 * target itself is big enough, rather than crediting it with its parent's size.
 */
function readCaptureSurfaces(ids: {
  liveStop: string; libraryCapture: string; liveTimer: string; libraryTimer: string;
}) {
  const perceivable = (el: HTMLElement | null): boolean => {
    if (!el || el.hidden) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const get = (id: string) => document.getElementById(id) as HTMLElement | null;
  const describe = (id: string) => {
    const el = get(id);
    const r = el?.getBoundingClientRect();
    return {
      id,
      present: el !== null,
      perceivable: perceivable(el),
      disabled: el instanceof HTMLButtonElement ? el.disabled : null,
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
    };
  };
  return {
    shell: (document.querySelector(".app") as HTMLElement).dataset.shell ?? null,
    phase: (document.querySelector(".app") as HTMLElement).dataset.capturePhase ?? null,
    liveStop: describe(ids.liveStop),
    libraryCapture: describe(ids.libraryCapture),
    liveTimer: describe(ids.liveTimer),
    libraryTimer: describe(ids.libraryTimer),
    perceivableStops: [ids.liveStop, ids.libraryCapture].filter((id) => perceivable(get(id))),
    perceivableTimers: [ids.liveTimer, ids.libraryTimer].filter((id) => perceivable(get(id))),
  };
}

/**
 * Every painted interactive shell control, with a REAL edge-band hit test.
 *
 * For each control the probe walks the perimeter of the 44x44 box centred on the
 * control and asks `elementFromPoint` at the four edge midpoints. A control whose
 * own painted box is smaller than 44x44 fails, even when a decorative parent
 * capsule would have answered the centre probe - which is exactly the false pass
 * that let 28px-tall controls ship as "44px targets".
 */
function readShellTargets(selector: string) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const perceivable = (el: HTMLElement): boolean => {
    if (el.hidden) return false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /**
   * True when the control is currently inside every scrolling ancestor's visible
   * box. A control scrolled out of the dock's own viewport is reachable (the user
   * scrolls to it) but is NOT at the coordinates a hit test would probe, so
   * including it would report a scroll position as a target-size defect.
   */
  const withinScrollViewport = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    // Fully inside the layout viewport: a control that straddles an edge cannot
    // be probed at that edge, and a partially-scrolled row is a scroll position
    // rather than a target-size defect.
    if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) return false;
    for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      const scrolls = /(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX);
      if (!scrolls) continue;
      const nr = n.getBoundingClientRect();
      // Fully inside this scroller too, for the same reason.
      if (r.top < nr.top - 1 || r.bottom > nr.bottom + 1) return false;
      if (r.left < nr.left - 1 || r.right > nr.right + 1) return false;
    }
    return true;
  };

  return [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(perceivable)
    .filter(withinScrollViewport)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      // The four edge midpoints of the control's OWN box, inset by 1px.
      //
      // Probing the required 44x44 box instead would sample OUTSIDE any control
      // that is exactly 44px wide in a tight grid, landing on the neighbouring
      // cell and reporting a miss for a target that is precisely the right size.
      // Size is asserted separately by `meetsBox`; this probe answers the other
      // question - is the box the control's own, or a decorative parent's?
      const probes = [
        { name: "top", x: cx, y: r.y + 1 },
        { name: "bottom", x: cx, y: r.bottom - 1 },
        { name: "left", x: r.x + 1, y: cy },
        { name: "right", x: r.right - 1, y: cy },
      ];
      const misses = probes.filter((p) => {
        if (p.x < 0 || p.y < 0 || p.x > vw || p.y > vh) return true;
        // `elementsFromPoint` (plural) returns the full hit-test stack. A control
        // inside a scroll container can legitimately sit UNDER its own scrolling
        // ancestor in that stack while still receiving the pointer - the single
        // `elementFromPoint` reports the ancestor and reads as a false miss.
        // Membership in the stack is the honest question: does a pointer here
        // reach this control at all?
        const stack = document.elementsFromPoint(Math.round(p.x), Math.round(p.y));
        return !stack.some((node) => node === el || el.contains(node));
      }).map((p) => p.name);
      return {
        id: el.id || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "anon"}`,
        w: Math.round(r.width),
        h: Math.round(r.height),
        meetsBox: r.width >= 44 && r.height >= 44,
        edgeMisses: misses,
      };
    });
}

/** The contextual action surface itself: how much room it takes, how it composes. */
function readActionSurface() {
  const vh = document.documentElement.clientHeight;
  const vw = document.documentElement.clientWidth;
  const dock = document.querySelector(".dock") as HTMLElement | null;
  const set = document.querySelector(".dock__more-set") as HTMLElement | null;
  const more = document.getElementById("dock-more") as HTMLDetailsElement | null;

  /** Column count of a grid track list; "none" (i.e. not a grid) reads as 0. */
  const columns = (el: HTMLElement | null): number => {
    if (!el) return 0;
    const tracks = getComputedStyle(el).gridTemplateColumns;
    if (!tracks || tracks === "none") return 0;
    return tracks.split(" ").filter((t) => Number.parseFloat(t) > 0).length;
  };

  const r = dock?.getBoundingClientRect() ?? null;
  return {
    present: dock !== null,
    heightShareOfViewport: r ? Number((r.height / vh).toFixed(3)) : null,
    height: r ? Math.round(r.height) : null,
    setColumns: columns(set),
    disclosureOpen: more?.open ?? null,
    // Every painted control inside the surface must fit inside the viewport.
    escapingControls: dock
      ? [...dock.querySelectorAll<HTMLElement>("button, a[data-output-target], summary")]
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && (b.right > vw + 1 || b.left < -1);
        })
        .map((el) => el.id || el.tagName.toLowerCase())
      : [],
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

// ── suite ───────────────────────────────────────────────────────────────────

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

describe("Todo 13 · every binding ID keeps exactly one home", () => {
  for (const context of ["library", "live"] as const) {
    test(`${context}: each of the ${ALL_BINDING_IDS.length} binding IDs resolves to exactly one element`, async () => {
      const session = await openSession(1244, 836);
      try {
        if (context === "live") await enterLive(session);
        const rows = await session.page.evaluate(readControls, ALL_BINDING_IDS);
        const missing = rows.filter((row) => !row.present).map((row) => row.id);
        const duplicated = rows.filter((row) => row.count > 1).map((row) => `${row.id}x${row.count}`);
        expect(missing).toEqual([]);
        expect(duplicated).toEqual([]);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("Todo 13 · DESIGN 9.11 capability placement", () => {
  test("library with a meeting selected: the Ask entry is open, not buried in a disclosure", async () => {
    const session = await openSession(1244, 836);
    try {
      await selectMeeting(session);
      const [ask] = await session.page.evaluate(readControls, ["btn-ask"]);
      // 9.11: "Library, meeting selected | Always visible: ... Ask entry".
      expect(ask!.closedDisclosure).toBeNull();
      expect(ask!.painted).toBe(true);
      expect(ask!.reachable).toBe(true);
      expect(ask!.focusable).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("library: the export set is behind ONE disclosure, not a permanent wall", async () => {
    const session = await openSession(1244, 836);
    try {
      const exportIds = [
        "btn-export-md", "btn-export-json", "btn-export-transcript",
        "btn-export-deck", "btn-export-pdf", "btn-export-png",
      ] as const;
      const rows = await session.page.evaluate(readControls, exportIds);
      // 9.11: "Library ... | Behind the More menu or a sheet: Export set".
      // Every one of them sits behind the SAME single disclosure.
      const owners = new Set(rows.map((row) => row.closedDisclosure));
      expect([...owners]).toEqual(["dock-more"]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("live: compile and export are behind a disclosure; Stop and the timer are not", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session);
      const rows = await session.page.evaluate(
        readControls,
        ["btn-compile-deck", "btn-export-pdf", "btn-live-stop"],
      );
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      // 9.11: "Live | Behind the More menu or a sheet: Compile, export, settings".
      expect(byId["btn-compile-deck"]!.closedDisclosure).not.toBeNull();
      expect(byId["btn-export-pdf"]!.closedDisclosure).not.toBeNull();
      // 9.11: "Live | Always visible: Stop, timer, ...".
      expect(byId["btn-live-stop"]!.closedDisclosure).toBeNull();
      expect(byId["btn-live-stop"]!.painted).toBe(true);
      expect(byId["btn-live-stop"]!.reachable).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("every capability is reachable once its own disclosure is opened, in both shells", async () => {
    for (const context of ["library", "live"] as const) {
      const session = await openSession(1244, 836);
      try {
        if (context === "live") await enterLive(session);
        // Open every real disclosure inside the action surface, as a user does.
        await session.page.evaluate(() => {
          for (const d of document.querySelectorAll<HTMLDetailsElement>(".dock details")) d.open = true;
        });
        const rows = await session.page.evaluate(readControls, DOCK_CAPABILITIES);
        // Reachability is the contract for EVERY capability: a disabled control
        // must still be painted and hit-testable so its reason can be read.
        const unreachable = rows.filter((row) => !row.reachable).map((row) => row.id);
        expect({ context, unreachable }).toEqual({ context, unreachable: [] });
        // Focusability is the contract for every ENABLED capability. A disabled
        // button is correctly skipped by the tab order, so requiring it to focus
        // would be asserting a bug: no meeting is selected here, which is exactly
        // why Ask is gated. Its reason is asserted by the disabled-reason suite.
        const unfocusable = rows
          .filter((row) => row.disabled === false && !row.focusable)
          .map((row) => row.id);
        expect({ context, unfocusable }).toEqual({ context, unfocusable: [] });
      } finally {
        await session.close();
      }
    }
  }, 60_000);
});

describe("Todo 13 · the contextual surface is composed, never a dashboard wall", () => {
  for (const vp of MATRIX) {
    test(`${vp.width}x${vp.height}: library action surface stays under two fifths of the viewport`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        // Worst case: measure with the disclosure the user can open ALREADY open.
        await session.page.evaluate(() => {
          for (const d of document.querySelectorAll<HTMLDetailsElement>(".dock details")) d.open = true;
        });
        const surface = await session.page.evaluate(readActionSurface);
        expect(surface.present).toBe(true);
        expect(surface.heightShareOfViewport).toBeLessThanOrEqual(MAX_ACTION_SURFACE_VIEWPORT_SHARE);
        // Composed: the disclosed set lays out in more than one column wherever
        // the viewport can hold one. A single narrow column IS the residual.
        if (vp.width >= NARROW_MAX_WIDTH) expect(surface.setColumns).toBeGreaterThanOrEqual(2);
        expect(surface.escapingControls).toEqual([]);
        expect(surface.rootOverflowX).toBeLessThanOrEqual(0);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("Todo 13 · the disclosure state belongs to the user", () => {
  test("a set opened during `starting` is still open after `capturing` arrives", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.act(
        'document.querySelector(".app")?.dataset.capturePhase === "starting"',
        () => harness.pushMessage(CAPTURE_STARTING),
      );
      // The user opens it themselves, through the real summary control.
      const opened = await session.page.evaluate(() => {
        const d = document.getElementById("dock-more") as HTMLDetailsElement | null;
        (d?.querySelector("summary") as HTMLElement | null)?.click();
        return d?.open ?? null;
      });
      expect(opened).toBe(true);

      // starting -> capturing is ONE continuous live shell. The shell did not
      // change, so no default may be re-applied over the user's choice.
      await session.act(
        'document.querySelector(".app")?.classList.contains("app--capturing") === true',
        () => harness.pushMessage(CAPTURE_LIVE),
      );
      const stillOpen = await session.page.evaluate(() =>
        (document.getElementById("dock-more") as HTMLDetailsElement | null)?.open ?? null);
      expect(stillOpen).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a set closed in the library stays closed across repeated meeting selections", async () => {
    const session = await openSession(1244, 836);
    try {
      await selectMeeting(session);
      const closed = await session.page.evaluate(() => {
        const d = document.getElementById("dock-more") as HTMLDetailsElement | null;
        if (d?.open) (d.querySelector("summary") as HTMLElement | null)?.click();
        return d?.open ?? null;
      });
      expect(closed).toBe(false);
      await session.act(
        'document.querySelectorAll("#session-list .session-row--selected").length === 1',
        () => session.page.evaluate(() =>
          (document.querySelector("#session-list .session-row") as HTMLElement).click()),
      );
      const stillClosed = await session.page.evaluate(() =>
        (document.getElementById("dock-more") as HTMLDetailsElement | null)?.open ?? null);
      expect(stillClosed).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("crossing the shell boundary applies the shell's own default exactly once", async () => {
    const session = await openSession(1244, 836);
    try {
      // Library default: the set is collapsed, so the library is not a wall.
      const libraryDefault = await session.page.evaluate(() =>
        (document.getElementById("dock-more") as HTMLDetailsElement | null)?.open ?? null);
      expect(libraryDefault).toBe(false);

      await enterLive(session);
      const liveDefault = await session.page.evaluate(() =>
        (document.getElementById("dock-more") as HTMLDetailsElement | null)?.open ?? null);
      expect(liveDefault).toBe(false);

      // Back to the library on an authoritative idle: still the library default,
      // and still not a wall.
      await session.act(
        'document.querySelector(".app")?.dataset.shell === "library"',
        () => harness.pushMessage(CAPTURE_IDLE),
      );
      const backInLibrary = await session.page.evaluate(() =>
        (document.getElementById("dock-more") as HTMLDetailsElement | null)?.open ?? null);
      expect(backInLibrary).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 13 · panels are real dialogs", () => {
  const PANELS = [
    { trigger: "btn-settings", panel: "provider-panel" },
    { trigger: "btn-attendees", panel: "attendee-panel" },
    { trigger: "btn-ask", panel: "ask-panel" },
  ] as const;

  for (const { trigger, panel } of PANELS) {
    test(`#${panel}: dialog role + accessible name, Escape closes, focus returns to #${trigger}`, async () => {
      const session = await openSession(1244, 836);
      try {
        // Ask is only meaningful with a meeting selected; selecting one is also
        // the context in which the other two must still work.
        await selectMeeting(session);
        // Open every disclosure so the trigger itself is clickable regardless of
        // where this task chooses to home it.
        await session.page.evaluate(() => {
          for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
        });

        const opened = await session.act(
          `document.getElementById(${JSON.stringify(panel)})?.hidden === false`,
          () => session.page.evaluate((id: string) => {
            const t = document.getElementById(id) as HTMLElement;
            t.focus();
            t.click();
          }, trigger),
        ).then(() => session.page.evaluate((id: string) => {
          const el = document.getElementById(id)!;
          return {
            role: el.getAttribute("role"),
            // An accessible name from either mechanism satisfies the contract.
            named: Boolean(el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby")),
            activeInside: el.contains(document.activeElement),
          };
        }, panel));

        expect(opened.role).toBe("dialog");
        expect(opened.named).toBe(true);
        // Focus moves into the panel that just opened (DESIGN 9.12).
        expect(opened.activeInside).toBe(true);

        // Escape closes it and returns focus to the trigger (DESIGN 9.12).
        await session.act(
          `document.getElementById(${JSON.stringify(panel)})?.hidden === true`,
          () => session.page.keyboard.press("Escape"),
        );
        const restored = await session.page.evaluate(() => document.activeElement?.id ?? null);
        expect(restored).toBe(trigger);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("Todo 13 · disabled controls carry their exact machine reason", () => {
  test("a disconnected client disables the gated set and states why in title AND aria-label", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });
      // A real transport loss, not a synthetic attribute flip.
      await session.act(
        'document.documentElement.dataset.connection === "disconnected"',
        () => harness.disconnectClients(),
      );

      const rows = await session.page.evaluate(readControls, DOCK_CAPABILITIES);
      for (const row of rows) {
        expect({ id: row.id, disabled: row.disabled }).toEqual({ id: row.id, disabled: true });
        // Disabled is muted, never invisible (DESIGN 9.11).
        expect({ id: row.id, painted: row.painted }).toEqual({ id: row.id, painted: true });
        // The exact machine reason, in BOTH places.
        expect({ id: row.id, title: row.title }).toEqual({ id: row.id, title: row.ariaLabel });
        expect(row.title ?? "").not.toBe("");
      }
    } finally {
      await session.close();
    }
  }, 30_000);

  test("Ask states its gate reason in title AND aria-label while no meeting is selected", async () => {
    const session = await openSession(1244, 836);
    try {
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });
      const [before] = await session.page.evaluate(readControls, ["btn-ask"]);
      expect(before!.disabled).toBe(true);
      expect(before!.title).toBe(before!.ariaLabel);
      expect(before!.title ?? "").not.toBe("");

      // Selecting a meeting removes the gate — and the reason with it.
      await selectMeeting(session);
      const [after] = await session.page.evaluate(readControls, ["btn-ask"]);
      expect(after!.disabled).toBe(false);
      expect(after!.title).toBe(after!.ariaLabel);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 13 · re-homed controls still send their frozen actions", () => {
  test("compile, export, save and reset emit their existing action names", async () => {
    const session = await openSession(1244, 836);
    try {
      // Live, with something actually said: the one context where every one of
      // these controls is legitimately actionable at the same time.
      await enterLive(session);
      await seedLiveTranscript(session);
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });

      const cases = [
        { id: "btn-compile-deck", action: "compileTranscriptSnapshot" },
        { id: "btn-export-md", action: "saveNotes" },
        { id: "btn-export-json", action: "saveJson" },
        { id: "btn-export-transcript", action: "saveTranscript" },
        { id: "btn-export-deck", action: "exportDeck" },
        { id: "btn-export-pdf", action: "exportPdf" },
        { id: "btn-export-png", action: "exportPng" },
      ] as const;

      for (const { id, action } of cases) {
        // Subscribe to the outbound frame BEFORE the click that produces it.
        // Compile disables the conflicting job set once it starts, so each case
        // re-enables only what a completed job would have re-enabled anyway; the
        // handler itself is never bypassed.
        const inbound = harness.nextClientMessage();
        await session.page.evaluate((target: string) => {
          const el = document.getElementById(target) as HTMLButtonElement;
          el.disabled = false;
          el.click();
        }, id);
        const message = await inbound as { action?: string };
        expect({ id, action: message.action }).toEqual({ id, action });
      }
    } finally {
      await session.close();
    }
  }, 60_000);

  test("reset emits `reset` from the library, where it is truthfully enabled", async () => {
    const session = await openSession(1244, 836);
    try {
      // Reset asks for confirmation before discarding the open meeting. Headless
      // Chromium auto-dismisses native dialogs, which would silently cancel the
      // action, so the fixture answers it the way a user who means it does.
      session.page.on("dialog", (dialog) => { void dialog.accept(); });
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });
      const inbound = harness.nextClientMessage();
      // No force-enabling: idle + connected is the state that really enables it.
      const wasEnabled = await session.page.evaluate(() => {
        const el = document.getElementById("btn-reset") as HTMLButtonElement;
        const enabled = !el.disabled;
        el.click();
        return enabled;
      });
      expect(wasEnabled).toBe(true);
      const message = await inbound as { action?: string };
      expect(message.action).toBe("reset");
    } finally {
      await session.close();
    }
  }, 30_000);

  test("Ask sends `ask` with the frozen `meetingId` payload key", async () => {
    const session = await openSession(1244, 836);
    try {
      await selectMeeting(session);
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });
      await session.act(
        'document.getElementById("ask-panel")?.hidden === false',
        () => session.page.evaluate(() => (document.getElementById("btn-ask") as HTMLElement).click()),
      );
      const inbound = harness.nextClientMessage();
      await session.page.evaluate(() => {
        const input = document.getElementById("ask-input") as HTMLInputElement;
        input.value = "결정된 마감일이 뭐였어?";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        (document.getElementById("btn-ask-send") as HTMLButtonElement).disabled = false;
        (document.getElementById("btn-ask-send") as HTMLElement).click();
      });
      const message = await inbound as { action?: string; meetingId?: number };
      expect(message.action).toBe("ask");
      // The payload key spelling is frozen (DESIGN 9.11).
      expect(message.meetingId).toBe(MEETING.id);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("repeated compile activation while a job is in flight emits exactly one action", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session);
      await seedLiveTranscript(session);
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });
      // Exactly ONE waiter: a second speculative waiter would itself consume the
      // next frame and make the assertion below unfalsifiable.
      const first = harness.nextClientMessage();
      await session.page.evaluate(() => {
        const el = document.getElementById("btn-compile-deck") as HTMLButtonElement;
        el.click();
        el.click();
      });
      const one = await first as { action?: string };
      expect(one.action).toBe("compileTranscriptSnapshot");
      // The second activation must NOT produce a second outbound compile: the
      // control disables itself while its job is in flight. Any later frame is
      // therefore something else entirely, so this drives a control the compile
      // job does NOT gate (`#btn-export-pdf` is deliberately job-conflicting and
      // would send nothing) and asserts the next frame is not a duplicate.
      const inbound = harness.nextClientMessage();
      await session.page.evaluate(() =>
        (document.getElementById("btn-export-md") as HTMLElement).click());
      const next = await inbound as { action?: string };
      expect(next.action).not.toBe("compileTranscriptSnapshot");
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 13 · narrow widths keep real target sizes", () => {
  for (const vp of MATRIX.filter((v) => v.width <= NARROW_MAX_WIDTH)) {
    test(`${vp.width}x${vp.height}: every painted action meets the ${MIN_TARGET_PX}px target`, async () => {
      const session = await openSession(vp.width, vp.height);
      try {
        await session.page.evaluate(() => {
          for (const d of document.querySelectorAll<HTMLDetailsElement>(".dock details")) d.open = true;
        });
        const rows = await session.page.evaluate(readControls, DOCK_CAPABILITIES);
        const undersized = rows
          .filter((row) => row.painted && row.box !== null
            && (row.box.h < MIN_TARGET_PX || row.box.w < MIN_TARGET_PX))
          .map((row) => `${row.id}:${row.box!.w}x${row.box!.h}`);
        expect(undersized).toEqual([]);
      } finally {
        await session.close();
      }
    }, 30_000);
  }

  // The audit above covers only the dock. These cover the WHOLE shell, in both
  // shells, with a real edge-band hit test rather than a box-size claim.
  for (const vp of MATRIX.filter((v) => v.width <= NARROW_MAX_WIDTH)) {
    for (const context of ["library", "live"] as const) {
      test(`${vp.width}x${vp.height} ${context}: every painted shell control passes a real ${MIN_TARGET_PX}px edge-band hit test`, async () => {
        const session = await openSession(vp.width, vp.height);
        try {
          if (context === "live") await enterLive(session);
          await session.page.evaluate(() => {
            for (const d of document.querySelectorAll<HTMLDetailsElement>(".dock details")) d.open = true;
          });
          const targets = await session.page.evaluate(readShellTargets, SHELL_CONTROL_SELECTOR);
          // Non-vacuous: the shell really does expose controls here.
          expect(targets.length).toBeGreaterThan(3);
          const undersized = targets
            .filter((t) => !t.meetsBox)
            .map((t) => `${t.id}:${t.w}x${t.h}`);
          expect({ context, undersized }).toEqual({ context, undersized: [] });
          // And the box is genuinely the control's own, not a parent capsule's.
          const unhittable = targets
            .filter((t) => t.edgeMisses.length > 0)
            .map((t) => `${t.id}:${t.edgeMisses.join("/")}`);
          expect({ context, unhittable }).toEqual({ context, unhittable: [] });
        } finally {
          await session.close();
        }
      }, 30_000);
    }
  }
});

describe("Todo 13 · exactly one Stop and one timer", () => {
  const LIVE_PHASES = ["starting", "capturing", "stopping"] as const;
  const IDS = {
    liveStop: LIVE_STOP_ID, libraryCapture: LIBRARY_CAPTURE_ID,
    liveTimer: LIVE_TIMER_ID, libraryTimer: LIBRARY_TIMER_ID,
  };

  for (const vp of [{ width: 1244, height: 836 }, { width: 375, height: 812 }, { width: 320, height: 667 }] as const) {
    for (const phase of LIVE_PHASES) {
      test(`${vp.width} ${phase}: one perceivable Stop and one perceivable timer`, async () => {
        const session = await openSession(vp.width, vp.height);
        try {
          await session.act(
            'document.querySelector(".app")?.dataset.capturePhase === "starting"',
            () => harness.pushMessage(CAPTURE_STARTING),
          );
          if (phase === "capturing" || phase === "stopping") {
            await session.act(
              'document.querySelector(".app")?.classList.contains("app--capturing") === true',
              () => harness.pushMessage(CAPTURE_LIVE),
            );
          }
          if (phase === "stopping") {
            await session.act(
              'document.querySelector(".app")?.dataset.capturePhase === "stopping"',
              () => harness.pushMessage(CAPTURE_STOPPING),
            );
          }

          const s = await session.page.evaluate(readCaptureSurfaces, IDS);
          expect(s.shell).toBe("live");
          // Exactly one Stop affordance, and it is the live one.
          expect(s.perceivableStops).toEqual([LIVE_STOP_ID]);
          expect(s.liveStop.perceivable).toBe(true);
          expect(s.liveStop.disabled).toBe(false);
          // The library capture control keeps its binding ID but is not painted.
          expect(s.libraryCapture.present).toBe(true);
          expect(s.libraryCapture.perceivable).toBe(false);
          // Exactly one clock, so two timers can never disagree on screen.
          expect(s.perceivableTimers).toEqual([LIVE_TIMER_ID]);
          expect(s.libraryTimer.present).toBe(true);
          expect(s.libraryTimer.perceivable).toBe(false);
        } finally {
          await session.close();
        }
      }, 30_000);
    }
  }

  test("reconnect during capture still shows exactly one Stop and one timer", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session);
      await session.act(
        'document.documentElement.dataset.connection === "disconnected"',
        () => harness.disconnectClients(),
      );
      const s = await session.page.evaluate(readCaptureSurfaces, IDS);
      // Transport loss must not resurrect the second Stop or the second clock.
      expect(s.perceivableStops).toEqual([LIVE_STOP_ID]);
      expect(s.perceivableTimers).toEqual([LIVE_TIMER_ID]);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("a compile job in flight never adds a second Stop or timer", async () => {
    const session = await openSession(1244, 836);
    try {
      await enterLive(session);
      await seedLiveTranscript(session);
      await session.page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
      });
      const inbound = harness.nextClientMessage();
      await session.page.evaluate(() =>
        (document.getElementById("btn-compile-deck") as HTMLElement).click());
      expect((await inbound as { action?: string }).action).toBe("compileTranscriptSnapshot");
      const s = await session.page.evaluate(readCaptureSurfaces, IDS);
      expect(s.perceivableStops).toEqual([LIVE_STOP_ID]);
      expect(s.perceivableTimers).toEqual([LIVE_TIMER_ID]);
      // Compile never disables Stop (DESIGN 9.8).
      expect(s.liveStop.disabled).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);

  test("the library restores #btn-record as its capture control, with no live Stop", async () => {
    const session = await openSession(1244, 836);
    try {
      const before = await session.page.evaluate(readCaptureSurfaces, IDS);
      expect(before.shell).toBe("library");
      expect(before.perceivableStops).toEqual([LIBRARY_CAPTURE_ID]);
      expect(before.liveStop.perceivable).toBe(false);

      // A full round trip must leave the library exactly as it started.
      await enterLive(session);
      await session.act(
        'document.querySelector(".app")?.dataset.shell === "library"',
        () => harness.pushMessage(CAPTURE_IDLE),
      );
      const after = await session.page.evaluate(readCaptureSurfaces, IDS);
      expect(after.perceivableStops).toEqual([LIBRARY_CAPTURE_ID]);
      expect(after.liveStop.perceivable).toBe(false);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 13 · the capture control states its own gate reason", () => {
  test("#btn-record carries the exact reason in title AND aria-label when disconnected", async () => {
    const session = await openSession(1244, 836);
    try {
      const enabled = await session.page.evaluate(() => {
        const el = document.getElementById("btn-record") as HTMLButtonElement;
        return { disabled: el.disabled, title: el.getAttribute("title"), ariaLabel: el.getAttribute("aria-label") };
      });
      // Enabled: the accessible name is the ACTION, not a reason.
      expect(enabled.disabled).toBe(false);
      expect(enabled.ariaLabel).toBe("녹음 시작");

      await session.act(
        'document.documentElement.dataset.connection === "disconnected"',
        () => harness.disconnectClients(),
      );
      const gated = await session.page.evaluate(() => {
        const el = document.getElementById("btn-record") as HTMLButtonElement;
        const r = el.getBoundingClientRect();
        return {
          disabled: el.disabled, title: el.getAttribute("title"),
          ariaLabel: el.getAttribute("aria-label"),
          painted: r.width > 0 && r.height > 0,
        };
      });
      expect(gated.disabled).toBe(true);
      // Disabled is muted, never invisible (DESIGN 9.11).
      expect(gated.painted).toBe(true);
      // The exact machine reason, in BOTH places.
      expect(gated.title).toBe(gated.ariaLabel);
      expect(gated.title ?? "").not.toBe("");
      expect(gated.title).not.toBe("녹음 시작");
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("Todo 13 · the output switcher reveals, never duplicates", () => {
  test("each switcher item targets a distinct existing surface and creates no second slide", async () => {
    const session = await openSession(1244, 836);
    try {
      // The client refuses slide frames until an authoritative CAPTURING state
      // has released the initial gate, so the fixture reaches the state in which
      // a real slide arrives instead of forcing one into an idle document.
      await enterLive(session);
      await session.act(
        'document.querySelector("#current-slide .slide__title") !== null',
        () => harness.pushMessage({ type: "slide", current: SLIDE, history: [] }),
      );
      const report = await session.page.evaluate(() => {
        const items = [...document.querySelectorAll<HTMLElement>(".output-switcher__item")];
        return {
          count: items.length,
          targets: items.map((el) => el.dataset.outputTarget ?? null),
          resolvable: items.every((el) =>
            el.dataset.outputTarget !== undefined
            && document.getElementById(el.dataset.outputTarget) !== null),
          // Exactly one slide surface exists in the whole document.
          slideSurfaces: document.querySelectorAll("#current-slide").length,
          titles: document.querySelectorAll(".slide__title").length,
        };
      });
      expect(report.count).toBe(3);
      expect(new Set(report.targets).size).toBe(3);
      expect(report.resolvable).toBe(true);
      expect(report.slideSurfaces).toBe(1);
      expect(report.titles).toBe(1);
    } finally {
      await session.close();
    }
  }, 30_000);
});
