// ============================================================
// app.js - 브라우저 클라이언트: WebSocket 수신 → 슬라이드 렌더
// ============================================================

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};

const currentSlideEl = $("current-slide");
const thumbnailsEl = $("thumbnails");
const historyCountEl = $("history-count");
const captionTextEl = $("caption-text");
const speakerChipEl = $("speaker-chip");
const islandEl = $("island");
const onairEl = $("onair");
const statusIndicatorEl = $("status-indicator");
const statusTextEl = $("status-text");
const btnExportMdEl = $("btn-export-md");
const btnExportJsonEl = $("btn-export-json");
const btnExportTranscriptEl = $("btn-export-transcript");
const btnCompileDeckEl = /** @type {HTMLButtonElement} */ ($("btn-compile-deck"));
const compileStatusEl = $("compile-status");
const btnExportDeckEl = $("btn-export-deck");
const btnExportPdfEl = /** @type {HTMLButtonElement} */ ($("btn-export-pdf"));
const btnExportPngEl = /** @type {HTMLButtonElement} */ ($("btn-export-png"));
const btnSettingsEl = /** @type {HTMLButtonElement} */ ($("btn-settings"));
const providerPanelEl = $("provider-panel");
const providerListEl = $("provider-list");
const btnRecheckEl = $("btn-recheck");
const btnSettingsCloseEl = $("btn-settings-close");
const btnRecheckSttEl = $("btn-recheck-stt");
const sttListEl = $("stt-list");
const btnRecordEl = /** @type {HTMLButtonElement} */ ($("btn-record"));
const btnAttendeesEl = /** @type {HTMLButtonElement} */ ($("btn-attendees"));
const attendeePanelEl = $("attendee-panel");
const attendeeFormEl = /** @type {HTMLFormElement} */ ($("attendee-form"));
const attendeeNameEl = /** @type {HTMLInputElement} */ ($("attendee-name"));
const attendeeCrmEl = /** @type {HTMLInputElement} */ ($("attendee-crm"));
const attendeeListEl = $("attendee-list");
const attendeeErrorEl = $("attendee-error");
const attendeeCountEl = $("attendee-count");
const btnAttendeeAddEl = /** @type {HTMLButtonElement} */ ($("btn-attendee-add"));
const btnAttendeeSaveEl = /** @type {HTMLButtonElement} */ ($("btn-attendee-save"));
// 전사는 우측 도킹 패널(.transcript-pane)이 1차 거처다 — 하단 도크 복제본은 없았다.
const transcriptStreamEl = $("transcript-stream");
const transcriptCountEl = $("transcript-count");
const transcriptEmptyEl = $("transcript-empty");
const transcriptBodyEl = $("transcript-body");
const btnResetEl = $("btn-reset");
const sessionListEl = $("session-list");
const sessionEmptyEl = $("session-empty");
const sessionCountEl = $("session-count");
const conflictingJobControls = [btnCompileDeckEl, btnExportPdfEl, btnExportPngEl];
let jobControlsBusy = false;

// 글랜서블 상태 스트립
const appEl = document.querySelector(".app");
const glanceCaptureEl = $("glance-capture");
const glanceCaptureLabelEl = glanceCaptureEl.querySelector(".glance__label");
const glanceSlideEl = $("glance-slide");
const glanceLinesEl = $("glance-lines");
const glanceProviderEl = $("glance-provider");
const glanceDetectEl = $("glance-detect");
const glanceRecEl = $("glance-rec");
const captureTimerEl = $("capture-timer");
const lastSavedEl = $("last-saved");
const docTitleEl = $("doc-title");
const docMetaEl = $("doc-meta");
const pillMetaEl = $("pill-meta");
const selectModelEl = /** @type {HTMLSelectElement} */ ($("select-model"));
const selectEffortEl = /** @type {HTMLSelectElement} */ ($("select-effort"));
const effortRowEl = $("effort-row");

const transcriptTruncEl = $("transcript-trunc");

let currentSlide = null;
let slideHistory = [];
let ws = null;
let meetings = [];
let selectedMeetingId = null;
let awaitingInitialCaptureState = true;
// 썸네일 미리보기 상태. PowerPoint 생성 결과도 같은 무대에서 확인한다.
let viewingHistory = null;
let renderedSlides = [];
let viewingCompiled = false;
let compiledPreviewTitle = "";
let activeMeetingTitle = "";

function syncActionAvailability() {
  const connected = Boolean(ws && ws.readyState === WebSocket.OPEN);
  btnRecordEl.disabled = !connected;
  btnAttendeesEl.disabled = !connected || capturing;
  for (const control of [btnExportMdEl, btnExportJsonEl, btnExportTranscriptEl, btnExportDeckEl]) {
    control.disabled = !connected;
  }
  for (const control of conflictingJobControls) control.disabled = !connected || jobControlsBusy;
  btnResetEl.disabled = !connected || capturing;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function requestMeetings() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "listMeetings" }));
  }
}

function renderMeetings(items) {
  meetings = Array.isArray(items) ? items : [];
  if (selectedMeetingId !== null && !meetings.some((item) => item.id === selectedMeetingId)) {
    selectedMeetingId = null;
    showFreshWorkspace();
  }
  sessionCountEl.textContent = String(meetings.length);
  sessionEmptyEl.hidden = meetings.length > 0;
  sessionListEl.innerHTML = meetings.map((item) => {
    const selected = item.id === selectedMeetingId;
    const started = new Date(item.started_at).toLocaleString("ko-KR", {
      month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    });
    return `<li class="session-item">
      <button type="button" class="session-row${selected ? " session-row--selected" : ""}" data-meeting-id="${escapeHtml(item.id)}" aria-pressed="${selected}">
        <span class="session-row__title">${escapeHtml(item.title)}</span>
        <span class="session-row__meta">
          <span>${escapeHtml(started)}</span>
          <span class="session-row__status session-row__status--${item.status === "open" ? "open" : "ended"}">${item.status === "open" ? "진행 중" : "종료"}</span>
        </span>
      </button>
      <button type="button" class="session-delete" data-meeting-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)} 삭제" title="회의 기록 삭제">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"></path>
        </svg>
      </button>
    </li>`;
  }).join("");
}

sessionListEl.addEventListener("click", (ev) => {
  const deleteButton = ev.target instanceof Element ? ev.target.closest(".session-delete") : null;
  if (deleteButton instanceof HTMLElement) {
    const meetingId = Number(deleteButton.dataset.meetingId);
    const meeting = meetings.find((item) => item.id === meetingId);
    if (
      Number.isSafeInteger(meetingId)
      && ws?.readyState === WebSocket.OPEN
      && window.confirm(`“${meeting?.title ?? `회의 #${meetingId}`}” 기록을 삭제할까요?\n내보낸 파일은 유지됩니다.`)
    ) {
      ws.send(JSON.stringify({ action: "deleteMeeting", meetingId }));
      renderStatus("회의 기록을 삭제하는 중…");
    }
    return;
  }
  const row = ev.target instanceof Element ? ev.target.closest(".session-row") : null;
  if (!(row instanceof HTMLElement)) return;
  const nextMeetingId = Number(row.dataset.meetingId);
  const meeting = meetings.find((item) => item.id === nextMeetingId);
  if (meeting?.status === "open" && capturing) {
    selectedMeetingId = null;
    renderMeetings(meetings);
    renderStatus("현재 진행 중인 회의를 보고 있습니다");
    return;
  }
  selectedMeetingId = nextMeetingId;
  renderMeetings(meetings);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "selectMeeting", meetingId: selectedMeetingId }));
    activeMeetingTitle = meeting?.title ?? "";
    renderStatus(`회의 기록을 불러오는 중… ${meeting?.title ?? `#${selectedMeetingId}`}`);
  }
});

function showFreshWorkspace() {
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  renderedSlides = [];
  viewingCompiled = false;
  compiledPreviewTitle = "";
  activeMeetingTitle = "";
  renderTranscriptBacklog([]);
  renderMain();
  renderThumbnails([]);
  compileStatusEl.hidden = true;
  compileStatusEl.textContent = "";
  if (lastSavedEl) {
    lastSavedEl.hidden = true;
    lastSavedEl.textContent = "";
    lastSavedEl.title = "";
  }
  renderDocHead();
}

// 라이브 MeetingCard → 실시간 kind 추론 후 레이아웃 분기.
// 예전에는 단일 카드만 써서 "디자인이 안 바뀌는" 느낌이 났고,
// kind별 비주얼은 컴파일 덱에만 있었다. 라이브 무대에서도 전환이 보여야 한다.
function inferLiveKind(slide) {
  const emphasis = typeof slide.emphasis === "string" ? slide.emphasis.trim() : "";
  const kicker = typeof slide.kicker === "string" ? slide.kicker.trim() : "";
  const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
  const actionHits = bullets.filter((b) => /담당|까지|하기로|액션|마감|완료|공유/.test(b)).length;
  if (/^결정\s*:/.test(emphasis) || /결정|합의|확정/.test(kicker)) return "decision";
  if (/^액션\s*:/.test(emphasis) || /액션|할\s*일|TODO|후속/.test(kicker) || actionHits >= 2) return "actions";
  if (/요약|정리|회고|클로징/.test(kicker) || bullets.length >= 5) return "summary";
  if (Number(slide.index) === 1 && bullets.length <= 2 && !emphasis) return "cover";
  if (bullets.length === 0) return "section";
  return "topic";
}

function resolveLiveKind(slide) {
  const allowed = new Set(["cover", "section", "topic", "decision", "actions", "summary"]);
  const raw = typeof slide.kind === "string" ? slide.kind.trim().toLowerCase() : "";
  if (allowed.has(raw)) return raw;
  return inferLiveKind(slide);
}

function sceneSlideMarkup(scene) {
  const elements = (scene.elements ?? []).map((element) => {
    const frame = `left:${element.x}%;top:${element.y / 56.25 * 100}%;width:${element.w}%;height:${element.h / 56.25 * 100}%`;
    if (element.type === "shape") {
      if (element.shape === "line") {
        return `<div class="live-scene__shape live-scene__line" style="${frame};border-top:${element.strokeWidth ?? 1}px solid #${element.stroke ?? "000000"}"></div>`;
      }
      const border = element.stroke ? `border:${element.strokeWidth ?? 1}px solid #${element.stroke}` : "";
      const fill = element.fill ? `background:#${element.fill}` : "";
      const radius = element.shape === "ellipse" ? "border-radius:50%" : "";
      return `<div class="live-scene__shape" style="${frame};${border};${fill};${radius}"></div>`;
    }
    const weight = element.weight === "bold" ? 740 : element.weight === "semibold" ? 620 : 400;
    return `<div class="live-scene__text live-scene__text--${element.role}" style="${frame};font-size:${element.fontSize}px;color:#${element.color};font-weight:${weight};text-align:${element.align ?? "left"}">${escapeHtml(element.text)}</div>`;
  }).join("");
  return `<div class="live-scene" data-scene-intent="${escapeHtml(scene.intent)}" style="background:#${scene.background}">${elements}</div>`;
}

function slideHtml(slide) {
  if (slide.scene && Array.isArray(slide.scene.elements)) {
    return sceneSlideMarkup(slide.scene);
  }
  const kind = resolveLiveKind(slide);
  const kicker = typeof slide.kicker === "string" ? slide.kicker.trim() : "";
  const emphasis = typeof slide.emphasis === "string" ? slide.emphasis.trim() : "";
  const title = escapeHtml(slide.title ?? "");
  const idx = escapeHtml(String(slide.index).padStart(2, "0"));
  const bullets = (slide.bullets ?? []).map((b) => escapeHtml(b));
  const kickerHtml = kicker
    ? `<span class="slide__kicker">${escapeHtml(kicker)}</span>`
    : "";
  const bulletsHtml = bullets.length
    ? `<ul class="slide__bullets">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`
    : "";
  const emphasisHtml = emphasis
    ? `<p class="slide__emphasis"><span class="slide__emphasis-label">핵심</span>${escapeHtml(emphasis)}</p>`
    : "";
  const kindLabel = {
    cover: "표지",
    section: "구분",
    topic: "주요 내용",
    decision: "결정",
    actions: "할 일",
    summary: "요약",
  }[kind] ?? "주요 내용";

  // cover: 히어로 타이틀 중심
  if (kind === "cover") {
    return `
    <div class="slide__inner slide__inner--live slide__inner--cover" data-live-kind="cover">
      <span class="slide__cover-number" aria-hidden="true">${idx}</span>
      <div class="slide__kindchip">${kindLabel}</div>
      <p class="slide__cover-eyebrow">${kickerHtml || `<span class="slide__kicker">${selectedMeetingId !== null ? "회의 슬라이드" : "실시간 슬라이드"}</span>`}</p>
      <h2 class="slide__title slide__title--hero">${title}</h2>
      ${bulletsHtml}
      <div class="slide__cover-foot"><span class="slide__index">${idx}</span><span>${selectedMeetingId !== null || !capturing ? "회의 기록" : "내용 정리 중"}</span></div>
    </div>`;
  }

  // section: 큰 제목 + 얇은 본문
  if (kind === "section") {
    return `
    <div class="slide__inner slide__inner--live slide__inner--section" data-live-kind="section">
      <div class="slide__kindchip">${kindLabel}</div>
      <div class="slide__meta"><span class="slide__index">${idx}</span>${kickerHtml}</div>
      <h2 class="slide__title slide__title--section">${title}</h2>
      <div class="slide__accent"></div>
      ${emphasisHtml}
    </div>`;
  }

  // decision: 강조 박스가 주인공
  if (kind === "decision") {
    return `
    <div class="slide__inner slide__inner--live slide__inner--decision" data-live-kind="decision">
      <div class="slide__kindchip">${kindLabel}</div>
      <div class="slide__meta"><span class="slide__index">${idx}</span>${kickerHtml}</div>
      <h2 class="slide__title">${title}</h2>
      ${emphasisHtml || `<p class="slide__emphasis"><span class="slide__emphasis-label">결정</span>${title}</p>`}
      ${bulletsHtml}
    </div>`;
  }

  // actions: 체크리스트 톤
  if (kind === "actions") {
    const items = bullets.map((b, i) =>
      `<li class="slide__action"><span class="slide__action-no">${String(i + 1).padStart(2, "0")}</span><span class="slide__action-text">${b}</span></li>`
    ).join("");
    return `
    <div class="slide__inner slide__inner--live slide__inner--actions" data-live-kind="actions">
      <div class="slide__kindchip">${kindLabel}</div>
      <div class="slide__meta"><span class="slide__index">${idx}</span>${kickerHtml}</div>
      <h2 class="slide__title">${title}</h2>
      <div class="slide__accent"></div>
      <ul class="slide__actions">${items}</ul>
      ${emphasisHtml}
    </div>`;
  }

  // summary: 2열 불릿 느낌
  if (kind === "summary") {
    return `
    <div class="slide__inner slide__inner--live slide__inner--summary" data-live-kind="summary">
      <div class="slide__kindchip">${kindLabel}</div>
      <div class="slide__meta"><span class="slide__index">${idx}</span>${kickerHtml}</div>
      <h2 class="slide__title">${title}</h2>
      <div class="slide__accent"></div>
      <div class="slide__summary-grid">${bulletsHtml}</div>
      ${emphasisHtml}
    </div>`;
  }

  // topic (default): 좌 텍스트 + 우 비주얼 밴드 — 실시간 "디자인 중"이 보이게
  return `
    <div class="slide__inner slide__inner--live slide__inner--topic" data-live-kind="topic">
      <div class="slide__topic-main">
        <div class="slide__kindchip">${kindLabel}</div>
        <div class="slide__meta"><span class="slide__index">${idx}</span>${kickerHtml}</div>
        <h2 class="slide__title">${title}</h2>
        <div class="slide__accent"></div>
        ${bulletsHtml}
        ${emphasisHtml}
      </div>
      <aside class="slide__topic-visual" aria-hidden="true">
        <span class="slide__topic-number">${idx}</span>
      </aside>
    </div>`;
}

function renderSlide(slide) {
  if (!slide) {
    setOnAir(false);
    currentSlideEl.innerHTML = `
      <div class="slide__placeholder">
        <div class="placeholder__mic">
          <span class="mic__core" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V6a3 3 0 0 0-3-3Z"></path>
              <path d="M5 11a1 1 0 1 1 2 0v1a5 5 0 0 0 10 0v-1a1 1 0 1 1 2 0v1a7 7 0 0 1-6 6.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.07A7 7 0 0 1 5 12v-1Z"></path>
            </svg>
          </span>
        </div>
        <h2 class="placeholder__title">대화가 충분히 쌓이면 슬라이드 초안을 만들어 보세요</h2>
        <p class="placeholder__sub">지금까지의 대화로 편집 가능한 PowerPoint 초안을 만듭니다</p>
      </div>`;
    return;
  }

  setOnAir(true);
  currentSlideEl.innerHTML = slideHtml(slide);
}
function renderMain() {
  if (!viewingHistory) {
    renderSlide(currentSlide);
  } else {
    setOnAir(true);
    const notice = viewingCompiled
      ? `만든 PowerPoint의 ${viewingHistory.index}번째 슬라이드입니다. 누르면 실시간 화면으로 돌아갑니다.`
      : `${viewingHistory.index}번째 슬라이드 미리보기입니다. 누르면 현재 화면으로 돌아갑니다.`;
    currentSlideEl.innerHTML = `
      <button type="button" class="slide__notice">${escapeHtml(notice)}</button>
      ${slideHtml(viewingHistory)}`;
  }
  renderGlance();
}

// 글랜서블 스트립: 현재 슬라이드 인덱스 + 히스토리 수 + 전사 줄 수.
function renderGlance() {
  const cur = viewingHistory ?? currentSlide;
  const total = viewingCompiled ? renderedSlides.length : slideHistory.length + (currentSlide ? 1 : 0);
  const idx = cur ? String(cur.index).padStart(2, "0") : "00";
  glanceSlideEl.textContent = `${idx}/${String(total).padStart(2, "0")}`;
  glanceLinesEl.textContent = String(transcriptLineCount);
}

function renderThumbnails(history, includeCurrent = true) {
  const slides = [...history];
  if (includeCurrent && currentSlide && !slides.some((slide) => slide.index === currentSlide.index)) slides.push(currentSlide);
  renderedSlides = slides;
  historyCountEl.textContent = `${slides.length}장`;

  if (slides.length === 0) {
    thumbnailsEl.innerHTML = `
      <div class="filmstrip__empty">
        <span class="filmstrip__empty-ring"></span>
        <span>아직 만든 슬라이드가 없습니다</span>
      </div>`;
    return;
  }
  thumbnailsEl.innerHTML = slides.map((s) => `
    <div class="thumbnail${viewingHistory && viewingHistory.index === s.index ? " thumbnail--viewing" : ""}" data-index="${escapeHtml(String(s.index))}" tabindex="0" role="button" aria-label="슬라이드 ${escapeHtml(String(s.index))} 미리보기">
      <div class="thumbnail__index">슬라이드 ${escapeHtml(String(s.index).padStart(2, "0"))}</div>
      <div class="thumbnail__title">${escapeHtml(s.title)}</div>
      <ul class="thumbnail__bullets">
        ${(s.bullets ?? []).slice(0, 3).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
      </ul>
    </div>`).join("");
}

function compiledSceneSlides(scene) {
  if (!scene || !Array.isArray(scene.slides)) return [];
  return scene.slides.map((slide, index) => {
    const textElements = Array.isArray(slide.elements)
      ? slide.elements.filter((element) => element?.type === "text" && typeof element.text === "string")
      : [];
    const title = textElements.find((element) => element.role === "title")?.text ?? `슬라이드 ${index + 1}`;
    const bullets = textElements
      .filter((element) => ["statement", "body", "quote", "meta"].includes(element.role))
      .map((element) => element.text);
    return { index: index + 1, title, bullets, scene: slide };
  });
}

function showCompiledScene(scene) {
  const slides = compiledSceneSlides(scene);
  if (slides.length === 0) return;
  viewingCompiled = true;
  compiledPreviewTitle = typeof scene.title === "string" && scene.title.trim() ? scene.title.trim() : "슬라이드 초안";
  viewingHistory = slides[0];
  renderThumbnails(slides, false);
  renderMain();
  renderDocHead();
  renderPill();
}

function exitSlidePreview() {
  viewingHistory = null;
  viewingCompiled = false;
  compiledPreviewTitle = "";
  renderThumbnails(slideHistory);
  renderMain();
  renderDocHead();
  renderPill();
}

const SPEAKER_COLORS = ["#10b981", "#60a5fa", "#f59e0b", "#f472b6"];

function renderCaption(text, speaker) {
  const live = !!text;
  if (live) lastCaptionAt = Date.now();
  captionTextEl.textContent = text || "발언을 기다리는 중…";
  islandEl.classList.toggle("island--live", live);
  if (live && speaker) {
    speakerChipEl.hidden = false;
    speakerChipEl.textContent = `화자 ${speaker}`;
    speakerChipEl.style.setProperty("--chip-color", SPEAKER_COLORS[(speaker - 1) % SPEAKER_COLORS.length]);
  } else {
    speakerChipEl.hidden = true;
  }
  renderPill();
}

// ── Granola식 단일 상태 필 + 문서 헤드 ──
// 상태 우선순위: 신선한 자막 > AI 생성 중 > 녹음 중 > 대기.
// 글랜스 메트릭은 필 오른쪽 메타 한 줄에 압축한다.
let lastCaptionAt = 0;
let detecting = false;
let meetingStartTs = 0;
let providerLabelCur = "";

function fmtMMSS(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderPill() {
  const fresh = Date.now() - lastCaptionAt < 2500;
  if (!fresh) {
    let text = currentSlide ? "녹음이 끝났습니다" : "녹음 대기";
    if (detecting) text = "슬라이드를 정리하는 중…";
    else if (capturing) text = `녹음 중 ${fmtMMSS(Date.now() - captureStartedAt)}`;
    captionTextEl.textContent = text;
  }
  islandEl.classList.toggle("island--live", fresh);
  islandEl.classList.toggle("island--recording", capturing && !fresh);
  islandEl.classList.toggle("island--detecting", detecting && !fresh);
  const shown = viewingHistory ?? currentSlide;
  const total = viewingCompiled ? renderedSlides.length : slideHistory.length + (currentSlide ? 1 : 0);
  pillMetaEl.textContent = [
    shown ? `슬라이드 ${shown.index}/${total}` : null,
    `${transcriptLineCount}문장`,
    providerLabelCur || null,
  ].filter(Boolean).join(" · ");
}

function renderDocHead() {
  if (viewingCompiled) docTitleEl.textContent = compiledPreviewTitle;
  else if (selectedMeetingId !== null) docTitleEl.textContent = activeMeetingTitle || "지난 회의";
  else if (capturing) docTitleEl.textContent = "회의 진행 중";
  else if (currentSlide) docTitleEl.textContent = "최근 회의";
  else docTitleEl.textContent = "새 회의 준비";
  const total = viewingCompiled ? renderedSlides.length : slideHistory.length + (currentSlide ? 1 : 0);
  const parts = [];
  if (meetingStartTs) {
    parts.push(new Date(meetingStartTs).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit" }));
  }
  parts.push(`${transcriptLineCount}문장`);
  if (total > 0) parts.push(`슬라이드 ${total}장`);
  docMetaEl.textContent = parts.join(" · ");
}

function setOnAir() {
  const label = onairEl.querySelector(".onair__label");
  onairEl.classList.toggle("onair--idle", !capturing);
  if (label) label.textContent = capturing ? "녹음 중" : "녹음 대기";
}

function savedArtifactLabel(path) {
  const value = String(path ?? "").toLowerCase();
  if (value.endsWith(".pptx")) return "PowerPoint";
  if (value.endsWith(".pdf")) return "PDF";
  if (value.endsWith("index.html")) return "웹 슬라이드";
  if (value.endsWith(".json")) return "회의 데이터";
  if (/transcript-.*\.md$/.test(value)) return "전사 원문";
  if (value.endsWith(".md")) return "회의 메모";
  if (value.endsWith("-png") || value.includes("-png/")) return "슬라이드 이미지";
  return "파일";
}

function friendlyStatus(text) {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  const saved = cleaned.match(/^(?:(웹 슬라이드|덱|PDF|슬라이드 이미지|초안 PNG)\s+)?저장됨:\s*(.+?)(?:\s+\(미검토\))?$/);
  if (saved) {
    const explicit = saved[1] === "덱" ? "웹 슬라이드" : saved[1] === "초안 PNG" ? "슬라이드 이미지" : saved[1];
    return `${explicit || savedArtifactLabel(saved[2])} 저장 완료`;
  }
  if (/^whisper-stream 시작:/i.test(cleaned)) return "음성 인식을 시작했습니다";
  if (/usage limit|사용량 한도/i.test(cleaned)) return "AI 사용량 한도에 도달했습니다. 기본 형식으로 이어서 만듭니다";
  if (/^연결됨\.\s*LLM provider=/i.test(cleaned)) return "AI 모델에 연결되었습니다";
  if (/^LLM 변경됨:/i.test(cleaned)) return "슬라이드 생성 모델을 변경했습니다";
  if (/^STT 모델 변경됨:/i.test(cleaned)) return "음성 인식 모델을 변경했습니다";
  if (/연결\/로그인 명령을 실행합니다/.test(cleaned)) return "로그인 화면을 열었습니다. 로그인 후 연결 상태를 다시 확인해 주세요.";
  if (/A conflicting .* job is already in progress/i.test(cleaned)) return "다른 파일을 만드는 중입니다. 완료 후 다시 시도해 주세요.";
  if (/meetingId must be|No stored meeting|Meeting was not found/i.test(cleaned)) return "저장된 회의를 찾을 수 없습니다";
  if (/capture must be stopped before reset/i.test(cleaned)) return "녹음을 중지한 뒤 새 회의를 준비해 주세요";
  return cleaned;
}

function renderStatus(text) {
  const cleaned = friendlyStatus(text);
  statusTextEl.textContent = cleaned.length > 96 ? `${cleaned.slice(0, 93)}...` : cleaned;
  statusTextEl.title = cleaned;
  statusIndicatorEl.classList.remove(
    "status__indicator--ok",
    "status__indicator--warn",
    "status__indicator--error",
  );
  if (/오류|실패|error|fail/i.test(`${text} ${cleaned}`)) {
    statusIndicatorEl.classList.add("status__indicator--error");
  } else if (/연결|완료|저장|정상|ok/i.test(cleaned)) {
    statusIndicatorEl.classList.add("status__indicator--ok");
  } else {
    statusIndicatorEl.classList.add("status__indicator--warn");
  }
}

function downloadText(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── 전사 원문 저장 ──
function exportTranscript(entries) {
  if (!entries || entries.length === 0) {
    renderStatus("저장할 발언이 없습니다");
    return;
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
  const lines = ["# 회의 전사 원문", "", `저장 시각: ${new Date().toLocaleString("ko-KR")}`, ""];
  for (const e of entries) {
    const who = e.speaker ? `화자 ${e.speaker}` : "전사";
    lines.push(`**[${fmtTime(e.ts)}] ${who}** — ${e.text}`);
  }
  lines.push("");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadText(`meeting-transcript-${stamp}.md`, "text/markdown;charset=utf-8", lines.join("\n"));
  renderStatus(`전사 원문 ${entries.length}문장을 저장했습니다`);
}

// ── 슬라이드 생성 모델 설정 ──
let currentProvider = "";

const PROVIDER_COPY = {
  "cli:codex": { name: "ChatGPT", detail: "구독 계정" },
  "cli:grok": { name: "Grok", detail: "xAI 계정" },
  "cli:claude": { name: "Claude", detail: "Claude Pro 또는 Max 계정" },
  "cli:gemini": { name: "Gemini", detail: "Google 계정" },
  alibaba: { name: "Alibaba GLM", detail: "Alibaba Cloud API 키" },
  openai: { name: "OpenAI", detail: "API 키로 연결" },
  local: { name: "로컬 모델", detail: "이 Mac에서 실행" },
};

function providerCopy(provider) {
  return PROVIDER_COPY[provider?.id] ?? { name: provider?.label ?? "AI 모델", detail: provider?.detail ?? "" };
}

function displayModelName(model) {
  const value = String(model ?? "");
  const gpt = value.match(/^gpt-(\d+(?:\.\d+)?)-(sol|luna|terra)$/i);
  if (gpt) return `GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1).toLowerCase()}`;
  return value;
}

const EFFORT_COPY = { low: "낮음", medium: "보통", high: "높음" };

function renderProviders(msg) {
  currentProvider = msg.current ?? "";
  const curRow = (Array.isArray(msg.list) ? msg.list : []).find((p) => p.id === currentProvider);
  const currentCopy = providerCopy(curRow);
  providerLabelCur = msg.currentModel ? displayModelName(msg.currentModel) : (curRow ? currentCopy.name : currentProvider);
  glanceProviderEl.textContent = providerLabelCur || "—";
  renderProviderConfig(msg);
  renderDocHead();
  renderPill();
  const list = Array.isArray(msg.list) ? msg.list : [];
  providerListEl.innerHTML = list.map((p) => {
    const isCli = p.id.startsWith("cli:");
    const keyBased = p.id === "openai" || p.id === "alibaba";
    const status = providerStatus(p);
    const copy = providerCopy(p);
    const showActions = isCli || !status.selectable;
    return `
    <div class="provider-row${p.id === currentProvider ? " provider-row--current" : ""}${status.selectable ? "" : " provider-row--disabled"}" data-id="${escapeHtml(p.id)}" data-auth="${escapeHtml(status.auth)}" data-installed="${status.installed ? "true" : "false"}">
      <button type="button" class="provider-row__select" ${status.selectable ? "" : "disabled"} aria-pressed="${p.id === currentProvider ? "true" : "false"}">
        <span class="provider-row__name">${escapeHtml(copy.name)}</span>
        <span class="provider-row__detail">${escapeHtml(copy.detail)}</span>
        <span class="provider-row__badge provider-row__badge--${status.tone}">${escapeHtml(status.badge)}</span>
      </button>
      ${showActions ? `
        <div class="provider-row__actions">
          ${isCli ? `<button type="button" class="provider-row__connect" data-id="${escapeHtml(p.id)}">${escapeHtml(status.connectLabel)}</button>` : ""}
          ${keyBased && !status.selectable ? `
            <button type="button" class="provider-row__connect" data-id="${escapeHtml(p.id)}">키 발급</button>
            <input class="provider-row__key" type="password" placeholder="${escapeHtml(copy.name)} API 키" aria-label="${escapeHtml(copy.name)} API 키" autocomplete="off">
            <button type="button" class="provider-row__save" data-id="${escapeHtml(p.id)}">API 키 저장</button>` : ""}
        </div>` : ""}
    </div>`;
  }).join("");
}

/**
 * 품질 기준: 설치/인증 상태를 진실하게 분리한다.
 * auth=="unknown"은 어뜘가 확인되지 않은 것이므로 절대 "연결됨"으로 표시하지 않고,
 * 설치된 CLI는 여전히 사용자가 직접 선택할 수 있게 남긴다.
 */
function providerStatus(p) {
  const isCli = p.id.startsWith("cli:");
  const auth = typeof p.auth === "string" ? p.auth : (p.available ? "connected" : "unavailable");
  const installed = typeof p.installed === "boolean" ? p.installed : Boolean(p.available);
  if (!isCli) {
    return {
      auth, installed,
      selectable: Boolean(p.available),
      tone: p.available ? "ok" : "absent",
      badge: p.available ? "사용 가능" : (p.id === "local" ? "설정 필요" : "API 키 필요"),
      connectLabel: "설정",
    };
  }
  if (!installed || auth === "unavailable") {
    return { auth, installed, selectable: false, tone: "absent", badge: "설치 필요", connectLabel: "로그인" };
  }
  if (auth === "connected") {
    return { auth, installed, selectable: true, tone: "ok", badge: "사용 가능", connectLabel: "다시 로그인" };
  }
  if (auth === "disconnected") {
    return { auth, installed, selectable: true, tone: "absent", badge: "로그인 필요", connectLabel: "로그인" };
  }
  return { auth, installed, selectable: true, tone: "unknown", badge: "로그인 확인 필요", connectLabel: "로그인" };
}

// ── 현재 프로바이더의 모델/effort 선택 ──
function renderProviderConfig(msg) {
  const entry = (Array.isArray(msg.list) ? msg.list : []).find((p) => p.id === msg.current);
  const models = entry?.models ?? [];
  selectModelEl.disabled = models.length === 0;
  selectModelEl.innerHTML = `<option value="">기본 모델</option>` + models.map((m) =>
    `<option value="${escapeHtml(m)}"${m === msg.currentModel ? " selected" : ""}>${escapeHtml(displayModelName(m))}</option>`,
  ).join("");

  const efforts = entry?.efforts ?? [];
  effortRowEl.hidden = efforts.length === 0;
  selectEffortEl.innerHTML = `<option value="">기본 설정</option>` + efforts.map((e) =>
    `<option value="${e}"${e === msg.currentEffort ? " selected" : ""}>${escapeHtml(EFFORT_COPY[e] ?? e)}</option>`,
  ).join("");
}

// ── 음성 인식(whisper.cpp) 모델 관리 ──
// 서버가 디스크 기준의 진실을 보내주므로 클라이언트는 상태를 추측하지 않고 그대로 반영한다.
let sttSelectedModelId = null;

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(value / 1024 ** 2)} MB`;
}

function sttStatusView(model) {
  switch (model.status) {
    case "selected": return { tone: "selected", badge: "사용 중" };
    case "installed": return { tone: "installed", badge: "설치됨" };
    case "downloading": return { tone: "downloading", badge: "내려받는 중" };
    case "failed": return { tone: "failed", badge: "실패" };
    default: return { tone: "absent", badge: "미설치" };
  }
}

function sttActions(model) {
  const id = escapeHtml(model.id);
  const label = escapeHtml(model.label ?? model.id);
  switch (model.status) {
    case "downloading":
      return `<button type="button" class="stt-btn stt-btn--quiet stt-row__cancel" data-id="${id}" aria-label="${label} 내려받기 취소">취소</button>`;
    case "installed":
      return `<button type="button" class="stt-btn stt-row__select" data-id="${id}" aria-label="${label} 사용">사용</button>`;
    case "selected":
      return `<button type="button" class="stt-btn stt-row__select" data-id="${id}" aria-label="${label} 사용 중" disabled>사용 중</button>`;
    case "failed":
      return `<button type="button" class="stt-btn stt-row__install" data-id="${id}" aria-label="${label} 다시 내려받기">다시 시도</button>`;
    default:
      return `<button type="button" class="stt-btn stt-row__install" data-id="${id}" aria-label="${label} 내려받기">내려받기</button>`;
  }
}

function renderSttModels(msg) {
  const models = Array.isArray(msg.models) ? msg.models : [];
  sttSelectedModelId = msg.selectedModelId ?? null;
  sttListEl.innerHTML = models.map((model) => {
    const view = sttStatusView(model);
    const downloading = model.status === "downloading";
    const total = downloading ? Number(model.totalBytes) || 0 : 0;
    const received = downloading ? Number(model.receivedBytes) || 0 : 0;
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const meta = downloading
      ? `${formatBytes(received)} / ${formatBytes(total || model.sizeBytes)} · ${percent}%`
      : `${formatBytes(model.sizeBytes)} · ${escapeHtml(model.license ?? "—")}`;
    return `
    <div class="stt-row${model.status === "selected" ? " stt-row--selected" : ""}${model.status === "failed" ? " stt-row--failed" : ""}" data-id="${escapeHtml(model.id)}" data-status="${escapeHtml(model.status)}">
      <div class="stt-row__head">
        <span class="stt-row__name">${escapeHtml(model.label ?? model.id)}</span>
        <span class="stt-row__badge stt-row__badge--${view.tone}">${view.badge}</span>
      </div>
      <span class="stt-row__meta">${meta}</span>
      ${downloading ? `<div class="stt-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="stt-progress__fill" style="width:${percent}%"></div></div>` : ""}
      ${model.status === "failed" && model.error ? `<span class="stt-row__error">${escapeHtml(model.error)}</span>` : ""}
      <div class="stt-row__actions">${sttActions(model)}</div>
    </div>`;
  }).join("");
}

function sendSttAction(action, modelId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, modelId }));
  }
}

sttListEl.addEventListener("click", (ev) => {
  const install = ev.target instanceof Element ? ev.target.closest(".stt-row__install") : null;
  if (install instanceof HTMLElement) return sendSttAction("installSttModel", install.dataset.id);
  const cancel = ev.target instanceof Element ? ev.target.closest(".stt-row__cancel") : null;
  if (cancel instanceof HTMLElement) return sendSttAction("cancelSttModel", cancel.dataset.id);
  const select = ev.target instanceof Element ? ev.target.closest(".stt-row__select") : null;
  if (select instanceof HTMLButtonElement && !select.disabled) return sendSttAction("selectSttModel", select.dataset.id);
});

btnRecheckSttEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "recheckSttModels" }));
    renderStatus("음성 인식 모델의 설치 상태를 확인하는 중…");
  }
};

function sendProviderSelection() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: "setProvider",
      id: currentProvider,
      model: selectModelEl.value,
      effort: effortRowEl.hidden ? "" : selectEffortEl.value,
    }));
  }
}
selectModelEl.onchange = sendProviderSelection;
selectEffortEl.onchange = sendProviderSelection;

btnSettingsEl.setAttribute("aria-controls", providerPanelEl.id);
btnSettingsEl.setAttribute("aria-expanded", "false");

function setProviderPanelOpen(open, restoreFocus = false) {
  providerPanelEl.hidden = !open;
  btnSettingsEl.setAttribute("aria-expanded", String(open));
  if (restoreFocus) btnSettingsEl.focus({ preventScroll: true });
}

btnSettingsEl.onclick = (ev) => {
  ev.stopPropagation();
  setProviderPanelOpen(providerPanelEl.hidden);
};
btnSettingsCloseEl.onclick = () => setProviderPanelOpen(false, true);

providerListEl.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const connectBtn = ev.target.closest(".provider-row__connect");
  if (connectBtn instanceof HTMLElement && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "connectProvider", id: connectBtn.dataset.id }));
    return;
  }
  const saveBtn = ev.target.closest(".provider-row__save");
  if (saveBtn instanceof HTMLElement && ws && ws.readyState === WebSocket.OPEN) {
    const row = saveBtn.closest(".provider-row");
    const input = row?.querySelector(".provider-row__key");
    if (input instanceof HTMLInputElement && input.value.trim()) {
      ws.send(JSON.stringify({ action: "setProviderKey", id: saveBtn.dataset.id, key: input.value.trim() }));
      input.value = "";
    }
    return;
  }
  const selectBtn = ev.target.closest(".provider-row__select");
  const row = selectBtn?.closest(".provider-row");
  if (selectBtn instanceof HTMLButtonElement && row instanceof HTMLElement &&
      !selectBtn.disabled && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "setProvider", id: row.dataset.id }));
  }
});

btnRecheckEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "recheckProviders" }));
    renderStatus("AI 모델 연결 상태를 확인하는 중…");
  }
};

document.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  if (!providerPanelEl.hidden && !ev.target.closest("#provider-panel") && !ev.target.closest("#btn-settings")) {
    setProviderPanelOpen(false, true);
  }
});

// ── 실시간 전사: 우측 도킹 패널 ──
let transcriptLineCount = 0;

// 도킹 패널은 pane__body가 스크롤 컨테이너다 — 목록이 아니라 몸체를 밀어야 최신 문장이 보인다.
function scrollTranscriptToLatest() {
  transcriptBodyEl.scrollTop = transcriptBodyEl.scrollHeight;
}

function renderTranscriptLine(entry) {
  transcriptEmptyEl.hidden = true;
  const row = document.createElement("div");
  row.className = "feed-line";
  const time = new Date(entry.ts).toLocaleTimeString("ko-KR", { hour12: false });
  const chip = entry.speaker
    ? `<span class="speaker-chip" style="--chip-color: ${SPEAKER_COLORS[(entry.speaker - 1) % SPEAKER_COLORS.length]}">화자 ${entry.speaker}</span>`
    : "";
  row.innerHTML = `
    <span class="feed-line__meta"><span class="feed-line__time">${escapeHtml(time)}</span>${chip}</span>
    <span class="feed-line__text">${escapeHtml(entry.text)}</span>`;
  transcriptStreamEl.appendChild(row);
  transcriptLineCount += 1;
  transcriptCountEl.textContent = String(transcriptLineCount);
  if (!meetingStartTs) meetingStartTs = entry.ts;
  renderGlance();
  renderDocHead();
  renderPill();
  scrollTranscriptToLatest();
}
function renderTranscriptBacklog(entries) {
  transcriptStreamEl.replaceChildren();
  transcriptLineCount = 0;
  meetingStartTs = 0;
  transcriptCountEl.textContent = "0";
  transcriptBodyEl.scrollTop = 0;
  if (!entries || entries.length === 0) {
    transcriptEmptyEl.hidden = false;
    return;
  }
  // 각 line은 renderTranscriptLine이 transcriptLineCount를 증가시키고 renderGlance를 갱신한다.
  // backlog 시작점에서 카운트/스크롤을 리셋하고, 한 번만 끝단에서 정리.
  for (const e of entries) renderTranscriptLine(e);
  renderGlance();
  scrollTranscriptToLatest();
}

// ── 녹음 시작/중지 버튼 ──
let capturing = false;
let inputMode = "mic";

function renderCaptureState() {
  if (capturing) {
    appEl.classList.add("app--capturing");
    if (glanceCaptureLabelEl) glanceCaptureLabelEl.textContent = "녹음 중";
    startCaptureTimer();
  } else {
    appEl.classList.remove("app--capturing");
    if (glanceCaptureLabelEl) glanceCaptureLabelEl.textContent = currentSlide ? "녹음 완료" : "녹음 대기";
    stopCaptureTimer();
  }
  const resetLabel = capturing ? "새 회의 준비. 녹음을 먼저 중지해 주세요" : "현재 회의를 닫고 새 회의 준비";
  btnResetEl.title = resetLabel;
  btnResetEl.setAttribute("aria-label", resetLabel);
  syncActionAvailability();
  setOnAir();
}

// ── 녹음 경과 타이머 (클라이언트 기준: capture 시작 시각 추정) ──
let captureStartedAt = 0;
let captureTimerId = null;
function startCaptureTimer() {
  if (captureTimerId !== null) return;
  if (!Number.isFinite(captureStartedAt) || captureStartedAt <= 0) captureStartedAt = Date.now();
  if (glanceRecEl) glanceRecEl.hidden = false;
  const tick = () => {
    const s = Math.floor((Date.now() - captureStartedAt) / 1000);
    if (captureTimerEl) captureTimerEl.textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    renderPill();
  };
  tick();
  captureTimerId = setInterval(tick, 1000);
}
function stopCaptureTimer() {
  if (captureTimerId !== null) { clearInterval(captureTimerId); captureTimerId = null; }
  captureStartedAt = 0;
  if (glanceRecEl) glanceRecEl.hidden = true;
}

function renderCaptureButton() {
  btnRecordEl.hidden = inputMode === "file";
  btnRecordEl.classList.toggle("record-btn--on", capturing);
  btnRecordEl.setAttribute("aria-pressed", String(capturing));
  btnRecordEl.setAttribute("aria-label", capturing ? "녹음 중지" : "녹음 시작");
  const label = btnRecordEl.querySelector(".record-btn__label");
  if (label) label.textContent = capturing ? "녹음 중지" : "녹음 시작";
}

btnRecordEl.onclick = () => {
  sendCaptureToggle();
};

renderCaptureButton();

// ── 참석자 지정 (캡처 전 준비) ──
// 로컬 초안(drafts)은 아직 서버에 없는 편집 상태, attendeeState는 서버가 확정해
// 에코한 명단이다. 저장 버튼이 초안을 setAttendees로 보내고, attendees 메시지가
// 오면 attendeeState(+meeting_id)를 교체한 뒤 초안을 서버 명단으로 되맞춘다.
// meeting_id는 startCapture가 같은 draft meeting을 활성화하도록 함께 보낸다.
let attendeeDrafts = [];
let attendeeDirty = false;
const attendeeState = { meetingId: null, attendees: [] };
// 테스트/디버깅용 관찰 지점 — 드롭다운(T8)이 읽을 원천과 동일한 객체.
/** @type {Window & typeof globalThis & { __attendeeState: typeof attendeeState }} */ (window).__attendeeState = attendeeState;

function setAttendeeError(text) {
  attendeeErrorEl.textContent = text ?? "";
  attendeeErrorEl.hidden = !text;
}

function renderAttendeeList() {
  attendeeCountEl.textContent = String(attendeeState.attendees.length);
  attendeeCountEl.hidden = attendeeState.attendees.length === 0;
  if (attendeeDrafts.length === 0) {
    attendeeListEl.innerHTML = `<p class="attendee-list__empty">아직 참석자가 없습니다</p>`;
    return;
  }
  attendeeListEl.innerHTML = attendeeDrafts.map((a, i) => `
    <div class="attendee-row${a.saved ? " attendee-row--saved" : ""}" data-index="${i}">
      <span class="attendee-row__body">
        <span class="attendee-row__name">${escapeHtml(a.name)}</span>
        ${a.crmPersonId ? `<span class="attendee-row__crm">${escapeHtml(a.crmPersonId)}</span>` : ""}
      </span>
      <button type="button" class="attendee-row__edit" aria-label="${escapeHtml(a.name)} 수정">수정</button>
      <button type="button" class="attendee-row__remove" aria-label="${escapeHtml(a.name)} 삭제">삭제</button>
    </div>`).join("");
}

function openAttendeePanel() {
  if (btnAttendeesEl.disabled) return;
  attendeePanelEl.hidden = false;
  btnAttendeesEl.setAttribute("aria-expanded", "true");
  attendeeNameEl.focus();
}

function closeAttendeePanel(restoreFocus = false) {
  attendeePanelEl.hidden = true;
  btnAttendeesEl.setAttribute("aria-expanded", "false");
  if (restoreFocus) btnAttendeesEl.focus();
}

/** 캡처 중에는 명단을 잠근다 (서버가 draft meeting을 활성화한 뒤이므로 편집 불가). */
function renderAttendeeLock() {
  btnAttendeesEl.disabled = capturing;
  const attendeeLabel = capturing ? "참석자 지정. 녹음 중에는 변경할 수 없습니다" : "참석자 지정";
  btnAttendeesEl.title = attendeeLabel;
  btnAttendeesEl.setAttribute("aria-label", attendeeLabel);
  attendeeNameEl.disabled = capturing;
  attendeeCrmEl.disabled = capturing;
  btnAttendeeAddEl.disabled = capturing;
  btnAttendeeSaveEl.disabled = capturing;
  if (capturing) closeAttendeePanel();
  syncActionAvailability();
}

/** 초안 한 명 추가/수정 — 빈 이름·중복 이름은 거부하고 초안을 그대로 둔다. */
function commitAttendeeDraft() {
  if (capturing) return;
  const name = attendeeNameEl.value.trim();
  const crmPersonId = attendeeCrmEl.value.trim();
  if (!name) {
    setAttendeeError("이름을 입력하세요");
    attendeeNameEl.focus();
    return;
  }
  if (attendeeDrafts.some((a) => a.name === name)) {
    setAttendeeError(`이미 추가된 참석자입니다: ${name}`);
    attendeeNameEl.focus();
    return;
  }
  attendeeDrafts.push({ name, crmPersonId, saved: false });
  attendeeDirty = true;
  attendeeNameEl.value = "";
  attendeeCrmEl.value = "";
  setAttendeeError("");
  renderAttendeeList();
  attendeeNameEl.focus();
}

attendeeFormEl.addEventListener("submit", (ev) => {
  ev.preventDefault();
  commitAttendeeDraft();
});

attendeeListEl.addEventListener("click", (ev) => {
  if (capturing || !(ev.target instanceof Element)) return;
  const row = ev.target.closest(".attendee-row");
  if (!(row instanceof HTMLElement)) return;
  const index = Number(row.dataset.index);
  if (ev.target.closest(".attendee-row__remove")) {
    attendeeDrafts.splice(index, 1);
    attendeeDirty = true;
    setAttendeeError("");
    renderAttendeeList();
    return;
  }
  if (ev.target.closest(".attendee-row__edit")) {
    // 수정은 행을 폼으로 되돌린다 — 확정(Enter)하면 원래 위치가 아닌 끝에 다시 붙는다.
    const [entry] = attendeeDrafts.splice(index, 1);
    attendeeNameEl.value = entry.name;
    attendeeCrmEl.value = entry.crmPersonId ?? "";
    attendeeDirty = true;
    setAttendeeError("");
    renderAttendeeList();
    attendeeNameEl.focus();
  }
});

/** 초안을 setAttendees 와이어 페이로드로 직렬화해 보낸다. */
function sendAttendees() {
  if (capturing) return;
  if (attendeeDrafts.length === 0) {
    setAttendeeError("참석자를 한 명 이상 추가하세요");
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setAttendeeError("앱 서버에 연결되지 않아 참석자를 저장할 수 없습니다");
    return;
  }
  ws.send(JSON.stringify({
    action: "setAttendees",
    attendees: attendeeDrafts.map((a) => (
      a.crmPersonId ? { name: a.name, crmPersonId: a.crmPersonId } : { name: a.name }
    )),
  }));
  setAttendeeError("");
  renderStatus("참석자 저장 중…");
}

btnAttendeeSaveEl.onclick = sendAttendees;

btnAttendeesEl.onclick = (ev) => {
  ev.stopPropagation();
  if (attendeePanelEl.hidden) openAttendeePanel();
  else closeAttendeePanel();
};

document.addEventListener("click", (ev) => {
  if (attendeePanelEl.hidden || !(ev.target instanceof Element)) return;
  // 패널 안 버튼(수정/삭제)은 핸들러가 리스트를 다시 그려 버리므로, 이벤트가
  // document까지 올라올 때 ev.target은 이미 DOM에서 떨어져 closest()가 패널을
  // 찾지 못한다. 그런 분리된 타겟을 "바깥 클릭"으로 오인하지 않도록 제외한다.
  if (!ev.target.isConnected) return;
  if (!ev.target.closest("#attendee-panel") && !ev.target.closest("#btn-attendees")) {
    closeAttendeePanel();
  }
});

/**
 * 준비된 draft 회의 참조를 버린다 (reset 이후). 서버가 그 회의를 이미 종료했으므로
 * meeting_id는 재사용할 수 없다. 명단 초안은 사용자가 다시 저장할 수 있게 남겨두되
 * 서버에 확정되지 않은 상태로 되돌린다.
 */
function clearPreparedMeeting() {
  attendeeState.meetingId = null;
  attendeeState.attendees = [];
  attendeeDrafts = attendeeDrafts.map((a) => ({ ...a, saved: false }));
  attendeeDirty = attendeeDrafts.length > 0;
  setAttendeeError("");
  renderAttendeeList();
}

/** 서버가 확정한 명단으로 상태와 초안을 되맞춘다 (재연결 복원 포함). */
function applyAttendeesMessage(msg) {
  const rows = Array.isArray(msg.attendees) ? msg.attendees : [];
  const attendees = rows
    .filter((a) => a && typeof a === "object" && typeof a.display_name === "string" && a.display_name.trim())
    .map((a) => ({
      attendeeId: typeof a.attendee_id === "string" ? a.attendee_id : "",
      displayName: a.display_name,
      crmPersonEntityId: typeof a.crm_person_entity_id === "string" ? a.crm_person_entity_id : null,
    }));
  if (typeof msg.meeting_id === "number" && Number.isFinite(msg.meeting_id)) {
    attendeeState.meetingId = msg.meeting_id;
  }
  attendeeState.attendees = attendees;
  attendeeDrafts = attendees.map((a) => ({
    name: a.displayName,
    crmPersonId: a.crmPersonEntityId ?? "",
    saved: true,
  }));
  const userWasSaving = attendeeDirty;
  attendeeDirty = false;
  setAttendeeError("");
  renderAttendeeList();
  if (userWasSaving) renderStatus(`참석자 ${attendees.length}명을 저장했습니다`);
}

/** 준비된 meeting_id가 있으면 startCapture에 실어 같은 draft 회의를 활성화한다. */
function sendCaptureToggle() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    renderStatus("앱 서버에 연결하는 중입니다. 잠시 후 다시 눌러 주세요");
    return;
  }
  renderStatus(capturing ? "녹음을 중지하는 중…" : "녹음을 시작하는 중…");
  if (capturing) {
    ws.send(JSON.stringify({ action: "stopCapture" }));
    requestMeetings();
    return;
  }
  if (attendeeDirty) {
    setAttendeeError("저장하지 않은 참석자가 있습니다. 참석자를 저장한 뒤 녹음을 시작해 주세요");
  }
  // 참석자는 하드 게이트가 아니다 — 지정하지 않아도 캡처는 시작된다.
  ws.send(JSON.stringify(attendeeState.meetingId === null
    ? { action: "startCapture" }
    : { action: "startCapture", meeting_id: attendeeState.meetingId }));
  requestMeetings();
}

renderAttendeeList();
renderAttendeeLock();

// ── 회의록 검토 오버레이 (review-panel.js) ──
// 슬라이드 셸 위에 얹히는 세 번째 오버레이. 소켓은 app.js가 소유하므로
// 전송/연결 여부만 얇은 transport로 넘긴다.
const reviewPanel = window.createReviewPanel ? window.createReviewPanel({
  send(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  },
  isOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
}) : {
  syncTransport() {},
  applyReview() {},
  applyStatus() {},
};

// ── 버튼 핸들러 (connect 외부에서 1회 바인딩) ──
function meetingTarget() {
  return selectedMeetingId === null ? {} : { meetingId: selectedMeetingId };
}

btnExportMdEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveNotes", ...meetingTarget() }));
    renderStatus("회의 메모를 저장하는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 저장할 수 없습니다");
  }
};
btnExportJsonEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveJson", ...meetingTarget() }));
    renderStatus("회의 데이터를 저장하는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 저장할 수 없습니다");
  }
};
btnExportTranscriptEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveTranscript", ...meetingTarget() }));
    renderStatus("전사 원문을 저장하는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 저장할 수 없습니다");
  }
};

btnCompileDeckEl.onclick = () => {
  if (transcriptLineCount === 0) {
    renderStatus("슬라이드를 만들려면 먼저 회의를 녹음해 주세요");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "compileTranscriptSnapshot", ...meetingTarget() }));
    setJobControlsBusy(true);
    compileStatusEl.hidden = false;
    compileStatusEl.dataset.state = "started";
    compileStatusEl.textContent = "슬라이드 초안을 만드는 중…";
    renderStatus("지금까지의 대화로 슬라이드 초안을 만드는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 슬라이드를 만들 수 없습니다");
  }
};

let activeJobId = null;
function setJobControlsBusy(busy) {
  jobControlsBusy = busy;
  syncActionAvailability();
}
function showRetry(action, meetingId) {
  document.querySelector(".job-retry")?.remove();
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "job-retry dock__btn";
  retry.dataset.action = action;
  retry.textContent = "재시도";
  retry.onclick = () => {
    retry.remove();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, ...(meetingId === undefined ? meetingTarget() : { meetingId }) }));
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
  compileStatusEl.hidden = false;
  compileStatusEl.dataset.state = msg.status;
  if (msg.status === "started" || msg.status === "progress") {
    activeJobId = msg.jobId ?? activeJobId;
    setJobControlsBusy(true);
    compileStatusEl.textContent = msg.status === "progress" ? progressText("슬라이드", msg) : "슬라이드 초안을 만드는 중…";
    renderStatus(compileStatusEl.textContent);
  } else if (msg.status === "success") {
    if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
    setJobControlsBusy(false);
    activeJobId = null;
    document.querySelector(".job-retry")?.remove();
    if (msg.scene) showCompiledScene(msg.scene);
    const count = msg.outline?.slideCount;
    const hasCount = Number.isFinite(count);
    const countText = hasCount ? `${count}장` : "슬라이드";
    const fallback = Boolean(msg.outline?.usedFallback || msg.outline?.plannerError);
    compileStatusEl.dataset.state = fallback ? "warning" : "success";
    compileStatusEl.textContent = fallback
      ? (hasCount ? `기본 형식으로 ${countText} 완성` : "기본 형식으로 완성")
      : (hasCount ? `슬라이드 ${countText} 완성` : "슬라이드 완성");
    const limitHit = /usage limit|사용량 한도/i.test(String(msg.outline?.plannerError ?? ""));
    renderStatus(fallback
      ? (limitHit
        ? (hasCount ? `AI 사용량 한도로 기본 형식 ${countText}을 만들었습니다` : "AI 사용량 한도로 기본 형식 슬라이드를 만들었습니다")
        : (hasCount ? `AI 구성이 원활하지 않아 기본 형식으로 ${countText}을 만들었습니다` : "AI 구성이 원활하지 않아 기본 형식으로 슬라이드를 만들었습니다"))
      : (hasCount ? `슬라이드 ${countText}을 만들었습니다` : "슬라이드를 만들었습니다"));
  } else {
    if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
    setJobControlsBusy(false);
    activeJobId = null;
    compileStatusEl.textContent = msg.status === "timeout"
      ? "슬라이드 생성 시간이 초과되었습니다"
      : `슬라이드를 만들지 못했습니다: ${friendlyStatus(msg.error || "알 수 없는 오류")}`;
    renderStatus(compileStatusEl.textContent);
    showRetry("compileTranscriptSnapshot", msg.meetingId);
  }
}

function renderExportStatus(msg) {
  const label = msg.action === "exportPdf" ? "PDF" : "슬라이드 이미지";
  if (msg.status === "started" || msg.status === "progress") {
    activeJobId = msg.jobId ?? activeJobId;
    setJobControlsBusy(true);
    renderStatus(msg.status === "progress" ? progressText(label, msg) : `${label} 준비 중…`);
    return;
  }
  if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
  setJobControlsBusy(false);
  activeJobId = null;
  if (msg.status === "success") {
    document.querySelector(".job-retry")?.remove();
    renderStatus(`${label} 저장 완료`);
  } else {
    const busy = msg.code === "job-busy" || msg.code === "compile-busy";
    renderStatus(busy
      ? "슬라이드를 만드는 중에는 다른 파일을 저장할 수 없습니다"
      : `${label} ${msg.status === "timeout" ? "생성 시간이 초과되었습니다" : "저장 실패"}: ${friendlyStatus(msg.error || "알 수 없는 오류")}`);
    if (!busy) showRetry(msg.action, msg.meetingId);
  }
}

btnExportDeckEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportDeck", ...meetingTarget() }));
    renderStatus("웹 슬라이드를 만드는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 웹 슬라이드를 저장할 수 없습니다");
  }
};

btnExportPdfEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportPdf", ...meetingTarget() }));
    setJobControlsBusy(true);
    renderStatus("PDF를 만드는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 PDF를 만들 수 없습니다");
  }
};

btnExportPngEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportPng", ...meetingTarget() }));
    setJobControlsBusy(true);
    renderStatus("슬라이드 이미지를 저장하는 중…");
  } else {
    renderStatus("앱 서버에 연결되지 않아 이미지를 저장할 수 없습니다");
  }
};
btnResetEl.onclick = () => {
  if (capturing) {
    renderStatus("녹음을 중지한 뒤 새 회의를 준비해 주세요");
    return;
  }
  if (!window.confirm("현재 회의를 닫고 새 회의를 준비할까요?\n저장된 회의 기록과 내보낸 파일은 그대로 남습니다.")) return;
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  viewingCompiled = false;
  compiledPreviewTitle = "";
  renderedSlides = [];
  renderTranscriptBacklog([]);
  transcriptTruncEl.hidden = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "reset" }));
    requestMeetings();
    clearPreparedMeeting();
    renderStatus("새 회의를 준비했습니다");
  } else {
    renderStatus("앱 서버에 연결되지 않아 새 회의를 준비할 수 없습니다");
  }
  renderMain();
  renderThumbnails([]);
  renderDocHead();
};

// ── 슬라이드 썸네일 미리보기 ──
/** @param {HTMLElement} card */
function toggleThumbnailPreview(card) {
  const idx = Number(card.dataset.index);
  const slide = renderedSlides.find((candidate) => candidate.index === idx);
  if (!slide) return;
  if (viewingHistory && viewingHistory.index === slide.index) {
    exitSlidePreview();
    return;
  }
  viewingHistory = slide;
  renderMain();
  renderPill();
}
thumbnailsEl.addEventListener("click", (ev) => {
  const card = ev.target instanceof HTMLElement ? ev.target.closest(".thumbnail") : null;
  if (card instanceof HTMLElement) toggleThumbnailPreview(card);
});
thumbnailsEl.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const card = (ev.target instanceof HTMLElement ? ev.target.closest(".thumbnail") : null);
  if (!(card instanceof HTMLElement)) return;
  ev.preventDefault();
  toggleThumbnailPreview(card);
});

currentSlideEl.addEventListener("click", (ev) => {
  if (ev.target instanceof Element && ev.target.closest(".slide__notice")) exitSlidePreview();
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !attendeePanelEl.hidden) {
    closeAttendeePanel(true);
    return;
  }
  if (ev.key === "Escape" && viewingHistory) {
    exitSlidePreview();
    return;
  }
  // 입력 필드/패널 안에서는 단축키 무시
  const tag = (ev.target instanceof HTMLElement ? ev.target.tagName : "").toLowerCase();
  if (tag === "input" || tag === "textarea" || !providerPanelEl.hidden || !attendeePanelEl.hidden) return;
  if (ev.key === "r" && inputMode !== "file") {
    sendCaptureToggle();
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || providerPanelEl.hidden) return;
  // 키보드 사용자가 패널 닫은 뒤 포커스를 잃지 않게 트리거로 되돌린다.
  setProviderPanelOpen(false, true);
});

// ── WebSocket ──
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  awaitingInitialCaptureState = true;
  document.documentElement.dataset.connection = "connecting";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  syncActionAvailability();

  ws.onopen = () => {
    document.documentElement.dataset.connection = "connected";
    syncActionAvailability();
    renderStatus("앱 서버에 연결되었습니다");
    requestMeetings();
    ws.send(JSON.stringify({ action: "attendees" }));
    reviewPanel.syncTransport();
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "slide") {
        if (selectedMeetingId !== null) return;
        if (awaitingInitialCaptureState) return;
        currentSlide = msg.current;
        slideHistory = Array.isArray(msg.history) ? msg.history : [];
        // 라이브 슬라이드가 갱신돼도 사용자가 보고 있는 PowerPoint 미리보기는 유지한다.
        if (!viewingCompiled && viewingHistory && !slideHistory.some((s) => s.index === viewingHistory.index)) {
          viewingHistory = null;
        }
        if (!viewingCompiled) {
          renderMain();
          renderThumbnails(slideHistory);
        }
        renderDocHead();
        renderPill();
        setOnAir();
      } else if (msg.type === "caption") {
        renderCaption(msg.text, msg.speaker);
      } else if (msg.type === "meetings") {
        renderMeetings(msg.items);
      } else if (msg.type === "meeting") {
        if (msg.meetingId !== selectedMeetingId) return;
        currentSlide = msg.current ?? null;
        slideHistory = Array.isArray(msg.history) ? msg.history : [];
        viewingHistory = null;
        viewingCompiled = false;
        compiledPreviewTitle = "";
        activeMeetingTitle = msg.title || `회의 #${msg.meetingId}`;
        renderTranscriptBacklog(msg.transcript);
        renderMain();
        renderThumbnails(slideHistory);
        renderDocHead();
        if (msg.compiled) {
          compileStatusEl.hidden = false;
          compileStatusEl.dataset.state = "success";
          compileStatusEl.textContent = `만든 슬라이드 ${msg.compiled.slideCount}장`;
        } else {
          compileStatusEl.hidden = true;
          compileStatusEl.textContent = "";
        }
        renderStatus(`${activeMeetingTitle} 기록을 불러왔습니다`);
      } else if (msg.type === "transcript") {
        if (selectedMeetingId !== null && msg.reason === "snapshot") return;
        if (awaitingInitialCaptureState && msg.reason === "snapshot") return;
        if (msg.reason === "snapshot") {
          renderTranscriptBacklog(msg.entries);
          transcriptTruncEl.hidden = !msg.truncated;
        } else {
          exportTranscript(msg.entries);
        }
      } else if (msg.type === "line") {
        if (selectedMeetingId === null) renderTranscriptLine(msg);
      } else if (msg.type === "providers") {
        renderProviders(msg);
      } else if (msg.type === "sttModels") {
        renderSttModels(msg);
      } else if (msg.type === "attendees") {
        applyAttendeesMessage(msg);
      } else if (msg.type === "review") {
        reviewPanel.applyReview(msg);
      } else if (msg.type === "capture") {
        capturing = !!msg.capturing;
        if (capturing) {
          if (Number.isFinite(msg.startedAt) && msg.startedAt > 0) captureStartedAt = msg.startedAt;
          awaitingInitialCaptureState = false;
        } else if (awaitingInitialCaptureState && selectedMeetingId === null) {
          showFreshWorkspace();
        }
        inputMode = msg.mode ?? "mic";
        renderCaptureButton();
        renderCaptureState();
        renderAttendeeLock();
        renderPill();
        renderDocHead();
        setOnAir();
      } else if (msg.type === "detect") {
        detecting = !!msg.detecting;
        if (glanceDetectEl) glanceDetectEl.hidden = !msg.detecting;
        renderPill();
      } else if (msg.type === "compile") {
        renderCompileStatus(msg);
      } else if (msg.type === "export") {
        renderExportStatus(msg);
      } else if (msg.type === "saved") {
        if (awaitingInitialCaptureState && selectedMeetingId === null) return;
        renderStatus(`저장됨: ${msg.path}`);
        requestMeetings();
        if (lastSavedEl) {
          const label = savedArtifactLabel(msg.path);
          lastSavedEl.hidden = false;
          lastSavedEl.textContent = `${label} 저장 완료`;
          lastSavedEl.title = `${label} 파일을 저장했습니다`;
        }
      } else if (msg.type === "status") {
        renderStatus(msg.text);
        reviewPanel.applyStatus(msg.text);
      }
    } catch (e) {
      console.error("parse error", e);
    }
  };
  ws.onclose = () => {
    activeJobId = null;
    setJobControlsBusy(false);
    document.documentElement.dataset.connection = "disconnected";
    syncActionAvailability();
    renderStatus("앱 서버 연결이 끊겼습니다. 다시 연결하는 중…");
    reviewPanel?.syncTransport();
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    document.documentElement.dataset.connection = "error";
    syncActionAvailability();
    renderStatus("앱 서버에 연결하지 못했습니다");
  };
}

connect();
