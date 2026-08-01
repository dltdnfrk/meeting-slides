const REVIEW_KIND_LABEL = {
  decision: "결정",
  action_item: "액션",
  open_item: "미결",
};

const reviewEscapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

const reviewIsFiniteInt = (value) => typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);

function reviewNormalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (!REVIEW_KIND_LABEL[raw.kind]) return null;
  if (typeof raw.description !== "string" || !raw.description.trim()) return null;
  const source = raw.sourceSegment;
  if (!source || typeof source !== "object") return null;
  const versionId = source.transcript_version_id;
  if (typeof versionId !== "string" || !versionId) return null;
  if (!reviewIsFiniteInt(source.start_seq) || !reviewIsFiniteInt(source.end_seq)) return null;
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

function reviewPanelNormalizeReview(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.reviewId !== "string" || !msg.reviewId || !Array.isArray(msg.items)) return null;
  const attendees = (Array.isArray(msg.attendees) ? msg.attendees : [])
    .filter((attendee) => attendee && typeof attendee.attendeeId === "string" && attendee.attendeeId
      && typeof attendee.displayName === "string" && attendee.displayName.trim())
    .map((attendee) => ({ attendeeId: attendee.attendeeId, displayName: attendee.displayName }));
  return {
    reviewId: msg.reviewId,
    transcriptVersionId: typeof msg.transcriptVersionId === "string" ? msg.transcriptVersionId : "",
    attendees,
    items: msg.items.map(reviewNormalizeItem).filter((item) => item !== null),
  };
}

function reviewOptionsHtml(review, selectedId, hasAttendees) {
  if (!hasAttendees) return `<option value="">참석자 없음</option>`;
  const options = [`<option value="">미지정</option>`];
  for (const attendee of review.attendees) {
    const selected = attendee.attendeeId === selectedId ? " selected" : "";
    options.push(`<option value="${reviewEscapeHtml(attendee.attendeeId)}"${selected}>${reviewEscapeHtml(attendee.displayName)}</option>`);
  }
  return options.join("");
}

function reviewItemHtml(input) {
  const { item, review, itemState, description, attributionId, assigneeId, deadlineValue,
    editing, hasAttendees, complete } = input;
  const dropped = itemState === "rejected";
  const confirmed = itemState === "confirmed";
  const disabled = dropped || !hasAttendees ? " disabled" : "";
  const range = item.startSeq === item.endSeq ? `seq ${item.startSeq}` : `seq ${item.startSeq}–${item.endSeq}`;
  const deadline = item.kind === "action_item"
    ? `<label class="review-item__field review-item__deadline"><span class="review-item__field-label">기한</span>
         <input class="review-item__deadline-input" type="date" value="${reviewEscapeHtml(deadlineValue)}"
           aria-label="${reviewEscapeHtml(description)} 기한"${dropped ? " disabled" : ""}>
         ${item.deadlineText ? `<span class="review-item__deadline-text">${reviewEscapeHtml(item.deadlineText)}</span>` : ""}
       </label>`
    : "";
  const assignee = item.kind === "action_item"
    ? `<label class="review-item__field"><span class="review-item__field-label">담당자</span>
         <select class="review-item__select review-item__assignee" aria-label="${reviewEscapeHtml(description)} 담당자"${disabled}>
           ${reviewOptionsHtml(review, assigneeId, hasAttendees)}
         </select></label>`
    : "";
  const body = editing
    ? `<textarea class="review-item__editor" aria-label="${reviewEscapeHtml(description)} 설명 수정">${reviewEscapeHtml(description)}</textarea>`
    : `<p class="review-item__description">${reviewEscapeHtml(description)}</p>`;

  return `
    <article class="review-item${dropped ? " review-item--dropped" : ""} review-item--${reviewEscapeHtml(item.kind)}"
      role="listitem" data-item-id="${reviewEscapeHtml(item.id)}" data-kind="${reviewEscapeHtml(item.kind)}"
      data-review-state="${reviewEscapeHtml(itemState)}" data-transcript-version-id="${reviewEscapeHtml(item.transcriptVersionId)}"
      data-start-seq="${reviewEscapeHtml(String(item.startSeq))}" data-end-seq="${reviewEscapeHtml(String(item.endSeq))}">
      <header class="review-item__head">
        <span class="review-item__kind">${reviewEscapeHtml(REVIEW_KIND_LABEL[item.kind])}</span>
        <span class="review-item__coords" title="불변 전사 좌표">${reviewEscapeHtml(range)} · ${reviewEscapeHtml(item.transcriptVersionId)}</span>
      </header>
      ${body}
      <blockquote class="review-item__quote">${reviewEscapeHtml(item.evidenceQuote)}</blockquote>
      <details class="review-item__evidence">
        <summary class="review-item__evidence-summary">근거 구간 전문</summary>
        <pre class="review-item__segment">${reviewEscapeHtml(item.segmentText)}</pre>
      </details>
      ${deadline}
      <footer class="review-item__foot">
        <label class="review-item__field"><span class="review-item__field-label">귀속</span>
          <select class="review-item__select review-item__attribution" aria-label="${reviewEscapeHtml(description)} 발언 귀속"${disabled}>
            ${reviewOptionsHtml(review, attributionId, hasAttendees)}
          </select></label>
        ${assignee}
        <span class="review-item__spacer"></span>
        ${!dropped ? `<button type="button" class="review-item__action review-item__confirm"
          aria-label="${reviewEscapeHtml(description)} ${confirmed ? "재검토" : "항목 확정"}"
          ${!confirmed && !complete ? " disabled" : ""}>${confirmed ? "재검토" : "항목 확정"}</button>` : ""}
        ${editing
          ? `<button type="button" class="review-item__action review-item__save" aria-label="${reviewEscapeHtml(description)} 수정 저장">저장</button>
             <button type="button" class="review-item__action review-item__cancel" aria-label="${reviewEscapeHtml(description)} 수정 취소">취소</button>`
          : `<button type="button" class="review-item__action review-item__edit" aria-label="${reviewEscapeHtml(description)} 수정"${dropped ? " disabled" : ""}>수정</button>`}
        <button type="button" class="review-item__action review-item__drop" aria-label="${reviewEscapeHtml(description)} ${dropped ? "복원" : "제외"}">${dropped ? "복원" : "제외"}</button>
      </footer>
    </article>`;
}

function reviewPanelRender(input) {
  const { review, listEl, confirmEl, confirmCountEl, countEl, noticeEl, versionEl,
    itemState, description, attribution, assignee, deadline, editingId, complete, canConfirm, isOpen } = input;
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
  listEl.innerHTML = review.items.length === 0
    ? `<p class="review-list__empty">추출된 후보가 없습니다 — 전사에 명시적인 결정·액션·미결 표현이 없었습니다</p>`
    : review.items.map((item) => reviewItemHtml({
      item, review, itemState: itemState(item), description: description(item),
      attributionId: attribution(item), assigneeId: assignee(item), deadlineValue: deadline(item),
      editing: editingId === item.id, hasAttendees, complete: complete(item),
    })).join("");
  noticeEl.textContent = hasAttendees || review.items.length === 0
    ? "" : "참석자 명단이 비어 있어 귀속을 지정할 수 없습니다";
  noticeEl.hidden = !noticeEl.textContent;
  const kept = review.items.filter((item) => itemState(item) !== "rejected").length;
  confirmCountEl.textContent = String(kept);
  countEl.textContent = String(kept);
  countEl.hidden = kept === 0;
  confirmEl.disabled = !canConfirm() || !isOpen();
}
