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
const btnCompileDeckEl = $("btn-compile-deck");
const compileStatusEl = $("compile-status");
const btnExportDeckEl = $("btn-export-deck");
const btnExportPdfEl = $("btn-export-pdf");
const btnExportPngEl = $("btn-export-png");
const btnSettingsEl = $("btn-settings");
const providerPanelEl = $("provider-panel");
const providerListEl = $("provider-list");
const btnRecheckEl = $("btn-recheck");
const btnRecheckSttEl = $("btn-recheck-stt");
const sttListEl = $("stt-list");
const btnRecordEl = $("btn-record");
// 전사는 우측 도킹 패널(.transcript-pane)이 1차 거처다 — 하단 도크 복제본은 없았다.
const transcriptStreamEl = $("transcript-stream");
const transcriptCountEl = $("transcript-count");
const transcriptEmptyEl = $("transcript-empty");
const transcriptBodyEl = $("transcript-body");
const btnResetEl = $("btn-reset");
const sessionListEl = $("session-list");
const sessionEmptyEl = $("session-empty");
const sessionCountEl = $("session-count");

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
const selectModelEl = $("select-model");
const selectEffortEl = $("select-effort");
const effortRowEl = $("effort-row");

const transcriptTruncEl = $("transcript-trunc");

let currentSlide = null;
let slideHistory = [];
let ws = null;
let meetings = [];
let selectedMeetingId = null;
// 히스토리 썸네일로 미리보기 중인 과거 슬라이드 (null이면 라이브 표시)
let viewingHistory = null;

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
  }
  sessionCountEl.textContent = String(meetings.length);
  sessionEmptyEl.hidden = meetings.length > 0;
  sessionListEl.innerHTML = meetings.map((item) => {
    const selected = item.id === selectedMeetingId;
    const started = new Date(item.started_at).toLocaleString("ko-KR", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return `<li>
      <button type="button" class="session-row${selected ? " session-row--selected" : ""}" data-meeting-id="${escapeHtml(item.id)}" aria-pressed="${selected}">
        <span class="session-row__title">${escapeHtml(item.title)}</span>
        <span class="session-row__meta">
          <span>${escapeHtml(started)}</span>
          <span class="session-row__status session-row__status--${item.status === "open" ? "open" : "ended"}">${item.status === "open" ? "진행 중" : "종료"}</span>
        </span>
      </button>
    </li>`;
  }).join("");
}

sessionListEl.addEventListener("click", (ev) => {
  const row = ev.target.closest(".session-row");
  if (!row) return;
  selectedMeetingId = Number(row.dataset.meetingId);
  renderMeetings(meetings);
  const meeting = meetings.find((item) => item.id === selectedMeetingId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "selectMeeting", meetingId: selectedMeetingId }));
    renderStatus(`세션 불러오는 중… ${meeting?.title ?? `#${selectedMeetingId}`}`);
  }
});

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

function slideHtml(slide) {
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
    cover: "COVER",
    section: "SECTION",
    topic: "TOPIC",
    decision: "DECISION",
    actions: "ACTIONS",
    summary: "SUMMARY",
  }[kind] ?? "TOPIC";

  // cover: 히어로 타이틀 중심
  if (kind === "cover") {
    return `
    <div class="slide__inner slide__inner--live slide__inner--cover" data-live-kind="cover">
      <div class="slide__kindchip">${kindLabel}</div>
      <p class="slide__cover-eyebrow">${kickerHtml || `<span class="slide__kicker">LIVE DECK</span>`}</p>
      <h2 class="slide__title slide__title--hero">${title}</h2>
      ${bulletsHtml}
      <div class="slide__cover-foot"><span class="slide__index">${idx}</span><span>실시간 구성 중</span></div>
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
        <div class="slide__topic-orb"></div>
        <div class="slide__topic-grid"></div>
        <p class="slide__topic-caption">LIVE · DESIGNING</p>
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
        <h2 class="placeholder__title">발언을 시작하면<br>슬라이드가 만들어집니다</h2>
        <p class="placeholder__sub">whisper.cpp가 음성을 전사하고, AI가 주제 블록을 감지해 한 장씩 정리합니다</p>
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
    currentSlideEl.innerHTML = `
      <button type="button" class="slide__notice">
        SLIDE ${escapeHtml(String(viewingHistory.index).padStart(2, "0"))} 미리보기 · 클릭하면 라이브로 복귀 (Esc)
      </button>
      ${slideHtml(viewingHistory)}`;
  }
  renderGlance();
}

// 글랜서블 스트립: 현재 슬라이드 인덱스 + 히스토리 수 + 전사 줄 수.
function renderGlance() {
  const cur = viewingHistory ?? currentSlide;
  const total = slideHistory.length + (currentSlide ? 1 : 0);
  const idx = cur ? String(cur.index).padStart(2, "0") : "00";
  glanceSlideEl.textContent = `${idx}/${String(total).padStart(2, "0")}`;
  glanceLinesEl.textContent = String(transcriptLineCount);
}

function allSlides() {
  const slides = [...slideHistory];
  if (currentSlide && !slides.some((slide) => slide.index === currentSlide.index)) slides.push(currentSlide);
  return slides;
}

function renderThumbnails(history) {
  const slides = [...history];
  if (currentSlide && !slides.some((slide) => slide.index === currentSlide.index)) slides.push(currentSlide);
  historyCountEl.textContent = String(slides.length);

  if (slides.length === 0) {
    thumbnailsEl.innerHTML = `
      <div class="filmstrip__empty">
        <span class="filmstrip__empty-ring"></span>
        <span>슬라이드가 없습니다</span>
      </div>`;
    return;
  }
  thumbnailsEl.innerHTML = slides.map((s) => `
    <div class="thumbnail${viewingHistory && viewingHistory.index === s.index ? " thumbnail--viewing" : ""}" data-index="${escapeHtml(String(s.index))}" tabindex="0" role="button" aria-label="슬라이드 ${escapeHtml(String(s.index))} 미리보기">
      <div class="thumbnail__index">SLIDE ${escapeHtml(String(s.index).padStart(2, "0"))}</div>
      <div class="thumbnail__title">${escapeHtml(s.title)}</div>
      <ul class="thumbnail__bullets">
        ${(s.bullets ?? []).slice(0, 3).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
      </ul>
    </div>`).join("");
}

const SPEAKER_COLORS = ["#10b981", "#60a5fa", "#f59e0b", "#f472b6"];

function renderCaption(text, speaker) {
  const live = !!text;
  if (live) lastCaptionAt = Date.now();
  captionTextEl.textContent = text || "대기 중…";
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
    let text = "대기 중…";
    if (detecting) text = "✦ AI 슬라이드 만드는 중…";
    else if (capturing) text = `● 녹음 중 ${fmtMMSS(Date.now() - captureStartedAt)}`;
    captionTextEl.textContent = text;
  }
  islandEl.classList.toggle("island--live", fresh);
  islandEl.classList.toggle("island--recording", capturing && !fresh);
  islandEl.classList.toggle("island--detecting", detecting && !fresh);
  const total = slideHistory.length + (currentSlide ? 1 : 0);
  pillMetaEl.textContent = [
    currentSlide ? `SLIDE ${currentSlide.index}/${String(total).padStart(2, "0")}` : null,
    `LINES ${transcriptLineCount}`,
    providerLabelCur || null,
  ].filter(Boolean).join(" · ");
}

function renderDocHead() {
  // 문서 제목은 회의 정체성 — 슬라이드 제목과 중복되지 않게 회의 단위로
  docTitleEl.textContent = currentSlide ? "오늘의 회의" : (capturing ? "회의 진행 중" : "회의 준비 중");
  const total = slideHistory.length + (currentSlide ? 1 : 0);
  const parts = [];
  if (meetingStartTs) {
    parts.push(new Date(meetingStartTs).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit" }));
  }
  parts.push(`${transcriptLineCount}문장`);
  if (total > 0) parts.push(`${total}슬라이드`);
  if (providerLabelCur) parts.push(providerLabelCur);
  docMetaEl.textContent = parts.join(" · ");
}

function setOnAir(active) {
  onairEl.classList.toggle("onair--idle", !active);
}

function renderStatus(text) {
  // 긴 whisper/metal 로그가 status bar를 잠식하지 않게 자른다.
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  statusTextEl.textContent = cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
  statusTextEl.title = cleaned;
  statusIndicatorEl.classList.remove(
    "status__indicator--ok",
    "status__indicator--warn",
    "status__indicator--error",
  );
  if (/오류|실패|error|fail/i.test(text)) {
    statusIndicatorEl.classList.add("status__indicator--error");
  } else if (/연결됨|ok|정상/i.test(text)) {
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

// ── 전사본(원문)보내기 ──
function exportTranscript(entries) {
  if (!entries || entries.length === 0) {
    renderStatus("저장할 전사 문장 없음");
    return;
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
  const lines = ["# Meeting Transcript", "", `Exported: ${new Date().toISOString()}`, ""];
  for (const e of entries) {
    const who = e.speaker ? `화자 ${e.speaker}` : "전사";
    lines.push(`**[${fmtTime(e.ts)}] ${who}** — ${e.text}`);
  }
  lines.push("");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadText(`meeting-transcript-${stamp}.md`, "text/markdown;charset=utf-8", lines.join("\n"));
  renderStatus(`전사본 저장 완료 (${entries.length}문장)`);
}

// ── 프로바이더 선택 패널 ──
let currentProvider = "";

function renderProviders(msg) {
  currentProvider = msg.current ?? "";
  // 글랜서블: 현재 선택된 프로바이더 라벨 노출
  const curRow = (Array.isArray(msg.list) ? msg.list : []).find((p) => p.id === currentProvider);
  providerLabelCur = curRow
    ? curRow.label + (msg.currentModel ? `/${msg.currentModel}` : "") + (msg.currentEffort ? `·${msg.currentEffort}` : "")
    : currentProvider;
  glanceProviderEl.textContent = curRow ? curRow.label : (currentProvider || "—");
  renderProviderConfig(msg);
  renderDocHead();
  renderPill();
  const list = Array.isArray(msg.list) ? msg.list : [];
  providerListEl.innerHTML = list.map((p) => {
    const isCli = p.id.startsWith("cli:");
    const keyBased = p.id === "openai" || p.id === "alibaba";
    const status = providerStatus(p);
    const showActions = isCli || !status.selectable;
    return `
    <div class="provider-row${p.id === currentProvider ? " provider-row--current" : ""}${status.selectable ? "" : " provider-row--disabled"}" data-id="${escapeHtml(p.id)}" data-auth="${escapeHtml(status.auth)}" data-installed="${status.installed ? "true" : "false"}">
      <button type="button" class="provider-row__select" ${status.selectable ? "" : "disabled"} aria-pressed="${p.id === currentProvider ? "true" : "false"}">
        <span class="provider-row__name">${escapeHtml(p.label)}</span>
        <span class="provider-row__detail">${escapeHtml(p.detail)}</span>
        <span class="provider-row__badge provider-row__badge--${status.tone}">${escapeHtml(status.badge)}</span>
      </button>
      ${showActions ? `
        <div class="provider-row__actions">
          ${isCli ? `<button type="button" class="provider-row__connect" data-id="${escapeHtml(p.id)}">${escapeHtml(status.connectLabel)}</button>` : ""}
          ${keyBased && !status.selectable ? `
            <button type="button" class="provider-row__connect" data-id="${escapeHtml(p.id)}">연결</button>
            <input class="provider-row__key" type="password" placeholder="API 키 붙여넣기" autocomplete="off">
            <button type="button" class="provider-row__save" data-id="${escapeHtml(p.id)}">저장</button>` : ""}
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
      badge: p.available ? "설정됨" : "미설정",
      connectLabel: "연결",
    };
  }
  if (!installed || auth === "unavailable") {
    return { auth, installed, selectable: false, tone: "absent", badge: "미설치", connectLabel: "연결" };
  }
  if (auth === "connected") {
    return { auth, installed, selectable: true, tone: "ok", badge: "연결됨", connectLabel: "재인증" };
  }
  if (auth === "disconnected") {
    return { auth, installed, selectable: true, tone: "absent", badge: "로그인 필요", connectLabel: "연결" };
  }
  // unknown: 설치는 확인되지만 인증은 토킹할 수 없는 상태
  return { auth, installed, selectable: true, tone: "unknown", badge: "인증 미확인", connectLabel: "연결" };
}

// ── 현재 프로바이더의 모델/effort 선택 ──
function renderProviderConfig(msg) {
  const entry = (Array.isArray(msg.list) ? msg.list : []).find((p) => p.id === msg.current);
  const models = entry?.models ?? [];
  selectModelEl.disabled = models.length === 0;
  selectModelEl.innerHTML = `<option value="">기본값</option>` + models.map((m) =>
    `<option value="${escapeHtml(m)}"${m === msg.currentModel ? " selected" : ""}>${escapeHtml(m)}</option>`,
  ).join("");

  const efforts = entry?.efforts ?? [];
  effortRowEl.hidden = efforts.length === 0;
  selectEffortEl.innerHTML = `<option value="">기본값</option>` + efforts.map((e) =>
    `<option value="${e}"${e === msg.currentEffort ? " selected" : ""}>${e}</option>`,
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
  switch (model.status) {
    case "downloading":
      return `<button type="button" class="stt-btn stt-btn--quiet stt-row__cancel" data-id="${id}">취소</button>`;
    case "installed":
      return `<button type="button" class="stt-btn stt-row__select" data-id="${id}">선택</button>`;
    case "selected":
      return `<button type="button" class="stt-btn stt-row__select" data-id="${id}" disabled>선택됨</button>`;
    case "failed":
      return `<button type="button" class="stt-btn stt-row__install" data-id="${id}">다시 시도</button>`;
    default:
      return `<button type="button" class="stt-btn stt-row__install" data-id="${id}">내려받기</button>`;
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
  const install = ev.target.closest(".stt-row__install");
  if (install) return sendSttAction("installSttModel", install.dataset.id);
  const cancel = ev.target.closest(".stt-row__cancel");
  if (cancel) return sendSttAction("cancelSttModel", cancel.dataset.id);
  const select = ev.target.closest(".stt-row__select");
  if (select && !select.disabled) return sendSttAction("selectSttModel", select.dataset.id);
});

btnRecheckSttEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "recheckSttModels" }));
    renderStatus("음성 인식 모델 재검사 중…");
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

providerListEl.addEventListener("click", (ev) => {
  const connectBtn = ev.target.closest(".provider-row__connect");
  if (connectBtn && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "connectProvider", id: connectBtn.dataset.id }));
    return;
  }
  const saveBtn = ev.target.closest(".provider-row__save");
  if (saveBtn && ws && ws.readyState === WebSocket.OPEN) {
    const row = saveBtn.closest(".provider-row");
    const input = row ? row.querySelector(".provider-row__key") : null;
    if (input && input.value.trim()) {
      ws.send(JSON.stringify({ action: "setProviderKey", id: saveBtn.dataset.id, key: input.value.trim() }));
      input.value = "";
    }
    return;
  }
  const selectBtn = ev.target.closest(".provider-row__select");
  if (selectBtn && !selectBtn.disabled && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "setProvider", id: selectBtn.closest(".provider-row").dataset.id }));
  }
});

btnRecheckEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "recheckProviders" }));
    renderStatus("프로바이더 재검사 중…");
  }
};

document.addEventListener("click", (ev) => {
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
    if (glanceCaptureLabelEl) glanceCaptureLabelEl.textContent = currentSlide ? "진행 중" : "대기";
    stopCaptureTimer();
  }
}

// ── 녹음 경과 타이머 (클라이언트 기준: capture 시작 시각 추정) ──
let captureStartedAt = 0;
let captureTimerId = null;
function startCaptureTimer() {
  if (captureTimerId !== null) return;
  captureStartedAt = Date.now();
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
  if (glanceRecEl) glanceRecEl.hidden = true;
}

function renderCaptureButton() {
  btnRecordEl.hidden = inputMode === "file";
  btnRecordEl.classList.toggle("record-btn--on", capturing);
  btnRecordEl.setAttribute("aria-pressed", String(capturing));
  btnRecordEl.setAttribute("aria-label", capturing ? "녹음 중지" : "녹음 시작");
  const label = btnRecordEl.querySelector(".record-btn__label");
  if (label) label.textContent = capturing ? "중지" : "녹음 시작";
}

btnRecordEl.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    renderStatus("서버 연결 중… 잠시 후 다시 눌러주세요");
    return;
  }
  // 즉시 피드백 — 서버 capture 이벤트가 오기 전에도 클릭 반응을 보여준다.
  renderStatus(capturing ? "녹음 중지 요청…" : "녹음 시작 요청…");
  ws.send(JSON.stringify({ action: capturing ? "stopCapture" : "startCapture" }));
  requestMeetings();
};

renderCaptureButton();

// ── 버튼 핸들러 (connect 외부에서 1회 바인딩) ──
function meetingTarget() {
  return selectedMeetingId === null ? {} : { meetingId: selectedMeetingId };
}

btnExportMdEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveNotes", ...meetingTarget() }));
    renderStatus("Markdown 저장 중…");
  } else {
    renderStatus("연결되지 않음 — 저장 불가");
  }
};
btnExportJsonEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveJson", ...meetingTarget() }));
    renderStatus("JSON 저장 중…");
  } else {
    renderStatus("연결되지 않음 — 저장 불가");
  }
};
btnExportTranscriptEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveTranscript", ...meetingTarget() }));
    renderStatus("전사본 저장 중…");
  } else {
    renderStatus("연결되지 않음 — 저장 불가");
  }
};

btnCompileDeckEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "compileDeck", ...meetingTarget() }));
    setJobControlsBusy(true);
    compileStatusEl.hidden = false;
    compileStatusEl.dataset.state = "started";
    compileStatusEl.textContent = "컴파일 중…";
    renderStatus("발표 덱 컴파일 시작…");
  } else {
    renderStatus("연결되지 않음 — 컴파일 불가");
  }
};

const conflictingJobControls = [btnCompileDeckEl, btnExportPdfEl, btnExportPngEl];
let activeJobId = null;
function setJobControlsBusy(busy) {
  for (const control of conflictingJobControls) control.disabled = busy;
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
  const count = Number.isFinite(msg.completed) && Number.isFinite(msg.total) ? ` ${msg.completed}/${msg.total}` : "";
  return `${label} · ${msg.stage || "처리"}${count}`;
}
function renderCompileStatus(msg) {
  compileStatusEl.hidden = false;
  compileStatusEl.dataset.state = msg.status;
  if (msg.status === "started" || msg.status === "progress") {
    activeJobId = msg.jobId ?? activeJobId;
    setJobControlsBusy(true);
    compileStatusEl.textContent = msg.status === "progress" ? progressText("컴파일", msg) : "컴파일 중…";
    renderStatus(compileStatusEl.textContent);
  } else if (msg.status === "success") {
    if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
    setJobControlsBusy(false);
    activeJobId = null;
    document.querySelector(".job-retry")?.remove();
    const count = msg.outline?.slideCount;
    compileStatusEl.textContent = `컴파일 완료${Number.isFinite(count) ? ` · ${count}장` : ""}`;
    renderStatus(`컴파일 완료${msg.path ? `: ${msg.path}` : ""}`);
  } else {
    if (activeJobId && msg.jobId && msg.jobId !== activeJobId) return;
    setJobControlsBusy(false);
    activeJobId = null;
    compileStatusEl.textContent = `${msg.status === "timeout" ? "컴파일 시간 초과" : "컴파일 실패"}: ${msg.error || "알 수 없는 오류"}`;
    renderStatus(compileStatusEl.textContent);
    showRetry("compileDeck", msg.meetingId);
  }
}

function renderExportStatus(msg) {
  const label = msg.action === "exportPdf" ? "PDF" : "PNG";
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
    renderStatus(`${label} 저장됨${msg.path ? `: ${msg.path}` : ""}`);
  } else {
    const busy = msg.code === "job-busy" || msg.code === "compile-busy";
    renderStatus(busy
      ? "컴파일 중에는 내보낼 수 없습니다"
      : `${label} ${msg.status === "timeout" ? "시간 초과" : "실패"}: ${msg.error || "알 수 없는 오류"}`);
    if (!busy) showRetry(msg.action, msg.meetingId);
  }
}

btnExportDeckEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // lecture-deck 템플릿으로 reveal.js 강의 덱 생성 → exports/deck-*/
    ws.send(JSON.stringify({ action: "exportDeck", ...meetingTarget() }));
    renderStatus("강의 덱 생성 중…");
  } else {
    renderStatus("연결되지 않음 — 덱 저장 불가");
  }
};

btnExportPdfEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportPdf", ...meetingTarget() }));
    setJobControlsBusy(true);
    renderStatus("PDF 준비 중…");
  } else {
    renderStatus("연결되지 않음 — PDF 저장 불가");
  }
};

btnExportPngEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportPng", ...meetingTarget() }));
    setJobControlsBusy(true);
    renderStatus("PNG 준비 중…");
  } else {
    renderStatus("연결되지 않음 — PNG 저장 불가");
  }
};
btnResetEl.onclick = () => {
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  renderTranscriptBacklog([]);
  transcriptTruncEl.hidden = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "reset" }));
    requestMeetings();
    renderStatus("세션 초기화 요청됨");
  } else {
    renderStatus("연결되지 않음 — 초기화 불가");
  }
  renderMain();
  renderGlance();
};

// ── 히스토리 썸네일 클릭/키보드 → 과거 슬라이드 미리보기 ──
// 같은 썸네일 재클릭 / 안내 바 클릭 / Esc 로 라이브 복귀.
/** @param {HTMLElement} card */
function toggleThumbnailPreview(card) {
  const idx = Number(card.dataset.index);
  const slide = allSlides().find((s) => s.index === idx);
  if (!slide) return;
  viewingHistory = viewingHistory && viewingHistory.index === slide.index ? null : slide;
  renderMain();
}
thumbnailsEl.addEventListener("click", (ev) => {
  const card = ev.target.closest(".thumbnail");
  if (card) toggleThumbnailPreview(card);
});
thumbnailsEl.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const card = (ev.target instanceof HTMLElement ? ev.target.closest(".thumbnail") : null);
  if (!card) return;
  ev.preventDefault();
  toggleThumbnailPreview(card);
});

currentSlideEl.addEventListener("click", (ev) => {
  if (ev.target.closest(".slide__notice")) {
    viewingHistory = null;
    renderMain();
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && viewingHistory) {
    viewingHistory = null;
    renderMain();
    return;
  }
  // 입력 필드/패널 안에서는 단축키 무시
  const tag = (ev.target instanceof HTMLElement ? ev.target.tagName : "").toLowerCase();
  if (tag === "input" || tag === "textarea" || !providerPanelEl.hidden) return;
  if (ev.key === "r" && inputMode !== "file") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: capturing ? "stopCapture" : "startCapture" }));
    }
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
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    renderStatus("서버 연결됨");
    requestMeetings();
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "slide") {
        if (selectedMeetingId !== null) return;
        currentSlide = msg.current;
        slideHistory = Array.isArray(msg.history) ? msg.history : [];
        // 미리보기 중인 슬라이드가 히스토리에서 사라졌으면(예: reset) 라이브로 복귀
        if (viewingHistory && !slideHistory.some((s) => s.index === viewingHistory.index)) {
          viewingHistory = null;
        }
        renderMain();
        renderThumbnails(slideHistory);
        renderDocHead();
        renderPill();
        setOnAir(capturing || !!currentSlide);
      } else if (msg.type === "caption") {
        renderCaption(msg.text, msg.speaker);
      } else if (msg.type === "meetings") {
        renderMeetings(msg.items);
      } else if (msg.type === "meeting") {
        if (msg.meetingId !== selectedMeetingId) return;
        currentSlide = msg.current ?? null;
        slideHistory = Array.isArray(msg.history) ? msg.history : [];
        viewingHistory = null;
        renderTranscriptBacklog(msg.transcript);
        renderMain();
        renderThumbnails(slideHistory);
        docTitleEl.textContent = msg.title || `회의 #${msg.meetingId}`;
        if (msg.compiled) {
          compileStatusEl.hidden = false;
          compileStatusEl.dataset.state = "success";
          compileStatusEl.textContent = `컴파일됨 · ${msg.compiled.slideCount}장`;
        } else {
          compileStatusEl.hidden = true;
          compileStatusEl.textContent = "";
        }
        renderStatus(`세션 불러옴: ${msg.title || `#${msg.meetingId}`}`);
      } else if (msg.type === "transcript") {
        if (selectedMeetingId !== null && msg.reason === "snapshot") return;
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
      } else if (msg.type === "capture") {
        capturing = !!msg.capturing;
        inputMode = msg.mode ?? "mic";
        renderCaptureButton();
        renderCaptureState();
        renderPill();
        renderDocHead();
        // ON AIR 표시도 캡처 상태와 연동
        setOnAir(capturing || !!currentSlide);
      } else if (msg.type === "detect") {
        detecting = !!msg.detecting;
        if (glanceDetectEl) glanceDetectEl.hidden = !msg.detecting;
        renderPill();
      } else if (msg.type === "compile") {
        renderCompileStatus(msg);
      } else if (msg.type === "export") {
        renderExportStatus(msg);
      } else if (msg.type === "saved") {
        renderStatus(`저장됨: ${msg.path}`);
        requestMeetings();
        // 상시 표시 (관찰성: 마지막 저장물 경로를 도크에 고정)
        if (lastSavedEl) {
          lastSavedEl.hidden = false;
          lastSavedEl.textContent = `저장: ${msg.path}`;
          lastSavedEl.title = msg.path;
        }
      } else if (msg.type === "status") {
        renderStatus(msg.text);
      }
    } catch (e) {
      console.error("parse error", e);
    }
  };
  ws.onclose = () => {
    activeJobId = null;
    setJobControlsBusy(false);
    renderStatus("연결 끊김. 3초 후 재시도...");
    setTimeout(connect, 3000);
  };
  ws.onerror = () => renderStatus("연결 오류");
}

connect();
