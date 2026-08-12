// Live browser client handle for the dual-surface integration seam (Todo 16).
//
// `tests/helpers/caret-browser-driver.ts` captures ONE scripted fixture per
// page. Todo 16 needs the opposite shape: one long-lived workspace page that
// stays connected to the same Bun session across reconnect, reload, capture,
// stop and history preview, so this module owns the page instead.
//
// Synchronisation rule (identical to the Todo 4 driver): the in-page predicate
// is armed with a MutationObserver BEFORE the trigger fires, settlement is
// pushed from the page, and awaiting is bounded by a named timeout. No sleeps,
// no polling, no `waitForTimeout`.

import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";

export const DEFAULT_BROWSER_TIMEOUT_MS = 6_000;

export class BrowserStateTimeoutError extends Error {
  readonly missingState: string;
  constructor(missingState: string, timeoutMs: number, snapshot: unknown) {
    super(
      `browser surface timed out after ${timeoutMs}ms waiting for "${missingState}"; last state: ${JSON.stringify(snapshot)}`,
    );
    this.name = "BrowserStateTimeoutError";
    this.missingState = missingState;
  }
}

export interface BrowserSurfaceState {
  connection: string;
  connectionState: string | null;
  capturePhase: string | null;
  uiState: string | null;
  shell: string | null;
  /** The legacy compatibility class every existing suite still reads. */
  capturing: boolean;
  captureTimerText: string;
  liveTimerText: string;
  recordPressed: string | null;
  transcriptTexts: string[];
  transcriptLineCount: number;
  captionText: string;
  selectedMeetingTitle: string | null;
  selectedMeetingIds: string[];
  meetingTitles: string[];
  slideTitle: string | null;
  statusText: string;
  compileStatusState: string | null;
  compileStatusHidden: boolean;
}

/** Serialisable predicate: runs inside the page, so it must be self-contained. */
export type BrowserPredicateSource = string;

export interface BrowserSurfaceClient {
  readonly page: Page;
  /** Arm a predicate BEFORE the trigger; await the promise after. */
  expect(label: string, predicateSource: BrowserPredicateSource, timeoutMs?: number): Promise<void>;
  read(): Promise<BrowserSurfaceState>;
  click(selector: string): Promise<void>;
  /** Two activations dispatched inside one task: the rapid-Stop proof. */
  doubleClick(selector: string): Promise<void>;
  reload(): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

declare global {
  interface Window {
    __dualAwait?: (token: string, source: string) => void;
    __dualSettle?: (token: string) => Promise<void>;
  }
}

/** Installed before any page script: freezes the clock and arms subscriptions. */
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

  (window as Window).__dualAwait = (token: string, source: string): void => {
    // eslint-disable-next-line no-new-func
    const predicate = new Function(`return (${source});`)() as () => boolean;
    let done = false;
    const settle = (): boolean => {
      let matched = false;
      try {
        matched = predicate() === true;
      } catch {
        matched = false;
      }
      if (done || !matched) return false;
      done = true;
      void window.__dualSettle!(token);
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

function readState(): BrowserSurfaceState {
  const app = document.querySelector(".app") as HTMLElement | null;
  const text = (id: string): string => document.getElementById(id)?.textContent?.trim() ?? "";
  const compileStatus = document.getElementById("compile-status");
  const selectedRow = document.querySelector("#session-list .session-row--selected");
  return {
    connection: document.documentElement.dataset.connection ?? "unknown",
    connectionState: app?.dataset.connectionState ?? null,
    capturePhase: app?.dataset.capturePhase ?? null,
    uiState: app?.dataset.uiState ?? null,
    shell: app?.dataset.shell ?? null,
    capturing: app?.classList.contains("app--capturing") === true,
    captureTimerText: text("capture-timer"),
    liveTimerText: text("live-topbar-timer"),
    recordPressed: document.getElementById("btn-record")?.getAttribute("aria-pressed") ?? null,
    transcriptTexts: [...document.querySelectorAll("#transcript-stream .feed-line")].map(
      (node) => (node.querySelector(".feed-line__text") ?? node).textContent?.trim() ?? "",
    ),
    transcriptLineCount: document.querySelectorAll("#transcript-stream .feed-line").length,
    captionText: text("caption-text"),
    selectedMeetingTitle:
      selectedRow?.querySelector(".session-row__title")?.textContent?.trim() ?? null,
    selectedMeetingIds: [...document.querySelectorAll("#session-list .session-row--selected")].map(
      (node) => (node as HTMLElement).dataset.meetingId ?? "",
    ),
    meetingTitles: [...document.querySelectorAll("#session-list .session-row__title")].map(
      (node) => node.textContent?.trim() ?? "",
    ),
    slideTitle: document.querySelector("#current-slide .slide__title")?.textContent?.trim() ?? null,
    statusText: text("status-text"),
    compileStatusState: compileStatus?.dataset.state ?? null,
    compileStatusHidden: compileStatus?.hasAttribute("hidden") ?? true,
  };
}

export interface BrowserClientOptions {
  /** Scheme+host+port of the fixture session. Used for request allow-listing. */
  origin: string;
  /**
   * Identifies this surface to the session, so one client can be severed
   * without touching the other. Carried as a query parameter the page's own
   * WebSocket URL inherits from `location`.
   */
  clientLabel: string;
  clockEpochMs: number;
  locale?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
}

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    args: ["--no-sandbox", "--force-device-scale-factor=1", "--font-render-hinting=none"],
  });
}

export async function createBrowserSurfaceClient(
  browser: Browser,
  options: BrowserClientOptions,
): Promise<BrowserSurfaceClient> {
  const page = await browser.newPage();
  const settleWaiters = new Map<string, () => void>();
  let tokenCounter = 0;

  await page.exposeFunction("__dualSettle", (token: string) => {
    settleWaiters.get(token)?.();
  });
  await page.emulateTimezone(options.timezone ?? "Asia/Seoul");
  await page.setExtraHTTPHeaders({ "Accept-Language": options.locale ?? "ko-KR" });
  await page.evaluateOnNewDocument(pageBootstrap, options.clockEpochMs);
  await page.setViewport({ ...(options.viewport ?? { width: 1244, height: 836 }), deviceScaleFactor: 1 });

  await page.setRequestInterception(true);
  page.on("request", (request: HTTPRequest) => {
    const url = request.url();
    if (url.startsWith(options.origin) || url.startsWith("data:") || url === "about:blank") {
      void request.continue();
      return;
    }
    // No fixture may depend on the network; remote font/CSS links are stubbed.
    if (request.resourceType() === "stylesheet") {
      void request.respond({ status: 200, contentType: "text/css", body: ":root{--dual-fixture-fonts:local}" });
      return;
    }
    void request.abort();
  });

  const pageUrl = `${options.origin}/?client=${encodeURIComponent(options.clientLabel)}`;

  async function navigate(): Promise<void> {
    await page.goto(pageUrl, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  }

  await navigate();

  function expect(
    label: string,
    predicateSource: BrowserPredicateSource,
    timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
  ): Promise<void> {
    const token = `dual-${(tokenCounter += 1)}`;
    const settled = new Promise<void>((resolve) => {
      settleWaiters.set(token, resolve);
    });
    // Arming is awaited before the caller fires its trigger.
    const armed = page.evaluate(
      (t: string, source: string) => window.__dualAwait!(t, source),
      token,
      predicateSource,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(async () => {
        let snapshot: unknown = null;
        try {
          snapshot = await page.evaluate(readState);
        } catch {
          snapshot = "unavailable";
        }
        reject(new BrowserStateTimeoutError(label, timeoutMs, snapshot));
      }, timeoutMs);
    });
    return armed.then(() =>
      Promise.race([settled, bounded]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        settleWaiters.delete(token);
      }),
    );
  }

  return {
    page,
    expect,
    read() {
      return page.evaluate(readState) as Promise<BrowserSurfaceState>;
    },
    async click(selector) {
      const ok = await page.evaluate((sel: string) => {
        const target = document.querySelector(sel);
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
      }, selector);
      if (!ok) throw new Error(`dual-surface browser click target not found: ${selector}`);
    },
    async doubleClick(selector) {
      const count = await page.evaluate((sel: string) => {
        const target = document.querySelector(sel);
        if (!(target instanceof HTMLElement)) return 0;
        // Both activations happen in ONE task, before any server frame can be
        // processed: exactly the rapid double-Stop the contract must survive.
        target.click();
        target.click();
        return 2;
      }, selector);
      if (count !== 2) throw new Error(`dual-surface browser click target not found: ${selector}`);
    },
    async reload() {
      await navigate();
    },
    screenshot() {
      return page.screenshot({ type: "png", captureBeyondViewport: false }) as Promise<Uint8Array>;
    },
    async close() {
      await page.close();
    },
  };
}
