import { escapeHtml } from "./meeting-workspace.js";
export function createSettingsPanel({ transport, workspace }) {
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};

const btnSettingsEl = /** @type {HTMLButtonElement} */ ($("btn-settings"));
const providerPanelEl = $("provider-panel");
const providerListEl = $("provider-list");
const providerDetailEl = $("provider-detail");
const providerDetailContentEl = $("provider-detail-content");
const providerBackEl = /** @type {HTMLButtonElement} */ ($("provider-back"));
const btnRecheckEl = $("btn-recheck");
const btnSettingsCloseEl = $("btn-settings-close");
const btnRecheckSttEl = $("btn-recheck-stt");
const sttListEl = $("stt-list");
const captureSourceListEl = $("capture-source-list");
const glanceProviderEl = $("glance-provider");
const contextAiStatusEl = $("context-ai-status");
const contextSttStatusEl = $("context-stt-status");
const providerConfigEl = $("provider-config");
const selectModelEl = /** @type {HTMLSelectElement} */ ($("select-model"));
const selectEffortEl = /** @type {HTMLSelectElement} */ ($("select-effort"));
const effortRowEl = $("effort-row");
let providerLabelCur = "";
let audioSource = "mic";
// ── 슬라이드 생성 모델 설정 ──
let currentProvider = "";
let providerMessage = null;
let providerDetailId = "";
let providerKeyPendingId = "";

const PROVIDER_COPY = {
  "cli:codex": { name: "ChatGPT", detail: "구독 계정", mark: "O" },
  "cli:grok": { name: "Grok", detail: "xAI 계정", mark: "X" },
  "cli:claude": { name: "Claude", detail: "Claude Pro 또는 Max 계정", mark: "C" },
  "cli:gemini": { name: "Gemini", detail: "Google 계정", mark: "G" },
  openai: { name: "OpenAI API", detail: "직접 결제 API 키", mark: "O" },
  local: { name: "로컬 모델", detail: "이 Mac에서 실행", mark: "L" },
};

function providerCopy(provider) {
  return PROVIDER_COPY[provider?.id] ?? {
    name: provider?.label ?? "AI 모델",
    detail: provider?.detail ?? "",
    mark: String(provider?.label ?? "AI").slice(0, 1).toUpperCase(),
  };
}

function displayModelName(model) {
  const value = String(model ?? "");
  const gpt = value.match(/^gpt-(\d+(?:\.\d+)?)-(sol|luna|terra)$/i);
  if (gpt) return `GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1).toLowerCase()}`;
  return value;
}

const EFFORT_COPY = { low: "낮음", medium: "보통", high: "높음" };

function renderProviders(msg) {
  providerMessage = msg;
  currentProvider = msg.current ?? "";
  const curRow = (Array.isArray(msg.list) ? msg.list : []).find((p) => p.id === currentProvider);
  const currentCopy = providerCopy(curRow);
  providerLabelCur = msg.currentModel ? displayModelName(msg.currentModel) : (curRow ? currentCopy.name : currentProvider);
  if (contextAiStatusEl) {
    contextAiStatusEl.textContent = curRow?.available
      ? (providerLabelCur || currentCopy.name)
      : "연결 필요";
    contextAiStatusEl.dataset.tone = curRow?.available ? "positive" : "warning";
  }
  glanceProviderEl.textContent = providerLabelCur || "—";
  workspace.renderDocHead();
  workspace.renderPill();
  const pending = (Array.isArray(msg.list) ? msg.list : []).find((p) => p.id === providerKeyPendingId);
  if (pending?.available) {
    providerKeyPendingId = "";
    providerDetailId = "";
  }
  renderProviderViews();
}

function providerMark(copy) {
  return `<span class="provider-mark" aria-hidden="true">${escapeHtml(copy.mark)}</span>`;
}

function renderProviderViews() {
  if (!providerMessage) return;
  const list = Array.isArray(providerMessage.list) ? providerMessage.list : [];
  const detail = list.find((provider) => provider.id === providerDetailId);
  providerListEl.dataset.view = detail ? "detail" : "gallery";
  providerListEl.hidden = Boolean(detail);
  providerDetailEl.hidden = !detail;
  providerDetailEl.dataset.provider = detail?.id ?? "";

  providerListEl.innerHTML = list.map((provider) => {
    const status = providerStatus(provider);
    const copy = providerCopy(provider);
    return `
      <article class="provider-row${provider.id === currentProvider ? " provider-row--current" : ""}" data-id="${escapeHtml(provider.id)}" data-auth="${escapeHtml(status.auth)}" data-installed="${status.installed ? "true" : "false"}">
        <button type="button" class="provider-row__open" aria-label="${escapeHtml(copy.name)} 설정 열기">
          ${providerMark(copy)}
          <span class="provider-row__copy">
            <span class="provider-row__name">${escapeHtml(copy.name)}</span>
            <span class="provider-row__badge provider-row__badge--${status.tone}">${escapeHtml(provider.id === currentProvider ? "현재 사용" : status.badge)}</span>
          </span>
          <span class="provider-row__chevron" aria-hidden="true">›</span>
        </button>
      </article>`;
  }).join("");

  if (!detail) {
    providerDetailContentEl.innerHTML = "";
    providerConfigEl.hidden = true;
    return;
  }

  const status = providerStatus(detail);
  const copy = providerCopy(detail);
  const isCli = detail.id.startsWith("cli:");
  const isKeyBased = detail.id === "openai";
  const isCurrent = detail.id === currentProvider;
  const pending = providerKeyPendingId === detail.id;
  const providerActions = `
    <div class="provider-detail__actions">
      ${isCli ? `<button type="button" class="provider-row__connect provider-detail__button provider-detail__button--quiet" data-id="${escapeHtml(detail.id)}">${escapeHtml(status.connectLabel)}</button>` : ""}
      ${status.selectable && !isCurrent ? `<button type="button" class="provider-row__select provider-detail__button" data-id="${escapeHtml(detail.id)}">이 모델 사용</button>` : ""}
      ${isCurrent ? `<span class="provider-detail__current">현재 사용 중</span>` : ""}
    </div>`;
  providerDetailContentEl.innerHTML = `
    <header class="provider-detail__brand">
      ${providerMark(copy)}
      <span class="provider-detail__brand-copy">
        <span class="provider-detail__title" id="provider-detail-title">${escapeHtml(copy.name)}</span>
        <span class="provider-row__badge provider-row__badge--${status.tone}">${escapeHtml(isCurrent ? "현재 사용" : status.badge)}</span>
      </span>
    </header>
    <p class="provider-detail__blurb">${escapeHtml(copy.detail)}</p>
    ${isKeyBased ? `
      <div class="provider-key-form">
        <label class="provider-key-form__label" for="provider-key">API key</label>
        <div class="provider-key-form__control">
          <input id="provider-key" class="provider-key-form__input" type="password" placeholder="${detail.available ? "새 키를 입력해 교체" : "sk-…"}" autocomplete="off" spellcheck="false">
          <button id="provider-key-reveal" class="provider-key-form__reveal" type="button" aria-pressed="false">표시</button>
        </div>
        <p class="provider-key-form__help">키는 이 Mac의 프로젝트 설정에만 저장되며 화면에 다시 표시되지 않습니다.</p>
        <div class="provider-key-form__actions">
          <button type="button" class="provider-row__connect provider-detail__button provider-detail__button--quiet" data-id="${escapeHtml(detail.id)}">OpenAI에서 키 만들기</button>
          <button id="provider-key-save" class="provider-detail__button" type="button" data-id="${escapeHtml(detail.id)}" disabled>${pending ? "확인 중…" : "저장 및 연결"}</button>
        </div>
        <div id="provider-key-feedback" class="provider-key-form__feedback" aria-live="polite">${pending ? "연결 상태를 확인하고 있습니다" : ""}</div>
      </div>` : providerActions}
  `;
  renderProviderConfig(providerMessage);
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
  providerConfigEl.hidden = !entry || entry.id !== providerDetailId;
  selectModelEl.disabled = models.length === 0;
  selectModelEl.innerHTML = `<option value="">기본 모델</option>` + models.map((m) =>
    `<option value="${escapeHtml(m)}"${m === msg.currentModel ? " selected" : ""}>${escapeHtml(displayModelName(m))}</option>`,
  ).join("");

  const efforts = entry?.efforts ?? [];
  effortRowEl.hidden = efforts.length === 0;
  selectEffortEl.innerHTML = `<option value="">기본 설정</option>` + efforts.map((e) =>
    `<option value="${escapeHtml(e)}"${e === msg.currentEffort ? " selected" : ""}>${escapeHtml(EFFORT_COPY[e] ?? e)}</option>`,
  ).join("");
}

// ── 음성 인식(whisper.cpp) 모델 관리 ──
// 서버가 디스크 기준의 진실을 보내주므로 클라이언트는 상태를 추측하지 않고 그대로 반영한다.
let sttSelectedModelId = null;
let latestSttModelsMessage = null;

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
    case "installed": {
      const disabled = workspace.capturing ? ` disabled title="녹음을 중지한 뒤 모델을 변경할 수 있습니다"` : "";
      const actionLabel = workspace.capturing ? `${label} 선택 불가: 녹음 중` : `${label} 사용`;
      return `<button type="button" class="stt-btn stt-row__select" data-id="${id}" aria-label="${actionLabel}"${disabled}>사용</button>`;
    }
    case "selected":
      return `<button type="button" class="stt-btn stt-row__select" data-id="${id}" aria-label="${label} 사용 중" disabled>사용 중</button>`;
    case "failed":
      return `<button type="button" class="stt-btn stt-row__install" data-id="${id}" aria-label="${label} 다시 내려받기">다시 시도</button>`;
    default:
      return `<button type="button" class="stt-btn stt-row__install" data-id="${id}" aria-label="${label} 내려받기">내려받기</button>`;
  }
}

function renderSttModels(msg) {
  latestSttModelsMessage = msg;
  const models = Array.isArray(msg.models) ? msg.models : [];
  sttSelectedModelId = msg.selectedModelId ?? null;
  if (contextSttStatusEl) {
    const selected = models.find((model) => model.id === sttSelectedModelId && model.status === "selected");
    contextSttStatusEl.textContent = selected?.label ?? "모델 필요";
    contextSttStatusEl.dataset.tone = selected ? "positive" : "warning";
  }
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
  if (transport.isOpen()) {
    transport.send({ action, modelId });
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

captureSourceListEl.addEventListener("change", (ev) => {
  const input = ev.target;
  if (!(input instanceof HTMLInputElement) || input.name !== "capture-source") return;
  if (workspace.capturing) {
    workspace.renderStatus("녹음을 중지한 뒤 오디오 소스를 변경해 주세요");
    for (const option of captureSourceListEl.querySelectorAll('input[name="capture-source"]')) {
      if (option instanceof HTMLInputElement) option.checked = option.value === audioSource;
    }
    return;
  }
  if (transport.isOpen()) {
    transport.send({ action: "setCaptureSource", source: input.value });
  }
});

btnRecheckSttEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "recheckSttModels" });
    workspace.renderStatus("음성 인식 모델의 설치 상태를 확인하는 중…");
  }
};

function sendProviderSelection() {
  if (transport.isOpen()) {
    transport.send({
      action: "setProvider",
      id: currentProvider,
      model: selectModelEl.value,
      effort: effortRowEl.hidden ? "" : selectEffortEl.value,
    });
  }
}
selectModelEl.onchange = sendProviderSelection;
selectEffortEl.onchange = sendProviderSelection;

btnSettingsEl.setAttribute("aria-controls", providerPanelEl.id);
btnSettingsEl.setAttribute("aria-expanded", "false");

/**
 * DESIGN 9.12: opening a sheet moves focus into it. Without this the settings
 * sheet appeared while focus stayed on the trigger behind it, so a keyboard user
 * had to tab through the whole shell to reach the panel they had just opened.
 */
function focusFirstControl(panel) {
  const target = panel.querySelector(
    "button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  );
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

function setProviderPanelOpen(open, restoreFocus = false) {
  btnSettingsEl.setAttribute("aria-expanded", String(open));
  if (open) {
    if (window.openDialog) window.openDialog(providerPanelEl); else providerPanelEl.hidden = false;
    focusFirstControl(providerPanelEl);
    // DESIGN 9.12: Tab/Shift+Tab stay inside the open sheet (focus-trap.js).
    window.trapFocus?.(providerPanelEl);
  } else {
    providerDetailId = "";
    providerKeyPendingId = "";
    renderProviderViews();
    if (window.closeDialog) window.closeDialog(providerPanelEl, () => {
      if (restoreFocus) btnSettingsEl.focus({ preventScroll: true });
    }); else {
      providerPanelEl.hidden = true;
      window.releaseFocus?.(providerPanelEl);
      if (restoreFocus) btnSettingsEl.focus({ preventScroll: true });
    }
  }
}

btnSettingsEl.onclick = (ev) => {
  ev.stopPropagation();
  setProviderPanelOpen(providerPanelEl.hidden || providerPanelEl.dataset.motionState === "closing");
};
btnSettingsCloseEl.onclick = () => setProviderPanelOpen(false, true);

providerListEl.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const openBtn = ev.target.closest(".provider-row__open");
  const row = openBtn?.closest(".provider-row");
  if (openBtn instanceof HTMLElement && row instanceof HTMLElement) {
    providerDetailId = row.dataset.id ?? "";
    renderProviderViews();
    focusFirstControl(providerDetailEl);
  }
});

providerBackEl.onclick = () => {
  providerDetailId = "";
  providerKeyPendingId = "";
  renderProviderViews();
  const firstCard = providerListEl.querySelector(".provider-row__open");
  if (firstCard instanceof HTMLElement) firstCard.focus({ preventScroll: true });
};

providerDetailEl.addEventListener("input", (ev) => {
  if (!(ev.target instanceof HTMLInputElement) || ev.target.id !== "provider-key") return;
  const save = providerDetailEl.querySelector("#provider-key-save");
  if (save instanceof HTMLButtonElement) save.disabled = ev.target.value.trim().length === 0;
});

providerDetailEl.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const revealBtn = ev.target.closest("#provider-key-reveal");
  if (revealBtn instanceof HTMLButtonElement) {
    const input = providerDetailEl.querySelector("#provider-key");
    if (input instanceof HTMLInputElement) {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      revealBtn.textContent = reveal ? "숨김" : "표시";
      revealBtn.setAttribute("aria-pressed", String(reveal));
      input.focus({ preventScroll: true });
    }
    return;
  }
  const connectBtn = ev.target.closest(".provider-row__connect");
  if (connectBtn instanceof HTMLElement && transport.isOpen()) {
    transport.send({ action: "connectProvider", id: connectBtn.dataset.id });
    return;
  }
  const saveBtn = ev.target.closest("#provider-key-save");
  if (saveBtn instanceof HTMLButtonElement && transport.isOpen()) {
    const input = providerDetailEl.querySelector("#provider-key");
    if (input instanceof HTMLInputElement && input.value.trim()) {
      transport.send({ action: "setProviderKey", id: saveBtn.dataset.id, key: input.value.trim() });
      providerKeyPendingId = saveBtn.dataset.id ?? "";
      input.value = "";
      saveBtn.disabled = true;
      saveBtn.textContent = "확인 중…";
      const feedback = providerDetailEl.querySelector("#provider-key-feedback");
      if (feedback) feedback.textContent = "연결 상태를 확인하고 있습니다";
    }
    return;
  }
  const selectBtn = ev.target.closest(".provider-row__select");
  if (selectBtn instanceof HTMLButtonElement && !selectBtn.disabled && transport.isOpen()) {
    transport.send({ action: "setProvider", id: selectBtn.dataset.id });
  }
});

btnRecheckEl.onclick = () => {
  if (transport.isOpen()) {
    transport.send({ action: "recheckProviders" });
    workspace.renderStatus("AI 모델 연결 상태를 확인하는 중…");
  }
};

document.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const path = ev.composedPath();
  if (!providerPanelEl.hidden && !path.includes(providerPanelEl) && !path.includes(btnSettingsEl)) {
    setProviderPanelOpen(false, true);
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || providerPanelEl.hidden) return;
  // 키보드 사용자가 패널 닫은 뒤 포커스를 잃지 않게 트리거로 되돌린다.
  setProviderPanelOpen(false, true);
});


function applyCaptureSource(msg) {
  if (msg.audioSource !== "mic" && msg.audioSource !== "system") return;
  audioSource = msg.audioSource;
  for (const option of captureSourceListEl.querySelectorAll('input[name="capture-source"]')) {
    if (option instanceof HTMLInputElement) option.checked = option.value === audioSource;
  }
}
return Object.freeze({
  applyProviders: renderProviders, applySttModels: renderSttModels, applyCaptureSource,
  syncCapture: () => { if (latestSttModelsMessage) renderSttModels(latestSttModelsMessage); },
  isOpen: () => !providerPanelEl.hidden,
  get providerLabel() { return providerLabelCur; },
});
}
