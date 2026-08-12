// Deterministic Chromium driver for the canonical Caret UI fixtures.
//
// Determinism rules enforced here:
//  - the page clock is frozen before any application script runs;
//  - locale/timezone are pinned and font readiness is awaited via document.fonts.ready;
//  - every external request is aborted and recorded, so a fixture can never depend
//    on the network (Google Fonts / jsDelivr links in index.html are stubbed locally);
//  - each awaited client state is subscribed to with a MutationObserver BEFORE its
//    trigger frame is pushed, so no capture can observe a stale DOM;
//  - a state that never arrives fails with a named, bounded CaretFixtureTimeoutError
//    instead of screenshotting stale content.
// No sleeps, no polling delays, no waitForTimeout anywhere in this file.
import { createHash } from "node:crypto";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";

import {
  CANONICAL_VIEWPORTS,
  FIXED_CLOCK_EPOCH_MS,
  type CanonicalViewport,
  type CaretUiFixture,
} from "../fixtures/caret-ui-states.ts";
import { createPublicTestHarness } from "../public-test-harness.ts";

/**
 * Bounded deadline for one awaited client state. Deliberately far below Bun's
 * default 5000ms per-test timeout so a missing state always surfaces as this
 * harness's own named failure instead of racing the test runner.
 */
export const DEFAULT_STATE_TIMEOUT_MS = 1_500;

export class CaretFixtureTimeoutError extends Error {
  readonly fixtureId: string;
  readonly missingState: string;
  readonly timeoutMs: number;
  /** Always false: the driver refuses to return a capture taken from stale DOM. */
  readonly capturedStale = false;

  constructor(fixtureId: string, missingState: string, timeoutMs: number) {
    super(`caret fixture "${fixtureId}" timed out after ${timeoutMs}ms waiting for client state "${missingState}"`);
    this.name = "CaretFixtureTimeoutError";
    this.fixtureId = fixtureId;
    this.missingState = missingState;
    this.timeoutMs = timeoutMs;
  }
}

export interface CaptureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaretMachineState {
  fixtureId: string;
  environment: {
    locale: string;
    timezone: string;
    now: number;
    fontsReady: boolean;
    deviceScaleFactor: number;
  };
  connection: string;
  capturing: boolean;
  captureTimerText: string;
  recordButtonLabel: string;
  meetingTitles: string[];
  selectedMeetingTitle: string | null;
  slideTitle: string | null;
  slideIndexLabel: string | null;
  thumbnails: number;
  transcriptLines: number;
  transcriptCountText: string;
  captionText: string;
  compileStatusState: string | null;
  compileStatusHidden: boolean;
  geometry: Record<string, CaptureBox | null>;
  /** Machine-readable stage/transcript arrangement; drives the stacked contract. */
  layout: {
    stageAboveTranscript: boolean;
    sameRow: boolean;
    sameColumn: boolean;
    stageVisible: boolean;
    transcriptVisible: boolean;
  };
  rootOverflow: { horizontal: number };
}

export interface CaretTimelineStep {
  awaitState: string;
  /** Which real trigger drove this step. */
  triggerKind: "message" | "click";
  /** Unified driver trigger clock when the in-page subscription was armed. */
  subscribedAtSeq: number;
  /** Unified driver trigger clock when the trigger was dispatched. */
  triggeredAtSeq: number;
  /** Harness broadcast counter before the trigger (unchanged by click steps). */
  harnessSentBefore: number;
  /** Harness broadcast counter after the trigger. */
  harnessSentAfter: number;
  /** In-page monotonic counter when the observer was armed. */
  pageArmedOrdinal: number | null;
  /** In-page monotonic counter when the click dispatched; null for message steps. */
  pageTriggeredOrdinal: number | null;
}

export interface CaretCapture {
  fixtureId: string;
  viewport: CanonicalViewport;
  state: CaretMachineState;
  /** Canonical machine JSON: stable key order, no timing or host-dependent values. */
  json: string;
  hash: string;
  timeline: CaretTimelineStep[];
  requestedUrls: string[];
  /** URLs that actually reached the network. Must always be empty. */
  externalRequests: string[];
  /** Off-origin URLs the driver refused, served locally or aborted instead. */
  blockedRequests: string[];
  /** Client actions the page sent back, in order. */
  clientActions: string[];
  screenshot?: Uint8Array;
}

export interface CaptureOptions {
  screenshot?: boolean;
  timeoutMs?: number;
}

export interface CaretBrowserDriver {
  readonly origin: string;
  captureState(fixture: CaretUiFixture, options?: CaptureOptions): Promise<CaretCapture>;
  close(): Promise<void>;
}

/** Deterministic local replacement for the two remote stylesheet links. */
const STUB_STYLESHEET = ":root{--caret-fixture-fonts:local}";

declare global {
  interface Window {
    __caretAwait?: (token: string, state: string) => number;
    __caretOrdinal?: () => number;
    /** Injected by the driver via exposeFunction; pushes settle events to Node. */
    __caretSettle?: (token: string) => Promise<void>;
  }
}

/**
 * Installed before any page script. Freezes Date, and exposes a subscription
 * registry that resolves a token when a DOM predicate first becomes true. The
 * observer is armed at subscription time, so a state reached between arming and
 * awaiting is still captured (initial check + mutation-driven re-check).
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
  // eslint-disable-next-line no-global-assign
  (globalThis as unknown as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
  performance.now = () => 0;

  // Monotonic in-page ordinal: arming a subscription and dispatching a click both
  // advance it, so subscribe-before-click ordering is observable inside the page.
  let ordinal = 0;
  (window as Window).__caretOrdinal = () => (ordinal += 1);

  const matches = (state: string): boolean => {
    const text = (id: string): string => document.getElementById(id)?.textContent?.trim() ?? "";
    if (state === "connection:connected") {
      return document.documentElement.dataset.connection === "connected";
    }
    if (state === "capture:capturing") {
      return document.querySelector(".app")?.classList.contains("app--capturing") === true;
    }
    if (state === "capture:idle") {
      return document.querySelector(".app")?.classList.contains("app--capturing") === false;
    }
    if (state === "meetings:listed") {
      const list = document.getElementById("session-list");
      const empty = document.getElementById("session-empty");
      return Boolean(list) && (list!.children.length > 0 || empty?.hasAttribute("hidden") === false);
    }
    if (state === "meeting:selected") {
      return document.querySelectorAll("#session-list .session-row--selected").length === 1;
    }
    if (state === "meeting:loaded") {
      // The detail payload rendered: a selected row AND slide content from it.
      return document.querySelectorAll("#session-list .session-row--selected").length === 1
        && document.querySelector("#current-slide .slide__title") !== null;
    }
    if (state === "slide:rendered") {
      return document.querySelector("#current-slide .slide__title") !== null;
    }
    if (state === "slide:cleared") {
      return document.querySelector("#current-slide .slide__placeholder") !== null;
    }
    if (state.startsWith("transcript:lines=")) {
      const want = Number(state.slice("transcript:lines=".length));
      return document.querySelectorAll("#transcript-stream .feed-line").length === want;
    }
    if (state === "caption:shown") {
      return text("caption-text").length > 0;
    }
    if (state.startsWith("compile:")) {
      const status = document.getElementById("compile-status");
      return Boolean(status) && !status!.hasAttribute("hidden")
        && status!.dataset.state === state.slice("compile:".length);
    }
    if (state === "detect:on") {
      return document.getElementById("glance-detect")?.hasAttribute("hidden") === false;
    }
    if (state === "detect:off") {
      return document.getElementById("glance-detect")?.hasAttribute("hidden") === true;
    }
    throw new Error(`unknown caret await state: ${state}`);
  };

  (window as Window).__caretAwait = (token: string, state: string): number => {
    const armedAt = (window as Window).__caretOrdinal!();
    let done = false;
    const settle = (): boolean => {
      if (done || !matches(state)) return false;
      done = true;
      void window.__caretSettle!(token);
      return true;
    };
    // Already true at arming time: report the same ordinal, no observer needed.
    if (settle()) return armedAt;
    const observer = new MutationObserver(() => {
      if (settle()) observer.disconnect();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return armedAt;
  };
}

/** Runs inside the page: reads only machine-consumed values, never prose copy. */
function readMachineState(fixtureId: string, deviceScaleFactor: number): CaretMachineState {
  const box = (selector: string): CaptureBox | null => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const text = (id: string): string => document.getElementById(id)?.textContent?.trim() ?? "";
  const compileStatus = document.getElementById("compile-status");
  const stageBox = box("#stage-pane");
  const transcriptBox = box("#transcript-pane");
  const selected = document.querySelector("#session-list .session-row--selected .session-row__title");
  const record = document.getElementById("btn-record");

  return {
    fixtureId,
    environment: {
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      now: Date.now(),
      fontsReady: (document as Document & { __caretFontsReady?: boolean }).__caretFontsReady === true,
      deviceScaleFactor,
    },
    connection: document.documentElement.dataset.connection ?? "unknown",
    capturing: document.querySelector(".app")?.classList.contains("app--capturing") === true,
    captureTimerText: text("capture-timer"),
    recordButtonLabel: record?.getAttribute("aria-label") ?? "",
    meetingTitles: [...document.querySelectorAll("#session-list .session-row__title")]
      .map((node) => node.textContent?.trim() ?? ""),
    selectedMeetingTitle: selected?.textContent?.trim() ?? null,
    slideTitle: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
    slideIndexLabel: document.querySelector("#current-slide .slide__index")?.textContent?.trim() ?? null,
    thumbnails: document.querySelectorAll("#thumbnails .thumbnail").length,
    transcriptLines: document.querySelectorAll("#transcript-stream .feed-line").length,
    transcriptCountText: text("transcript-count"),
    captionText: text("caption-text"),
    compileStatusState: compileStatus?.dataset.state ?? null,
    compileStatusHidden: compileStatus?.hasAttribute("hidden") ?? true,
    geometry: {
      "#workspace": box("#workspace"),
      "#stage-pane": box("#stage-pane"),
      "#current-slide": box("#current-slide"),
      "#transcript-pane": box("#transcript-pane"),
      "#session-list": box("#session-list"),
      ".dock": box(".dock"),
    },
    layout: {
      stageAboveTranscript: Boolean(stageBox && transcriptBox)
        && stageBox!.y + stageBox!.height <= transcriptBox!.y + 1,
      sameRow: Boolean(stageBox && transcriptBox) && Math.abs(stageBox!.y - transcriptBox!.y) <= 1,
      sameColumn: Boolean(stageBox && transcriptBox) && Math.abs(stageBox!.x - transcriptBox!.x) <= 1,
      stageVisible: Boolean(stageBox && stageBox.width > 0 && stageBox.height > 0),
      transcriptVisible: Boolean(transcriptBox && transcriptBox.width > 0 && transcriptBox.height > 0),
    },
    rootOverflow: {
      horizontal: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    },
  };
}

/** Stable stringify so two identical states always produce identical bytes. */
function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export async function createCaretBrowserDriver(): Promise<CaretBrowserDriver> {
  const harness = createPublicTestHarness();
  const browser: Browser = await puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });

  let tokenCounter = 0;

  async function captureState(fixture: CaretUiFixture, options: CaptureOptions = {}): Promise<CaretCapture> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
    const viewport = CANONICAL_VIEWPORTS[fixture.viewport];
    const page: Page = await browser.newPage();
    const requestedUrls: string[] = [];
    const externalRequests: string[] = [];
    const blockedRequests: string[] = [];
    const clientActions: string[] = [];
    const settleWaiters = new Map<string, () => void>();

    try {
      await page.exposeFunction("__caretSettle", (token: string) => {
        settleWaiters.get(token)?.();
      });
      await page.emulateTimezone(fixture.timezone);
      await page.setExtraHTTPHeaders({ "Accept-Language": fixture.locale });
      await page.evaluateOnNewDocument(pageBootstrap, fixture.clockEpochMs);
      await page.evaluateOnNewDocument((locale: string) => {
        Object.defineProperty(navigator, "language", { get: () => locale });
        Object.defineProperty(navigator, "languages", { get: () => [locale] });
        const original = Intl.DateTimeFormat;
        const patched = function (this: unknown, tag?: string | string[], opts?: Intl.DateTimeFormatOptions) {
          return new original(tag ?? locale, opts);
        } as unknown as typeof Intl.DateTimeFormat;
        patched.supportedLocalesOf = original.supportedLocalesOf;
        Intl.DateTimeFormat = patched;
      }, fixture.locale);
      await page.setViewport(viewport);

      await page.setRequestInterception(true);
      page.on("request", (request: HTTPRequest) => {
        const url = request.url();
        requestedUrls.push(url);
        if (url.startsWith(harness.origin) || url.startsWith("data:") || url === "about:blank") {
          void request.continue();
          return;
        }
        // Fonts/CDN links in index.html must never reach the network in tests.
        blockedRequests.push(url);
        if (request.resourceType() === "stylesheet") {
          void request.respond({ status: 200, contentType: "text/css", body: STUB_STYLESHEET });
          return;
        }
        void request.abort();
      });

      await page.goto(harness.origin, { waitUntil: "load" });
      await harness.waitForClient();
      // Font readiness is awaited via the browser's own promise, never a delay.
      await page.evaluate(async () => {
        await document.fonts.ready;
        (document as Document & { __caretFontsReady?: boolean }).__caretFontsReady = true;
      });

      const timeline: CaretTimelineStep[] = [];
      // Unified trigger clock: advances for arming and for every trigger kind, so
      // subscribe-before-trigger ordering is recorded for clicks exactly as for
      // server frames instead of relying on the message-only harness counter.
      let triggerClock = 0;
      for (const event of fixture.events) {
        const hasMessage = event.message !== undefined;
        const hasClick = event.click !== undefined;
        if (hasMessage === hasClick) {
          throw new Error(
            `caret fixture "${fixture.id}": step "${event.awaitState}" must have exactly one trigger (message or click)`,
          );
        }
        const token = `caret-${(tokenCounter += 1)}`;
        // Subscribe to the client's outbound action before the interaction fires.
        const inboundAction = event.expectClientAction === undefined
          ? null
          : harness.nextClientMessage();
        // Register the Node-side listener, then arm the in-page observer, and only
        // then broadcast the trigger frame. Settlement is pushed from the page.
        const settled = new Promise<void>((resolve) => { settleWaiters.set(token, resolve); });
        const pageArmedOrdinal = await page.evaluate(
          (t: string, s: string) => window.__caretAwait!(t, s),
          token,
          event.awaitState,
        );
        const subscribedAtSeq = (triggerClock += 1);
        const harnessSentBefore = harness.sentSequence;

        let pageTriggeredOrdinal: number | null = null;
        if (event.message !== undefined) {
          harness.pushMessage(event.message);
        } else {
          const clicked = await page.evaluate((selector: string) => {
            const target = document.querySelector(selector);
            if (!(target instanceof HTMLElement)) return null;
            // Ordinal is taken at dispatch time, inside the page, after arming.
            const at = window.__caretOrdinal!();
            target.click();
            return at;
          }, event.click!);
          if (clicked === null) {
            throw new Error(`caret fixture "${fixture.id}": click target not found: ${event.click}`);
          }
          pageTriggeredOrdinal = clicked;
        }
        const triggeredAtSeq = (triggerClock += 1);
        const harnessSentAfter = harness.sentSequence;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const bounded = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new CaretFixtureTimeoutError(fixture.id, event.awaitState, timeoutMs)),
            timeoutMs,
          );
        });
        try {
          await Promise.race([settled, bounded]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          settleWaiters.delete(token);
        }
        if (inboundAction !== null) {
          const message = await inboundAction as { action?: string };
          const action = message.action;
          if (action === undefined || action !== event.expectClientAction) {
            throw new Error(
              `caret fixture "${fixture.id}": expected client action "${event.expectClientAction}", got "${String(action)}"`,
            );
          }
          clientActions.push(action);
        }
        timeline.push({
          awaitState: event.awaitState,
          triggerKind: hasMessage ? "message" : "click",
          subscribedAtSeq,
          triggeredAtSeq,
          harnessSentBefore,
          harnessSentAfter,
          pageArmedOrdinal,
          pageTriggeredOrdinal,
        });
      }

      const state = await page.evaluate(readMachineState, fixture.id, viewport.deviceScaleFactor);
      const json = canonicalJson(state);
      const capture: CaretCapture = {
        fixtureId: fixture.id,
        viewport,
        state,
        json,
        hash: createHash("sha256").update(json).digest("hex"),
        timeline,
        requestedUrls,
        externalRequests,
        blockedRequests,
        clientActions,
      };
      if (options.screenshot) {
        capture.screenshot = await page.screenshot({ type: "png", captureBeyondViewport: false });
      }
      return capture;
    } finally {
      await page.close();
    }
  }

  return {
    origin: harness.origin,
    captureState,
    async close() {
      await browser.close();
      harness.stop();
    },
  };
}

export { FIXED_CLOCK_EPOCH_MS };
