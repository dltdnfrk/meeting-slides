// ============================================================
// review-panel.js — 회의록 후보 검토 오버레이
// review 메시지(자체완전 페이로드)를 받아 결정/액션/미결 후보를 카드로
// 세우고, 근거 인용 + 불변 전사 좌표(version_id, seq)를 함께 보여준다.
// 귀속·담당자는 참석자 명단 드롭다운으로만 지정한다(자유입력 없음 — D8).
// 슬라이드 셸은 그대로 두고 위에 얹히며, 캡처를 하드 게이트하지 않는다.
// ============================================================

/**
 * @param {{ send: (payload: object) => boolean, isOpen: () => boolean, getNotes?: () => string }} transport
 */
function createReviewPanel(transport) {
  const byId = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el;
  };

  const panelEl = byId("review-panel");
  const listEl = byId("review-list");
  const errorEl = byId("review-error");
  const noticeEl = byId("review-attendee-notice");
  const loadingEl = byId("review-loading");
  const versionEl = byId("review-version");
  const confirmEl = /** @type {HTMLButtonElement} */ (byId("btn-review-confirm"));
  const confirmCountEl = byId("review-confirm-count");
  const retryEl = /** @type {HTMLButtonElement} */ (byId("btn-review-retry"));
  const closeEl = /** @type {HTMLButtonElement} */ (byId("btn-review-close"));
  const toggleEl = /** @type {HTMLButtonElement} */ (byId("btn-review"));
  const countEl = byId("review-count");

  const STATUS_LOADING = new Set(["회의록 정리 중…", "회의록 후보 추출 중…"]);
  const STATUS_FAILED = new Set(["회의록을 정리하지 못했습니다", "회의록 후보 추출 실패·재시도"]);

  /** 서버가 보낸 마지막 리뷰. 재연결·부분 갱신에도 이 스냅샷이 진실이다. */
  let review = null;
  /** itemId → 로컬 편집 상태. 서버 왕복 없이도 화면이 즉시 사실을 반영한다. */
  const localState = new Map();
  /** 편집 중인 itemId (한 번에 하나) */
  let editingId = null;

  const stateOf = (item) => localState.get(item.id) ?? {};
  const descriptionOf = (item) => stateOf(item).description ?? item.description;
  const reviewStateOf = (item) => stateOf(item).reviewState ?? "candidate";
  const attributionOf = (item) => stateOf(item).attributedAttendeeId ?? item.attributedAttendeeId;
  const assigneeOf = (item) => stateOf(item).assigneeAttendeeId ?? item.assigneeAttendeeId;
  const deadlineOf = (item) => stateOf(item).deadline ?? item.deadline;
  const patchLocal = (id, patch) => localState.set(id, { ...(localState.get(id) ?? {}), ...patch });

  const isComplete = (item) => Boolean(attributionOf(item)) && (item.kind !== "action_item" ||
    (Boolean(assigneeOf(item)) && Boolean(deadlineOf(item))));
  const canConfirmReview = () => (review?.items ?? []).every((item) => reviewStateOf(item) !== "candidate");

  function setError(text) {
    errorEl.textContent = text ?? "";
    errorEl.hidden = !text;
  }

  function setPanelState(state) {
    panelEl.dataset.state = state;
    panelEl.setAttribute("aria-busy", String(state === "loading"));
    loadingEl.hidden = state !== "loading";
    retryEl.hidden = state !== "error";
    listEl.hidden = state === "loading" || state === "error";
  }

  function render() {
    reviewPanelRender({
      review, listEl, confirmEl, confirmCountEl, countEl, noticeEl, versionEl,
      itemState: reviewStateOf, description: descriptionOf, attribution: attributionOf,
      assignee: assigneeOf, deadline: deadlineOf, editingId, complete: isComplete,
      canConfirm: canConfirmReview, isOpen: transport.isOpen,
    });
    if (review) toggleEl.hidden = false;
  }

  function open(focusInside = true) {
    panelEl.hidden = false;
    toggleEl.hidden = false;
    toggleEl.setAttribute("aria-expanded", "true");
    if (focusInside) (confirmEl.disabled ? closeEl : confirmEl).focus();
  }

  function close(restoreFocus = false) {
    panelEl.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
    if (restoreFocus && !toggleEl.hidden) toggleEl.focus();
  }

  function sendPatch(item, patch) {
    if (!review) return false;
    if (!transport.send({
      action: "updateItem",
      reviewId: review.reviewId,
      itemId: item.id,
      kind: item.kind,
      patch,
    })) {
      setError("앱 서버에 연결되지 않아 변경 내용을 저장할 수 없습니다");
      return false;
    }
    setError("");
    return true;
  }

  const itemFor = (target) => {
    const card = target instanceof Element ? target.closest(".review-item") : null;
    if (!(card instanceof HTMLElement) || !review) return null;
    return review.items.find((candidate) => candidate.id === card.dataset.itemId) ?? null;
  };

  listEl.addEventListener("change", (ev) => {
    const item = itemFor(ev.target);
    if (!item || !(ev.target instanceof HTMLSelectElement)) return;
    const value = ev.target.value;
    if (ev.target.classList.contains("review-item__attribution")) {
      patchLocal(item.id, { attributedAttendeeId: value });
      sendPatch(item, { attributedAttendeeId: value || null });
      render();
    } else if (ev.target.classList.contains("review-item__assignee")) {
      patchLocal(item.id, { assigneeAttendeeId: value });
      sendPatch(item, { assigneeAttendeeId: value || null });
      render();
    }
  });

  listEl.addEventListener("change", (ev) => {
    const item = itemFor(ev.target);
    if (!item || !(ev.target instanceof HTMLInputElement) ||
        !ev.target.classList.contains("review-item__deadline-input")) return;
    const deadline = ev.target.value;
    if (!deadline || !sendPatch(item, { deadline })) return;
    patchLocal(item.id, { deadline });
    render();
  });

  listEl.addEventListener("click", (ev) => {
    const item = itemFor(ev.target);
    if (!item || !(ev.target instanceof Element)) return;

    if (ev.target.closest(".review-item__confirm")) {
      const nextState = reviewStateOf(item) === "confirmed" ? "candidate" : "confirmed";
      if (nextState === "confirmed" && !isComplete(item)) {
        setError("발언자, 담당자, 기한을 모두 지정해 주세요");
        return;
      }
      if (!sendPatch(item, { reviewState: nextState })) return;
      patchLocal(item.id, { reviewState: nextState });
      render();
      return;
    }
    if (ev.target.closest(".review-item__edit")) {
      editingId = item.id;
      setError("");
      render();
      const editor = listEl.querySelector(`.review-item[data-item-id="${CSS.escape(item.id)}"] .review-item__editor`);
      if (editor instanceof HTMLTextAreaElement) {
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      }
      return;
    }
    if (ev.target.closest(".review-item__cancel")) {
      editingId = null;
      setError("");
      render();
      return;
    }
    if (ev.target.closest(".review-item__save")) {
      const editor = listEl.querySelector(`.review-item[data-item-id="${CSS.escape(item.id)}"] .review-item__editor`);
      const next = (editor instanceof HTMLTextAreaElement ? editor.value : "").trim();
      if (!next) {
        setError("내용을 입력해 주세요");
        if (editor instanceof HTMLTextAreaElement) editor.focus();
        return;
      }
      if (!sendPatch(item, { description: next })) return;
      patchLocal(item.id, { description: next });
      editingId = null;
      render();
      return;
    }
    if (ev.target.closest(".review-item__drop")) {
      const nextState = reviewStateOf(item) === "rejected" ? "candidate" : "rejected";
      if (!sendPatch(item, { reviewState: nextState })) return;
      patchLocal(item.id, { reviewState: nextState });
      if (nextState === "rejected" && editingId === item.id) editingId = null;
      render();
    }
  });

  confirmEl.addEventListener("click", () => {
    if (!review) return;
    if (!canConfirmReview()) {
      setError("모든 항목을 확인하거나 제외해 주세요");
      return;
    }
    if (!transport.send({ action: "confirmReview", reviewId: review.reviewId })) {
      setError("앱 서버에 연결되지 않아 검토를 완료할 수 없습니다");
      return;
    }
    setError("");
  });

  retryEl.addEventListener("click", () => {
    const notes = transport.getNotes?.() ?? "";
    if (!transport.send({ action: "startReview", ...(notes.trim() ? { notes: notes.trim() } : {}) })) {
      setError("앱 서버에 연결되지 않아 다시 정리할 수 없습니다");
      return;
    }
    setError("");
    setPanelState("loading");
  });

  closeEl.addEventListener("click", () => close(true));

  toggleEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (panelEl.hidden) open();
    else close();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || panelEl.hidden) return;
    if (editingId !== null) { editingId = null; render(); return; }
    close(true);
  });

  return {
    /** review 메시지 → 후보 카드. 두 번째 메시지는 이전 후보를 대체한다. */
    applyReview(msg) {
      const next = reviewPanelNormalizeReview(msg);
      if (!next) return;
      review = next;
      localState.clear();
      editingId = null;
      setError("");
      setPanelState("ready");
      render();
      open();
    },
    /** 서버 status 텍스트로 로딩/실패 상태를 연다 (추출은 비동기다). */
    applyStatus(text) {
      if (STATUS_LOADING.has(text)) {
        setPanelState("loading");
        setError("");
        confirmEl.disabled = true;
        toggleEl.hidden = false;
        open(false);
        return;
      }
      if (STATUS_FAILED.has(text)) {
        setPanelState("error");
        setError("회의록을 정리하지 못했습니다");
        confirmEl.disabled = true;
        toggleEl.hidden = false;
        open(false);
      }
    },
    /** 소켓 개폐에 따라 확정 버튼 가용성을 되맞춘다. */
    syncTransport() {
      confirmEl.disabled = !canConfirmReview() || !transport.isOpen();
    },
  };
}

window.createReviewPanel = createReviewPanel;
