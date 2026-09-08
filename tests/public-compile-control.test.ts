import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.goto(harness.origin, { waitUntil: "load" });
  await harness.clientConnected;
});

afterAll(async () => {
  await browser?.close();
  harness.stop();
});

describe("컴파일 컨트롤", () => {
  test("PowerPoint 생성은 하나의 명확한 주 버튼으로 제공한다", async () => {
    expect(await page.$("#btn-export-pptx")).toBeNull();
    expect(await page.$$eval("#btn-compile-deck", (buttons) => buttons.map((button) => ({
      text: button.textContent?.trim(),
      title: button.getAttribute("title"),
      ariaLabel: button.getAttribute("aria-label"),
    })))).toEqual([{
      text: "슬라이드 초안 만들기",
      title: "지금까지의 대화로 편집 가능한 PowerPoint 초안 만들기",
      ariaLabel: "슬라이드 초안 만들기",
    }]);
  });

  test("녹음 중 전사가 비어 있으면 녹음이 아니라 대화 내용이 필요하다고 안내한다", async () => {
    harness.pushMessage({ type: "capture", capturing: true, mode: "mic", phase: "capturing" });
    await page.waitForFunction(() =>
      (document.getElementById("btn-record") as HTMLButtonElement)?.textContent?.includes("녹음 중지"),
    );
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck");
    expect(await page.$eval("#status-text", (node) => node.textContent?.trim()))
      .toBe("슬라이드를 만들 대화 내용이 아직 없습니다");
    harness.pushMessage({ type: "capture", capturing: false, mode: "mic", phase: "idle" });
    await page.waitForFunction(() =>
      !(document.querySelector(".app") as HTMLElement)?.classList.contains("app--capturing"),
    );
  });

  test("요청을 보내고 진행·완료·실패 상태와 생성 결과를 사용자에게 표시한다", async () => {
    harness.pushMessage({ type: "line", seq: 1, ts: Date.now(), text: "금요일에 출시하기로 결정했습니다", speaker: 1 });
    await page.waitForFunction(() => document.getElementById("transcript-count")?.textContent === "1");
    const action = harness.nextClientMessage();
    // Todo 13 homes compile inside the one contextual disclosure (DESIGN 9.11
    // puts compile behind the More menu). Puppeteer's click requires a visible
    // target, so the test opens the disclosure first - exactly as a user does.
    // Every assertion below is unchanged.
    await page.click("#dock-more > summary");
    await page.click("#btn-compile-deck");
    expect(await action).toEqual({ action: "compileSlidePlan" });
    expect(await page.$eval("#btn-compile-deck", (button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval("#btn-record", (button) => (button as HTMLButtonElement).disabled)).toBe(false);

    harness.pushMessage({ type: "compile", status: "started", meetingId: 1 });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent === "슬라이드 초안을 만드는 중…");
    harness.pushMessage({
      type: "compile",
      status: "success",
      meetingId: 1,
      publicationStatus: "draft",
      path: "exports/deck-ok/slides",
      outline: { title: "출시 덱", style: "scene-graph", slideCount: 2, usedFallback: false, plannerError: null },
      scene: {
        meetingId: 1,
        title: "출시 덱",
        width: 100,
        height: 56.25,
        slides: [
          { id: "slide-1", intent: "cover", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "출시 덱", x: 6, y: 20, w: 80, h: 12, fontSize: 38, color: "14213D" },
          ] },
          { id: "slide-2", intent: "decision", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "출시일 확정", x: 6, y: 11, w: 84, h: 10, fontSize: 28, color: "14213D" },
            { type: "text", role: "statement", text: "금요일에 출시합니다", x: 10, y: 29, w: 80, h: 10, fontSize: 25, color: "14213D" },
          ] },
        ],
      },
    });
    await page.waitForFunction(() =>
      (document.getElementById("compile-status") as HTMLElement)?.dataset.state === "success");
    expect(await page.$eval("#history-count", (element) => element.textContent)).toBe("2장");
    expect(await page.$eval("#current-slide", (element) => element.textContent)).toContain("출시 덱");
    expect(await page.$eval("#btn-compile-deck", (button) => (button as HTMLButtonElement).disabled)).toBe(false);

    harness.pushMessage({ type: "compile", status: "error", meetingId: 1, error: "planner unavailable" });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent?.includes("planner unavailable"));
    const state = await page.$eval("#compile-status", (status) => ({
      text: status.textContent,
      state: (status as HTMLElement).dataset.state,
      role: status.getAttribute("role"),
    }));
    expect(state).toEqual({ text: "슬라이드를 만들지 못했습니다: planner unavailable", state: "error", role: "status" });

    harness.pushMessage({
      type: "export",
      status: "error",
      action: "exportPdf",
      code: "compile-busy",
      error: "Deck compile is in progress; export was not started",
    });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "슬라이드를 만드는 중에는 다른 파일을 저장할 수 없습니다");
  });

  test("retired scene payloads cannot displace restored MeetingCard history", async () => {
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 7, title: "복원 회의", started_at: 1_700_000_000_000, status: "ended" }],
    });
    await page.waitForSelector('.session-row[data-meeting-id="7"]');
    const selection = harness.nextClientMessage();
    await page.click('.session-row[data-meeting-id="7"]');
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: 7 });

    harness.pushMessage({
      type: "meeting",
      meetingId: 7,
      title: "복원 회의",
      transcript: [{ text: "금요일에 출시합니다", ts: 1_700_000_000_100 }],
      current: {
        index: 1,
        title: "복원 MeetingCard",
        bullets: ["금요일에 출시합니다"],
        startedAt: 1_700_000_000_100,
        sentenceCount: 1,
      },
      history: [],
      compiled: null,
      scene: {
        meetingId: 7,
        title: "복원 덱",
        width: 100,
        height: 56.25,
        slides: [
          { id: "slide-1", intent: "cover", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "복원 덱", x: 6, y: 20, w: 80, h: 12, fontSize: 38, color: "14213D" },
          ] },
          { id: "slide-2", intent: "decision", background: "F6F1E8", elements: [
            { type: "text", role: "title", text: "복원된 결정", x: 6, y: 11, w: 84, h: 10, fontSize: 28, color: "14213D" },
            { type: "text", role: "statement", text: "금요일에 출시합니다", x: 10, y: 29, w: 80, h: 10, fontSize: 25, color: "14213D" },
          ] },
        ],
      },
    });

    await page.waitForFunction(() =>
      document.getElementById("current-slide")?.textContent?.includes("복원 MeetingCard"),
    );
    const restored = await page.$eval("#current-slide", (element) => element.textContent ?? "");
    expect(restored).toContain("복원 MeetingCard");
    expect(restored).not.toContain("복원 덱");
    expect(await page.$eval("#transcript-count", (element) => element.textContent)).toBe("1");
  });

  test("SlidePlan 출판이 있으면 레거시 compiled가 없어도 컴파일 상태를 보여 준다", async () => {
    await openPublishedMeeting(21, "SlidePlan 회의");
    const status = await page.$eval("#compile-status", (element) => ({
      hidden: (element as HTMLElement).hidden,
      text: element.textContent?.trim() ?? "",
    }));
    expect(status.hidden).toBe(false);
    expect(status.text.length).toBeGreaterThan(0);
  }, 15_000);

  test("dirty confirmed draft cancel is non-destructive and accept is one compile shot", async () => {
    await openPublishedMeeting(22, "확정 검토 회의", confirmedReview(22));
    await page.select("[data-slide-layout]", "timeline");
    await page.waitForFunction(() =>
      document.querySelector('[data-slide-plan-export][aria-disabled="true"]') !== null,
    );
    const before = await workspaceSnapshot();

    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck");
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    expect(await page.evaluate(() => {
      const dialog = document.getElementById("slide-final-rebuild-dialog")!;
      const titleId = dialog.getAttribute("aria-labelledby")!;
      const bodyId = dialog.getAttribute("aria-describedby")!;
      return {
        role: dialog.getAttribute("role"),
        modal: dialog.getAttribute("aria-modal"),
        title: document.getElementById(titleId)?.textContent?.trim(),
        body: document.getElementById(bodyId)?.textContent?.trim(),
        focus: document.activeElement?.id,
      };
    })).toEqual({
      role: "dialog",
      modal: "true",
      title: "확정본을 새로 만들까요?",
      body: "검토가 확정되어 현재 초안의 로컬 편집은 확정본에 저장할 수 없습니다. 새 확정본은 확정된 검토 내용으로 다시 만들며, 저장된 초안은 그대로 남습니다. 현재 로컬 편집은 확정본에 포함되지 않습니다.",
      focus: "btn-slide-final-rebuild-cancel",
    });

    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btn-slide-final-rebuild-confirm");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btn-slide-final-rebuild-cancel");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden
      && document.activeElement?.id === "btn-compile-deck",
    );
    expect(await workspaceSnapshot()).toEqual(before);

    await page.click("#btn-compile-deck");
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    const cancelSentinel = harness.nextClientMessage();
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden
      && document.activeElement?.id === "btn-compile-deck",
    );
    await page.click("#btn-export-md");
    expect(await cancelSentinel).toEqual({ action: "saveNotes", meetingId: 22 });
    expect(await workspaceSnapshot()).toEqual(before);

    await page.click("#btn-compile-deck");
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    const compile = harness.nextClientMessage();
    const disabledSynchronously = await page.$eval("#btn-slide-final-rebuild-confirm", (node) => {
      const confirm = node as HTMLButtonElement;
      confirm.click();
      confirm.click();
      return {
        cancel: (document.getElementById("btn-slide-final-rebuild-cancel") as HTMLButtonElement).disabled,
        confirm: confirm.disabled,
      };
    });
    expect(disabledSynchronously).toEqual({ cancel: true, confirm: true });
    await page.keyboard.press("Enter");
    expect(await compile).toEqual({ action: "compileSlidePlan", meetingId: 22 });
    const duplicateSentinel = harness.nextClientMessage();
    await page.click("#btn-export-md");
    expect(await duplicateSentinel).toEqual({ action: "saveNotes", meetingId: 22 });
    expect(await workspaceSnapshot()).toEqual(before);
    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-decision", meetingId: 22,
      error: "decision test complete",
    });
    await page.waitForFunction(() =>
      !(document.getElementById("btn-compile-deck") as HTMLButtonElement).disabled
      && (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden,
    );
  }, 20_000);

  test("lineage frame matrix admits only the selected meeting current compile terminal", async () => {
    await openPublishedMeeting(42, "계보 프레임 행렬", confirmedReview(42));
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden,
    );
    await page.select("[data-slide-layout]", "timeline");
    await page.evaluate(() => {
      const dialog = document.getElementById("slide-final-rebuild-dialog")!;
      const state = window as typeof window & {
        __lineageDialogOpenCount?: number;
        __lineageDialogObserver?: MutationObserver;
      };
      state.__lineageDialogOpenCount = 0;
      state.__lineageDialogObserver?.disconnect();
      state.__lineageDialogObserver = new MutationObserver(() => {
        if (!(dialog as HTMLElement).hidden) state.__lineageDialogOpenCount = (state.__lineageDialogOpenCount ?? 0) + 1;
      });
      state.__lineageDialogObserver.observe(dialog, { attributes: true, attributeFilter: ["hidden"] });
    });

    harness.pushMessage({
      type: "compile", status: "error", jobId: "other-meeting-job", meetingId: 999,
      code: "stale-review-lineage", error: "localized prose is irrelevant",
    });
    harness.pushMessage({ type: "compile", status: "started", jobId: "compile-current-42", meetingId: 42 });
    await page.waitForFunction(() =>
      (document.getElementById("compile-status") as HTMLElement).dataset.state === "started",
    );
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-stale-42", meetingId: 42,
      code: "stale-review-lineage", error: "stale terminal",
    });
    harness.pushMessage({
      type: "compile", status: "progress", jobId: "compile-current-42", meetingId: 42,
      stage: "planning", completed: 1, total: 2,
    });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent?.includes("1/2"));
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-current-42", meetingId: 42,
      code: "stale-review-lineage", error: "current lineage",
    });
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    expect(await page.evaluate(() =>
      (window as typeof window & { __lineageDialogOpenCount?: number }).__lineageDialogOpenCount)).toBe(1);
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() => (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden);

    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-current-42", meetingId: 42,
      code: "stale-review-lineage", error: "duplicate terminal",
    });
    harness.pushMessage({ type: "compile", status: "started", jobId: "compile-prose-42", meetingId: 42 });
    await page.waitForFunction(() =>
      (document.getElementById("compile-status") as HTMLElement).dataset.state === "started",
    );
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);
    expect(await page.evaluate(() =>
      (window as typeof window & { __lineageDialogOpenCount?: number }).__lineageDialogOpenCount)).toBe(1);

    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-prose-42", meetingId: 42,
      error: "stale-review-lineage 문구만 있는 오류",
    });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent?.includes("문구만 있는 오류"));
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    harness.pushMessage({ type: "compile", status: "started", jobId: "compile-code-42", meetingId: 42 });
    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-code-42", meetingId: 42,
      code: "review-failed", error: "unrelated code",
    });
    await page.waitForFunction(() => document.getElementById("compile-status")?.textContent?.includes("unrelated code"));
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    const noSendSentinel = harness.nextClientMessage();
    await page.click("#btn-export-md");
    expect(await noSendSentinel).toEqual({ action: "saveNotes", meetingId: 42 });
    await page.evaluate(() => {
      const state = window as typeof window & { __lineageDialogObserver?: MutationObserver };
      state.__lineageDialogObserver?.disconnect();
      delete state.__lineageDialogObserver;
    });
  }, 20_000);

  test("same job id wrong meeting terminals cannot clear the selected compile owner", async () => {
    await openPublishedMeeting(42, "동일 작업 ID 소유권", confirmedReview(42));
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden,
    );
    await page.select("[data-slide-layout]", "timeline");
    await page.evaluate(() => {
      const dialog = document.getElementById("slide-final-rebuild-dialog")!;
      const state = window as typeof window & {
        __sameJobOpenCount?: number;
        __sameJobObserver?: MutationObserver;
      };
      state.__sameJobOpenCount = 0;
      state.__sameJobObserver?.disconnect();
      state.__sameJobObserver = new MutationObserver(() => {
        if (!(dialog as HTMLElement).hidden) state.__sameJobOpenCount = (state.__sameJobOpenCount ?? 0) + 1;
      });
      state.__sameJobObserver.observe(dialog, { attributes: true, attributeFilter: ["hidden"] });
    });

    harness.pushMessage({ type: "compile", status: "started", jobId: "job-b", meetingId: 42 });
    harness.pushMessage({
      type: "compile", status: "error", jobId: "job-b", meetingId: 999,
      code: "stale-review-lineage", error: "same job id, wrong meeting",
    });
    harness.pushMessage({ type: "status", text: "wrong-error-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "wrong-error-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);
    harness.pushMessage({
      type: "compile", status: "error", jobId: "job-b", meetingId: 42,
      code: "stale-review-lineage", error: "legitimate owner after wrong error",
    });
    harness.pushMessage({ type: "status", text: "owner-error-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "owner-error-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(false);
    expect(await page.evaluate(() =>
      (window as typeof window & { __sameJobOpenCount?: number }).__sameJobOpenCount)).toBe(1);
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() => (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden);
    harness.pushMessage({
      type: "compile", status: "error", jobId: "job-b", meetingId: 42,
      code: "stale-review-lineage", error: "duplicate owner terminal",
    });
    harness.pushMessage({ type: "status", text: "duplicate-owner-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "duplicate-owner-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    harness.pushMessage({ type: "compile", status: "started", jobId: "job-success", meetingId: 42 });
    harness.pushMessage({ type: "compile", status: "success", jobId: "job-success", meetingId: 999 });
    harness.pushMessage({ type: "status", text: "wrong-success-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "wrong-success-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);
    harness.pushMessage({
      type: "compile", status: "error", jobId: "job-success", meetingId: 42,
      code: "stale-review-lineage", error: "legitimate owner after wrong success",
    });
    harness.pushMessage({ type: "status", text: "owner-after-success-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "owner-after-success-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(false);
    expect(await page.evaluate(() =>
      (window as typeof window & { __sameJobOpenCount?: number }).__sameJobOpenCount)).toBe(2);
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() => (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden);

    harness.pushMessage({ type: "compile", status: "started", jobId: "job-code", meetingId: 42 });
    harness.pushMessage({
      type: "compile", status: "error", jobId: "job-code", meetingId: 999,
      code: "review-failed", error: "wrong meeting unrelated code",
    });
    harness.pushMessage({ type: "status", text: "wrong-code-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "wrong-code-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);
    harness.pushMessage({
      type: "compile", status: "error", jobId: "job-code", meetingId: 42,
      code: "stale-review-lineage", error: "legitimate owner after unrelated code",
    });
    harness.pushMessage({ type: "status", text: "owner-after-code-processed" });
    await page.waitForFunction(() => document.getElementById("status-text")?.textContent === "owner-after-code-processed");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(false);
    expect(await page.evaluate(() =>
      (window as typeof window & { __sameJobOpenCount?: number }).__sameJobOpenCount)).toBe(3);
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() => (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden);

    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    const noSendSentinel = harness.nextClientMessage();
    await page.click("#btn-export-md");
    expect(await noSendSentinel).toEqual({ action: "saveNotes", meetingId: 42 });
    await page.evaluate(() => {
      const state = window as typeof window & { __sameJobObserver?: MutationObserver };
      state.__sameJobObserver?.disconnect();
      delete state.__sameJobObserver;
    });
  }, 20_000);

  test("compile retry and stale lineage handling use machine code without stale job interference", async () => {
    await openPublishedMeeting(25, "계보 검증 회의", { ...confirmedReview(25), status: "draft" });
    harness.pushMessage({
      type: "reviewConfirmed", meetingId: 25, reviewId: "review-25",
      transcriptVersionId: "transcript-v1", confirmedAt: 1_700_000_000_000,
    });
    await page.select("[data-slide-layout]", "timeline");
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck");
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    const firstCompile = harness.nextClientMessage();
    await page.click("#btn-slide-final-rebuild-confirm");
    expect(await firstCompile).toEqual({ action: "compileSlidePlan", meetingId: 25 });
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden,
    );

    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-first", meetingId: 25,
      error: "temporary failure",
    });
    await page.waitForSelector(".job-retry");
    const retryCompile = harness.nextClientMessage();
    await page.click(".job-retry");
    expect(await retryCompile).toEqual({ action: "compileSlidePlan", meetingId: 25 });

    harness.pushMessage({ type: "compile", status: "started", jobId: "compile-current", meetingId: 25 });
    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-stale", meetingId: 25,
      code: "stale-review-lineage", error: "확정 검토가 오래되었습니다",
    });
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-current", meetingId: 25,
      error: "stale-review-lineage 문구만 있는 오류",
    });
    await page.waitForSelector(".job-retry");
    expect(await page.$eval("#slide-final-rebuild-dialog", (node) => (node as HTMLElement).hidden)).toBe(true);

    harness.pushMessage({ type: "compile", status: "started", jobId: "compile-lineage", meetingId: 25 });
    harness.pushMessage({
      type: "compile", status: "error", jobId: "compile-lineage", meetingId: 25,
      code: "stale-review-lineage", error: "localized text may change",
    });
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btn-slide-final-rebuild-cancel");
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden,
    );
  }, 20_000);

  test("confirmed Review context atomically exposes final copy before and during compilation", async () => {
    page.once("dialog", (dialog) => dialog.accept());
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 61, title: "확정본 준비 회의", started_at: 1_700_000_300_000, status: "ended" }],
    });
    await page.waitForSelector('.session-row[data-meeting-id="61"]');
    const selection = harness.nextClientMessage();
    await page.click('.session-row[data-meeting-id="61"]');
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: 61 });
    await armDomSignal("confirmed-meeting", "#status-text", "확정본 준비 회의 기록을 불러왔습니다");
    harness.pushMessage({
      type: "meeting",
      meetingId: 61,
      title: "확정본 준비 회의",
      transcript: [{ text: "확정된 내용을 발표합니다", ts: 1_700_000_300_100 }],
      current: null,
      history: [],
      compiled: null,
      slidePlan: null,
      review: confirmedReview(61),
    });
    await waitForDomSignal("confirmed-meeting");

    expect(await page.evaluate(() => ({
      controlCount: document.querySelectorAll("#btn-compile-deck").length,
      text: document.getElementById("btn-compile-deck")?.textContent?.trim(),
      title: document.getElementById("btn-compile-deck")?.getAttribute("title"),
      ariaLabel: document.getElementById("btn-compile-deck")?.getAttribute("aria-label"),
      placeholder: document.querySelector("#current-slide .placeholder__sub")?.textContent?.trim(),
      workspaceLabel: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("aria-label"),
      confirmedCopy: [
        document.getElementById("btn-compile-deck")?.textContent,
        document.getElementById("btn-compile-deck")?.getAttribute("title"),
        document.getElementById("btn-compile-deck")?.getAttribute("aria-label"),
        document.querySelector("#current-slide .slide__placeholder")?.textContent,
      ].join(" "),
    }))).toEqual({
      controlCount: 1,
      text: "슬라이드 확정본 만들기",
      title: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      ariaLabel: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      placeholder: "확정된 검토 내용으로 편집 가능한 PowerPoint 확정본을 만듭니다",
      workspaceLabel: "편집 가능한 슬라이드 확정본",
      confirmedCopy: expect.not.stringContaining("초안"),
    });

    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    const compile = harness.nextClientMessage();
    await page.click("#btn-compile-deck");
    expect(await compile).toEqual({ action: "compileSlidePlan", meetingId: 61 });
    await armDomSignal("final-building", "#compile-status", "확정본을 만드는 중…");
    harness.pushMessage({ type: "compile", status: "started", jobId: "final-61", meetingId: 61 });
    await waitForDomSignal("final-building");
    expect(await page.$eval("#compile-status", (node) => node.textContent?.trim())).toBe("확정본을 만드는 중…");
    await armDomSignal("final-error-retry", ".job-retry");
    harness.pushMessage({
      type: "compile", status: "error", jobId: "final-61", meetingId: 61,
      error: "confirmed copy test complete",
    });
    await waitForDomSignal("final-error-retry");
  }, 15_000);

  test("malformed distinct Review replacement cannot mutate confirmed publication authority", async () => {
    await armDomSignal("invalid-review-meeting-row", '.session-row[data-meeting-id="71"]');
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 71, title: "잘못된 교체 검증", started_at: 1_700_000_500_000, status: "ended" }],
    });
    await waitForDomSignal("invalid-review-meeting-row");
    const selection = harness.nextClientMessage();
    await page.click('.session-row[data-meeting-id="71"]');
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: 71 });

    await armDomSignal("invalid-review-authority", "#status-text", "잘못된 교체 검증 기록을 불러왔습니다");
    harness.pushMessage({
      type: "meeting", meetingId: 71, title: "잘못된 교체 검증",
      transcript: [{ text: "현재 검토가 확정되었습니다", ts: 1_700_000_500_100 }],
      current: null, history: [], compiled: null, slidePlan: null,
      review: {
        ...confirmedReview(71),
        reviewId: "review-71",
        confirmedAt: 1_700_000_000_000,
      },
    });
    await waitForDomSignal("invalid-review-authority");

    await armDomSignal("invalid-review-processed", "#status-text", "invalid-review-processed");
    harness.pushMessage({
      type: "review",
      meetingId: 71,
      reviewId: "invalid-replacement",
      status: "draft",
      confirmedAt: null,
      attendees: null,
      transcript: null,
      items: "invalid",
    });
    harness.pushMessage({ type: "status", text: "invalid-review-processed" });
    await waitForDomSignal("invalid-review-processed");

    expect(await publicationCopySnapshot()).toEqual({
      text: "슬라이드 확정본 만들기",
      title: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      ariaLabel: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      placeholder: "확정된 검토 내용으로 편집 가능한 PowerPoint 확정본을 만듭니다",
      workspaceLabel: "편집 가능한 슬라이드 확정본",
      workspaceStatus: "저장된 확정본이 없습니다",
    });
  }, 15_000);

  test("confirmed Review lineage rejects reordered downgrade while replacements and snapshots remain authoritative", async () => {
    await armDomSignal("lineage-meeting-row", '.session-row[data-meeting-id="62"]');
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 62, title: "순서 역전 검증", started_at: 1_700_000_400_000, status: "ended" }],
    });
    await waitForDomSignal("lineage-meeting-row");
    const selection = harness.nextClientMessage();
    await page.click('.session-row[data-meeting-id="62"]');
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: 62 });

    const currentConfirmed = {
      ...confirmedReview(62),
      reviewId: "review-current",
      confirmedAt: 1_700_000_000_100,
    };
    await armDomSignal("lineage-current-confirmed", "#status-text", "순서 역전 검증 기록을 불러왔습니다");
    harness.pushMessage({
      type: "meeting", meetingId: 62, title: "순서 역전 검증",
      transcript: [{ text: "현재 검토가 확정되었습니다", ts: 1_700_000_400_100 }],
      current: null, history: [], compiled: null, slidePlan: null, review: currentConfirmed,
    });
    await waitForDomSignal("lineage-current-confirmed");
    expect(await publicationCopySnapshot()).toMatchObject({
      text: "슬라이드 확정본 만들기",
      title: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      ariaLabel: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      placeholder: "확정된 검토 내용으로 편집 가능한 PowerPoint 확정본을 만듭니다",
      workspaceLabel: "편집 가능한 슬라이드 확정본",
    });

    await armDomSignal("same-lineage-stale-processed", "#status-text", "same-lineage-stale-processed");
    harness.pushMessage({
      ...currentConfirmed,
      status: "draft",
      confirmedAt: null,
    });
    harness.pushMessage({ type: "status", text: "same-lineage-stale-processed" });
    await waitForDomSignal("same-lineage-stale-processed");
    expect(await publicationCopySnapshot()).toEqual({
      text: "슬라이드 확정본 만들기",
      title: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      ariaLabel: "확정된 검토 내용으로 슬라이드 확정본 만들기",
      placeholder: "확정된 검토 내용으로 편집 가능한 PowerPoint 확정본을 만듭니다",
      workspaceLabel: "편집 가능한 슬라이드 확정본",
      workspaceStatus: "저장된 확정본이 없습니다",
    });

    await armDomSignal("wrong-meeting-stale-processed", "#status-text", "wrong-meeting-stale-processed");
    harness.pushMessage({
      ...currentConfirmed,
      meetingId: 999,
      status: "draft",
      confirmedAt: null,
    });
    harness.pushMessage({ type: "status", text: "wrong-meeting-stale-processed" });
    await waitForDomSignal("wrong-meeting-stale-processed");
    expect((await publicationCopySnapshot()).text).toBe("슬라이드 확정본 만들기");

    await armDomSignal("replacement-review", "#btn-compile-deck", "슬라이드 초안 만들기");
    harness.pushMessage({
      ...confirmedReview(62),
      reviewId: "review-replacement",
      status: "draft",
      confirmedAt: null,
    });
    await waitForDomSignal("replacement-review");
    expect(await publicationCopySnapshot()).toMatchObject({
      text: "슬라이드 초안 만들기",
      workspaceLabel: "편집 가능한 슬라이드 초안",
      workspaceStatus: "저장된 초안이 없습니다",
    });

    await armDomSignal("snapshot-confirmed", "#status-text", "교체 검토 확정 기록을 불러왔습니다");
    harness.pushMessage({
      type: "meeting", meetingId: 62, title: "교체 검토 확정", transcript: [],
      current: null, history: [], compiled: null, slidePlan: null,
      review: { ...currentConfirmed, reviewId: "review-replacement" },
    });
    await waitForDomSignal("snapshot-confirmed");
    expect((await publicationCopySnapshot()).text).toBe("슬라이드 확정본 만들기");

    await armDomSignal("snapshot-draft", "#status-text", "권위 스냅샷 기록을 불러왔습니다");
    harness.pushMessage({
      type: "meeting", meetingId: 62, title: "권위 스냅샷", transcript: [],
      current: null, history: [], compiled: null, slidePlan: null,
      review: {
        ...currentConfirmed,
        reviewId: "review-replacement",
        status: "draft",
        confirmedAt: null,
      },
    });
    await waitForDomSignal("snapshot-draft");
    expect(await publicationCopySnapshot()).toMatchObject({
      text: "슬라이드 초안 만들기",
      workspaceLabel: "편집 가능한 슬라이드 초안",
      workspaceStatus: "저장된 초안이 없습니다",
    });
    if (!await page.$eval("#review-panel", (panel) => (panel as HTMLElement).hidden)) {
      await armDomSignal("lineage-review-panel-closed", "#review-panel[hidden]");
      await page.click("#btn-review-close");
      await waitForDomSignal("lineage-review-panel-closed");
    }
  }, 20_000);

  test("an authoritative confirmed review frame opens the decision for the selected dirty draft", async () => {
    await openPublishedMeeting(26, "검토 프레임 회의");
    harness.pushMessage(confirmedReview(26));
    await page.waitForSelector("#review-panel:not([hidden])");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (document.getElementById("review-panel") as HTMLElement).hidden);
    await page.select("[data-slide-layout]", "timeline");
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-compile-deck");
    await page.waitForSelector("#slide-final-rebuild-dialog:not([hidden])");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btn-slide-final-rebuild-cancel");
    await page.click("#btn-slide-final-rebuild-cancel");
    await page.waitForFunction(() =>
      (document.getElementById("slide-final-rebuild-dialog") as HTMLElement).hidden,
    );
  }, 15_000);

  test("웹 슬라이드는 SlidePlan 출판의 standalone HTML을 연다", async () => {
    await openPublishedMeeting(23, "웹 슬라이드 회의");
    await page.evaluate(() => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
      window.open = (url?: string | URL) => {
        (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
        return null;
      };
    });
    const action = harness.nextClientMessage();
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-export-deck");
    expect(await action).toEqual({ action: "exportDeck", meetingId: 23 });
    expect(await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls)).toEqual([
      "/slide-plan-artifacts/plan%3Alaunch/standalone/index.html",
    ]);
  }, 15_000);

  test("웹 슬라이드는 SlidePlan 출판이 없으면 초안을 먼저 만들라고 한다", async () => {
    page.once("dialog", (dialog) => dialog.accept());
    harness.pushMessage({
      type: "meetings",
      items: [{ id: 24, title: "초안 없음", started_at: 1_700_000_200_000, status: "ended" }],
    });
    await page.waitForSelector('.session-row[data-meeting-id="24"]');
    const selection = harness.nextClientMessage();
    await page.click('.session-row[data-meeting-id="24"]');
    expect(await selection).toEqual({ action: "selectMeeting", meetingId: 24 });
    harness.pushMessage({
      type: "meeting",
      meetingId: 24,
      title: "초안 없음",
      transcript: [{ text: "아직 덱이 없습니다", ts: 1_700_000_200_100 }],
      current: null,
      history: [],
      compiled: null,
    });
    await page.waitForFunction(() =>
      document.getElementById("status-text")?.textContent?.includes("초안 없음"),
    );
    await page.evaluate(() => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
      window.open = (url?: string | URL) => {
        (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
        return null;
      };
    });
    await page.$eval("#dock-more", (node) => { (node as HTMLDetailsElement).open = true; });
    await page.click("#btn-export-deck");
    expect(await page.$eval("#status-text", (node) => node.textContent?.trim()))
      .toBe("먼저 슬라이드 초안을 만들어 주세요");
    expect(await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls)).toEqual([]);
  }, 15_000);

});

async function armDomSignal(key: string, selector: string, expectedText?: string): Promise<void> {
  await page.evaluate(({ signalKey, targetSelector, targetText }) => {
    const state = window as typeof window & { __todo6Signals?: Record<string, Promise<void>> };
    state.__todo6Signals ??= {};
    state.__todo6Signals[signalKey] = new Promise<void>((resolve) => {
      const matches = () => {
        const target = document.querySelector(targetSelector);
        if (!target) return false;
        return targetText === undefined || target.textContent?.trim() === targetText;
      };
      if (matches()) {
        resolve();
        return;
      }
      const observer = new MutationObserver(() => {
        if (!matches()) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    });
  }, { signalKey: key, targetSelector: selector, targetText: expectedText });
}

function waitForDomSignal(key: string): Promise<void> {
  return page.evaluate((signalKey) => {
    const state = window as typeof window & { __todo6Signals?: Record<string, Promise<void>> };
    return state.__todo6Signals?.[signalKey]
      ?? Promise.reject(new DOMException(`missing DOM signal ${signalKey}`, "InvalidStateError"));
  }, key);
}

async function openPublishedMeeting(
  meetingId: number,
  title: string,
  review?: Record<string, unknown>,
): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  harness.pushMessage({
    type: "meetings",
    items: [{ id: meetingId, title, started_at: 1_700_000_100_000, status: "ended" }],
  });
  await page.waitForSelector(`.session-row[data-meeting-id="${meetingId}"]`);
  const alreadySelected = await page.$(`.session-row--selected[data-meeting-id="${meetingId}"]`);
  if (!alreadySelected) {
    const selection = harness.nextClientMessage();
    await page.click(`.session-row[data-meeting-id="${meetingId}"]`);
    expect(await selection).toEqual({ action: "selectMeeting", meetingId });
  }
  harness.pushMessage({
    type: "meeting",
    meetingId,
    title,
    transcript: [{ text: "금요일에 출시합니다", ts: 1_700_000_100_100 }],
    current: null,
    history: [],
    compiled: null,
    review,
    slidePlan: {
      plan: slidePlanFixture(), path: "exports/plan", publicationSha256: "a".repeat(64),
      publicationStatus: "draft", publishedAt: 1,
    },
  });
  await page.waitForSelector("[data-slide-plan-workspace]:not([hidden])");
  await page.waitForFunction((expectedTitle) =>
    document.getElementById("status-text")?.textContent === `${expectedTitle} 기록을 불러왔습니다`,
  {}, title);
}

async function publicationCopySnapshot(): Promise<Record<string, string | null>> {
  return page.evaluate(() => ({
    text: document.getElementById("btn-compile-deck")?.textContent?.trim() ?? null,
    title: document.getElementById("btn-compile-deck")?.getAttribute("title") ?? null,
    ariaLabel: document.getElementById("btn-compile-deck")?.getAttribute("aria-label") ?? null,
    placeholder: document.querySelector("#current-slide .placeholder__sub")?.textContent?.trim() ?? null,
    workspaceLabel: document.querySelector("[data-slide-plan-workspace]")?.getAttribute("aria-label") ?? null,
    workspaceStatus: document.querySelector("[data-slide-plan-status]")?.textContent?.trim() ?? null,
  }));
}

async function workspaceSnapshot(): Promise<unknown> {
  return page.evaluate(() => {
    const workspace = (window as typeof window & {
      __slidePlanWorkspace?: {
        currentPlan: () => unknown;
        currentPublicationStatus: () => string | null;
        isDirty: () => boolean;
      };
    }).__slidePlanWorkspace;
    const plan = workspace?.currentPlan();
    return {
      plan: plan === undefined ? null : JSON.parse(JSON.stringify(plan)),
      publicationStatus: workspace?.currentPublicationStatus() ?? null,
      dirty: workspace?.isDirty() ?? false,
    };
  });
}

function confirmedReview(meetingId: number): Record<string, unknown> {
  return {
    type: "review",
    meetingId,
    reviewId: `review-${meetingId}`,
    transcriptVersionId: "transcript-v1",
    status: "confirmed",
    confirmedAt: 1_700_000_000_000,
    attendees: [],
    transcript: { lines: [] },
    items: [],
  };
}

function slidePlanFixture() {
  const sha = "a".repeat(64);
  const theme = {
    id: "meeting-paper-v1", canvas: { width: 1280, height: 720 },
    font: { family: "Pretendard", localPath: "fonts/Pretendard.woff2", sha256: sha },
    colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" },
    spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
    typography: {
      display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 },
      body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 },
    },
    stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 },
  };
  const source = { transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Friday launch." };
  return {
    schemaVersion: 1, planId: "plan:launch", revision: 4,
    snapshot: { meetingId: 7, transcriptVersionId: "transcript-v1", contentSha256: sha, lineCount: 1 },
    title: "Launch review", theme,
    claims: [{ id: "claim-launch", kind: "decision", text: "Friday launch.", method: "reviewed", sources: [source] }], assets: [],
    slides: [
      {
        id: "opening", layout: "hero", storyRole: "opening", title: "Launch review",
        payload: { variant: "cover", statement: "Friday launch." },
        bindings: { title: ["claim-launch"], statement: ["claim-launch"] }, editorialPaths: [], assetIds: [], notes: "Welcome the room.",
      },
      {
        id: "decision", layout: "decision", storyRole: "decision", title: "Ship Friday",
        payload: { decision: "Friday launch.", rationale: ["Review complete."] },
        bindings: { title: ["claim-launch"], decision: ["claim-launch"], "rationale[0]": ["claim-launch"] },
        editorialPaths: [], assetIds: [], notes: "Confirm the owner.",
      },
    ], createdAt: "2026-08-14T10:00:00.000Z", updatedAt: "2026-08-14T10:05:00.000Z",
  };
}
