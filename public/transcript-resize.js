// ============================================================
// transcript-resize.js — 도킹된 전사 패널의 다중 모서리 리사이즈 (todo 3)
// 서(W): 워크스페이스 스플리터가 담당 (workspace-split.js)
// 남(S): 전사 카드 높이만
// 남서(SW): 높이 + 폭 동시 — 폭은 workspaceLayout API로 위임해 clamp 규칙을 공유한다
// 기하는 CSS 변수 --transcript-card-h 하나로만 흐르고 localStorage에 남는다.
// ============================================================

(() => {
  const STORAGE_KEY = "workspace.transcript.v1";

  // 헤드 + 몇 줄은 보이는 하한. 그 아래로는 패널이 정보 가치를 잃는다.
  const MIN_CARD_H = 160;

  const pane = document.getElementById("transcript-pane");
  const card = document.getElementById("transcript-card");
  const gripS = document.getElementById("transcript-grip-s");
  const gripSW = document.getElementById("transcript-grip-sw");
  if (!pane || !card || !gripS || !gripSW) return;

  /** 카드가 pane을 넘지 않도록 접는다. pane 전체 높이면 "꽉 참"으로 되돌린다. */
  const clampHeight = (heightPx) =>
    Math.max(MIN_CARD_H, Math.min(Math.round(heightPx), pane.clientHeight));

  const isFull = (heightPx) => heightPx >= pane.clientHeight - 1;

  /** null이면 pane을 꽉 채우는 기본 상태(높이 제약 없음)로 되돌린다. */
  const applyHeight = (heightPx) => {
    if (heightPx === null || isFull(heightPx)) {
      pane.style.removeProperty("--transcript-card-h");
      pane.classList.remove("transcript-pane--sized");
      return null;
    }
    pane.style.setProperty("--transcript-card-h", `${heightPx}px`);
    pane.classList.add("transcript-pane--sized");
    return heightPx;
  };

  const persist = (heightPx) => {
    try {
      if (heightPx === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify({ heightPx }));
    } catch {
      // 프라이빗 모드 등 저장 불가 — 리사이즈 자체는 계속 동작한다
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
    return Number.isFinite(stored.heightPx) ? stored.heightPx : null;
  };

  const layout = () => window.workspaceLayout ?? null;

  /**
   * 하나의 그립을 포인터 드래그에 묶는다.
   * 모든 그립은 높이를 늘리고(아래로 끌수록 커짐), SW는 서쪽으로 끌 때 폭도 함께 늘린다.
   */
  const bind = (grip, withWidth, onCommit) => {
    let pointerId = null;
    let startY = 0;
    let startX = 0;
    let startHeight = 0;
    let startWidth = 0;

    grip.addEventListener("pointerdown", (event) => {
      if (pointerId !== null || event.button !== 0) return;
      pointerId = event.pointerId;
      startY = event.clientY;
      startX = event.clientX;
      startHeight = card.getBoundingClientRect().height;
      startWidth = withWidth ? (layout()?.transcriptWidth() ?? pane.clientWidth) : 0;
      grip.setPointerCapture(pointerId);
      grip.classList.add("transcript-grip--active");
      pane.classList.add("transcript-pane--resizing");
      event.preventDefault();
    });

    grip.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      applyHeight(clampHeight(startHeight + (event.clientY - startY)));
      // 서쪽(왼쪽)으로 끌면 폭이 커진다 — 스플리터와 같은 방향 감각
      if (withWidth) layout()?.setTranscriptWidth(startWidth - (event.clientX - startX));
    });

    const end = (event) => {
      if (event.pointerId !== pointerId) return;
      if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId);
      pointerId = null;
      grip.classList.remove("transcript-grip--active");
      pane.classList.remove("transcript-pane--resizing");
      const committed = applyHeight(clampHeight(card.getBoundingClientRect().height));
      onCommit(committed);
      persist(committed);
      if (withWidth) layout()?.persistTranscriptWidth();
    };

    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };

  // 선호 높이를 들고 있다가 뷰포트에 맞춰 접어서 적용한다 (스플리터 폭과 같은 규칙).
  let preferred = readStored();
  if (preferred !== null) applyHeight(clampHeight(preferred));

  const commit = (heightPx) => { preferred = heightPx; };
  bind(gripS, false, commit);
  bind(gripSW, true, commit);

  window.addEventListener("resize", () => {
    if (preferred !== null) applyHeight(clampHeight(preferred));
  });
})();
