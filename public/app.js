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
const btnSettingsEl = $("btn-settings");
const providerPanelEl = $("provider-panel");
const providerListEl = $("provider-list");
const btnRecheckEl = $("btn-recheck");
const btnRecordEl = $("btn-record");
const btnResetEl = $("btn-reset");

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

// 메인 스테이지 렌더: 히스토리 미리보기 중이면 그 슬라이드 + 복귀 안내를,
// 아니면 라이브 슬라이드를 보여준다.
function renderMain() {
  if (!viewingHistory) {
    renderSlide(currentSlide);
    return;
  }
  setOnAir(true);
  currentSlideEl.innerHTML = `
    <button type="button" class="slide__notice">
      SLIDE ${escapeHtml(String(viewingHistory.index).padStart(2, "0"))} 미리보기 · 클릭하면 라이브로 복귀 (Esc)
    </button>
    ${slideHtml(viewingHistory)}`;
}

function renderThumbnails(history) {
  historyCountEl.textContent = String(history.length);

  if (history.length === 0) {
    thumbnailsEl.innerHTML = `
      <div class="filmstrip__empty">
        <span class="filmstrip__empty-ring"></span>
        아직 슬라이드가<br>없습니다
      </div>`;
    return;
  }
  thumbnailsEl.innerHTML = history.map((s) => `
    <div class="thumbnail${viewingHistory && viewingHistory.index === s.index ? " thumbnail--viewing" : ""}" data-index="${escapeHtml(String(s.index))}">
      <div class="thumbnail__index">SLIDE ${escapeHtml(String(s.index).padStart(2, "0"))}</div>
      <div class="thumbnail__title">${escapeHtml(s.title)}</div>
      <ul class="thumbnail__bullets">
        ${(s.bullets ?? []).slice(0, 3).map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
      </ul>
    </div>`).join("");
}

const SPEAKER_COLORS = ["#10b981", "#60a5fa", "#f59e0b", "#f472b6"];

function renderCaption(text, speaker) {
  captionTextEl.textContent = text;
  islandEl.classList.toggle("island--live", !!text);
  if (speaker) {
    speakerChipEl.hidden = false;
    speakerChipEl.textContent = `화자 ${speaker}`;
    speakerChipEl.style.setProperty("--chip-color", SPEAKER_COLORS[(speaker - 1) % SPEAKER_COLORS.length]);
  } else {
    speakerChipEl.hidden = true;
  }
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

// ── Export ──
function getSlidesForExport() {
  return [...slideHistory, ...(currentSlide ? [currentSlide] : [])];
}

function exportMarkdown(slides) {
  const exportedAt = new Date().toISOString();
  const lines = ["# Meeting Slides", "", `Exported: ${exportedAt}`, ""];
  for (const slide of slides) {
    lines.push(`## ${String(slide.index).padStart(2, "0")}. ${slide.title}`, "");
    for (const bullet of slide.bullets ?? []) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function exportJson(slides) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), slides }, null, 2);
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

function exportSlides(format) {
  const slides = getSlidesForExport();
  if (slides.length === 0) {
    renderStatus("저장할 슬라이드 없음");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (format === "markdown") {
    downloadText(`meeting-slides-${stamp}.md`, "text/markdown;charset=utf-8", exportMarkdown(slides));
    renderStatus(`Markdown 저장 완료 (${slides.length}장)`);
  } else {
    downloadText(`meeting-slides-${stamp}.json`, "application/json;charset=utf-8", exportJson(slides));
    renderStatus(`JSON 저장 완료 (${slides.length}장)`);
  }
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

// ── 녹음 시작/중지 버튼 ──
let capturing = false;
let inputMode = "mic";

function renderCaptureButton() {
  btnRecordEl.hidden = inputMode === "file";
  btnRecordEl.classList.toggle("record-btn--on", capturing);
  const label = btnRecordEl.querySelector(".record-btn__label");
  if (label) label.textContent = capturing ? "중지" : "녹음 시작";
}

btnRecordEl.onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: capturing ? "stopCapture" : "startCapture" }));
};

renderCaptureButton();

// ── 버튼 핸들러 (connect 외부에서 1회 바인딩) ──
btnExportMdEl.onclick = () => exportSlides("markdown");
btnExportJsonEl.onclick = () => exportSlides("json");
btnExportTranscriptEl.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "transcript" }));
    renderStatus("전사본 요청 중…");
  } else {
    renderStatus("연결되지 않음 — 전사본 불가");
  }
};
btnResetEl.onclick = () => {
  currentSlide = null;
  slideHistory = [];
  viewingHistory = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "reset" }));
    renderStatus("세션 초기화 요청됨");
  } else {
    renderStatus("연결되지 않음 — 초기화 불가");
  }
};

// ── 히스토리 썸네일 클릭 → 과거 슬라이드 미리보기 ──
// 같은 썸네일 재클릭 / 안내 바 클릭 / Esc 로 라이브 복귀.
thumbnailsEl.addEventListener("click", (ev) => {
  const card = ev.target.closest(".thumbnail");
  if (!card) return;
  const idx = Number(card.dataset.index);
  const slide = slideHistory.find((s) => s.index === idx);
  if (!slide) return;
  viewingHistory = viewingHistory && viewingHistory.index === slide.index ? null : slide;
  renderMain();
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
  }
});

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
      } else if (msg.type === "caption") {
        renderCaption(msg.text, msg.speaker);
      } else if (msg.type === "transcript") {
        exportTranscript(msg.entries);
      } else if (msg.type === "providers") {
        renderProviders(msg);
      } else if (msg.type === "capture") {
        capturing = !!msg.capturing;
        inputMode = msg.mode ?? "mic";
        renderCaptureButton();
        // ON AIR 표시도 캡처 상태와 연동
        setOnAir(capturing || !!currentSlide);
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
