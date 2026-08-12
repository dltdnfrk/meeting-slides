// F1 repair — the three independent visual-fidelity defects recorded in
// `.omo/evidence/caret-clone-redesign/final/f1-repair/reviews/visual/REPORT.md`.
//
// Each assertion here reproduces one defect as a MACHINE-CONSUMED geometric or
// DOM fact. Nothing in this file pins prose: the only string comparisons are
// accessible names (DESIGN.md 9.12 explicitly makes those a contract) and
// element identity. Truncation is measured as `scrollWidth > clientWidth` on
// the text-bearing node, never as a screenshot diff.
//
//   V1  `#island` (the provisional caption row) is a `flex: 0 0 auto` child of
//       `#stage-pane` with the default `min-width: auto`. At >= 900px the stage
//       occupies only grid column 1 of the live `#document-surface`, so a long
//       Korean/English provisional caption inflates the island past its flex
//       container: measured 902.4px wide at x=-133.7 inside a 635px stage. It
//       therefore shears at BOTH edges — glyphs cut at x<0 on the left and the
//       row running under the transcript pane on the right — and leaves
//       `#stage-pane` with 150px of its own overflow.
//
//       The review attributed this to missing grid placement on a direct child
//       of `#document-surface`. The runtime parent chain proves otherwise
//       (island -> stage-pane -> document-surface), so this file asserts the
//       measured containment fact rather than that hypothesis: the island stays
//       inside the pane that owns it and neither it nor its text overflows.
//       Contract: DESIGN.md 9.9 (no partial glyph) and 9.4 rank 3/5 (supporting
//       content must not collide with the document surface).
//
//   V2  `#btn-review` renders as a 44x44 control with ZERO rendered content at
//       <= 420px: its only visible child (`.review-btn__label`) is hidden by a
//       media query and the `.review-btn__icon` the stylesheet targets does not
//       exist in the markup. Contract: DESIGN.md 9.12 (an icon-only control
//       keeps an accessible name — but it must still be an icon).
//
//   V3  At 320px `.action-card__head` stays a single non-wrapping flex row whose
//       `.action-card__actions` group is `flex-shrink: 0`. The command group
//       therefore keeps its full intrinsic width and crushes the text column
//       that owns the card's title and description to a ragged sliver (measured
//       81px of a 254px content box, under a third), so "Send follow-up" and the
//       Korean description fragment across lines and the commands are pushed to
//       the card's right edge. Contract: DESIGN.md 9.9 (nothing at 320 may be
//       reduced to a partial/illegible label) and 9.13 (a real capability must
//       be legible in the surface where the action lives).
//
// Synchronization: every awaited client state is armed with a MutationObserver
// BEFORE its trigger frame is pushed and bounded by a named timeout. There is
// no sleep, no polling delay and no waitForTimeout in this file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness, type PublicTestHarness } from "./public-test-harness.ts";

const FIXED_CLOCK_EPOCH_MS = 1_710_376_860_000;
const FIXED_CAPTURE_STARTED_AT = FIXED_CLOCK_EPOCH_MS - 125_000;

/**
 * The long mixed Korean/English provisional caption named by the repair task.
 * V1 is content-length dependent: a short caption renders as a clean centered
 * pill and would falsely confirm a fix, which is exactly how the defect was
 * missed by the task-18 static sweep.
 */
const LONG_PROVISIONAL_CAPTION =
  "온보딩 이탈률과 설치 시간 지표를 함께 점검하면서 다음 스프린트의 범위를 확정하겠습니다. " +
  "금요일 배포는 민수가 담당합니다. QA 마감은 수요일 18시입니다. beta channel opens Thursday " +
  "and the release notes are owned by Minsu, with the rollback window kept at thirty minutes.";

const SLIDE = {
  index: 3,
  startedAt: FIXED_CLOCK_EPOCH_MS - 60_000,
  sentenceCount: 9,
  kind: "topic",
  title: "온보딩 지표 점검과 다음 스프린트 범위 확정",
  kicker: "제품 로드맵",
  bullets: ["이탈률 12% 감소", "설치 시간 4분 → 2분 30초"],
} as const;

const MEETING_LIST = {
  type: "meetings",
  items: [{ id: 101, title: "제품 로드맵 정렬", started_at: FIXED_CLOCK_EPOCH_MS - 86_400_000, status: "ended" }],
} as const;

const MEETING_DETAIL = {
  type: "meeting",
  meetingId: 101,
  title: "제품 로드맵 정렬",
  transcript: [{ text: "확정된 회의 발언입니다.", ts: FIXED_CLOCK_EPOCH_MS - 3_000, speaker: 1 }],
  current: SLIDE,
  history: [],
  compiled: null,
} as const;

const CAPTURE_STARTING = { type: "capture", capturing: false, mode: "mic", phase: "starting" } as const;
const CAPTURE_LIVE = {
  type: "capture", capturing: true, mode: "mic", phase: "capturing",
  startedAt: FIXED_CAPTURE_STARTED_AT,
} as const;

declare global {
  interface Window {
    __vrAwait?: (token: string, predicate: string) => void;
    __vrSettle?: (token: string) => Promise<void>;
  }
}

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

  window.__vrAwait = (token: string, predicate: string): void => {
    const check = new Function(`return (${predicate});`) as () => boolean;
    let done = false;
    const settle = (): boolean => {
      if (done) return true;
      let ok = false;
      try {
        ok = check() === true;
      } catch {
        ok = false;
      }
      if (!ok) return false;
      done = true;
      void window.__vrSettle!(token);
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => {
      if (settle()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  };
}

class VisualStateTimeoutError extends Error {
  constructor(predicate: string, timeoutMs: number) {
    super(`visual-repair fixture timed out after ${timeoutMs}ms waiting for: ${predicate}`);
    this.name = "VisualStateTimeoutError";
  }
}

interface Session {
  page: Page;
  act(predicate: string, trigger: () => void | Promise<void>, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

let browser: Browser;
let harness: PublicTestHarness;

async function openSession(width: number, height: number): Promise<Session> {
  const page = await browser.newPage();
  const settleWaiters = new Map<string, () => void>();
  await page.exposeFunction("__vrSettle", (token: string) => {
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
      const token = `vr-${(counter += 1)}`;
      const settled = new Promise<void>((resolve) => settleWaiters.set(token, resolve));
      await page.evaluate((t: string, p: string) => window.__vrAwait!(t, p), token, predicate);
      await trigger();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VisualStateTimeoutError(predicate, timeoutMs)), timeoutMs);
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

/** starting -> capturing -> slide -> one finalized line -> long provisional caption. */
async function enterLiveWithLongCaption(session: Session): Promise<void> {
  await session.act(
    'document.querySelector(".app")?.dataset.capturePhase === "starting"',
    () => harness.pushMessage(CAPTURE_STARTING),
  );
  await session.act(
    'document.querySelector(".app")?.classList.contains("app--capturing") === true',
    () => harness.pushMessage(CAPTURE_LIVE),
  );
  await session.act(
    'document.querySelector("#current-slide .slide__title") !== null',
    () => harness.pushMessage({ type: "slide", current: SLIDE, history: [] }),
  );
  await session.act(
    'document.querySelectorAll("#transcript-stream .feed-line").length === 1',
    () => harness.pushMessage({
      type: "line",
      text: "확정된 라이브 발언입니다.",
      ts: FIXED_CLOCK_EPOCH_MS - 3_000,
      speaker: 1,
    }),
  );
  await session.act(
    `document.getElementById("caption-text")?.textContent === ${JSON.stringify(LONG_PROVISIONAL_CAPTION)}`,
    () => harness.pushMessage({ type: "caption", text: LONG_PROVISIONAL_CAPTION, speaker: 2 }),
  );
}

/** Select the one meeting so meeting-scoped capabilities (#btn-review) ungate. */
async function enterLibraryWithMeeting(session: Session): Promise<void> {
  await session.act(
    'document.querySelectorAll("#session-list .session-row").length === 1',
    () => harness.pushMessage(MEETING_LIST),
  );
  await session.act(
    'document.querySelector("#session-list .session-row--selected") !== null',
    () => session.page.click("#session-list .session-row"),
  );
  await session.act(
    'document.getElementById("btn-review")?.hidden === false',
    () => harness.pushMessage(MEETING_DETAIL),
  );
}

// ── in-page readers: machine values only ────────────────────────────────────

/**
 * V1 reader. Reports where the island actually sits relative to the live grid's
 * transcript column, and whether its text node overflows its own box.
 *
 * `overflowX` is per-element (`scrollWidth - clientWidth`), NOT the document
 * root. The review found that the task-18 harness only measured root overflow,
 * which is why intra-grid shear passed unnoticed.
 */
function readIslandGeometry() {
  const rect = (node: Element | null) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const island = document.getElementById("island");
  const text = document.getElementById("caption-text");
  const stage = document.getElementById("stage-pane");
  const owner = island?.parentElement ?? null;
  const transcript = document.getElementById("transcript-pane");
  const surface = document.getElementById("document-surface");
  const islandStyle = island ? getComputedStyle(island) : null;
  const textStyle = text ? getComputedStyle(text) : null;
  const surfaceRect = rect(surface);
  const islandRect = rect(island);
  const ownerRect = rect(owner);
  return {
    island: islandRect,
    owner: ownerRect,
    ownerId: owner?.id ?? null,
    ownerOverflowX: owner ? owner.scrollWidth - owner.clientWidth : null,
    text: rect(text),
    stage: rect(stage),
    transcript: rect(transcript),
    surface: surfaceRect,
    islandGridColumn: islandStyle?.gridColumnStart ?? null,
    islandGridRow: islandStyle?.gridRowStart ?? null,
    textMinInlineSize: textStyle?.minInlineSize ?? textStyle?.minWidth ?? null,
    textOverflowX: text ? text.scrollWidth - text.clientWidth : null,
    islandOverflowX: island ? island.scrollWidth - island.clientWidth : null,
    rootOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // The island must not start left of, nor extend right of, the surface it
    // lives in — a sheared row starts at a negative x and spans past the
    // stage/transcript seam.
    withinSurface: Boolean(islandRect && surfaceRect)
      && islandRect!.x >= surfaceRect!.x - 1
      && islandRect!.x + islandRect!.w <= surfaceRect!.x + surfaceRect!.w + 1,
    // The real containment contract: the island fits the pane that owns it.
    withinOwner: Boolean(islandRect && ownerRect)
      && islandRect!.x >= ownerRect!.x - 1
      && islandRect!.x + islandRect!.w <= ownerRect!.x + ownerRect!.w + 1,
  };
}

/**
 * V2 reader. A control is "blank" when it paints a box but no descendant of it
 * renders any ink: no visible text, no visible icon glyph.
 */
function readReviewControl() {
  const button = document.getElementById("btn-review");
  if (!button) return null;
  const r = button.getBoundingClientRect();
  const visibleInk = Array.from(button.querySelectorAll("*")).filter((node) => {
    const el = node as HTMLElement;
    if (el.hasAttribute("hidden")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    return (el.textContent ?? "").trim().length > 0;
  }).map((node) => ({
    className: (node as HTMLElement).className,
    text: ((node as HTMLElement).textContent ?? "").trim(),
  }));
  return {
    hidden: (button as HTMLElement).hidden,
    box: { w: Math.round(r.width), h: Math.round(r.height) },
    accessibleName: button.getAttribute("aria-label"),
    visibleInkCount: visibleInk.length,
    visibleInk,
    overflowX: button.scrollWidth - button.clientWidth,
  };
}

/**
 * V3 reader. For every action-card command: does its own text box overflow?
 * `scrollWidth > clientWidth` on a single-line label is exactly the mid-word
 * cut the review observed, and it is content-measured rather than eyeballed.
 */
function readActionCommands() {
  return Array.from(document.querySelectorAll<HTMLElement>(".action-card__btn")).map((button) => {
    const r = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      id: button.id,
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      overflowX: button.scrollWidth - button.clientWidth,
      textOverflow: style.textOverflow,
      accessibleName: button.getAttribute("aria-label") ?? (button.textContent ?? "").trim(),
      // A sibling rendered as an empty box has a painted area but no legible
      // label: width below its own text's intrinsic single-glyph need.
      rendersLabel: (button.textContent ?? "").trim().length > 0 && r.width > 0 && r.height > 0,
      right: Math.round(r.right),
    };
  });
}

/**
 * V3's actual measurement. The card's head is a two-part row: a text column
 * (title + description) and a command group. The defect is a share-of-width
 * failure, so it is measured as a ratio of real laid-out boxes rather than as
 * a hardcoded pixel guess.
 */
function readActionHeadShare() {
  const head = document.querySelector<HTMLElement>("#action-followup .action-card__head");
  const textColumn = document.querySelector<HTMLElement>("#action-followup .action-card__head > div:first-child");
  const commands = document.querySelector<HTMLElement>("#action-followup .action-card__actions");
  const title = document.querySelector<HTMLElement>("#action-followup .action-card__title");
  if (!head || !textColumn || !commands || !title) return null;
  const headBox = head.getBoundingClientRect();
  const textBox = textColumn.getBoundingClientRect();
  const commandBox = commands.getBoundingClientRect();
  return {
    headWidth: Math.round(headBox.width),
    textWidth: Math.round(textBox.width),
    commandWidth: Math.round(commandBox.width),
    textShare: textBox.width / headBox.width,
    // Stacked layouts put the command group on its own row below the text; the
    // crushed single-row layout keeps their tops aligned.
    sameRow: Math.abs(textBox.y - commandBox.y) <= 1,
    // The title must render on a single line; a crushed column forces
    // "Send follow-up" to wrap, doubling its height. `line-height` computes to
    // the keyword `normal` here, so the line box is measured directly from a
    // Range over the title's own text rather than parsed from the keyword.
    titleLines: (() => {
      const range = document.createRange();
      range.selectNodeContents(title);
      return range.getClientRects().length;
    })(),
  };
}

function readCardBounds() {
  const card = document.getElementById("action-followup");
  const title = document.querySelector<HTMLElement>("#action-followup .action-card__title");
  if (!card || !title) return null;
  const cardRect = card.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  return {
    card: { x: Math.round(cardRect.x), w: Math.round(cardRect.width), right: Math.round(cardRect.right) },
    title: {
      x: Math.round(titleRect.x),
      w: Math.round(titleRect.width),
      right: Math.round(titleRect.right),
      overflowX: title.scrollWidth - title.clientWidth,
    },
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

describe("V1 — the live provisional caption row stays inside the pane that owns it", () => {
  // 900 is the exact seam; 960/1244/1440 are the contract viewports of 9.9.
  for (const { name, width, height } of [
    { name: "seam900", width: 900, height: 760 },
    { name: "live960", width: 960, height: 760 },
    { name: "library1244", width: 1244, height: 836 },
    { name: "reference1440", width: 1440, height: 900 },
  ]) {
    test(`${name} — #island fits its pane and never shears across the split`, async () => {
      const session = await openSession(width, height);
      try {
        await enterLiveWithLongCaption(session);
        const g = await session.page.evaluate(readIslandGeometry);

        // The island must be a real, laid-out row.
        expect(g.island).not.toBeNull();
        expect(g.island!.w).toBeGreaterThan(0);
        expect(g.island!.h).toBeGreaterThan(0);

        // THE DEFECT. The row must fit the pane that owns it. Shipped CSS
        // yields a 902px island at x=-133.7 inside a 635px stage.
        expect(g.withinOwner).toBe(true);

        // Never wider than its own owner.
        expect(g.island!.w).toBeLessThanOrEqual(g.owner!.w + 1);

        // It is contained by the live surface, so it can never run across the
        // splitter and under the transcript pane.
        expect(g.withinSurface).toBe(true);
        expect(g.transcript).not.toBeNull();
        expect(g.island!.x + g.island!.w).toBeLessThanOrEqual(g.transcript!.x + 1);

        // No shear: the row does not overflow its own box, and the pane that
        // owns it is not forced to overflow either.
        expect(g.islandOverflowX).toBe(0);
        expect(g.ownerOverflowX).toBe(0);

        // The caption text still ellipsizes cleanly inside its own box rather
        // than being cut mid-glyph by an ancestor's edge. `overflow: hidden` +
        // `text-overflow: ellipsis` means scrollWidth legitimately exceeds
        // clientWidth here; what matters is that the box itself is contained,
        // which the assertions above enforce.
        expect(g.text).not.toBeNull();
        expect(g.text!.x).toBeGreaterThanOrEqual(g.owner!.x - 1);
        expect(g.text!.x + g.text!.w).toBeLessThanOrEqual(g.owner!.x + g.owner!.w + 1);

        // And the pre-existing root-overflow contract still holds.
        expect(g.rootOverflowX).toBe(0);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});

describe("V2 — #btn-review is never a blank control", () => {
  for (const { name, width, height } of [
    { name: "compact320", width: 320, height: 667 },
    { name: "narrow375", width: 375, height: 812 },
    { name: "threshold420", width: 420, height: 800 },
  ]) {
    test(`${name} — the review control renders visible content and keeps its name`, async () => {
      const session = await openSession(width, height);
      try {
        await enterLibraryWithMeeting(session);
        const control = await session.page.evaluate(readReviewControl);

        expect(control).not.toBeNull();
        expect(control!.hidden).toBe(false);

        // DESIGN.md 9.12: the accessible name survives (this already passes and
        // is asserted so a "fix" cannot trade the name away for a glyph).
        expect(control!.accessibleName).toBe("회의록 검토");

        // The target-size repair must be preserved.
        expect(control!.box.w).toBeGreaterThanOrEqual(44);
        expect(control!.box.h).toBeGreaterThanOrEqual(44);

        // The actual defect: a 44x44 box with zero rendered content.
        expect(control!.visibleInkCount).toBeGreaterThan(0);

        // Whatever it renders must fit.
        expect(control!.overflowX).toBe(0);
      } finally {
        await session.close();
      }
    }, 30_000);
  }

  test("the .review-btn__icon selector is not dead — the markup provides the node", async () => {
    const session = await openSession(320, 667);
    try {
      await enterLibraryWithMeeting(session);
      const icon = await session.page.evaluate(() => {
        const node = document.querySelector<HTMLElement>("#btn-review .review-btn__icon");
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return {
          text: (node.textContent ?? "").trim(),
          ariaHidden: node.getAttribute("aria-hidden"),
          box: { w: Math.round(r.width), h: Math.round(r.height) },
        };
      });
      expect(icon).not.toBeNull();
      // A decorative glyph: it must never be announced alongside the aria-label.
      expect(icon!.ariaHidden).toBe("true");
      expect(icon!.text.length).toBeGreaterThan(0);
      expect(icon!.box.w).toBeGreaterThan(0);
      expect(icon!.box.h).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("V3 — action-card commands stay legible at the narrow floor", () => {
  for (const { name, width, height } of [
    { name: "compact320", width: 320, height: 667 },
    { name: "narrow375", width: 375, height: 812 },
  ]) {
    test(`${name} — no action command truncates mid-glyph or renders unlabeled`, async () => {
      const session = await openSession(width, height);
      try {
        await enterLibraryWithMeeting(session);
        const commands = await session.page.evaluate(readActionCommands);
        const bounds = await session.page.evaluate(readCardBounds);
        const share = await session.page.evaluate(readActionHeadShare);

        expect(commands.length).toBeGreaterThan(0);
        expect(bounds).not.toBeNull();
        expect(share).not.toBeNull();

        // THE DEFECT. Either the head wraps so the commands take their own row,
        // or the text column keeps at least half the row. The shipped CSS does
        // neither: `.action-card__actions { flex-shrink: 0 }` holds a single row
        // and leaves the text column at 81/254 = 32%.
        if (share!.sameRow) {
          expect(share!.textShare).toBeGreaterThanOrEqual(0.5);
        }

        // And the card's own title stays on one line rather than fragmenting.
        expect(share!.titleLines).toBe(1);

        for (const command of commands) {
          // Every sibling carries a legible label, not an empty box.
          expect(command.rendersLabel).toBe(true);
          expect(command.accessibleName.length).toBeGreaterThan(0);
          // Its own text fits its own box: no mid-word cut.
          expect(command.overflowX).toBe(0);
          // And it stays inside the card that owns it.
          expect(command.right).toBeLessThanOrEqual(bounds!.card.right + 1);
          // Target size at the narrow floor is preserved.
          expect(command.box.w).toBeGreaterThanOrEqual(44);
          expect(command.box.h).toBeGreaterThanOrEqual(44);
        }

        // The card title ("Send follow-up") is the node the review saw cut to
        // "Send follow-": it must fit its own box and stay inside the card.
        expect(bounds!.title.overflowX).toBe(0);
        expect(bounds!.title.right).toBeLessThanOrEqual(bounds!.card.right + 1);

        const rootOverflow = await session.page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(rootOverflow).toBe(0);
      } finally {
        await session.close();
      }
    }, 30_000);
  }
});
