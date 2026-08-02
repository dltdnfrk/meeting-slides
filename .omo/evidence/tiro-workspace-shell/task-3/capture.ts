// todo 3 증거 캡처: 빈 상태 → 라이브 전사 도킹 → S 높이 축소 → SW 폭+높이 → 복원.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import puppeteer from "puppeteer";

import { createPublicTestHarness } from "../../../../tests/public-test-harness.ts";

const outDir = join(import.meta.dir);
await mkdir(outDir, { recursive: true });

const harness = createPublicTestHarness();
const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(harness.origin, { waitUntil: "load" });
await harness.clientConnected;

const settle = () =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

const measure = () =>
  page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const pane = rect(".transcript-pane");
    const card = rect(".transcript-card");
    const stage = rect(".stage-pane");
    return {
      transcriptW: Math.round(pane.width),
      cardH: Math.round(card.height),
      paneH: Math.round(pane.height),
      stageW: Math.round(stage.width),
      stageH: Math.round(stage.height),
      lines: document.querySelectorAll(".transcript-pane .feed-line").length,
      linesOutsidePane:
        document.querySelectorAll(".feed-line").length -
        document.querySelectorAll(".transcript-pane .feed-line").length,
      stageHitAtCenter:
        document
          .elementFromPoint(stage.left + stage.width / 2, stage.top + stage.height / 2)
          ?.closest(".stage-pane") !== null,
      storedHeight: localStorage.getItem("workspace.transcript.v1"),
      storedLayout: localStorage.getItem("workspace.layout.v1"),
    };
  });

const drag = async (selector: string, dx: number, dy: number) => {
  const origin = await page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + dx / 2, origin.y + dy / 2);
  await page.mouse.move(origin.x + dx, origin.y + dy);
  await page.mouse.up();
  await settle();
};

const log: string[] = [];
const record = async (label: string, file: string) => {
  log.push(`${label}: ${JSON.stringify(await measure())}`);
  await page.screenshot({ path: join(outDir, file) });
};

await record("empty", "transcript-dock-empty.png");

// 라이브 전사 + 슬라이드를 동시에 밀어 넣어 "무대는 살아 있고 전사는 도킹" 상태를 만든다
const sentences = [
  "이번 스프린트 목표부터 정리하겠습니다",
  "전사 패널은 오른쪽에 고정으로 붙습니다",
  "가운데 무대는 어떤 경우에도 가리지 않습니다",
  "폭은 스플리터, 높이는 남쪽 손잡이로 조절합니다",
  "남서 코너를 잡으면 둘 다 동시에 바뀝니다",
  "저장된 레이아웃은 새로고침해도 살아남습니다",
  "다음 안건으로 넘어가겠습니다",
  "일정은 다음 주 화요일까지입니다",
];
sentences.forEach((text, i) =>
  harness.pushMessage({ type: "line", text, ts: 1_700_000_000_000 + i * 7_000, speaker: (i % 3) + 1 }),
);
harness.pushMessage({
  type: "slide",
  current: {
    index: 1,
    kicker: "스프린트 킥오프",
    title: "전사 패널 도킹 설계",
    bullets: ["오른쪽 고정 패널", "W/S/SW 다중 모서리 리사이즈", "중앙 무대 비가림 보장"],
    emphasis: "플로팅 SE 전용 손잡이를 대체한다",
  },
  history: [],
});
await settle();
await record("docked-live", "transcript-dock-live.png");

await drag("#transcript-grip-s", 0, -260);
await record("south-drag", "transcript-dock-south.png");

await drag("#transcript-grip-sw", -160, 90);
await record("southwest-drag", "transcript-dock-southwest.png");

await page.reload({ waitUntil: "load" });
await settle();
await record("after-reload", "transcript-dock-restored.png");

// 좁은 화면: 좌우 분할 대신 무대 아래로 쌓이며 전사가 사라지지 않는다
await page.evaluate(() => {
  localStorage.removeItem("workspace.transcript.v1");
  localStorage.removeItem("workspace.layout.v1");
});
await page.setViewport({ width: 820, height: 900 });
await page.reload({ waitUntil: "load" });
// 재접속이 끝나기 전에 push하면 메시지가 버려진다 — 상태 텍스트로 확인한다
await page.waitForFunction(
  () => document.getElementById("status-text")?.textContent === "서버 연결됨",
  { timeout: 5_000 },
);
sentences.forEach((text, i) =>
  harness.pushMessage({ type: "line", text, ts: 1_700_000_000_000 + i * 7_000, speaker: (i % 3) + 1 }),
);
harness.pushMessage({
  type: "slide",
  current: { index: 1, title: "좁은 화면에서도 무대가 먼저", bullets: ["세로 스택 배치"] },
  history: [],
});
await settle();
await record("narrow-820", "transcript-dock-narrow-820.png");

await writeFile(join(outDir, "measurements.txt"), `${log.join("\n")}\n`, "utf-8");
console.log(log.join("\n"));

await browser.close();
harness.stop();
