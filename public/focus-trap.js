// ============================================================
// focus-trap.js — 시트/모달 포커스 가둠 (DESIGN 9.12)
//
// "Sheets and modals trap focus, close on Escape, and restore focus to the
// trigger." 초기 포커스와 Escape 복귀는 각 패널이 이미 갖고 있었지만, 열린
// 다이얼로그 안에서 Tab을 계속 누르면 뒤에 있는 셸로 빠져나갔다. 이 파일은
// 그 마지막 한 조각인 "가둠"만 담당한다.
//
// 설계 원칙:
//   * 한 번에 하나. 열린 다이얼로그가 여러 개면 가장 마지막에 연 것이 키를
//     받는다(Escape 우선순위와 같은 순서).
//   * DOM을 건드리지 않는다. inert/aria-hidden/tabindex 를 심었다가 닫을 때
//     되돌리는 방식은 되돌리기에 실패하면 셸 전체가 접근 불가로 남는다.
//     대신 keydown 단계에서 Tab의 목적지만 계산해 감싼다.
//   * 포커스 가능한 목록은 매번 다시 읽는다. 검토 카드처럼 내용이 다시
//     그려지는 패널에서는 열릴 때 캐시한 목록이 곧바로 낡는다.
// ============================================================

(() => {
  const TABBABLE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[tabindex]",
  ].join(", ");

  /** 지금 실제로 탭 순서에 들어가는가 (숨김/disabled/0 크기 제외). */
  const isTabbable = (el) => {
    if (el.matches(":disabled")) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    if (el.closest("[inert]")) return false;
    for (let node = el; node; node = node.parentElement) {
      if (node.hidden) return false;
      const styles = getComputedStyle(node);
      if (styles.display === "none" || styles.visibility === "hidden") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // Native radio groups are scoped by name, form owner and tree, not by their
  // immediate container. Unnamed radios remain independent tab stops.
  const sameRadioGroup = (left, right) =>
    left instanceof HTMLInputElement && right instanceof HTMLInputElement
    && left.type === "radio" && right.type === "radio" && left.name !== ""
    && left.name === right.name && left.form === right.form
    && left.getRootNode() === right.getRootNode();

  const tabbablesOf = (root, backwards) => {
    const candidates = [...root.querySelectorAll(TABBABLE_SELECTOR)].filter(isTabbable);
    return candidates.filter((el) => {
      if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
      const group = candidates.filter((peer) => sameRadioGroup(el, peer));
      // A disabled/hidden checked input is not a tab stop. Without an eligible
      // checked member Chrome enters the group at its first/last enabled input
      // for forward/reverse Tab respectively.
      const target = group.find((peer) => peer.checked)
        ?? group[backwards ? group.length - 1 : 0];
      return el === target;
    });
  };

  const sameTabStop = (active, boundary) =>
    active === boundary || sameRadioGroup(active, boundary);

  /** 활성 트랩 스택. 마지막 항목이 키를 받는다. */
  const stack = [];
  const scrim = document.getElementById("dialog-scrim");
  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const CLOSE_MS = 200;
  const closeTimers = new WeakMap();

  const syncScrim = () => {
    if (!(scrim instanceof HTMLElement)) return;
    const open = stack.some((root) => root.isConnected && !root.hidden);
    scrim.dataset.open = String(open);
    scrim.setAttribute("aria-hidden", String(!open));
  };

  const activeRoot = () => {
    // 이미 닫힌(hidden) 패널은 스택에 남아 있어도 무시한다: 패널이 자기
    // close()에서 release 를 부르지 못한 경로에서도 셸이 잠기지 않는다.
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const root = stack[i];
      if (root.isConnected && !root.hidden) return root;
    }
    return null;
  };

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab" || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const root = activeRoot();
    if (!root) return;

    const items = tabbablesOf(root, ev.shiftKey);
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && root.contains(active);

    if (!inside) {
      // 포커스가 어떤 이유로든 밖에 있으면 다음 Tab이 다이얼로그로 되돌린다.
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (ev.shiftKey && sameTabStop(active, first)) {
      ev.preventDefault();
      last.focus({ preventScroll: true });
      return;
    }
    if (!ev.shiftKey && sameTabStop(active, last)) {
      ev.preventDefault();
      first.focus({ preventScroll: true });
    }
    // 그 사이의 이동은 브라우저 기본 순서 그대로 둔다.
  }, true);

  /**
   * 열린 시트/모달을 가둠 대상으로 등록한다. 같은 루트를 다시 등록하면 맨 위로
   * 올라오므로(중복 없음), 열기 경로가 여러 개여도 스택이 자라지 않는다.
   * @param {HTMLElement | null | undefined} root
   */
  function trapFocus(root) {
    if (!(root instanceof HTMLElement)) return;
    const at = stack.indexOf(root);
    if (at !== -1) stack.splice(at, 1);
    stack.push(root);
    syncScrim();
  }

  /**
   * 닫힌 시트/모달을 대상에서 뺀다. 포커스 복원은 각 패널의 close()가 이미
   * 담당하므로 여기서는 아무것도 포커스하지 않는다.
   * @param {HTMLElement | null | undefined} root
   */
  function releaseFocus(root) {
    const at = stack.indexOf(root);
    if (at !== -1) stack.splice(at, 1);
    syncScrim();
  }

  scrim?.addEventListener("click", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  /**
   * Shared symmetric dialog transition. Accessibility state changes immediately;
   * only visual removal waits for the short opacity/transform outro.
   */
  function openDialog(root) {
    if (!(root instanceof HTMLElement)) return;
    const timer = closeTimers.get(root);
    if (timer) clearTimeout(timer);
    closeTimers.delete(root);
    root.hidden = false;
    root.inert = false;
    root.dataset.motionState = "opening";
    requestAnimationFrame(() => {
      if (!root.hidden && root.dataset.motionState === "opening") root.dataset.motionState = "open";
    });
  }

  function closeDialog(root, onClosed) {
    if (!(root instanceof HTMLElement)) { onClosed?.(); return; }
    const timer = closeTimers.get(root);
    if (timer) clearTimeout(timer);
    releaseFocus(root);
    root.inert = true;
    root.dataset.motionState = "closing";
    const finish = () => {
      closeTimers.delete(root);
      root.hidden = true;
      root.inert = false;
      root.dataset.motionState = "closed";
      onClosed?.();
    };
    if (reduceMotion() || root.hidden) finish();
    else closeTimers.set(root, setTimeout(finish, CLOSE_MS));
  }

  window.trapFocus = trapFocus;
  window.releaseFocus = releaseFocus;
  window.openDialog = openDialog;
  window.closeDialog = closeDialog;
})();
