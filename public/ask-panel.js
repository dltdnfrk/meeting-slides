import { applyGate } from "./publication-controller.js";
export function createAskPanel({ transport, workspace }) {
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};

const btnAskEl = /** @type {HTMLButtonElement} */ ($("btn-ask"));
const askPanelEl = $("ask-panel");
const askInputEl = /** @type {HTMLInputElement} */ ($("ask-input"));
const askSendEl = /** @type {HTMLButtonElement} */ ($("btn-ask-send"));
const askCloseEl = $("btn-ask-close");
const askConversationEl = $("ask-conversation");
const askEmptyEl = $("ask-empty");
// ── Ask 회의 질문 패널 (RAG) ──
let askPending = false;
let askPendingRequest = null;

function openAskPanel() {
  if (workspace.selectedMeetingId === null) {
    workspace.renderStatus("왼쪽 히스토리에서 회의를 먼저 선택하세요");
    return;
  }
  if (window.openDialog) window.openDialog(askPanelEl); else askPanelEl.hidden = false;
  askPanelEl.setAttribute("aria-expanded", "true");
  askInputEl.focus();
  window.trapFocus?.(askPanelEl);
  syncAskAvailability();
}

/**
 * DESIGN 9.12: a dialog returns focus to the control that opened it, so a
 * keyboard user is never left with focus on a node that just disappeared.
 */
function closeAskPanel(restoreFocus = false) {
  askPanelEl.setAttribute("aria-expanded", "false");
  if (window.closeDialog) window.closeDialog(askPanelEl, () => {
    if (restoreFocus && !btnAskEl.disabled) btnAskEl.focus({ preventScroll: true });
  }); else {
    askPanelEl.hidden = true;
    window.releaseFocus?.(askPanelEl);
    if (restoreFocus && !btnAskEl.disabled) btnAskEl.focus({ preventScroll: true });
  }
}

function syncAskAvailability() {
  const hasMeeting = workspace.selectedMeetingId !== null && !askPending;
  askSendEl.disabled = !hasMeeting || !askInputEl.value.trim();
  // The gate reason reaches BOTH the tooltip and the accessible name (9.11).
  applyGate(btnAskEl, workspace.selectedMeetingId === null
    ? "왼쪽 히스토리에서 회의를 먼저 선택하세요"
    : null);
}

function appendAskMessage(role, text) {
  const row = document.createElement("div");
  row.className = `ask-message ask-message--${role}`;
  row.textContent = text;
  askConversationEl.appendChild(row);
  askConversationEl.scrollTop = askConversationEl.scrollHeight;
  askEmptyEl.hidden = true;
}

function sendAsk() {
  const question = askInputEl.value.trim();
  if (!question || workspace.selectedMeetingId === null || askPending) return;
  askPending = true;
  askPendingRequest = {
    requestId: globalThis.crypto?.randomUUID?.() ?? `ask-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    meetingId: workspace.selectedMeetingId,
    question,
  };
  syncAskAvailability();
  appendAskMessage("user", question);
  askInputEl.value = "";
  if (transport.isOpen()) {
    transport.send({
      action: "ask", meetingId: askPendingRequest.meetingId,
      question: askPendingRequest.question, requestId: askPendingRequest.requestId,
    });
  } else {
    appendAskMessage("assistant", "서버 연결이 끊어졌습니다. 다시 연결되면 질문을 이어서 처리합니다");
    syncAskAvailability();
  }
}

function applyAskMessage(msg) {
  if (askPendingRequest && msg.requestId !== askPendingRequest.requestId) return;
  askPending = false;
  askPendingRequest = null;
  syncAskAvailability();
  if (msg.error) {
    appendAskMessage("assistant", msg.error);
    return;
  }
  const sourceNote = msg.matchedCount > 0
    ? `\n\n(전사 ${msg.matchedCount}개 구간에서 답변)`
    : "";
  appendAskMessage("assistant", `${msg.answer}${sourceNote}`);
}

btnAskEl.onclick = () => {
  if (askPanelEl.hidden || askPanelEl.dataset.motionState === "closing") openAskPanel();
  else closeAskPanel();
};
askCloseEl.onclick = () => closeAskPanel(true);
askSendEl.onclick = sendAsk;
askInputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") sendAsk();
});
askInputEl.addEventListener("input", syncAskAvailability);

// Escape priority (DESIGN 9.12): the Ask dialog closes before any shell-level
// handler runs, and returns focus to the control that opened it.
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || askPanelEl.hidden) return;
  ev.stopPropagation();
  closeAskPanel(true);
});


return Object.freeze({
  applyMessage: applyAskMessage, syncAvailability: syncAskAvailability,
  reconnect() {
    if (askPendingRequest && askPendingRequest.meetingId === workspace.selectedMeetingId) {
      transport.send({ action: "ask", meetingId: askPendingRequest.meetingId,
        question: askPendingRequest.question, requestId: askPendingRequest.requestId });
    }
  },
});
}
