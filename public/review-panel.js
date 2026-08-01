// ============================================================
// review-panel.js — 회의록 후보 검토 오버레이
// review 메시지(자체완전 페이로드)를 받아 결정/액션/미결 후보를 카드로
// 세우고, 근거 인용 + 불변 전사 좌표(version_id, seq)를 함께 보여준다.
// 귀속·담당자는 참석자 명단 드롭다운으로만 지정한다(자유입력 없음 — D8).
// 슬라이드 셸은 그대로 두고 위에 얹히며, 캡처를 하드 게이트하지 않는다.
// ============================================================

/**
 * @param {{ send: (payload: object) => boolean, isOpen: () => boolean }} transport
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

  // updateItem의 kind 계약과 정확히 같은 집합이다(server.ts parseReviewKind).
  // 여기 없는 kind를 카드로 세우면 그 카드의 모든 조작은 서버가 반드시
  // INVALID_REVIEW_REQUEST로 거절하므로, 사용자에게 거짓 손잡이를 주는 셈이다.
  const KIND_LABEL = {
    decision: "결정",
    action_item: "액션",
    open_item: "미결",
  };
  const STATUS_LOADING = "회의록 후보 추출 중…";
  const STATUS_FAILED = "회의록 후보 추출 실패·재시도";

  /** 서버가 보낸 마지막 리뷰. 재연결·부분 갱신에도 이 스냅샷이 진실이다. */
  let review = null;
  /** itemId → 로컬 편집 상태. 서버 왕복 없이도 화면이 즉시 사실을 반영한다. */
  const localState = new Map();
  /** 편집 중인 itemId (한 번에 하나) */
  let editingId = null;

  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const isFiniteInt = (v) => typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);

  /** 근거 좌표가 없는 후보는 렌더하지 않는다 — 인용 없는 항목은 회의록에 못 들어간다(D3). */
  function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.id !== "string" || !raw.id) return null;
    if (!KIND_LABEL[raw.kind]) return null;
    if (typeof raw.description !== "string" || !raw.description.trim()) return null;
    const source = raw.sourceSegment;
    if (!source || typeof source !== "object") return null;
    const versionId = source.transcript_version_id;
    if (typeof versionId !== "string" || !versionId) return null;
    if (!isFiniteInt(source.start_seq) || !isFiniteInt(source.end_seq)) return null;
    if (source.start_seq < 1 || source.end_seq < source.start_seq) return null;
    if (typeof raw.evidenceQuote !== "string" || !raw.evidenceQuote.trim()) return null;
    return {
      id: raw.id,
      kind: raw.kind,
      description: raw.description,
      transcriptVersionId: versionId,
      startSeq: source.start_seq,
      endSeq: source.end_seq,
      evidenceQuote: raw.evidenceQuote,
      segmentText: typeof raw.segment_text === "string" ? raw.segment_text : "",
      attributedAttendeeId: typeof raw.attributedAttendeeId === "string" ? raw.attributedAttendeeId : "",
      assigneeAttendeeId: typeof raw.assigneeAttendeeId === "string" ? raw.assigneeAttendeeId : "",
      deadline: typeof raw.deadline === "string" ? raw.deadline : "",
      deadlineText: typeof raw.deadlineText === "string" ? raw.deadlineText : "",
    };
  }

  function normalizeReview(msg) {
    if (!msg || typeof msg !== "object") return null;
    if (typeof msg.reviewId !== "string" || !msg.reviewId) return null;
    if (!Array.isArray(msg.items)) return null;
    const attendees = (Array.isArray(msg.attendees) ? msg.attendees : [])
      .filter((a) => a && typeof a.attendeeId === "string" && a.attendeeId
        && typeof a.displayName === "string" && a.displayName.trim())
      .map((a) => ({ attendeeId: a.attendeeId, displayName: a.displayName }));
    const items = msg.items.map(normalizeItem).filter((item) => item !== null);
    return {
      reviewId: msg.reviewId,
      transcriptVersionId: typeof msg.transcriptVersionId === "string" ? msg.transcriptVersionId : "",
      attendees,
      items,
    };
  }

  const stateOf = (item) => localState.get(item.id) ?? {};
  const descriptionOf = (item) => stateOf(item).description ?? item.description;
  const reviewStateOf = (item) => stateOf(item).reviewState ?? "candidate";
  const attributionOf = (item) => stateOf(item).attributedAttendeeId ?? item.attributedAttendeeId;
  const assigneeOf = (item) => stateOf(item).assigneeAttendeeId ?? item.assigneeAttendeeId;
  const deadlineOf = (item) => stateOf(item).deadline ?? item.deadline;
  const patchLocal = (id, patch) => localState.set(id, { ...(localState.get(id) ?? {}), ...patch });

  const keptItems = () => (review?.items ?? []).filter((item) => reviewStateOf(item) !== "rejected");
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

  function optionsHtml(selectedId, hasAttendees) {
    if (!hasAttendees) return `<option value="">참석자 없음</option>`;
    const options = [`<option value="">미지정</option>`];
    for (const attendee of review.attendees) {
      const selected = attendee.attendeeId === selectedId ? " selected" : "";
      options.push(
        `<option value="${escapeHtml(attendee.attendeeId)}"${selected}>${escapeHtml(attendee.displayName)}</option>`,
      );
    }
    return options.join("");
  }

  function itemHtml(item, hasAttendees) {
    const itemState = reviewStateOf(item);
    const dropped = itemState === "rejected";
    const confirmed = itemState === "confirmed";
    const description = descriptionOf(item);
    const disabled = dropped || !hasAttendees ? " disabled" : "";
    const range = item.startSeq === item.endSeq
      ? `seq ${item.startSeq}`
      : `seq ${item.startSeq}–${item.endSeq}`;
    const editing = editingId === item.id;
    const deadline = item.kind === "action_item"
      ? `<label class="review-item__field review-item__deadline"><span class="review-item__field-label">기한</span>
           <input class="review-item__deadline-input" type="date" value="${escapeHtml(deadlineOf(item))}"
             aria-label="${escapeHtml(description)} 기한"${dropped ? " disabled" : ""}>
           ${item.deadlineText ? `<span class="review-item__deadline-text">${escapeHtml(item.deadlineText)}</span>` : ""}
         </label>`
      : "";
    const assignee = item.kind === "action_item"
      ? `<label class="review-item__field"><span class="review-item__field-label">담당자</span>
           <select class="review-item__select review-item__assignee" aria-label="${escapeHtml(description)} 담당자"${disabled}>
             ${optionsHtml(assigneeOf(item), hasAttendees)}
           </select></label>`
      : "";
    const body = editing
      ? `<textarea class="review-item__editor" aria-label="${escapeHtml(description)} 설명 수정">${escapeHtml(description)}</textarea>`
      : `<p class="review-item__description">${escapeHtml(description)}</p>`;

    return `
      <article class="review-item${dropped ? " review-item--dropped" : ""} review-item--${escapeHtml(item.kind)}"
        role="listitem"
        data-item-id="${escapeHtml(item.id)}"
        data-kind="${escapeHtml(item.kind)}"
        data-review-state="${escapeHtml(itemState)}"
        data-transcript-version-id="${escapeHtml(item.transcriptVersionId)}"
        data-start-seq="${escapeHtml(String(item.startSeq))}"
        data-end-seq="${escapeHtml(String(item.endSeq))}">
        <header class="review-item__head">
          <span class="review-item__kind">${escapeHtml(KIND_LABEL[item.kind])}</span>
          <span class="review-item__coords" title="불변 전사 좌표">${escapeHtml(range)} · ${escapeHtml(item.transcriptVersionId)}</span>
        </header>
        ${body}
        <blockquote class="review-item__quote">${escapeHtml(item.evidenceQuote)}</blockquote>
        <details class="review-item__evidence">
          <summary class="review-item__evidence-summary">근거 구간 전문</summary>
          <pre class="review-item__segment">${escapeHtml(item.segmentText)}</pre>
        </details>
        ${deadline}
        <footer class="review-item__foot">
          <label class="review-item__field"><span class="review-item__field-label">귀속</span>
            <select class="review-item__select review-item__attribution" aria-label="${escapeHtml(description)} 발언 귀속"${disabled}>
              ${optionsHtml(attributionOf(item), hasAttendees)}
            </select></label>
          ${assignee}
          <span class="review-item__spacer"></span>
          ${!dropped ? `<button type="button" class="review-item__action review-item__confirm"
            aria-label="${escapeHtml(description)} ${confirmed ? "재검토" : "항목 확정"}"
            ${!confirmed && !isComplete(item) ? " disabled" : ""}>${confirmed ? "재검토" : "항목 확정"}</button>` : ""}
          ${editing
            ? `<button type="button" class="review-item__action review-item__save" aria-label="${escapeHtml(description)} 수정 저장">저장</button>
               <button type="button" class="review-item__action review-item__cancel" aria-label="${escapeHtml(description)} 수정 취소">취소</button>`
            : `<button type="button" class="review-item__action review-item__edit" aria-label="${escapeHtml(description)} 수정"${dropped ? " disabled" : ""}>수정</button>`}
          <button type="button" class="review-item__action review-item__drop" aria-label="${escapeHtml(description)} ${dropped ? "복원" : "제외"}">${dropped ? "복원" : "제외"}</button>
        </footer>
      </article>`;
  }

  function render() {
    if (!review) {
      listEl.innerHTML = "";
      confirmEl.disabled = true;
      confirmCountEl.textContent = "0";
      countEl.hidden = true;
      return;
    }
    const hasAttendees = review.attendees.length > 0;
    versionEl.textContent = review.transcriptVersionId;
    versionEl.title = review.transcriptVersionId;

    if (review.items.length === 0) {
      listEl.innerHTML = `<p class="review-list__empty">추출된 후보가 없습니다 — 전사에 명시적인 결정·액션·미결 표현이 없었습니다</p>`;
    } else {
      listEl.innerHTML = review.items.map((item) => itemHtml(item, hasAttendees)).join("");
    }

    noticeEl.textContent = hasAttendees || review.items.length === 0
      ? ""
      : "참석자 명단이 비어 있어 귀속을 지정할 수 없습니다";
    noticeEl.hidden = !noticeEl.textContent;

    const kept = keptItems().length;
    confirmCountEl.textContent = String(kept);
    countEl.textContent = String(kept);
    countEl.hidden = kept === 0;
    confirmEl.disabled = !canConfirmReview() || !transport.isOpen();
    toggleEl.hidden = false;
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
      setError("연결되지 않음 — 검토 저장 불가");
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
        setError("귀속·담당자·기한을 모두 지정해야 합니다");
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
        setError("설명을 비울 수 없습니다");
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
      setError("모든 후보를 항목 확정 또는 제외해야 합니다");
      return;
    }
    if (!transport.send({ action: "confirmReview", reviewId: review.reviewId })) {
      setError("연결되지 않음 — 확정 불가");
      return;
    }
    setError("");
  });

  retryEl.addEventListener("click", () => {
    if (!transport.send({ action: "startReview" })) {
      setError("연결되지 않음 — 재시도 불가");
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
      const next = normalizeReview(msg);
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
      if (text === STATUS_LOADING) {
        setPanelState("loading");
        setError("");
        confirmEl.disabled = true;
        toggleEl.hidden = false;
        open(false);
        return;
      }
      if (text === STATUS_FAILED) {
        setPanelState("error");
        setError(STATUS_FAILED);
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
