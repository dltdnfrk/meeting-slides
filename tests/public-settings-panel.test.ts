// 설정 패널 검증 — 실제 public/app.js + index.html을 브라우저에서 로드한다.
// 백엔드 계약(providers / sttModels 메시지, install·cancel·select·recheck 액션)만 사용하는 헤르메틱 스텁.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import type { ProvidersUpdate, SttModelsUpdate } from "../src/session.ts";
import { createPublicTestHarness } from "./public-test-harness.ts";

const harness = createPublicTestHarness();
let browser: Browser;
let page: Page;

/** 설치/인증 상태를 서버가 보내는 모양 그대로 만든다. */
function providers(overrides: Partial<ProvidersUpdate> = {}): ProvidersUpdate {
  return {
    type: "providers",
    current: "cli:codex",
    currentModel: "gpt-5.6-sol",
    currentEffort: "high",
    list: [
      {
        id: "cli:codex", label: "GPT (subscription)", detail: "Codex CLI",
        available: true, installed: true, auth: "connected",
        models: ["gpt-5.6-sol", "gpt-5.6-luna"], efforts: ["low", "medium", "high"],
      },
      {
        id: "cli:grok", label: "Grok (subscription)", detail: "Grok Build CLI",
        available: true, installed: true, auth: "unknown", models: ["grok-4.5"],
      },
      {
        id: "cli:claude", label: "Claude (subscription)", detail: "Claude CLI",
        available: true, installed: true, auth: "disconnected", models: ["opus", "sonnet"],
      },
      {
        id: "cli:gemini", label: "Gemini (subscription)", detail: "Gemini CLI",
        available: false, installed: false, auth: "unavailable", models: ["gemini-2.5-pro"],
      },
    ],
    ...overrides,
  };
}

function sttModels(overrides: Partial<SttModelsUpdate> = {}): SttModelsUpdate {
  return {
    type: "sttModels",
    selectedModelId: null,
    models: [
      { id: "small", label: "Small (Q8_0)", sizeBytes: 264_464_607, license: "MIT", status: "absent" },
      { id: "medium", label: "Medium (Q8_0)", sizeBytes: 823_369_779, license: "MIT", status: "absent" },
      { id: "large-v3-turbo", label: "Large v3 Turbo (Q8_0)", sizeBytes: 874_188_075, license: "MIT", status: "absent" },
      { id: "large-v3", label: "Large v3 (Q8_0)", sizeBytes: 1_656_538_283, license: "Apache-2.0", status: "absent" },
    ],
    ...overrides,
  };
}

/** 렌더 완료를 DOM 신호로 기다린다 — 고정 sleep 없음. */
function waitForStt(id: string, status: string): Promise<void> {
  return page.waitForFunction(
    (modelId: string, expected: string) =>
      document.querySelector(`.stt-row[data-id="${modelId}"]`)?.getAttribute("data-status") === expected,
    { timeout: 5_000 }, id, status,
  ).then(() => undefined);
}

function waitForProviderAuth(id: string, auth: string): Promise<void> {
  return page.waitForFunction(
    (providerId: string, expected: string) =>
      document.querySelector(`.provider-row[data-id="${providerId}"]`)?.getAttribute("data-auth") === expected,
    { timeout: 5_000 }, id, auth,
  ).then(() => undefined);
}

async function armPanelClosedWithTriggerFocus(): Promise<void> {
  await page.evaluate(() => {
    const panel = document.getElementById("provider-panel")!;
    const trigger = document.getElementById("btn-settings")!;
    (globalThis as unknown as { __panelClosed: Promise<void> }).__panelClosed =
      new Promise<void>((resolve, reject) => {
        const matches = () => panel.hasAttribute("hidden") && document.activeElement === trigger;
        const finish = () => {
          if (!matches()) return;
          clearTimeout(timer);
          observer.disconnect();
          window.removeEventListener("focusin", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          observer.disconnect();
          window.removeEventListener("focusin", finish);
          reject(new Error("settings panel did not close with trigger focus"));
        }, 5_000);
        const observer = new MutationObserver(finish);
        observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
        window.addEventListener("focusin", finish);
        finish();
      });
  });
}

async function awaitPanelClosedWithTriggerFocus(): Promise<void> {
  await page.evaluate(() =>
    (globalThis as unknown as { __panelClosed: Promise<void> }).__panelClosed,
  );
}

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

describe("AI 모델 설정 UI", () => {
  test("설치와 로그인 상태를 사용자 언어로 구분해 표시한다", async () => {
    harness.pushMessage(providers());
    await waitForProviderAuth("cli:gemini", "unavailable");

    const rows = await page.$$eval(".provider-row", (nodes) => nodes.map((node) => ({
      id: node.getAttribute("data-id"),
      auth: node.getAttribute("data-auth"),
      badge: node.querySelector(".provider-row__badge")?.textContent?.trim(),
      disabled: (node.querySelector(".provider-row__select") as HTMLButtonElement).disabled,
      connect: node.querySelector(".provider-row__connect")?.textContent?.trim(),
    })));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    // 네 개의 구독형 CLI 카드가 모두 보인다.
    expect(Object.keys(byId)).toEqual(expect.arrayContaining(["cli:codex", "cli:grok", "cli:claude", "cli:gemini"]));

    expect(byId["cli:codex"]).toMatchObject({ badge: "사용 가능", disabled: false, connect: "다시 로그인" });

    // auth=unknown은 사용 가능으로 속이지 않지만 설치되어 있으므로 선택은 가능하다.
    expect(byId["cli:grok"].badge).toBe("로그인 확인 필요");
    expect(byId["cli:grok"].badge).not.toBe("사용 가능");
    expect(byId["cli:grok"].disabled).toBe(false);

    expect(byId["cli:claude"]).toMatchObject({ badge: "로그인 필요", disabled: false, connect: "로그인" });
    expect(byId["cli:gemini"]).toMatchObject({ badge: "설치 필요", disabled: true });

    // 저장된 현재 선택이 모델/effort 셀렉트에 반영된다.
    expect(await page.$eval("#select-model", (el) => (el as HTMLSelectElement).value)).toBe("gpt-5.6-sol");
    expect(await page.$eval("#select-effort", (el) => (el as HTMLSelectElement).value)).toBe("high");
    expect(await page.$eval('.provider-row[data-id="cli:codex"]', (el) => el.className)).toContain("provider-row--current");
  });

  test("연결·재검사·프로바이더/모델 선택 액션을 프로토콜대로 보낸다", async () => {
    harness.pushMessage(providers());
    await waitForProviderAuth("cli:claude", "disconnected");
    await page.evaluate(() => {
      const panel = document.getElementById("provider-panel");
      if (panel?.hidden) (document.getElementById("btn-settings") as HTMLButtonElement).click();
    });

    const connect = harness.nextClientMessage();
    await page.click('.provider-row[data-id="cli:claude"] .provider-row__connect');
    expect(await connect).toEqual({ action: "connectProvider", id: "cli:claude" });

    const select = harness.nextClientMessage();
    await page.click('.provider-row[data-id="cli:grok"] .provider-row__select');
    expect(await select).toEqual({ action: "setProvider", id: "cli:grok" });

    const recheck = harness.nextClientMessage();
    await page.click("#btn-recheck");
    expect(await recheck).toEqual({ action: "recheckProviders" });

    const model = harness.nextClientMessage();
    await page.select("#select-model", "gpt-5.6-luna");
    expect(await model).toEqual({
      action: "setProvider", id: "cli:codex", model: "gpt-5.6-luna", effort: "high",
    });
  });
});

describe("STT 모델 설정 UI", () => {
  test("카탈로그 네 모델을 크기·라이선스와 함께 렌더한다", async () => {
    harness.pushMessage(sttModels());
    await waitForStt("large-v3", "absent");

    const rows = await page.$$eval(".stt-row", (nodes) => nodes.map((node) => ({
      id: node.getAttribute("data-id"),
      meta: node.querySelector(".stt-row__meta")?.textContent?.trim(),
      badge: node.querySelector(".stt-row__badge")?.textContent?.trim(),
      action: node.querySelector(".stt-row__actions button")?.textContent?.trim(),
    })));
    expect(rows.map((row) => row.id)).toEqual(["small", "medium", "large-v3-turbo", "large-v3"]);
    expect(rows[0]).toMatchObject({ meta: "252 MB · MIT", badge: "미설치", action: "내려받기" });
    expect(rows[3]?.meta).toBe("1.5 GB · Apache-2.0");
  });

  test("absent→downloading→installed→selected 상태와 진행률을 반영한다", async () => {
    harness.pushMessage(sttModels({
      models: sttModels().models.map((model) =>
        model.id === "medium"
          ? { ...model, status: "downloading", receivedBytes: 411_684_889, totalBytes: 823_369_779 }
          : model),
    }));
    await waitForStt("medium", "downloading");
    const progress = await page.$eval('.stt-row[data-id="medium"]', (node) => ({
      badge: node.querySelector(".stt-row__badge")?.textContent?.trim(),
      meta: node.querySelector(".stt-row__meta")?.textContent?.trim(),
      valuenow: node.querySelector(".stt-progress")?.getAttribute("aria-valuenow"),
      action: node.querySelector(".stt-row__actions button")?.textContent?.trim(),
    }));
    expect(progress).toEqual({ badge: "내려받는 중", meta: "393 MB / 785 MB · 50%", valuenow: "50", action: "취소" });

    harness.pushMessage(sttModels({
      selectedModelId: "medium",
      models: sttModels().models.map((model) =>
        model.id === "medium" ? { ...model, status: "selected", path: "/models/medium.bin" } : model),
    }));
    await waitForStt("medium", "selected");
    const selected = await page.$eval('.stt-row[data-id="medium"]', (node) => ({
      badge: node.querySelector(".stt-row__badge")?.textContent?.trim(),
      current: node.className.includes("stt-row--selected"),
      disabled: (node.querySelector(".stt-row__actions button") as HTMLButtonElement).disabled,
    }));
    expect(selected).toEqual({ badge: "사용 중", current: true, disabled: true });
  });

  test("실패 상태는 오류와 재시도를 노출한다", async () => {
    harness.pushMessage(sttModels({
      models: sttModels().models.map((model) =>
        model.id === "small" ? { ...model, status: "failed", error: "checksum mismatch" } : model),
    }));
    await waitForStt("small", "failed");
    const failed = await page.$eval('.stt-row[data-id="small"]', (node) => ({
      badge: node.querySelector(".stt-row__badge")?.textContent?.trim(),
      error: node.querySelector(".stt-row__error")?.textContent?.trim(),
      action: node.querySelector(".stt-row__actions button")?.textContent?.trim(),
    }));
    expect(failed).toEqual({ badge: "실패", error: "checksum mismatch", action: "다시 시도" });
  });

  test("install/cancel/select/recheck 액션을 modelId와 함께 보낸다", async () => {
    harness.pushMessage(sttModels());
    await waitForStt("small", "absent");
    await page.evaluate(() => {
      const panel = document.getElementById("provider-panel");
      if (panel?.hidden) (document.getElementById("btn-settings") as HTMLButtonElement).click();
    });
    const install = harness.nextClientMessage();
    await page.click('.stt-row[data-id="small"] .stt-row__install');
    expect(await install).toEqual({ action: "installSttModel", modelId: "small" });

    harness.pushMessage(sttModels({
      models: sttModels().models.map((model) =>
        model.id === "small"
          ? { ...model, status: "downloading", receivedBytes: 1_000, totalBytes: 264_464_607 }
          : model),
    }));
    await waitForStt("small", "downloading");
    const cancel = harness.nextClientMessage();
    await page.click('.stt-row[data-id="small"] .stt-row__cancel');
    expect(await cancel).toEqual({ action: "cancelSttModel", modelId: "small" });

    harness.pushMessage(sttModels({
      models: sttModels().models.map((model) =>
        model.id === "large-v3-turbo" ? { ...model, status: "installed", path: "/m.bin" } : model),
    }));
    await waitForStt("large-v3-turbo", "installed");
    const select = harness.nextClientMessage();
    await page.click('.stt-row[data-id="large-v3-turbo"] .stt-row__select');
    expect(await select).toEqual({ action: "selectSttModel", modelId: "large-v3-turbo" });

    const recheck = harness.nextClientMessage();
    await page.click("#btn-recheck-stt");
    expect(await recheck).toEqual({ action: "recheckSttModels" });
  });
});

describe("설정 패널 접근성", () => {
  test("좁은 폭에서도 잘리지 않고 키보드로 열고 닫을 수 있다", async () => {
    await page.setViewport({ width: 360, height: 720 });
    harness.pushMessage(providers());
    harness.pushMessage(sttModels());
    // 이전 테스트가 large-v3-turbo=installed를 남겼을 수 있으므로 새 메시지가 실제로
    // 반영된 신선한 렌더(모두 absent)까지 기다린다. small은 이전 렌더에서 이미
    // absent여서 stale 상태로 즉시 resolve될 수 있고, 재렌더링과 포커스 검사가 경쟁한다.
    await waitForStt("large-v3-turbo", "absent");
    await page.evaluate(() => {
      const panel = document.getElementById("provider-panel");
      if (!(panel?.hidden)) (document.getElementById("btn-settings") as HTMLButtonElement).click();
    });

    // 설정 패널을 연다.
    await page.$eval("#btn-settings", (button) => (button as HTMLButtonElement).click());
    await page.waitForFunction(() => document.getElementById("provider-panel")?.hidden === false);

    const fits = await page.evaluate(() => {
      const panel = document.getElementById("provider-panel")!;
      const box = panel.getBoundingClientRect();
      const trigger = document.getElementById("btn-settings")!;
      return {
        withinViewport: box.left >= 0 && box.right <= window.innerWidth,
        scrollable: panel.scrollHeight <= panel.clientHeight + 1 || getComputedStyle(panel).overflowY === "auto",
        label: panel.getAttribute("aria-label"),
        triggerVisible: trigger.getClientRects().length > 0,
      };
    });
    expect(fits.withinViewport).toBe(true);
    expect(fits.scrollable).toBe(true);
    expect(fits.label).toBe("설정");
    expect(fits.triggerVisible).toBe(true);

    // 액션 버튼에 키보드 포커스가 닿는다.
    // page.$eval은 셀렉터 조회와 콜백 실행이 별도 CDP 왕복이라, 그 사이에 대기 중인
    // sttModels 메시지가 innerHTML을 재렌더하면 캡처된 노드가 detached되어 focus()가
    // 조용히 무시된다. 조회+포커스+검증을 한 evaluate로 묶어 원자적으로 만든다.
    const focusable = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.stt-row[data-id="small"] .stt-row__install');
      if (!button) return false;
      button.focus();
      return document.activeElement === button;
    });
    expect(focusable).toBe(true);

    // Escape보다 먼저 정확한 hidden+focus 신호를 무장한다.
    await armPanelClosedWithTriggerFocus();
    await page.keyboard.press("Escape");
    await awaitPanelClosedWithTriggerFocus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("btn-settings");
    expect(await page.$eval("#btn-settings", (button) => button.getAttribute("aria-expanded"))).toBe("false");
    await page.setViewport({ width: 1280, height: 800 });
  });
});
