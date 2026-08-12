// Todo 4 - deterministic browser state fixture harness self-tests.
// Proves: fixed clock, deterministic machine JSON (byte-identical across runs),
// zero external requests, exact event-before-trigger subscriptions, bounded named
// failure when a subscribed state never arrives, and a static ban on sleep/poll APIs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CANONICAL_VIEWPORTS,
  CARET_UI_STATES,
  FIXED_CLOCK_EPOCH_MS,
  fixtureById,
  fixtureIds,
  type CaretUiFixture,
} from "./fixtures/caret-ui-states.ts";
import {
  CaretFixtureTimeoutError,
  createCaretBrowserDriver,
  DEFAULT_STATE_TIMEOUT_MS,
  type CaretBrowserDriver,
} from "./helpers/caret-browser-driver.ts";

let driver: CaretBrowserDriver;

beforeAll(async () => {
  driver = await createCaretBrowserDriver();
});

afterAll(async () => {
  await driver?.close();
});

describe("canonical fixture catalogue", () => {
  test("covers every state named in the plan with unique ids", () => {
    expect(fixtureIds()).toEqual([
      "reference-library",
      "empty-library",
      "library-overview",
      "library-notes",
      "library-transcript",
      "live-starting",
      "live-capturing",
      "live-stopping",
      "live-reconnecting",
      "history-preview",
      "compile-progress",
      "compile-fallback",
      "compile-error",
      "stacked-live",
      "narrow-live",
      "narrow-compact",
    ]);
    expect(new Set(fixtureIds()).size).toBe(fixtureIds().length);
  });

  test("every canonical viewport in the plan matrix is exercised by a real fixture", () => {
    const covered = new Set(CARET_UI_STATES.map((state) => state.viewport));
    expect([...covered].sort()).toEqual(["compact", "library", "live", "narrow", "reference", "stacked"]);
  });

  test("every fixture step is a real trigger: a server message or a user interaction", () => {
    for (const state of CARET_UI_STATES) {
      for (const event of state.events) {
        const kinds = [event.message !== undefined, event.click !== undefined].filter(Boolean);
        expect({ id: state.id, awaitState: event.awaitState, triggers: kinds.length })
          .toEqual({ id: state.id, awaitState: event.awaitState, triggers: 1 });
      }
    }
  });

  test("every fixture pins a canonical viewport, locale, timezone and fixed clock", () => {
    for (const fixture of CARET_UI_STATES) {
      expect(CANONICAL_VIEWPORTS[fixture.viewport]).toBeDefined();
      expect(fixture.locale).toBe("ko-KR");
      expect(fixture.timezone).toBe("Asia/Seoul");
      expect(fixture.clockEpochMs).toBe(FIXED_CLOCK_EPOCH_MS);
      expect(fixture.events.length).toBeGreaterThan(0);
    }
  });

  test("canonical viewports include the plan's browser matrix at deviceScaleFactor 1", () => {
    expect(CANONICAL_VIEWPORTS).toEqual({
      reference: { width: 1440, height: 900, deviceScaleFactor: 1 },
      library: { width: 1244, height: 836, deviceScaleFactor: 1 },
      live: { width: 960, height: 760, deviceScaleFactor: 1 },
      stacked: { width: 820, height: 900, deviceScaleFactor: 1 },
      narrow: { width: 375, height: 812, deviceScaleFactor: 1 },
      compact: { width: 320, height: 667, deviceScaleFactor: 1 },
    });
  });

  test("fixture events are frozen server messages, never mutable current time", () => {
    for (const fixture of CARET_UI_STATES) {
      for (const event of fixture.events) {
        expect(Object.isFrozen(event)).toBe(true);
        const serialized = JSON.stringify(event);
        expect(serialized).not.toContain('"ts":null');
        expect(serialized.includes("Date.now")).toBe(false);
      }
    }
  });
});

describe("deterministic browser state capture", () => {
  test("1244x836 library fixture yields byte-identical machine JSON twice", async () => {
    const first = await driver.captureState(fixtureById("library-overview"));
    const second = await driver.captureState(fixtureById("library-overview"));

    expect(first.viewport).toEqual({ width: 1244, height: 836, deviceScaleFactor: 1 });
    expect(second.json).toBe(first.json);
    expect(second.hash).toBe(first.hash);
    expect(first.externalRequests).toEqual([]);
  });

  test("960x760 live fixture yields byte-identical machine JSON twice with a fixed timer", async () => {
    const first = await driver.captureState(fixtureById("live-capturing"));
    const second = await driver.captureState(fixtureById("live-capturing"));

    expect(first.viewport).toEqual({ width: 960, height: 760, deviceScaleFactor: 1 });
    expect(second.hash).toBe(first.hash);
    // The live fixture starts capture exactly 125 s before the frozen clock.
    expect(first.state.captureTimerText).toBe("02:05");
    expect(second.state.captureTimerText).toBe(first.state.captureTimerText);
    expect(first.state.capturing).toBe(true);
    // At 960x760 the stage and transcript share a row.
    expect(first.state.layout.sameRow).toBe(true);
    expect(first.state.layout.stageAboveTranscript).toBe(false);
  });

  test("1440x900 reference fixture yields byte-identical machine JSON and geometry twice", async () => {
    const first = await driver.captureState(fixtureById("reference-library"));
    const second = await driver.captureState(fixtureById("reference-library"));

    expect(first.viewport).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1 });
    expect(second.json).toBe(first.json);
    expect(second.hash).toBe(first.hash);
    expect(second.state.geometry).toEqual(first.state.geometry);
    expect(first.state.geometry["#workspace"]!.width).toBe(1440);
    expect(first.state.rootOverflow).toEqual({ horizontal: 0 });
    expect(first.externalRequests).toEqual([]);
  });

  test("820x900 stacked fixture yields byte-identical machine JSON and the stacked-state contract", async () => {
    const first = await driver.captureState(fixtureById("stacked-live"));
    const second = await driver.captureState(fixtureById("stacked-live"));

    expect(first.viewport).toEqual({ width: 820, height: 900, deviceScaleFactor: 1 });
    expect(second.json).toBe(first.json);
    expect(second.state.geometry).toEqual(first.state.geometry);
    // Below the 900px seam the complete stage sits above the transcript, in one column.
    expect(first.state.layout).toEqual({
      stageAboveTranscript: true,
      sameRow: false,
      sameColumn: true,
      stageVisible: true,
      transcriptVisible: true,
    });
    expect(first.state.rootOverflow).toEqual({ horizontal: 0 });
    expect(first.state.capturing).toBe(true);
  });

  test("locale, timezone, fonts and clock are pinned inside the page", async () => {
    const capture = await driver.captureState(fixtureById("library-overview"));

    expect(capture.state.environment).toEqual({
      locale: "ko-KR",
      timezone: "Asia/Seoul",
      now: FIXED_CLOCK_EPOCH_MS,
      fontsReady: true,
      deviceScaleFactor: 1,
    });
  });

  test("no fixture reaches the network beyond the local harness origin", async () => {
    const capture = await driver.captureState(fixtureById("live-capturing"));

    expect(capture.externalRequests).toEqual([]);
    // Since the deterministic font foundation landed, index.html links no remote
    // stylesheet at all, so there is nothing left for the driver to refuse. The
    // driver's off-origin guard stays in place as a regression tripwire.
    expect(capture.blockedRequests).toEqual([]);
    for (const url of capture.requestedUrls) {
      const local = url.startsWith(driver.origin);
      expect(local || capture.blockedRequests.includes(url)).toBe(true);
    }
  });

  test("geometry is the deterministic artifact; screenshots are visual artifacts only", async () => {
    const first = await driver.captureState(fixtureById("live-capturing"), { screenshot: true });
    const second = await driver.captureState(fixtureById("live-capturing"), { screenshot: true });

    // Machine JSON and geometry are the regression-grade deterministic outputs.
    expect(second.json).toBe(first.json);
    expect(second.state.geometry).toEqual(first.state.geometry);
    expect(first.state.geometry["#stage-pane"]!.width).toBeGreaterThan(0);
    expect(first.state.geometry["#transcript-pane"]!.width).toBeGreaterThan(0);
    expect(first.state.rootOverflow).toEqual({ horizontal: 0 });
    // Screenshots are produced for human/visual review. Their bytes depend on font
    // rasterization and compositing, so they are NEVER asserted byte-identical here.
    expect(first.screenshot).toBeInstanceOf(Uint8Array);
    expect(first.screenshot!.byteLength).toBeGreaterThan(1_000);
    expect(second.screenshot).toBeInstanceOf(Uint8Array);
  });

  test("transcript, meetings, slides and job fixtures land deterministically", async () => {
    const library = await driver.captureState(fixtureById("library-transcript"));
    const compiling = await driver.captureState(fixtureById("compile-progress"));

    expect(library.state.meetingTitles).toEqual([
      "제품 로드맵 정렬",
      "고객 온보딩 리뷰",
      "분기 회고",
    ]);
    expect(library.state.transcriptLines).toBe(15);
    expect(compiling.state.compileStatusState).toBe("progress");
  });
});

describe("event-before-trigger synchronization", () => {
  test("the driver subscribes before every message trigger", async () => {
    const capture = await driver.captureState(fixtureById("live-starting"));

    // Every awaited subscription must be registered strictly before its trigger frame.
    for (const step of capture.timeline) {
      expect(step.subscribedAtSeq).toBeLessThan(step.triggeredAtSeq);
      expect(step.triggerKind).toBe("message");
      // Message steps also corroborate ordering against the harness broadcast counter.
      expect(step.harnessSentBefore).toBeLessThan(step.harnessSentAfter);
    }
    expect(capture.timeline.length).toBeGreaterThan(0);
  });

  test("click-driven steps prove ordering with an in-page observable counter", async () => {
    const capture = await driver.captureState(fixtureById("library-overview"));

    const clicks = capture.timeline.filter((step) => step.triggerKind === "click");
    expect(clicks.length).toBeGreaterThan(0);
    for (const step of capture.timeline) {
      // The unified driver trigger clock advances for clicks exactly as for messages.
      expect(step.subscribedAtSeq).toBeLessThan(step.triggeredAtSeq);
    }
    for (const step of clicks) {
      // Observed inside the page: the observer was armed before the click dispatched.
      expect(step.pageArmedOrdinal).not.toBeNull();
      expect(step.pageTriggeredOrdinal).not.toBeNull();
      expect(step.pageArmedOrdinal!).toBeLessThan(step.pageTriggeredOrdinal!);
      // A click sends no server frame, so the harness counter must not move.
      expect(step.harnessSentAfter).toBe(step.harnessSentBefore);
    }
    expect(capture.clientActions).toEqual(["selectMeeting"]);
  });

  test("a slide emitted before the subscribed capture state fails with a named bounded timeout", async () => {
    const preSubscription: CaretUiFixture = {
      ...fixtureById("live-capturing"),
      id: "live-capturing-pre-subscription",
      events: [
        { message: { type: "slide", current: null, history: [] }, awaitState: "capture:capturing" },
      ],
    };

    // Bounded well below Bun's default 5000ms test timeout so the deadline is the
    // harness's own, never a race with the test runner.
    const failure = await driver.captureState(preSubscription, { timeoutMs: 1_500 }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CaretFixtureTimeoutError);
    const timeout = failure as CaretFixtureTimeoutError;
    expect(timeout.missingState).toBe("capture:capturing");
    expect(timeout.fixtureId).toBe("live-capturing-pre-subscription");
    expect(timeout.timeoutMs).toBe(1_500);
    expect(timeout.capturedStale).toBe(false);
    expect(timeout.message).toContain("capture:capturing");
  });

  test("the default state deadline stays below Bun's default test timeout", () => {
    expect(DEFAULT_STATE_TIMEOUT_MS).toBeLessThan(5_000);
  });
});

/** Drops line and block comments so prose about forbidden APIs cannot trip guards. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("static determinism guards", () => {
  const forbidden = [
    /\bwaitForTimeout\s*\(/,
    /\bBun\.sleep\s*\(/,
    /\bsetInterval\s*\(/,
    /\bsleep\s*\(\s*\d/,
    /\bwaitFor\s*\(\s*\(\s*\)\s*=>\s*Date\.now/,
  ];

  test("harness, fixtures and driver never use sleep or polling wait APIs", async () => {
    const roots = ["public-test-harness.ts", "fixtures/caret-ui-states.ts", "helpers/caret-browser-driver.ts", "public-caret-harness.test.ts"];
    for (const relative of roots) {
      const source = await readFile(join(import.meta.dir, relative), "utf-8");
      const body = stripComments(source);
      for (const pattern of forbidden) {
        expect({ relative, pattern: pattern.source, hit: pattern.test(body) })
          .toEqual({ relative, pattern: pattern.source, hit: false });
      }
    }
  });

  test("no QA driver under tests/helpers reintroduces a polling delay", async () => {
    const helpers = await readdir(join(import.meta.dir, "helpers"));
    expect(helpers.length).toBeGreaterThan(0);
    for (const name of helpers) {
      const source = await readFile(join(import.meta.dir, "helpers", name), "utf-8");
      const body = stripComments(source);
      expect({ name, hit: body.includes("waitForTimeout") }).toEqual({ name, hit: false });
      expect({ name, hit: /setTimeout\([^)]*\)\s*;?\s*await/.test(body) }).toEqual({ name, hit: false });
    }
  });
});
