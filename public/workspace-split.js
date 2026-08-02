// ============================================================
// workspace-split.js — 워크스페이스 세로 스플리터 (todo 2)
// 좌 레일 | 무대 | 전사 세 패널의 경계를 포인터로 끌어 조정하고
// 결과를 localStorage에 저장/복원한다.
// 기하는 CSS 변수 --rail-w / --transcript-w 하나로만 흐른다.
// ============================================================

(() => {
  const STORAGE_KEY = "workspace.layout.v1";

  // 최소 폭: 레일/전사는 내용이 읽히는 하한, 무대는 히어로가 무너지지 않는 하한
  const MIN_RAIL = 180;
  const MIN_TRANSCRIPT = 240;
  const MIN_STAGE = 320;

  const workspace = document.getElementById("workspace");
  const railSplitter = document.getElementById("splitter-rail");
  const transcriptSplitter = document.getElementById("splitter-transcript");
  if (!workspace || !railSplitter || !transcriptSplitter) return;

  const splitterWidth = () => {
    const raw = getComputedStyle(workspace).getPropertyValue("--splitter-w");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const readVar = (name, fallback) => {
    const parsed = Number.parseFloat(getComputedStyle(workspace).getPropertyValue(name));
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  /**
   * 두 폭을 최소값과 뷰포트 안으로 함께 접는다.
   * 사이드가 남은 자리를 다 먹으면 무대(MIN_STAGE)를 먼저 지키고 사이드를 깎는다.
   */
  const clamp = (leftPx, rightPx) => {
    const available = workspace.clientWidth - splitterWidth() * 2;
    let left = Math.max(MIN_RAIL, Math.round(leftPx));
    let right = Math.max(MIN_TRANSCRIPT, Math.round(rightPx));

    const overflow = left + right + MIN_STAGE - available;
    if (overflow > 0) {
      // 넘친 만큼을 여유(최소폭 초과분)에 비례해 양쪽에서 회수한다
      const leftSlack = left - MIN_RAIL;
      const rightSlack = right - MIN_TRANSCRIPT;
      const slack = leftSlack + rightSlack;
      if (slack > 0) {
        const cut = Math.min(overflow, slack);
        const leftCut = Math.round((cut * leftSlack) / slack);
        left -= leftCut;
        right -= cut - leftCut;
      }
    }
    return { leftPx: left, rightPx: right };
  };

  const apply = ({ leftPx, rightPx }) => {
    workspace.style.setProperty("--rail-w", `${leftPx}px`);
    workspace.style.setProperty("--transcript-w", `${rightPx}px`);
  };

  const persist = ({ leftPx, rightPx }) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ leftPx, rightPx }));
    } catch {
      // 프라이빗 모드 등 저장 불가 — 레이아웃 자체는 계속 동작한다
    }
  };

  const readStored = () => {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      return null;
    }
    if (!stored || typeof stored !== "object") return null;
    const { leftPx, rightPx } = stored;
    if (!Number.isFinite(leftPx) || !Number.isFinite(rightPx)) return null;
    return { leftPx, rightPx };
  };

  const currentWidths = () => ({
    leftPx: readVar("--rail-w", MIN_RAIL),
    rightPx: readVar("--transcript-w", MIN_TRANSCRIPT),
  });

  /**
   * 하나의 스플리터를 포인터 드래그에 묶는다.
   * edge "left"는 레일 폭을 포인터와 같은 방향으로,
   * "right"는 전사 폭을 반대 방향으로 움직인다.
   */
  const bind = (splitter, edge, onCommit) => {
    let pointerId = null;
    let startX = 0;
    let startWidths = null;

    splitter.addEventListener("pointerdown", (event) => {
      if (pointerId !== null || event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startWidths = currentWidths();
      splitter.setPointerCapture(pointerId);
      splitter.classList.add("splitter--active");
      workspace.classList.add("workspace--resizing");
      event.preventDefault();
    });

    splitter.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId || !startWidths) return;
      const delta = event.clientX - startX;
      const next =
        edge === "left"
          ? { leftPx: startWidths.leftPx + delta, rightPx: startWidths.rightPx }
          : { leftPx: startWidths.leftPx, rightPx: startWidths.rightPx - delta };
      apply(clamp(next.leftPx, next.rightPx));
    });

    const end = (event) => {
      if (event.pointerId !== pointerId) return;
      if (splitter.hasPointerCapture(pointerId)) splitter.releasePointerCapture(pointerId);
      pointerId = null;
      startWidths = null;
      splitter.classList.remove("splitter--active");
      workspace.classList.remove("workspace--resizing");
      const committed = currentWidths();
      onCommit(committed);
      persist(committed);
    };

    splitter.addEventListener("pointerup", end);
    splitter.addEventListener("pointercancel", end);
  };

  // 선호 폭은 저장값 기준으로 들고 있다가 뷰포트에 맞춰 접어서 적용한다.
  // 그래야 창을 줄였다 늘려도 사용자가 고른 폭이 되살아난다.
  let preferred = readStored() ?? currentWidths();
  apply(clamp(preferred.leftPx, preferred.rightPx));

  const commit = (widths) => { preferred = widths; };
  bind(railSplitter, "left", commit);
  bind(transcriptSplitter, "right", commit);

  window.addEventListener("resize", () => apply(clamp(preferred.leftPx, preferred.rightPx)));

  // 서쪽 폭은 남서(SW) 그립도 같은 기하를 쓴다.
  // clamp/persist를 두 번 구현하지 않도록 전사 패널 폭만 좀은 상태로 열어둔다.
  window.workspaceLayout = {
    transcriptWidth: () => currentWidths().rightPx,
    setTranscriptWidth(rightPx) {
      const next = clamp(currentWidths().leftPx, rightPx);
      apply(next);
      preferred = next;
      return next.rightPx;
    },
    persistTranscriptWidth() {
      persist(currentWidths());
    },
  };
})();
