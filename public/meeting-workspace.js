import { setControlPurpose } from "./publication-controller.js";

export function createMeetingWorkspace({ transport, caretShell, slidePlanWorkspace }) {
let settings, attendees, ask, publication, reviewPanel;
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
const compileStatusEl = $("compile-status");
const btnRecordEl = /** @type {HTMLButtonElement} */ ($("btn-record"));
// 전사는 우측 도킹 패널(.transcript-pane)이 1차 거처다 — 하단 도크 복제본은 없았다.
const transcriptStreamEl = $("transcript-stream");
const transcriptCountEl = $("transcript-count");
const transcriptEmptyEl = $("transcript-empty");
const transcriptBodyEl = $("transcript-body");
const btnResetEl = $("btn-reset");
const sessionListEl = $("session-list");
const sessionEmptyEl = $("session-empty");
const sessionCountEl = $("session-count");
const documentSurfaceEl = $("document-surface");
const notesInputEl = /** @type {HTMLTextAreaElement} */ ($("notes-input"));

// 글랜서블 상태 스트립
const appEl = document.querySelector(".app");
const glanceCaptureEl = $("glance-capture");
const glanceCaptureLabelEl = glanceCaptureEl.querySelector(".glance__label");
const glanceSlideEl = $("glance-slide");
const glanceLinesEl = $("glance-lines");
const glanceDetectEl = $("glance-detect");
const glanceRecEl = $("glance-rec");
const captureTimerEl = $("capture-timer");
const contextRecentListEl = $("context-recent-list");
const contextRecentEmptyEl = $("context-recent-empty");
const contextServerStatusEl = $("context-server-status");
const lastSavedEl = $("last-saved");
const docTitleEl = $("doc-title");
const docMetaEl = $("doc-meta");
const meetingPurposeEl = $("meeting-purpose");
const pillMetaEl = $("pill-meta");

const transcriptTruncEl = $("transcript-trunc");

let currentSlide = null;
let slideHistory = [];
let meetings = [];
let selectedMeetingId = null;
let selectedMeetingReviewId = null;
let selectedMeetingReviewStatus = "none";

function formatContextMeetingDate(startedAt) {
  return new Date(startedAt).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}

function renderContextMeetings(items) {
  if (!contextRecentListEl || !contextRecentEmptyEl) return;
  const recent = (Array.isArray(items) ? items : []).slice(0, 3);
  contextRecentEmptyEl.hidden = recent.length > 0;
  contextRecentListEl.innerHTML = recent.map((item) => `
    <button type="button" class="context-recent__item" data-meeting-id="${escapeHtml(item.id)}">
      <span class="context-recent__marker" aria-hidden="true"></span>
      <span class="context-recent__copy">
        <span class="context-recent__title">${escapeHtml(item.title)}</span>
        <span class="context-recent__meta">${escapeHtml(formatContextMeetingDate(item.started_at))}</span>
      </span>
      <span class="context-recent__arrow" aria-hidden="true">›</span>
    </button>
  `).join("");
}

function renderMeetingPurpose(value) {
  const purpose = typeof value === "string" && value.trim() ? value : "";
  meetingPurposeEl.textContent = purpose;
  meetingPurposeEl.hidden = purpose.length === 0;
}

function selectMeeting(meetingId) {
  const meeting = meetings.find((item) => item.id === meetingId);
  if (meeting?.status === "open" && isCapturing()) {
    selectedMeetingId = null;
    caretShell.activateMeeting(null);
    renderMeetings(meetings);
    renderStatus("현재 진행 중인 회의를 보고 있습니다");
    return;
  }
  if (slidePlanWorkspace?.isDirty() &&
      !window.confirm("저장되지 않은 슬라이드 편집을 버리고 다른 회의로 이동할까요?")) return;
  slidePlanWorkspace?.clear();
  renderMeetingPurpose(null);
  selectedMeetingId = meetingId;
  selectedMeetingReviewId = null;
  selectedMeetingReviewStatus = "none";
  publication?.syncCopy();
  documentSurfaceEl.setAttribute("aria-busy", "true");
  documentSurfaceEl.dataset.loading = "true";
  reviewPanel?.selectMeeting(meetingId);
  caretShell.selectMeeting(meetingId);
  renderMeetings(meetings);
  if (transport.isOpen()) {
    transport.send({ action: "selectMeeting", meetingId: selectedMeetingId });
    activeMeetingTitle = meeting?.title ?? "";
    renderStatus(`회의 기록을 불러오는 중… ${meeting?.title ?? `#${selectedMeetingId}`}`);
  }
}
let awaitingInitialCaptureState = true;
// 썸네일 미리보기 상태. PowerPoint 생성 결과도 같은 무대에서 확인한다.
let viewingHistory = null;
let renderedSlides = [];
let viewingCompiled = false;
let compiledPreviewTitle = "";
let activeMeetingTitle = "";


function requestMeetings() {
  if (transport.isOpen()) {
    transport.send({ action: "listMeetings" });
  }
}

function renderMeetings(items) {
  meetings = Array.isArray(items) ? items : [];
  renderContextMeetings(meetings);
  // While the server is capturing, the meeting it marks `open` IS the live one.
  if (isCapturing()) {
    const open = meetings.find((item) => item.status === "open");
    if (open) liveMeetingId = open.id;
  }
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
      && transport.isOpen()
      && window.confirm(`“${meeting?.title ?? `회의 #${meetingId}`}” 기록을 삭제할까요?\n내보낸 파일은 유지됩니다.`)
    ) {
      transport.send({ action: "deleteMeeting", meetingId });
      renderStatus("회의 기록을 삭제하는 중…");
    }
    return;
  }
  const row = ev.target instanceof Element ? ev.target.closest(".session-row") : null;
  if (!(row instanceof HTMLElement)) return;
  const nextMeetingId = Number(row.dataset.meetingId);
  selectMeeting(nextMeetingId);
});

contextRecentListEl?.addEventListener("click", (ev) => {
  const row = ev.target instanceof Element ? ev.target.closest("[data-meeting-id]") : null;
  if (!(row instanceof HTMLElement)) return;
  const meetingId = Number(row.dataset.meetingId);
  if (Number.isSafeInteger(meetingId)) selectMeeting(meetingId);
});

function showFreshWorkspace() {
  caretShell.resetMeeting();
  documentSurfaceEl.removeAttribute("aria-busy");
  documentSurfaceEl.dataset.loading = "false";
  selectedMeetingReviewId = null;
  selectedMeetingReviewStatus = "none";
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  renderedSlides = [];
  viewingCompiled = false;
  compiledPreviewTitle = "";
  activeMeetingTitle = "";
  renderMeetingPurpose(null);
  slidePlanWorkspace?.clear();
  publication?.syncCopy();
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

// scene 필드는 LLM에서 나오므로 style/class/속성에 들어가는 값은 화이트리스트로 정화한다.
const cssHex = (value, fallback = "000000") => (/^[0-9a-fA-F]{3,8}$/.test(String(value ?? "")) ? String(value) : fallback);
const cssNumber = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
const cssToken = (value, fallback = "") => { const s = String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, ""); return s.length ? s : fallback; };
const cssAlign = (value, fallback = "left") => (["left", "center", "right"].includes(value) ? value : fallback);

function sceneSlideMarkup(scene) {
  const elements = (scene.elements ?? []).map((element) => {
    const frame = `left:${cssNumber(element.x)}%;top:${cssNumber(element.y) / 56.25 * 100}%;width:${cssNumber(element.w)}%;height:${cssNumber(element.h) / 56.25 * 100}%`;
    if (element.type === "shape") {
      if (element.shape === "line") {
        return `<div class="live-scene__shape live-scene__line" style="${frame};border-top:${cssNumber(element.strokeWidth, 1)}px solid #${cssHex(element.stroke)}"></div>`;
      }
      const border = element.stroke ? `border:${cssNumber(element.strokeWidth, 1)}px solid #${cssHex(element.stroke)}` : "";
      const fill = element.fill ? `background:#${cssHex(element.fill)}` : "";
      const radius = element.shape === "ellipse" ? "border-radius:50%" : "";
      return `<div class="live-scene__shape" style="${frame};${border};${fill};${radius}"></div>`;
    }
    const weight = element.weight === "bold" ? 740 : element.weight === "semibold" ? 620 : 400;
    return `<div class="live-scene__text live-scene__text--${cssToken(element.role, "body")}" style="${frame};font-size:${cssNumber(element.fontSize, 24)}px;color:#${cssHex(element.color)};font-weight:${weight};text-align:${cssAlign(element.align)}">${escapeHtml(element.text)}</div>`;
  }).join("");
  return `<div class="live-scene" data-scene-intent="${escapeHtml(scene.intent)}" style="background:#${cssHex(scene.background)}">${elements}</div>`;
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
      <div class="slide__cover-foot"><span class="slide__index">${idx}</span><span>${selectedMeetingId !== null || !isCapturing() ? "회의 기록" : "내용 정리 중"}</span></div>
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

function renderEmptySlidePlaceholder(copy = publication.currentCopy()) {
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
      <h2 class="placeholder__title">${copy.placeholderTitle}</h2>
      <p class="placeholder__sub">${copy.placeholderBody}</p>
    </div>`;
}

function renderSlide(slide) {
  if (!slide) {
    renderEmptySlidePlaceholder();
    return;
  }

  setOnAir(true);
  currentSlideEl.innerHTML = slideHtml(slide);
}
function renderMain() {
  // Explicit stage state, derived from what is actually about to be rendered.
  caretShell?.setStageState(
    viewingHistory ? "history-preview"
      : currentSlide ? "slide"
        : detecting ? "detecting"
          : isCapturing() ? "waiting"
            : "empty",
  );
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
    <div class="thumbnail${viewingHistory && viewingHistory.index === s.index ? " thumbnail--viewing" : ""}" data-index="${escapeHtml(String(s.index))}" tabindex="0" role="button" aria-current="${viewingHistory && viewingHistory.index === s.index ? "true" : "false"}" aria-label="슬라이드 ${escapeHtml(String(s.index))} 미리보기">
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
  appEl?.classList.add("app--compiled-preview");
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
  appEl?.classList.remove("app--compiled-preview");
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

function fmtMMSS(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function renderPill() {
  const fresh = Date.now() - lastCaptionAt < 2500;
  if (!fresh) {
    let text = currentSlide ? "녹음이 끝났습니다" : "녹음 대기";
    if (detecting) text = "슬라이드를 정리하는 중…";
    else if (isCapturing()) text = `녹음 중 ${fmtMMSS(Date.now() - captureStartedAt)}`;
    captionTextEl.textContent = text;
  }
  islandEl.classList.toggle("island--live", fresh);
  islandEl.classList.toggle("island--recording", isCapturing() && !fresh);
  islandEl.classList.toggle("island--detecting", detecting && !fresh);
  const shown = viewingHistory ?? currentSlide;
  const total = viewingCompiled ? renderedSlides.length : slideHistory.length + (currentSlide ? 1 : 0);
  pillMetaEl.textContent = [
    shown ? `슬라이드 ${shown.index}/${total}` : null,
    `${transcriptLineCount}문장`,
    settings.providerLabel || null,
  ].filter(Boolean).join(" · ");
}

function renderDocHead() {
  if (viewingCompiled) docTitleEl.textContent = compiledPreviewTitle;
  else if (selectedMeetingId !== null) docTitleEl.textContent = activeMeetingTitle || "지난 회의";
  else if (isCapturing()) docTitleEl.textContent = "회의 진행 중";
  else if (currentSlide) docTitleEl.textContent = "최근 회의";
  else docTitleEl.textContent = "새 회의 준비";
  caretShell.projectTitle(docTitleEl.textContent);
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
  onairEl.classList.toggle("onair--idle", !isCapturing());
  if (label) label.textContent = isCapturing() ? "녹음 중" : "녹음 대기";
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
  if (/validate failed:|NO_COLOR|FORCE_COLOR|node --trace-warnings|\(node:\d+\)/i.test(cleaned)) {
    return "파일 생성 도구를 실행하지 못했습니다. 다시 시도해 주세요";
  }
  return cleaned;
}

let statusMotionKey = 0;
function renderStatus(text) {
  const cleaned = friendlyStatus(text);
  statusTextEl.textContent = cleaned.length > 96 ? `${cleaned.slice(0, 93)}...` : cleaned;
  statusTextEl.title = cleaned;
  // Re-key the subtle compositor-only entrance even when two consecutive
  // updates reuse the same copy. CSS disables this under reduced motion.
  statusTextEl.dataset.motionKey = String(statusMotionKey += 1);
  statusTextEl.style.animation = "none";
  void statusTextEl.offsetWidth;
  statusTextEl.style.animation = "";
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

// ── 실시간 전사: 우측 도킹 패널 ──
let transcriptLineCount = 0;
const MAX_TRANSCRIPT_DOM_LINES = 1000;

// 도킹 패널은 pane__body가 스크롤 컨테이너다 — 목록이 아니라 몸체를 밀어야 최신 문장이 보인다.
function scrollTranscriptToLatest() {
  transcriptBodyEl.scrollTop = transcriptBodyEl.scrollHeight;
}

function renderTranscriptLine(entry, incrementCount = true, refresh = true) {
  const distanceFromBottom = transcriptBodyEl.scrollHeight - transcriptBodyEl.scrollTop - transcriptBodyEl.clientHeight;
  const shouldFollowLatest = distanceFromBottom <= 48;
  transcriptEmptyEl.hidden = true;
  const row = document.createElement("div");
  row.className = "feed-line";
  if (Number.isSafeInteger(entry.seq)) row.dataset.seq = String(entry.seq);
  const time = new Date(entry.ts).toLocaleTimeString("ko-KR", { hour12: false });
  const chip = entry.speaker
    ? `<span class="speaker-chip" style="--chip-color: ${SPEAKER_COLORS[(entry.speaker - 1) % SPEAKER_COLORS.length]}">화자 ${entry.speaker}</span>`
    : "";
  row.innerHTML = `
    <span class="feed-line__meta"><span class="feed-line__time">${escapeHtml(time)}</span>${chip}</span>
    <span class="feed-line__text">${escapeHtml(entry.text)}</span>`;
  transcriptStreamEl.appendChild(row);
  while (transcriptStreamEl.childElementCount > MAX_TRANSCRIPT_DOM_LINES) transcriptStreamEl.firstElementChild?.remove();
  if (incrementCount) transcriptLineCount += 1;
  transcriptCountEl.textContent = String(transcriptLineCount);
  transcriptTruncEl.hidden = transcriptLineCount <= MAX_TRANSCRIPT_DOM_LINES;
  if (!meetingStartTs) meetingStartTs = entry.ts;
  if (refresh) {
    renderGlance();
    renderDocHead();
    renderPill();
    if (shouldFollowLatest) scrollTranscriptToLatest();
  }
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
  // 전체 개수는 유지하되, 장시간 회의에서도 브라우저 DOM은 최근 1,000줄로 제한한다.
  transcriptLineCount = entries.length;
  transcriptCountEl.textContent = String(transcriptLineCount);
  meetingStartTs = entries[0]?.ts ?? 0;
  transcriptTruncEl.hidden = entries.length <= MAX_TRANSCRIPT_DOM_LINES;
  for (const e of entries.slice(-MAX_TRANSCRIPT_DOM_LINES)) renderTranscriptLine(e, false, false);
  renderGlance();
  renderDocHead();
  renderPill();
  scrollTranscriptToLatest();
}

// ── 녹음 시작/중지 버튼 ──
const isCapturing = () => caretShell.isCapturing();
const inputMode = () => caretShell.uiState.mode ?? "mic";
/**
 * The meeting the server is currently recording into, learned from the meetings
 * list while capture is live (the server marks exactly that one `open`).
 *
 * It exists so that authoritative idle can restore the meeting that just ended
 * instead of leaving the operator on a live shell whose content belongs to no
 * selected meeting. Cleared as soon as the restoration is issued, which is what
 * makes it happen exactly once per capture.
 */
let liveMeetingId = null;

function renderCaptureState() {
  if (isCapturing()) {
    if (glanceCaptureLabelEl) glanceCaptureLabelEl.textContent = "녹음 중";
    startCaptureTimer();
  } else {
    if (glanceCaptureLabelEl) glanceCaptureLabelEl.textContent = currentSlide ? "녹음 완료" : "녹음 대기";
    stopCaptureTimer();
  }
  // The reset gate's reason is owned by `syncActionAvailability`, which keeps
  // `title` and `aria-label` identical. Writing a second, differently worded
  // label here would leave the tooltip and the accessible name disagreeing.
  publication?.syncAvailability();
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
    caretShell.projectTimer(captureTimerEl.textContent);
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
  btnRecordEl.hidden = inputMode() === "file";
  btnRecordEl.classList.toggle("record-btn--on", isCapturing());
  btnRecordEl.setAttribute("aria-pressed", String(isCapturing()));
  const action = isCapturing() ? "녹음 중지" : "녹음 시작";
  // The ACTION label is the control's purpose. `applyGate` records it as the
  // purpose to restore, and while a gate is closed the reason wins instead, so
  // this must not overwrite a reason that is currently displayed.
  setControlPurpose(btnRecordEl, action, action);
  const label = btnRecordEl.querySelector(".record-btn__label");
  if (label) label.textContent = action;
}

btnRecordEl.onclick = () => {
  sendCaptureToggle();
};

/** 준비된 meeting_id가 있으면 startCapture에 실어 같은 draft 회의를 활성화한다. */
function sendCaptureToggle() {
  if (!transport.isOpen()) {
    renderStatus("앱 서버에 연결하는 중입니다. 잠시 후 다시 눌러 주세요");
    return;
  }
  // The canonical reducer owns "is another start/stop already in flight?".
  // `capturing` alone is a RENDER flag that only flips when the server answers,
  // so two activations inside one task both read `capturing === true` and both
  // sent `stopCapture` - the duplicate command the native surface has always
  // refused (`StopCommandGuard`). The reducer's outbox is the same one-command
  // guard for this surface; the payloads below are unchanged and still built
  // here, because `meeting_id` is the prepared ATTENDEE draft, not the meeting
  // the library happens to have selected.
  const intent = caretShell?.activateCapture();
  if (intent !== undefined && intent.length === 0) {
    // Two distinct refusals, and the operator is told which one applies rather
    // than watching a dead button: a command is already in flight, or the
    // surface has not yet received the server's authoritative capture snapshot.
    const phase = caretShell.uiState.capture;
    if (phase === "starting" || phase === "stopping") {
      renderStatus(phase === "stopping" ? "녹음을 중지하는 중…" : "녹음을 시작하는 중…");
    } else {
      renderStatus("앱 서버 상태를 확인하는 중입니다. 잠시 후 다시 눌러 주세요");
    }
    return;
  }
  const stopping = intent === undefined
    ? isCapturing()
    : intent.some((command) => command.action === "stopCapture");
  renderStatus(stopping ? "녹음을 중지하는 중…" : "녹음을 시작하는 중…");
  if (stopping) {
    transport.send({ action: "stopCapture" });
    requestMeetings();
    return;
  }
  attendees.warnUnsaved();
  // 참석자는 하드 게이트가 아니다 — 지정하지 않아도 캡처는 시작된다.
  transport.send({
    action: "startCapture",
    meeting_id: attendees.meetingId ?? undefined,
  });
  requestMeetings();
}


btnResetEl.onclick = () => {
  if (isCapturing()) {
    renderStatus("녹음을 중지한 뒤 새 회의를 준비해 주세요");
    return;
  }
  if (!window.confirm("현재 회의를 닫고 새 회의를 준비할까요?\n저장된 회의 기록과 내보낸 파일은 그대로 남습니다.")) return;
  selectedMeetingId = null;
  caretShell.resetMeeting();
  renderMeetings(meetings);
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  viewingCompiled = false;
  compiledPreviewTitle = "";
  renderedSlides = [];
  $("btn-review").hidden = true;
  renderTranscriptBacklog([]);
  transcriptTruncEl.hidden = true;
  if (transport.isOpen()) {
    transport.send({ action: "reset" });
    requestMeetings();
    attendees.clearPreparedMeeting();
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
  renderThumbnails(renderedSlides, false);
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
  const target = ev.target instanceof HTMLElement ? ev.target : null;
  if (ev.defaultPrevented || ev.isComposing || target?.isContentEditable) return;
  if (ev.key === "Escape" && attendees.isOpen()) {
    attendees.close(true);
    return;
  }
  if (ev.key === "Escape" && viewingHistory) {
    exitSlidePreview();
    return;
  }
  // 입력 필드/패널 안에서는 단축키 무시
  const tag = target?.tagName.toLowerCase() ?? "";
  if (tag === "input" || tag === "textarea" || tag === "select" || settings.isOpen() || attendees.isOpen()) return;
  if (ev.key === "r" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && inputMode() !== "file") {
    sendCaptureToggle();
  }
});

function handleMessage(msg) {
      // Hydration snapshots do not belong to the fresh workspace. Decide this
      // once before either the raw renderer or canonical projection sees them.
      if (msg.type === "transcript" && msg.reason === "snapshot"
        && (selectedMeetingId !== null || awaitingInitialCaptureState)) return;
      const wasCapturing = isCapturing();
      // Canonical state first: the pure reducers own connection/capture/shell and
      // the transcript projection. Malformed frames are dropped inside the
      // parsers and leave both projections untouched.
      caretShell.ingestServerFrame(msg);
      if (msg.type === "slide") {
        if (selectedMeetingId !== null) return;
        if (awaitingInitialCaptureState) return;
        // A malformed `current` must not destroy the last good slide (DESIGN
        // §9.8: live content is preserved until the server says otherwise). A
        // slide is renderable only as an object with a title; `null` is the
        // server's real "no slide yet" and stays meaningful.
        const nextSlide = msg.current;
        const renderable = nextSlide === null || nextSlide === undefined
          || (typeof nextSlide === "object" && typeof nextSlide.title === "string");
        if (!renderable) return;
        currentSlide = nextSlide ?? null;
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
        // Rapid selection: a payload for a superseded request is dropped, so the
        // one document surface never shows the meeting the user moved away from.
        if (msg.meetingId !== selectedMeetingId) return;
        if (caretShell && !caretShell.isCurrentMeeting(msg.meetingId)) return;
        documentSurfaceEl.removeAttribute("aria-busy");
        documentSurfaceEl.dataset.loading = "false";
        documentSurfaceEl.dataset.contentKey = String(msg.meetingId);
        documentSurfaceEl.style.animation = "none";
        void documentSurfaceEl.offsetWidth;
        documentSurfaceEl.style.animation = "";
        currentSlide = msg.current ?? null;
        slideHistory = Array.isArray(msg.history) ? msg.history : [];
        selectedMeetingReviewId = typeof msg.review?.reviewId === "string"
          ? msg.review.reviewId : null;
        selectedMeetingReviewStatus = msg.review?.status === "confirmed"
          ? "confirmed"
          : msg.review ? "draft" : "none";
        viewingHistory = null;
        viewingCompiled = false;
        appEl?.classList.remove("app--compiled-preview");
        compiledPreviewTitle = "";
        activeMeetingTitle = msg.title || `회의 #${msg.meetingId}`;
        renderMeetingPurpose(msg.purpose);
        renderTranscriptBacklog(msg.transcript);
        const showingSlidePlan = slidePlanWorkspace?.initialize(msg.slidePlan) ?? false;
        if (!showingSlidePlan) {
          renderMain();
          renderThumbnails(slideHistory);
          renderDocHead();
        } else {
          viewingCompiled = false;
          appEl?.classList.remove("app--compiled-preview");
          renderThumbnails([], false);
          renderDocHead();
        }
        const publishedCount = Number.isFinite(msg.compiled?.slideCount)
          ? msg.compiled.slideCount
          : Array.isArray(msg.slidePlan?.plan?.slides) ? msg.slidePlan.plan.slides.length : null;
        if (msg.compiled || msg.slidePlan) {
          compileStatusEl.hidden = false;
          compileStatusEl.dataset.state = "success";
          compileStatusEl.textContent = Number.isFinite(publishedCount)
            ? `만든 슬라이드 ${publishedCount}장`
            : "만든 슬라이드";
        } else {
          compileStatusEl.hidden = true;
          compileStatusEl.textContent = "";
        }
        // Selecting a meeting is what UNGATES the meeting-scoped capabilities.
        // Review must be reachable before a review payload exists; its first
        // activation requests that payload from the real server.
        $("btn-review").hidden = false;
        reviewPanel.restoreMeeting(msg.meetingId, msg.review ?? null);
        publication?.syncCopy();
        publication?.syncAvailability();
        renderStatus(`${activeMeetingTitle} 기록을 불러왔습니다`);
      } else if (msg.type === "transcript") {
        if (msg.reason === "snapshot") {
          renderTranscriptBacklog(msg.entries);
          transcriptTruncEl.hidden = !(msg.truncated || msg.entries.length > MAX_TRANSCRIPT_DOM_LINES);
        } else {
          exportTranscript(msg.entries);
        }
      } else if (msg.type === "line") {
        // The canonical reducer is the only judge of a well-formed line, so the
        // renderer asks it rather than trusting the frame. A malformed line is
        // dropped by both, which keeps the DOM and the projection identical.
        const accepted = caretShell?.acceptsTranscriptFrame(msg) ?? true;
        if (selectedMeetingId === null && accepted) renderTranscriptLine(msg);
      } else if (msg.type === "ask") {
        ask.applyMessage(msg);
      } else if (msg.type === "refine") {
        publication.applyRefine(msg);
      } else if (msg.type === "providers") {
        settings.applyProviders(msg);
      } else if (msg.type === "sttModels") {
        settings.applySttModels(msg);
      } else if (msg.type === "attendees") {
        attendees.applyMessage(msg);
      } else if (msg.type === "review") {
        if (selectedMeetingId !== null && msg.meetingId !== selectedMeetingId) return;
        const reviewId = typeof msg.reviewId === "string" ? msg.reviewId : null;
        const staleConfirmedDowngrade = selectedMeetingId !== null
          && selectedMeetingReviewStatus === "confirmed"
          && reviewId !== null
          && reviewId === selectedMeetingReviewId
          && msg.status !== "confirmed";
        if (staleConfirmedDowngrade || !reviewPanel.applyReview(msg)) return;
        if (selectedMeetingId !== null) {
          selectedMeetingReviewId = reviewId;
          selectedMeetingReviewStatus = msg.status === "confirmed" ? "confirmed" : "draft";
          publication?.syncCopy();
        }
        renderStatus(Array.isArray(msg.items) && msg.items.length === 0
          ? "검토할 결정 사항이나 할 일이 없습니다"
          : "회의록 정리가 완료되었습니다");
      } else if (msg.type === "reviewItemUpdated" || msg.type === "reviewConfirmed") {
        // ACKs carry authoritative meeting identity; stale tabs cannot apply them.
        if (msg.meetingId !== selectedMeetingId) return;
        if (msg.type === "reviewConfirmed") {
          if (typeof msg.reviewId === "string") selectedMeetingReviewId = msg.reviewId;
          selectedMeetingReviewStatus = "confirmed";
          publication?.syncCopy();
        }
      } else if (msg.type === "meetingConcluded") {
        if (msg.meetingId !== selectedMeetingId) return;
        renderStatus("검토와 회의록 묶음 저장이 완료되었습니다");
      } else if (msg.type === "capture") {
        const endedNow = wasCapturing && !isCapturing();
        settings.syncCapture();
        if (endedNow) attendees.clearPreparedMeeting();
        if (isCapturing()) {
          if (Number.isFinite(msg.startedAt) && msg.startedAt > 0) captureStartedAt = msg.startedAt;
          awaitingInitialCaptureState = false;
        } else if (awaitingInitialCaptureState && selectedMeetingId === null) {
          showFreshWorkspace();
        }
        // Authoritative idle after a real capture restores the meeting that just
        // ended - the one this surface watched being recorded - so its slides and
        // transcript belong to a selected meeting instead of being orphaned on a
        // live shell nobody owns.
        //
        // EXACTLY ONCE per capture: `liveMeetingId` is the token, it is cleared
        // before the selection is issued, and only a fresh capture can mint a new
        // one (`renderMeetings` sets it solely while `capturing`). A repeated idle
        // snapshot - a reconnect, or the server re-asserting state - therefore
        // finds no token and cannot re-select, cannot loop, and cannot overwrite
        // whatever the operator has chosen since.
        if (endedNow && liveMeetingId !== null) {
          const restoreId = liveMeetingId;
          liveMeetingId = null;
          // A selection left over from an EARLIER meeting is stale now; the
          // meeting that just ended is the authoritative one to show. The token
          // consumed above is the ONLY once-only guard, so this branch cannot be
          // reached twice for the same capture.
          selectedMeetingId = restoreId;
          caretShell?.selectMeeting(restoreId);
          if (transport.isOpen()) {
            transport.send({ action: "selectMeeting", meetingId: restoreId });
          }
          renderMeetings(meetings);
        }
        settings.applyCaptureSource(msg);
        renderCaptureButton();
        renderCaptureState();
        attendees.syncCapture();
        renderPill();
        renderDocHead();
        setOnAir();
      } else if (msg.type === "detect") {
        detecting = !!msg.detecting;
        if (glanceDetectEl) glanceDetectEl.hidden = !msg.detecting;
        renderPill();
      } else if (msg.type === "compile") {
        publication.applyCompile(msg);
      } else if (msg.type === "export") {
        publication.applyExport(msg);
      } else if (msg.type === "saved") {
        if (awaitingInitialCaptureState && selectedMeetingId === null) return;
        publication.clearRetry();
        renderStatus(`저장됨: ${msg.path}`);
        requestMeetings();
        if (lastSavedEl) {
          const label = savedArtifactLabel(msg.path);
          lastSavedEl.hidden = false;
          lastSavedEl.textContent = `${label} 저장 완료`;
          lastSavedEl.title = `${label} 파일을 저장했습니다`;
        }
      } else if (msg.type === "status") {
        if (msg.mutationAction && msg.meetingId !== selectedMeetingId) return;
        renderStatus(msg.text);
        reviewPanel.applyStatus(msg.text);
        if (msg.mutationAction && selectedMeetingId !== null && transport.isOpen()) {
          // Roll back any optimistic edit from the durable meeting snapshot.
          transport.send({ action: "selectMeeting", meetingId: selectedMeetingId });
        }
      }

}

function handleTransport(status) {
  caretShell.ingestTransport(status);
  if (status === "connecting") {
    awaitingInitialCaptureState = true;
    document.documentElement.dataset.connection = "connecting";
    publication?.syncAvailability();
  } else if (status === "open") {
    document.documentElement.dataset.connection = "connected";
    publication?.syncAvailability();
    renderStatus("앱 서버에 연결되었습니다");
    if (contextServerStatusEl) {
      contextServerStatusEl.textContent = "연결됨";
      contextServerStatusEl.dataset.tone = "positive";
    }
    requestMeetings();
    transport.send({ action: "attendees" });
    if (selectedMeetingId !== null) {
      transport.send({ action: "selectMeeting", meetingId: selectedMeetingId });
    }
    reviewPanel.syncTransport();
    ask.reconnect();
  } else if (status === "closed") {
    publication.disconnect();
    document.documentElement.dataset.connection = "disconnected";
    publication?.syncAvailability();
    renderStatus("앱 서버 연결이 끊겼습니다. 다시 연결하는 중…");
    if (contextServerStatusEl) {
      contextServerStatusEl.textContent = "재연결 중";
      contextServerStatusEl.dataset.tone = "warning";
    }
    reviewPanel?.syncTransport();
  } else if (status === "error") {
    document.documentElement.dataset.connection = "error";
    publication?.syncAvailability();
    renderStatus("앱 서버에 연결하지 못했습니다");
    if (contextServerStatusEl) {
      contextServerStatusEl.textContent = "연결 오류";
      contextServerStatusEl.dataset.tone = "warning";
    }
  }
}

let notes = notesInputEl.value;
const liveNote = document.getElementById("live-note");
notesInputEl.addEventListener("input", () => {
  notes = notesInputEl.value;
  if (liveNote) liveNote.value = notes;
});
liveNote?.addEventListener("input", () => {
  notes = liveNote.value;
  notesInputEl.value = notes;
});
return Object.freeze({
  bindControllers(controllers) {
    ({ settings, attendees, ask, publication, reviewPanel } = controllers);
    renderCaptureButton(); attendees.syncCapture();
  },
  handleMessage, handleTransport, renderStatus, friendlyStatus,
  renderDocHead, renderPill, renderEmptySlidePlaceholder, showCompiledScene,
  syncAvailability: () => publication?.syncAvailability(),
  get selectedMeetingId() { return selectedMeetingId; },
  get selectedMeetingReviewStatus() { return selectedMeetingReviewStatus; },
  get capturing() { return isCapturing(); },
  get currentSlide() { return currentSlide; },
  get viewingHistory() { return viewingHistory; },
  get transcriptLineCount() { return transcriptLineCount; },
  get notes() { return notes; },
  dispose: stopCaptureTimer,
});
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
