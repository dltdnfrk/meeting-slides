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
const btnExportDeckEl = $("btn-export-deck");
const btnExportPdfEl = $("btn-export-pdf");
const btnExportPngEl = $("btn-export-png");
const btnSettingsEl = $("btn-settings");
const providerPanelEl = $("provider-panel");
const providerListEl = $("provider-list");
const btnRecheckEl = $("btn-recheck");
const btnRecordEl = $("btn-record");
const feedListEl = $("feed-list");
const feedCountEl = $("feed-count");
const btnResetEl = $("btn-reset");

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

// 하단 도크 탭
const tabHistoryEl = $("tab-history");
const tabFeedEl = $("tab-feed");
const dockHistoryEl = $("dock-history");
const dockFeedEl = $("dock-feed");
const feedTruncEl = $("feed-trunc");

let currentSlide = null;
let slideHistory = [];
let ws = null;
// 히스토리 썸네일로 미리보기 중인 과거 슬라이드 (null이면 라이브 표시)
let viewingHistory = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 라이브 MeetingCard: title(필수) + kicker/emphasis(선택) + bullets.
// 라이브 무대는 항상 이 단일 레이아웃 하나만 쓴다 (kind별 분기는 컴파일 덱 전용).
// kicker/emphasis가 없는 레거시 슬라이드도 제목/불릿만으로 정상 렌더된다.
function slideHtml(slide) {
  const kicker = typeof slide.kicker === "string" ? slide.kicker.trim() : "";
  const emphasis = typeof slide.emphasis === "string" ? slide.emphasis.trim() : "";
  const bullets = (slide.bullets ?? [])
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join("");
  const kickerHtml = kicker
    ? `<span class="slide__kicker">${escapeHtml(kicker)}</span>`
    : "";
  const bulletsHtml = bullets
    ? `<ul class="slide__bullets">${bullets}</ul>`
    : "";
  const emphasisHtml = emphasis
    ? `<p class="slide__emphasis"><span class="slide__emphasis-label">핵심</span>${escapeHtml(emphasis)}</p>`
    : "";
  return `
    <div class="slide__inner">
      <header class="slide__header">
        <div class="slide__meta">
          <span class="slide__index">${escapeHtml(String(slide.index).padStart(2, "0"))}</span>
          ${kickerHtml}
        </div>
        <h2 class="slide__title">${escapeHtml(slide.title)}</h2>
      </header>
      <div class="slide__accent"></div>
      ${bulletsHtml}
      ${emphasisHtml}
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
  glanceLinesEl.textContent = String(feedCount);
}

function renderThumbnails(history) {
  historyCountEl.textContent = String(history.length);

  if (history.length === 0) {
    thumbnailsEl.innerHTML = `
      <div class="filmstrip__empty">
        <span class="filmstrip__empty-ring"></span>
        <span>슬라이드가 없습니다</span>
      </div>`;
    return;
  }
  thumbnailsEl.innerHTML = history.map((s) => `
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
    `LINES ${feedCount}`,
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
  parts.push(`${feedCount}문장`);
  if (total > 0) parts.push(`${total}슬라이드`);
  if (providerLabelCur) parts.push(providerLabelCur);
  docMetaEl.textContent = parts.join(" · ");
}

function setOnAir(active) {
  onairEl.classList.toggle("onair--idle", !active);
}

function renderStatus(text) {
  statusTextEl.textContent = text;
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
    const showActions = isCli || !p.available;
    return `
    <div class="provider-row${p.id === currentProvider ? " provider-row--current" : ""}${p.available ? "" : " provider-row--disabled"}" data-id="${escapeHtml(p.id)}">
      <button type="button" class="provider-row__select" ${p.available ? "" : "disabled"}>
        <span class="provider-row__name">${escapeHtml(p.label)}</span>
        <span class="provider-row__detail">${escapeHtml(p.detail)}</span>
        ${p.id === currentProvider
          ? '<span class="provider-row__badge">● 사용 중</span>'
          : (p.available ? "" : '<span class="provider-row__badge provider-row__badge--off">미설정</span>')}
      </button>
      ${showActions ? `
        <div class="provider-row__actions">
          ${isCli ? `<button type="button" class="provider-row__connect" data-id="${escapeHtml(p.id)}">${p.available ? "재인증" : "연결"}</button>` : ""}
          ${keyBased && !p.available ? `
            <button type="button" class="provider-row__connect" data-id="${escapeHtml(p.id)}">연결</button>
            <input class="provider-row__key" type="password" placeholder="API 키 붙여넣기" autocomplete="off">
            <button type="button" class="provider-row__save" data-id="${escapeHtml(p.id)}">저장</button>` : ""}
        </div>` : ""}
    </div>`;
  }).join("");
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

btnSettingsEl.onclick = (ev) => {
  ev.stopPropagation();
  providerPanelEl.hidden = !providerPanelEl.hidden;
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
    providerPanelEl.hidden = true;
  }
});

// ── 실시간 전사 피드 ──
let feedCount = 0;

function renderFeedLine(entry) {
  const empty = feedListEl.querySelector(".feed__empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "feed-line";
  const time = new Date(entry.ts).toLocaleTimeString("ko-KR", { hour12: false });
  const chip = entry.speaker
    ? `<span class="speaker-chip" style="--chip-color: ${SPEAKER_COLORS[(entry.speaker - 1) % SPEAKER_COLORS.length]}">화자 ${entry.speaker}</span>`
    : "";
  row.innerHTML = `
    <span class="feed-line__meta"><span class="feed-line__time">${escapeHtml(time)}</span>${chip}</span>
    <span class="feed-line__text">${escapeHtml(entry.text)}</span>`;
  feedListEl.appendChild(row);
  feedCount += 1;
  feedCountEl.textContent = String(feedCount);
  if (!meetingStartTs) meetingStartTs = entry.ts;
  renderGlance();
  renderDocHead();
  renderPill();
  feedListEl.scrollTop = feedListEl.scrollHeight;
}
function renderFeedBacklog(entries) {
  feedListEl.innerHTML = "";
  feedCount = 0;
  feedCountEl.textContent = "0";
  feedListEl.scrollTop = 0;
  if (!entries || entries.length === 0) {
    feedListEl.innerHTML = `<div class="feed__empty">녹음을 시작하면<br>전사가 여기에 흐릅니다</div>`;
    return;
  }
  // 각 line은 renderFeedLine이 feedCount를 증가시키고 renderGlance를 갱신한다.
  // backlog 시작점에서 카운트/스크롤을 리셋하고, 한 번만 끝단에서 정리.
  for (const e of entries) renderFeedLine(e);
  renderGlance();
  feedListEl.scrollTop = feedListEl.scrollHeight;
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: capturing ? "stopCapture" : "startCapture" }));
};

renderCaptureButton();

// ── 버튼 핸들러 (connect 외부에서 1회 바인딩) ──
btnExportMdEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveNotes" }));
    renderStatus("Markdown 저장 중…");
  } else {
    renderStatus("연결되지 않음 — 저장 불가");
  }
};
btnExportJsonEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "saveJson" }));
    renderStatus("JSON 저장 중…");
  } else {
    renderStatus("연결되지 않음 — 저장 불가");
  }
};
btnExportTranscriptEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // anarlog 방식: 서버 디스크(exports/)에 저장 — 브라우저 다운로드 차단과 무관
    ws.send(JSON.stringify({ action: "saveNotes" }));
    renderStatus("전사본 저장 중…");
  } else {
    renderStatus("연결되지 않음 — 저장 불가");
  }
};

btnExportDeckEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // lecture-deck 템플릿으로 reveal.js 강의 덱 생성 → exports/deck-*/
    ws.send(JSON.stringify({ action: "exportDeck" }));
    renderStatus("강의 덱 생성 중…");
  } else {
    renderStatus("연결되지 않음 — 덱 저장 불가");
  }
};

btnExportPdfEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportPdf" }));
    renderStatus("초안 PDF 준비 중… (design-gate 미적용)");
  } else {
    renderStatus("연결되지 않음 — PDF 저장 불가");
  }
};

btnExportPngEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "exportPng" }));
    renderStatus("초안 PNG 준비 중… (design-gate 미적용)");
  } else {
    renderStatus("연결되지 않음 — PNG 저장 불가");
  }
};
btnResetEl.onclick = () => {
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  feedCount = 0;
  feedCountEl.textContent = "0";
  feedTruncEl.hidden = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "reset" }));
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
  const slide = slideHistory.find((s) => s.index === idx);
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
  if (ev.key === "Escape" && !providerPanelEl.hidden) {
    providerPanelEl.hidden = true;
    return;
  }
  if (ev.key === "Escape" && viewingHistory) {
    viewingHistory = null;
    renderMain();
    return;
  }
  // 입력 필드/패널 안에서는 단축키 무시
  const tag = (ev.target instanceof HTMLElement ? ev.target.tagName : "").toLowerCase();
  if (tag === "input" || tag === "textarea" || !providerPanelEl.hidden) return;
  if (ev.key === "h" || ev.key === "1") setDockTab("history");
  else if (ev.key === "f" || ev.key === "2") setDockTab("feed");
  else if (ev.key === "r" && inputMode !== "file") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: capturing ? "stopCapture" : "startCapture" }));
    }
  }
});

// ── 하단 도크 탭 전환 ──
function setDockTab(which) {
  const toFeed = which === "feed";
  tabHistoryEl.classList.toggle("dock__tab--active", !toFeed);
  tabHistoryEl.setAttribute("aria-selected", String(!toFeed));
  tabFeedEl.classList.toggle("dock__tab--active", toFeed);
  tabFeedEl.setAttribute("aria-selected", String(toFeed));
  dockHistoryEl.hidden = toFeed;
  dockFeedEl.hidden = !toFeed;
}
tabHistoryEl.addEventListener("click", () => setDockTab("history"));
tabFeedEl.addEventListener("click", () => setDockTab("feed"));

// ── WebSocket ──
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => renderStatus("서버 연결됨");
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "slide") {
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
      } else if (msg.type === "transcript") {
        if (msg.reason === "snapshot") {
          renderFeedBacklog(msg.entries);
          feedTruncEl.hidden = !msg.truncated;
        } else {
          exportTranscript(msg.entries);
        }
      } else if (msg.type === "line") {
        renderFeedLine(msg);
      } else if (msg.type === "providers") {
        renderProviders(msg);
      } else if (msg.type === "capture") {
        const wasCapturing = capturing;
        capturing = !!msg.capturing;
        inputMode = msg.mode ?? "mic";
        // 녹음 시작 시 전사 탭으로 전환해 진행 과정이 바로 보이도록.
        // 단, 슬라이드 미리보기 중에는 사용자의 시선을 끊지 않는다.
        if (capturing && !wasCapturing && !viewingHistory) setDockTab("feed");
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
      } else if (msg.type === "saved") {
        renderStatus(`저장됨: ${msg.path}`);
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
    renderStatus("연결 끊김. 3초 후 재시도...");
    setTimeout(connect, 3000);
  };
  ws.onerror = () => renderStatus("연결 오류");
}

connect();
