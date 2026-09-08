/** Each gated control's purpose, captured from the markup before any override. */
const controlPurpose = new WeakMap();

/**
 * Declares a control's CURRENT purpose. When no gate is closed the purpose is
 * applied immediately; when one is, only the stored purpose is updated so the
 * displayed reason survives until the gate opens. This is what lets the capture
 * control flip its action label across phases without ever erasing a reason.
 */
export function setControlPurpose(control, title, ariaLabel) {
  if (!control) return;
  controlPurpose.set(control, { title, ariaLabel });
  if (control.disabled) return;
  if (title) control.setAttribute("title", title);
  else control.removeAttribute("title");
  if (ariaLabel) control.setAttribute("aria-label", ariaLabel);
  else control.removeAttribute("aria-label");
}

export function applyGate(control, reason) {
  if (!control) return;
  if (!controlPurpose.has(control)) {
    controlPurpose.set(control, {
      title: control.getAttribute("title") ?? "",
      ariaLabel: control.getAttribute("aria-label") ?? "",
    });
  }
  const purpose = controlPurpose.get(control);
  control.disabled = reason !== null;
  // The reason and the purpose are the same string in both attributes, so the
  // pointer tooltip and the accessible name can never disagree.
  const title = reason ?? purpose.title;
  const label = reason ?? purpose.ariaLabel;
  if (title) control.setAttribute("title", title);
  else control.removeAttribute("title");
  if (label) control.setAttribute("aria-label", label);
  else control.removeAttribute("aria-label");
}

export function createPublicationController({ transport, workspace, slidePlanWorkspace, ask }) {
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};

const btnExportMdEl = $("btn-export-md");
const btnExportJsonEl = $("btn-export-json");
const btnExportTranscriptEl = $("btn-export-transcript");
const btnCompileDeckEl = /** @type {HTMLButtonElement} */ ($("btn-compile-deck"));
const compileStatusEl = $("compile-status");
const finalRebuildDialogEl = $("slide-final-rebuild-dialog");
const btnFinalRebuildCancelEl = /** @type {HTMLButtonElement} */ ($("btn-slide-final-rebuild-cancel"));
const btnFinalRebuildConfirmEl = /** @type {HTMLButtonElement} */ ($("btn-slide-final-rebuild-confirm"));
const btnExportDeckEl = $("btn-export-deck");
const btnExportPdfEl = /** @type {HTMLButtonElement} */ ($("btn-export-pdf"));
const btnExportPngEl = /** @type {HTMLButtonElement} */ ($("btn-export-png"));
const btnRecordEl = /** @type {HTMLButtonElement} */ ($("btn-record"));
const btnAttendeesEl = /** @type {HTMLButtonElement} */ ($("btn-attendees"));
const btnResetEl = $("btn-reset");
let jobControlsBusy = false;
const conflictingJobControls = [btnCompileDeckEl, btnExportPdfEl, btnExportPngEl];
let refinePendingRequest = null;
slidePlanWorkspace?.setRefineHandler((detail) => {
  if (!transport.isOpen() || workspace.selectedMeetingId === null) {
    slidePlanWorkspace.showProposal({ error: "앱 서버에 연결되지 않아 다듬기를 요청할 수 없습니다" });
    return;
  }
  refinePendingRequest = {
    requestId: globalThis.crypto?.randomUUID?.() ?? `refine-${Date.now()}`,
    meetingId: workspace.selectedMeetingId,
    planId: slidePlanWorkspace.currentPlan().planId,
    revision: slidePlanWorkspace.currentPlan().revision,
    slideId: detail.slideId,
    path: detail.path,
  };
  transport.send({
    action: "refineSlideField", meetingId: workspace.selectedMeetingId,
    slideId: detail.slideId, path: detail.path, text: detail.text,
    instruction: detail.instruction, claimIds: detail.claimIds,
    requestId: refinePendingRequest.requestId,
  });
});
/**
 * DESIGN 9.11: "A capability the server gates stays visible and disabled with its
 * exact machine reason in both `title` and `aria-label`."
 *
 * The static markup carries each control's PURPOSE. The moment a gate closes,
 * that purpose is no longer the truth about the control, so the gate's reason
 * replaces it in BOTH places and the purpose is restored when the gate opens.
 * `title` alone is not enough: assistive technology reads the accessible name,
 * so a reason that lives only in `title` never reaches the user who needs it.
 */
const GATE_REASON_DISCONNECTED = "앱 서버에 연결되어야 사용할 수 있습니다";
const GATE_REASON_JOB_BUSY = "진행 중인 슬라이드 작업이 끝나야 사용할 수 있습니다";
const GATE_REASON_CAPTURING = "녹음을 중지한 뒤 사용할 수 있습니다";
const GATE_REASON_SLIDE_PLAN_DIRTY = "로컬 편집으로 내보내기가 오래되었습니다";
const DRAFT_SLIDE_COPY = Object.freeze({
  control: "슬라이드 초안 만들기",
  purpose: "지금까지의 대화로 편집 가능한 PowerPoint 초안 만들기",
  ariaLabel: "슬라이드 초안 만들기",
  placeholderTitle: "대화가 충분히 쌓이면 슬라이드 초안을 만들어 보세요",
  placeholderBody: "지금까지의 대화로 편집 가능한 PowerPoint 초안을 만듭니다",
  progress: "슬라이드 초안을 만드는 중…",
  progressDetail: "지금까지의 대화로 슬라이드 초안을 만드는 중…",
});
const FINAL_SLIDE_COPY = Object.freeze({
  control: "슬라이드 확정본 만들기",
  purpose: "확정된 검토 내용으로 슬라이드 확정본 만들기",
  ariaLabel: "확정된 검토 내용으로 슬라이드 확정본 만들기",
  placeholderTitle: "확정된 검토 내용으로 슬라이드 확정본을 만들어 보세요",
  placeholderBody: "확정된 검토 내용으로 편집 가능한 PowerPoint 확정본을 만듭니다",
  progress: "확정본을 만드는 중…",
  progressDetail: "확정된 검토 내용으로 확정본을 만드는 중…",
});

function finalSlideContext() {
  return workspace.selectedMeetingReviewStatus === "confirmed"
    || slidePlanWorkspace?.currentPublicationStatus() === "final";
}

function currentSlideCopy() {
  return finalSlideContext() ? FINAL_SLIDE_COPY : DRAFT_SLIDE_COPY;
}

function syncSlidePublicationCopy() {
  const copy = currentSlideCopy();
  slidePlanWorkspace?.setConfirmedReviewContext(finalSlideContext());
  btnCompileDeckEl.textContent = copy.control;
  setControlPurpose(btnCompileDeckEl, copy.purpose, copy.ariaLabel);
  if (!workspace.currentSlide && !workspace.viewingHistory && !slidePlanWorkspace?.isActive()) {
    workspace.renderEmptySlidePlaceholder(copy);
  }
}

function syncActionAvailability() {
  ask.syncAvailability();
  const connected = Boolean(transport.isOpen());
  const busy = jobControlsBusy || slidePlanWorkspace.isBusy();
  // The capture control states its gate reason like every other gated control.
  // Its enabled accessible name is the ACTION ("녹음 시작" / "녹음 중지"), which
  // `renderCaptureButton` owns and re-asserts whenever the phase flips, so the
  // reason is applied here and withdrawn there.
  applyGate(btnRecordEl, connected ? null : GATE_REASON_DISCONNECTED);
  applyGate(btnAttendeesEl, !connected ? GATE_REASON_DISCONNECTED : workspace.capturing ? GATE_REASON_CAPTURING : null);
  for (const control of [btnExportMdEl, btnExportJsonEl, btnExportTranscriptEl, btnExportDeckEl]) {
    const stale = control === btnExportDeckEl && slidePlanWorkspace?.isDirty();
    applyGate(control, !connected ? GATE_REASON_DISCONNECTED : stale ? GATE_REASON_SLIDE_PLAN_DIRTY : control === btnExportDeckEl && busy ? GATE_REASON_JOB_BUSY : null);
  }
  for (const control of conflictingJobControls) {
    const stale = control !== btnCompileDeckEl && slidePlanWorkspace?.isDirty();
    applyGate(control, !connected ? GATE_REASON_DISCONNECTED : stale ? GATE_REASON_SLIDE_PLAN_DIRTY : busy ? GATE_REASON_JOB_BUSY : null);
  }
  applyGate(btnResetEl, !connected ? GATE_REASON_DISCONNECTED : workspace.capturing ? GATE_REASON_CAPTURING : null);
}

// ── 버튼 핸들러 (connect 외부에서 1회 바인딩) ──
function meetingTarget() {
  return workspace.selectedMeetingId === null ? {} : { meetingId: workspace.selectedMeetingId };
}

btnExportMdEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "saveNotes", ...meetingTarget() });
    workspace.renderStatus("회의 메모를 저장하는 중…");
  } else {
    workspace.renderStatus("앱 서버에 연결되지 않아 저장할 수 없습니다");
  }
};
btnExportJsonEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "saveJson", ...meetingTarget() });
    workspace.renderStatus("회의 데이터를 저장하는 중…");
  } else {
    workspace.renderStatus("앱 서버에 연결되지 않아 저장할 수 없습니다");
  }
};
btnExportTranscriptEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "saveTranscript", ...meetingTarget() });
    workspace.renderStatus("전사 원문을 저장하는 중…");
  } else {
    workspace.renderStatus("앱 서버에 연결되지 않아 저장할 수 없습니다");
  }
};

let finalRebuildActivated = false;

function needsFinalRebuildDecision() {
  return workspace.selectedMeetingId !== null
    && workspace.selectedMeetingReviewStatus === "confirmed"
    && slidePlanWorkspace?.isDirty()
    && slidePlanWorkspace.currentPublicationStatus() === "draft";
}

function openFinalRebuildDecision() {
  if (!needsFinalRebuildDecision()) return false;
  finalRebuildActivated = false;
  btnFinalRebuildCancelEl.disabled = false;
  btnFinalRebuildConfirmEl.disabled = false;
  if (window.openDialog) window.openDialog(finalRebuildDialogEl);
  else finalRebuildDialogEl.hidden = false;
  window.trapFocus?.(finalRebuildDialogEl);
  btnFinalRebuildCancelEl.focus({ preventScroll: true });
  return true;
}

function closeFinalRebuildDecision(restoreFocus) {
  if (window.closeDialog) window.closeDialog(finalRebuildDialogEl, () => {
    if (restoreFocus && !btnCompileDeckEl.disabled) btnCompileDeckEl.focus({ preventScroll: true });
  }); else {
    finalRebuildDialogEl.hidden = true;
    window.releaseFocus?.(finalRebuildDialogEl);
    if (restoreFocus && !btnCompileDeckEl.disabled) btnCompileDeckEl.focus({ preventScroll: true });
  }
}

function showCompileStarted() {
  const copy = currentSlideCopy();
  clearJobRetry();
  setJobControlsBusy(true);
  compileStatusEl.hidden = false;
  compileStatusEl.dataset.state = "started";
  compileStatusEl.textContent = copy.progress;
  workspace.renderStatus(copy.progressDetail);
}

btnFinalRebuildCancelEl.onclick = () => {
  if (finalRebuildActivated) return;
  closeFinalRebuildDecision(true);
};

btnFinalRebuildConfirmEl.onclick = () => {
  if (finalRebuildActivated || finalRebuildDialogEl.hidden) return;
  finalRebuildActivated = true;
  btnFinalRebuildCancelEl.disabled = true;
  btnFinalRebuildConfirmEl.disabled = true;
  lastCompileAction = "compileSlidePlan";
  showCompileStarted();
  transport.send({ action: "compileSlidePlan", ...meetingTarget() });
  closeFinalRebuildDecision(false);
};

btnCompileDeckEl.onclick = () => {
  if (workspace.transcriptLineCount === 0) {
    workspace.renderStatus(workspace.capturing
      ? "슬라이드를 만들 대화 내용이 아직 없습니다"
      : workspace.selectedMeetingId !== null
        ? "슬라이드를 만들 전사 내용이 없습니다"
        : "슬라이드를 만들려면 먼저 회의를 녹음해 주세요");
    return;
  }
  if (transport.isOpen()) {
    if (openFinalRebuildDecision()) return;
    if (slidePlanWorkspace?.isDirty()) {
      const plan = slidePlanWorkspace.currentPlan();
      lastCompileAction = "persistSlidePlan";
      transport.send({ action: "persistSlidePlan", ...meetingTarget(), plan });
    } else {
      lastCompileAction = "compileSlidePlan";
      transport.send({ action: "compileSlidePlan", ...meetingTarget() });
    }
    showCompileStarted();
  } else {
    workspace.renderStatus("앱 서버에 연결되지 않아 슬라이드를 만들 수 없습니다");
  }
};

let activeJobId = null;
let currentCompileLineage = null;
let lastCompileAction = "compileSlidePlan";
function setJobControlsBusy(busy) {
  jobControlsBusy = busy;
  slidePlanWorkspace?.setBusy(busy);
  syncActionAvailability();
}
function clearJobRetry() {
  document.querySelector(".job-retry")?.remove();
}

function showRetry(action, meetingId) {
  clearJobRetry();
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "job-retry dock__btn";
  retry.dataset.action = action;
  retry.textContent = "재시도";
  retry.onclick = () => {
    retry.remove();
    if (transport.isOpen()) {
      const payload = { action, ...(meetingId === undefined ? meetingTarget() : { meetingId }) };
      if (action === "persistSlidePlan") {
        const plan = slidePlanWorkspace?.currentPlan();
        if (plan) payload.plan = plan;
      }
      transport.send(payload);
      setJobControlsBusy(true);
    }
  };
  compileStatusEl.insertAdjacentElement("afterend", retry);
}
function progressText(label, msg) {
  const count = Number.isFinite(msg.completed) && Number.isFinite(msg.total) ? ` · ${msg.completed}/${msg.total}` : "";
  const stage = {
    planning: "내용을 정리하는 중",
    render: "슬라이드를 디자인하는 중",
    publish: "파일을 저장하는 중",
    prepare: "내보내기를 준비하는 중",
    validate: "슬라이드를 확인하는 중",
    preview: "미리보기를 만드는 중",
    review: "디자인을 점검하는 중",
    "design-gate": "최종 점검 중",
  }[msg.stage] ?? `${label} 처리 중`;
  return `${stage}${count}`;
}
function renderCompileStatus(msg) {
  // A terminal answer for a SUPERSEDED job must not touch the current one. The
  // guard used to sit after these two writes, so a late failure for job-1
  // repainted the running job-2 as `error` and only then returned - the surface
  // reported a failure that had not happened to the job it was showing.
  const terminal = msg.status !== "started" && msg.status !== "progress";
  if (terminal && activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
  const ownsCurrentCompileLineage = terminal
    && currentCompileLineage !== null
    && msg.meetingId === currentCompileLineage.meetingId
    && msg.jobId === currentCompileLineage.jobId;
  if (terminal && currentCompileLineage !== null && !ownsCurrentCompileLineage) return;
  const matchesCurrentCompileLineage = ownsCurrentCompileLineage
    && activeJobId !== null
    && msg.meetingId === workspace.selectedMeetingId
    && msg.jobId === activeJobId;
  compileStatusEl.hidden = false;
  compileStatusEl.dataset.state = msg.status;
  if (msg.status === "started" || msg.status === "progress") {
    activeJobId = msg.jobId ?? activeJobId;
    if (msg.meetingId === workspace.selectedMeetingId && msg.jobId) {
      currentCompileLineage = { meetingId: msg.meetingId, jobId: msg.jobId };
    }
    setJobControlsBusy(true);
    compileStatusEl.textContent = msg.status === "progress" ? progressText("슬라이드", msg) : currentSlideCopy().progress;
    workspace.renderStatus(compileStatusEl.textContent);
  } else if (msg.status === "success") {
    setJobControlsBusy(false);
    activeJobId = null;
    if (ownsCurrentCompileLineage) currentCompileLineage = null;
    document.querySelector(".job-retry")?.remove();
    if (msg.scene) workspace.showCompiledScene(msg.scene);
    const count = msg.outline?.slideCount;
    const hasCount = Number.isFinite(count);
    const countText = hasCount ? `${count}장` : "슬라이드";
    const fallback = Boolean(msg.outline?.usedFallback || msg.outline?.plannerError);
    compileStatusEl.dataset.state = fallback ? "warning" : "success";
    const publicationLabel = msg.publicationStatus === "final" ? "확정본" : "초안";
    compileStatusEl.textContent = fallback
      ? (hasCount ? `기본 형식으로 ${countText} 완성` : "기본 형식으로 완성")
      : (hasCount ? `슬라이드 ${publicationLabel} ${countText} 완성` : `슬라이드 ${publicationLabel} 완성`);
    const limitHit = /usage limit|사용량 한도/i.test(String(msg.outline?.plannerError ?? ""));
    workspace.renderStatus(fallback
      ? (limitHit
        ? (hasCount ? `AI 사용량 한도로 기본 형식 ${countText}을 만들었습니다` : "AI 사용량 한도로 기본 형식 슬라이드를 만들었습니다")
        : (hasCount ? `AI 구성이 원활하지 않아 기본 형식으로 ${countText}을 만들었습니다` : "AI 구성이 원활하지 않아 기본 형식으로 슬라이드를 만들었습니다"))
      : (hasCount ? `슬라이드 ${countText}을 만들었습니다` : "슬라이드를 만들었습니다"));
    if (workspace.selectedMeetingId !== null && transport.isOpen()) {
      transport.send({ action: "selectMeeting", meetingId: workspace.selectedMeetingId });
    }
  } else {
    setJobControlsBusy(false);
    activeJobId = null;
    if (ownsCurrentCompileLineage) currentCompileLineage = null;
    compileStatusEl.textContent = msg.status === "timeout"
      ? "슬라이드 생성 시간이 초과되었습니다"
      : `슬라이드를 만들지 못했습니다: ${workspace.friendlyStatus(msg.error || "알 수 없는 오류")}`;
    workspace.renderStatus(compileStatusEl.textContent);
    if (msg.code === "stale-review-lineage" && matchesCurrentCompileLineage
      && openFinalRebuildDecision()) {
      clearJobRetry();
      return;
    }
    showRetry(lastCompileAction, msg.meetingId);
  }
}

function renderExportStatus(msg) {
  const label = msg.action === "exportPdf" ? "PDF" : "슬라이드 이미지";
  if (msg.status === "started" || msg.status === "progress") {
    activeJobId = msg.jobId ?? activeJobId;
    setJobControlsBusy(true);
    workspace.renderStatus(msg.status === "progress" ? progressText(label, msg) : `${label} 준비 중…`);
    return;
  }
  if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
  setJobControlsBusy(false);
  activeJobId = null;
  if (msg.status === "success") {
    document.querySelector(".job-retry")?.remove();
    workspace.renderStatus(`${label} 저장 완료`);
  } else {
    const busy = msg.code === "job-busy" || msg.code === "compile-busy";
    workspace.renderStatus(busy
      ? "슬라이드를 만드는 중에는 다른 파일을 저장할 수 없습니다"
      : `${label} ${msg.status === "timeout" ? "생성 시간이 초과되었습니다" : "저장 실패"}: ${workspace.friendlyStatus(msg.error || "알 수 없는 오류")}`);
    if (!busy) showRetry(msg.action, msg.meetingId);
  }
}

btnExportDeckEl.onclick = () => {
  const plan = slidePlanWorkspace?.isActive() ? slidePlanWorkspace.currentPlan() : null;
  const planId = plan && typeof plan.planId === "string" ? plan.planId : "";
  if (planId) {
    window.open(`/slide-plan-artifacts/${encodeURIComponent(planId)}/standalone/index.html`, "_blank", "noopener,noreferrer");
    workspace.renderStatus("웹 슬라이드를 열었습니다");
  } else {
    workspace.renderStatus("먼저 슬라이드 초안을 만들어 주세요");
  }
  if (transport.isOpen()) {
    transport.send({ action: "exportDeck", ...meetingTarget() });
  }
};

btnExportPdfEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "exportPdf", ...meetingTarget() });
    setJobControlsBusy(true);
    workspace.renderStatus("PDF를 만드는 중…");
  } else {
    workspace.renderStatus("앱 서버에 연결되지 않아 PDF를 만들 수 없습니다");
  }
};

btnExportPngEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "exportPng", ...meetingTarget() });
    setJobControlsBusy(true);
    workspace.renderStatus("슬라이드 이미지를 저장하는 중…");
  } else {
    workspace.renderStatus("앱 서버에 연결되지 않아 이미지를 저장할 수 없습니다");
  }
};
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || finalRebuildDialogEl.hidden || finalRebuildActivated) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  closeFinalRebuildDecision(true);
}, true);


return Object.freeze({
  syncCopy: syncSlidePublicationCopy, currentCopy: currentSlideCopy,
  syncAvailability: syncActionAvailability, clearRetry: clearJobRetry,
  applyCompile: renderCompileStatus, applyExport: renderExportStatus,
  applyRefine(msg) {
    const pending = refinePendingRequest;
    const plan = slidePlanWorkspace.currentPlan();
    if (!pending || msg.requestId !== pending.requestId
      || pending.meetingId !== workspace.selectedMeetingId
      || pending.planId !== plan?.planId || pending.revision !== plan?.revision
      || (msg.slideId !== undefined && msg.slideId !== pending.slideId)
      || (msg.path !== undefined && msg.path !== pending.path)) return;
    refinePendingRequest = null;
    slidePlanWorkspace.showProposal(msg);
  },
  disconnect() { activeJobId = null; setJobControlsBusy(false); },
});
}
