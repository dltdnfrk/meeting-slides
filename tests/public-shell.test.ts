// 라이브 무대(MeetingCard) 렌더 검증 — 실제 public/app.js + style.css를 브라우저에서 로드한다.
// 서버는 전사/LLM 없이 WS slide 페이로드만 밀어넣는 헤르메틱 스텁.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type Page } from "puppeteer";

import type { Slide } from "../src/session.ts";
import { createPublicTestHarness } from "./public-test-harness.ts";

type SlidePayload = { type: "slide"; current: Slide | null; history: Slide[] };

const harness = createPublicTestHarness();

function pushSlide(payload: SlidePayload): void {
  harness.pushMessage(payload);
}

/**
 * WS로 슬라이드를 밀어넣고 렌더 완료 시점까지 기다린다(고정 sleep 없음).
 * 렌더 신호는 페이지가 심어둔 MutationObserver 이벤트이므로 초기 DOM과 혼동되지 않는다.
 */
async function renderSlide(page: Page, payload: SlidePayload): Promise<void> {
  const expected = payload.current ? payload.current.title : null;
  // 1) 먼저 밍으로 대기를 무장해 전역에 걸어둔다 (설치 완료가 보장된 뒤에만 push).
  await page.evaluate((title: string | null) => {
    const root = document.getElementById("current-slide")!;
    const matches = () =>
      title === null
        ? root.querySelector(".slide__placeholder") !== null
        : root.querySelector(".slide__title")?.textContent === title;
    (globalThis as unknown as { __rendered: Promise<void> }).__rendered = new Promise<void>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`slide render timeout: ${title ?? "placeholder"}`));
        }, 5_000);
        const observer = new MutationObserver(() => {
          if (!matches()) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        });
        observer.observe(root, { childList: true, subtree: true });
      },
    );
  }, expected);
  // 2) 슬라이드 push 후 렌더 신호를 기다린다.
  pushSlide(payload);
  await page.evaluate(() => (globalThis as unknown as { __rendered: Promise<void> }).__rendered);
}

function card(overrides: Partial<Slide> & { index: number; title: string }): Slide {
  return {
    bullets: [],
    startedAt: 1_700_000_000_000,
    sentenceCount: 3,
    ...overrides,
  };
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 375, height: 720 });
  await page.goto(harness.origin, { waitUntil: "load" });
  // 첫 push가 유실되지 않도록 클라이언트 WS 연결이 열린 뒤에 테스트를 시작한다.
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

describe("라이브 MeetingCard 렌더", () => {
  test("슬라이드가 없으면 플레이스홀더를 유지한다", async () => {
    // 먼저 카드를 렌더해 두어야 placeholder 복귀가 실제 DOM 전환으로 관측된다.
    await renderSlide(page, {
      type: "slide",
      current: card({ index: 1, title: "부트스트랩 카드", bullets: ["x"] }),
      history: [],
    });
    await renderSlide(page, { type: "slide", current: null, history: [] });
    expect(await page.$(".slide__placeholder")).not.toBeNull();
    expect(await page.$(".slide__title")).toBeNull();
  });

  test("kicker/emphasis 포함 카드가 모두 렌더된다", async () => {
    await renderSlide(page, {
      type: "slide",
      current: card({
        index: 3,
        title: "출시 일정 확정",
        kicker: "일정 논의",
        bullets: ["베타는 금요일", "QA는 수요일까지"],
        emphasis: "결정: 금요일 베타 배포",
      }),
      history: [],
    });

    const dom = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      const q = (sel: string) => root.querySelector(sel)?.textContent?.trim() ?? null;
      return {
        index: q(".slide__index"),
        kicker: q(".slide__kicker"),
        title: q(".slide__title"),
        bullets: [...root.querySelectorAll(".slide__bullets li")].map((li) => li.textContent),
        emphasis: root.querySelector(".slide__emphasis")?.textContent?.trim() ?? null,
        emphasisLabel: q(".slide__emphasis-label"),
        // kicker는 인덱스 배지와 같은 메타 줄에 묶여 아이브로우 → 제목 계층을 유지한다
        kickerInMetaRow: root.querySelector(".slide__meta > .slide__kicker") !== null,
        // 제목 왼쪽 끝선은 불릿 목록과 같아야 한다(배지가 제목을 밀지 않음)
        titleAlignedWithBody:
          Math.abs(
            root.querySelector(".slide__title")!.getBoundingClientRect().left
              - root.querySelector(".slide__bullets")!.getBoundingClientRect().left,
          ) <= 1,
      };
    });

    expect(dom.index).toBe("03");
    expect(dom.kicker).toBe("일정 논의");
    expect(dom.title).toBe("출시 일정 확정");
    expect(dom.bullets).toEqual(["베타는 금요일", "QA는 수요일까지"]);
    expect(dom.emphasis).toContain("결정: 금요일 베타 배포");
    expect(dom.emphasisLabel).toBe("핵심");
    expect(dom.kickerInMetaRow).toBe(true);
    expect(dom.titleAlignedWithBody).toBe(true);
  });

  test("375px 폭에서 가로 오버플로가 없다", async () => {
    await renderSlide(page, {
      type: "slide",
      current: card({
        index: 4,
        title: "네트워크리소스최적화방안검토와후속조치정리",
        kicker: "인프라 워크스트림 정기 점검",
        bullets: ["서울리전에서엣지캐시히트율이임계치아래로떨어졌습니다"],
        emphasis: "리스크: 트래픽피크시점재발가능성이높아추가계측이필요합니다",
      }),
      history: [],
    });

    // 도크 버튼 행의 가로 스크롤은 이 todo 이전부터 존재하는 별개 이슈이므로,
    // 여기서는 슬라이드 카드 자체와 그 자식들이 카드 폭을 넘지 않는지만 검증한다.
    const overflow = await page.evaluate(() => {
      const el = document.getElementById("current-slide")!;
      const box = el.getBoundingClientRect();
      const spills = [...el.querySelectorAll<HTMLElement>("*")]
        .filter((child) => {
          const style = getComputedStyle(child);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const r = child.getBoundingClientRect();
          // display:none 은 0 사각형이라 left 비교에서 오탐 난다.
          if (r.width <= 0 || r.height <= 0) return false;
          return r.right > box.right + 1 || r.left < box.left - 1;
        })
        .map((child) => child.className);
      return { self: el.scrollWidth - el.clientWidth, spills };
    });
    expect(overflow.self).toBeLessThanOrEqual(0);
    expect(overflow.spills).toEqual([]);
  });

  test("한국어 제목과 불릿은 단어를 보존하고 예외적으로 긴 토큰만 줄바꿈한다", async () => {
    await renderSlide(page, {
      type: "slide",
      current: card({
        index: 5,
        title: "회의 논의 결과",
        bullets: ["제품 논의 결과를 공유합니다"],
      }),
      history: [],
    });

    const wrapping = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      const title = getComputedStyle(root.querySelector<HTMLElement>(".slide__title")!);
      const bullet = getComputedStyle(root.querySelector<HTMLElement>(".slide__bullets li")!);
      return {
        title: { wordBreak: title.wordBreak, overflowWrap: title.overflowWrap },
        bullet: { wordBreak: bullet.wordBreak, overflowWrap: bullet.overflowWrap },
      };
    });

    expect(wrapping).toEqual({
      title: { wordBreak: "keep-all", overflowWrap: "break-word" },
      bullet: { wordBreak: "keep-all", overflowWrap: "break-word" },
    });
  });

  test("kicker/emphasis 없는 레거시 슬라이드도 제목/불릿만으로 렌더된다", async () => {
    await renderSlide(page, {
      type: "slide",
      current: card({ index: 5, title: "레거시 블록", bullets: ["이전 클라이언트 페이로드"] }),
      history: [],
    });

    const dom = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      return {
        title: root.querySelector(".slide__title")?.textContent ?? null,
        bullets: [...root.querySelectorAll(".slide__bullets li")].map((li) => li.textContent),
        hasKicker: root.querySelector(".slide__kicker") !== null,
        hasEmphasis: root.querySelector(".slide__emphasis") !== null,
      };
    });

    expect(dom.title).toBe("레거시 블록");
    expect(dom.bullets).toEqual(["이전 클라이언트 페이로드"]);
    expect(dom.hasKicker).toBe(false);
    expect(dom.hasEmphasis).toBe(false);
  });

  test("불릿이 비어도 제목 카드가 깨지지 않는다", async () => {
    await renderSlide(page, {
      type: "slide",
      current: card({ index: 6, title: "오프닝", kicker: "회의 시작", bullets: [] }),
      history: [],
    });

    const dom = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      return {
        title: root.querySelector(".slide__title")?.textContent ?? null,
        kicker: root.querySelector(".slide__kicker")?.textContent ?? null,
        bulletList: root.querySelector(".slide__bullets") !== null,
      };
    });

    expect(dom.title).toBe("오프닝");
    expect(dom.kicker).toBe("회의 시작");
    expect(dom.bulletList).toBe(false);
  });

  test("히스토리 미리보기에서도 같은 카드 레이아웃을 쓴다", async () => {
    const past = card({
      index: 1,
      title: "과거 블록",
      kicker: "이전 주제",
      bullets: ["지난 논의"],
      emphasis: "다음: 후속 확인",
    });
    await renderSlide(page, {
      type: "slide",
      current: card({ index: 2, title: "현재 블록", bullets: ["진행 중"] }),
      history: [past],
    });

    await page.click(".thumbnail");
    await page.waitForFunction(
      () => document.querySelector("#current-slide .slide__title")?.textContent === "과거 블록",
      { timeout: 5_000 },
    );

    const dom = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      return {
        notice: root.querySelector(".slide__notice") !== null,
        kicker: root.querySelector(".slide__kicker")?.textContent ?? null,
        emphasis: root.querySelector(".slide__emphasis")?.textContent?.includes("다음: 후속 확인") ?? false,
      };
    });

    expect(dom.notice).toBe(true);
    expect(dom.kicker).toBe("이전 주제");
    expect(dom.emphasis).toBe(true);
  });
});

describe("HTML 이스케이프", () => {
  test("모델 텍스트의 마크업이 실행되지 않는다", async () => {
    await renderSlide(page, {
      type: "slide",
      current: card({
        index: 7,
        title: "<img src=x onerror=window.__pwned=1>제목",
        kicker: "<b>kick</b>",
        bullets: ["<script>window.__pwned=1</script>bullet"],
        emphasis: "<i>emph</i>",
      }),
      history: [],
    });

    const dom = await page.evaluate(() => {
      const root = document.getElementById("current-slide")!;
      return {
        pwned: (globalThis as unknown as { __pwned?: number }).__pwned ?? null,
        injectedTags: root.querySelectorAll("img, script, b, i").length,
        kicker: root.querySelector(".slide__kicker")?.textContent ?? null,
        bullet: root.querySelector(".slide__bullets li")?.textContent ?? null,
      };
    });

    expect(dom.pwned).toBeNull();
    expect(dom.injectedTags).toBe(0);
    expect(dom.kicker).toBe("<b>kick</b>");
    expect(dom.bullet).toBe("<script>window.__pwned=1</script>bullet");
  });
});
