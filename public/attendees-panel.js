import { escapeHtml } from "./meeting-workspace.js";
export function createAttendeesPanel({ transport, workspace }) {
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};

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
// ── 참석자 지정 (캡처 전 준비) ──
// 로컬 초안(drafts)은 아직 서버에 없는 편집 상태, attendeeState는 서버가 확정해
// 에코한 명단이다. 저장 버튼이 초안을 setAttendees로 보내고, attendees 메시지가
// 오면 attendeeState(+meeting_id)를 교체한 뒤 초안을 서버 명단으로 되맞춘다.
// meeting_id는 startCapture가 같은 draft meeting을 활성화하도록 함께 보낸다.
let attendeeDrafts = [];
let attendeeDirty = false;
const attendeeState = { meetingId: null, attendees: [] };
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
  if (window.openDialog) window.openDialog(attendeePanelEl); else attendeePanelEl.hidden = false;
  btnAttendeesEl.setAttribute("aria-expanded", "true");
  attendeeNameEl.focus();
  window.trapFocus?.(attendeePanelEl);
}

function closeAttendeePanel(restoreFocus = false) {
  btnAttendeesEl.setAttribute("aria-expanded", "false");
  if (window.closeDialog) window.closeDialog(attendeePanelEl, () => {
    if (restoreFocus) btnAttendeesEl.focus({ preventScroll: true });
  }); else {
    attendeePanelEl.hidden = true;
    window.releaseFocus?.(attendeePanelEl);
    if (restoreFocus) btnAttendeesEl.focus({ preventScroll: true });
  }
}

/** 캡처 중에는 명단을 잠근다 (서버가 draft meeting을 활성화한 뒤이므로 편집 불가). */
function renderAttendeeLock() {
  btnAttendeesEl.disabled = workspace.capturing;
  const attendeeLabel = workspace.capturing ? "참석자 지정. 녹음 중에는 변경할 수 없습니다" : "참석자 지정";
  btnAttendeesEl.title = attendeeLabel;
  btnAttendeesEl.setAttribute("aria-label", attendeeLabel);
  attendeeNameEl.disabled = workspace.capturing;
  attendeeCrmEl.disabled = workspace.capturing;
  btnAttendeeAddEl.disabled = workspace.capturing;
  btnAttendeeSaveEl.disabled = workspace.capturing;
  if (workspace.capturing) closeAttendeePanel();
  workspace.syncAvailability();
}

/** 초안 한 명 추가/수정 — 빈 이름·중복 이름은 거부하고 초안을 그대로 둔다. */
function commitAttendeeDraft() {
  if (workspace.capturing) return;
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
  if (workspace.capturing || !(ev.target instanceof Element)) return;
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
  if (workspace.capturing) return;
  if (attendeeDrafts.length === 0) {
    setAttendeeError("참석자를 한 명 이상 추가하세요");
    return;
  }
  if (!transport.isOpen()) {
    setAttendeeError("앱 서버에 연결되지 않아 참석자를 저장할 수 없습니다");
    return;
  }
  transport.send({
    action: "setAttendees",
    attendees: attendeeDrafts.map((a) => (
      a.crmPersonId ? { name: a.name, crmPersonId: a.crmPersonId } : { name: a.name }
    )),
  });
  setAttendeeError("");
  workspace.renderStatus("참석자 저장 중…");
}

btnAttendeeSaveEl.onclick = sendAttendees;

btnAttendeesEl.onclick = (ev) => {
  ev.stopPropagation();
  if (attendeePanelEl.hidden || attendeePanelEl.dataset.motionState === "closing") openAttendeePanel();
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
  if (msg.meeting_id === null) attendeeState.meetingId = null;
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
  if (userWasSaving) workspace.renderStatus(`참석자 ${attendees.length}명을 저장했습니다`);
}


renderAttendeeList();
return Object.freeze({
  applyMessage: applyAttendeesMessage, clearPreparedMeeting,
  syncCapture: renderAttendeeLock, close: closeAttendeePanel,
  isOpen: () => !attendeePanelEl.hidden,
  get meetingId() { return attendeeState.meetingId; },
  snapshot: () => structuredClone(attendeeState),
  warnUnsaved() {
    if (attendeeDirty) setAttendeeError("저장하지 않은 참석자가 있습니다. 참석자를 저장한 뒤 녹음을 시작해 주세요");
  },
});
}
