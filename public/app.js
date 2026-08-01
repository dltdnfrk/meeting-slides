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
const btnAttendeesEl = $("btn-attendees");
const attendeePanelEl = $("attendee-panel");
const attendeeFormEl = $("attendee-form");
const attendeeNameEl = $("attendee-name");
const attendeeCrmEl = $("attendee-crm");
const attendeeListEl = $("attendee-list");
const attendeeErrorEl = $("attendee-error");
const attendeeCountEl = $("attendee-count");
const btnAttendeeAddEl = $("btn-attendee-add");
const btnAttendeeSaveEl = $("btn-attendee-save");
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

function slideHtml(slide) {
  const bullets = (slide.bullets ?? [])
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join("");
  return `
    <div class="slide__inner">
      <header class="slide__header">
        <span class="slide__index">${escapeHtml(String(slide.index).padStart(2, "0"))}</span>
        <h2 class="slide__title">${escapeHtml(slide.title)}</h2>
      </header>
      <div class="slide__accent"></div>
      <ul class="slide__bullets">${bullets}</ul>
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
window.__attendeeState = attendeeState;

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
  attendeeNameEl.disabled = capturing;
  attendeeCrmEl.disabled = capturing;
  btnAttendeeAddEl.disabled = capturing;
  btnAttendeeSaveEl.disabled = capturing;
  if (capturing) closeAttendeePanel();
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
  if (capturing) return;
  const row = ev.target.closest(".attendee-row");
  if (!row) return;
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
    setAttendeeError("연결되지 않음 — 참석자 저장 불가");
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
  if (attendeePanelEl.hidden) return;
  // 패널 안 버튼(수정/삭제)은 핸들러가 리스트를 다시 그려 버리므로, 이벤트가
  // document까지 올라올 때 ev.target은 이미 DOM에서 떨어져 closest()가 패널을
  // 찾지 못한다. 그런 분리된 타겟을 "바깥 클릭"으로 오인하지 않도록 제외한다.
  if (ev.target instanceof Node && !ev.target.isConnected) return;
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
  attendeeDirty = false;
  setAttendeeError("");
  renderAttendeeList();
  renderStatus(`참석자 ${attendees.length}명 저장됨`);
}

/** 준비된 meeting_id가 있으면 startCapture에 실어 같은 draft 회의를 활성화한다. */
function sendCaptureToggle() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (capturing) {
    ws.send(JSON.stringify({ action: "stopCapture" }));
    return;
  }
  if (attendeeDirty) {
    setAttendeeError("저장하지 않은 참석자가 있습니다 — 저장 후 시작하세요");
  }
  // 참석자는 하드 게이트가 아니다 — 지정하지 않아도 캡처는 시작된다.
  ws.send(JSON.stringify(attendeeState.meetingId === null
    ? { action: "startCapture" }
    : { action: "startCapture", meeting_id: attendeeState.meetingId }));
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
    // 서버가 준비된 회의를 종료하고 currentMeetingId를 비우므로, 보관 중인
    // meeting_id는 즉시 죽은 ID가 된다. 그대로 두면 다음 startCapture가 거부당한다.
    clearPreparedMeeting();
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
  if (ev.key === "Escape" && !attendeePanelEl.hidden) {
    closeAttendeePanel(true);
    return;
  }
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
  if (tag === "input" || tag === "textarea" || !providerPanelEl.hidden || !attendeePanelEl.hidden) return;
  if (ev.key === "h" || ev.key === "1") setDockTab("history");
  else if (ev.key === "f" || ev.key === "2") setDockTab("feed");
  else if (ev.key === "r" && inputMode !== "file") sendCaptureToggle();
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

  ws.onopen = () => {
    renderStatus("서버 연결됨");
    reviewPanel?.syncTransport();
    // 재연결: 서버가 보관 중인 draft 참석자/meeting_id를 다시 요청한다.
    // 서버가 이 액션을 아직 모르면 무시되고(미등록 액션은 핸들러 없음),
    // 클라이언트는 마지막으로 받은 명단을 그대로 유지한다.
    ws.send(JSON.stringify({ action: "attendees" }));
  };
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
      } else if (msg.type === "attendees") {
        applyAttendeesMessage(msg);
      } else if (msg.type === "review") {
        reviewPanel.applyReview(msg);
      } else if (msg.type === "capture") {
        const wasCapturing = capturing;
        capturing = !!msg.capturing;
        inputMode = msg.mode ?? "mic";
        // 녹음 시작 시 전사 탭으로 전환해 진행 과정이 바로 보이도록.
        // 단, 슬라이드 미리보기 중에는 사용자의 시선을 끊지 않는다.
        if (capturing && !wasCapturing && !viewingHistory) setDockTab("feed");
        renderCaptureButton();
        renderCaptureState();
        renderAttendeeLock();
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
        reviewPanel.applyStatus(msg.text);
      }
    } catch (e) {
      console.error("parse error", e);
    }
  };
  ws.onclose = () => {
    renderStatus("연결 끊김. 3초 후 재시도...");
    reviewPanel?.syncTransport();
    setTimeout(connect, 3000);
  };
  ws.onerror = () => renderStatus("연결 오류");
}

connect();
