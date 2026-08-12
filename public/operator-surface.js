// operator-surface.js — the document-centric library shell (Todo 11).
//
// This module owns:
//   * the canonical UI/transcript reducers, imported from the GENERATED browser
//     artifacts under /generated/ (see scripts/build-public-modules.ts). The
//     `.ts` sources are served as application/octet-stream with nosniff and can
//     never be imported by a browser, so the build step is the permanent path;
//   * the explicit state attributes `data-connection`, `data-capture-phase`,
//     `data-shell`, `data-detail-tab`, `data-stage-state` and `data-ui-state`;
//   * a real ARIA tablist: roving tabindex, ArrowLeft/ArrowRight/Home/End,
//     focus movement, and exactly one perceivable tabpanel at a time.
//
// It owns NO transport and NO meeting data: `app.js` keeps the WebSocket, the
// rendering, the notes/history contract and every action payload spelling. This
// module observes the frames `app.js` republishes and projects state onto the
// shell. Nothing here renames a DOM ID, an action or a payload key.
import {
  initialUiState,
  parseServerEvent,
  reduce,
} from "/generated/ui-state-machine.js";
import {
  initialTranscriptState,
  minibarProjection,
  parseTranscriptEvent,
  reduceTranscript,
} from "/generated/transcript-state.js";

const app = document.querySelector(".app");

// Expose the loaded modules for the browser QA driver. This is a read-only
// probe surface: nothing in the product reads it back.
window.__caretModules = {
  ui: { initialUiState, parseServerEvent, reduce },
  transcript: { initialTranscriptState, minibarProjection, parseTranscriptEvent, reduceTranscript },
};

// ── canonical state ─────────────────────────────────────────────────────────

let uiState = initialUiState();
let transcriptState = initialTranscriptState();

const DETAIL_TABS = ["overview", "notes", "transcript"];

const tabButtons = () =>
  DETAIL_TABS.map((tab) => document.getElementById(`detail-tab-${tab}`)).filter(Boolean);

const panelFor = (tab) => {
  const button = document.getElementById(`detail-tab-${tab}`);
  const id = button?.getAttribute("aria-controls");
  return id ? document.getElementById(id) : null;
};

/**
 * The compile/save/export set is ONE real <details>, and DESIGN 9.11 puts that
 * whole set behind a disclosure in BOTH shells, so its default is `closed`
 * everywhere. Keeping one default rather than a per-shell one is what makes the
 * user's own toggle survivable.
 *
 * SINGLE SOURCE OF TRUTH. The shell is signalled twice - the reducer flips
 * `data-shell` on `starting`, and the legacy `.app--capturing` class flips later
 * on `capturing`. Two writers meant the second flip re-applied the default on
 * top of a choice the user had already made INSIDE one continuous live shell.
 * This function is now the only writer, and it acts only when the shell it is
 * told about differs from the one it last applied.
 */
let lastDisclosureShell = null;
function applyDockDisclosureDefault(shell) {
  if (shell === lastDisclosureShell) return;
  lastDisclosureShell = shell;
  const details = document.getElementById("dock-more");
  if (details instanceof HTMLDetailsElement) details.open = false;
}

/**
 * DESIGN 9.12 / Todo 15: a USER-started capture hands focus to the visible Stop.
 *
 * The browser is the product's only Start surface, and activating Start removes
 * `#btn-record` from the live shell while revealing `#btn-live-stop`. Without
 * this handoff the keyboard operator is left on BODY and must re-traverse the
 * shell to reach the only control that ends their own recording.
 *
 * It is armed ONLY by a local activation (`activateCapture` below), never by the
 * arrival of a capture frame, so a calendar auto-capture, a reconnect
 * re-assertion and first-load hydration all leave focus exactly where the
 * operator put it. It is a one-shot: the flag is cleared on the first attempt,
 * so one start can move focus at most once.
 */
let pendingStartFocus = false;

/**
 * Moves focus to Stop for a user-started capture, once Stop is actually
 * perceivable. Deliberately declines in the two cases where something else owns
 * focus by contract: an open dialog (9.12 traps focus inside its sheet) and a
 * control the operator has already moved to inside the live shell.
 */
function handOffStartFocus() {
  if (!pendingStartFocus || uiState.shell !== "live") return;
  const stop = document.getElementById("btn-live-stop");
  if (!(stop instanceof HTMLElement)) return;
  const rect = stop.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  pendingStartFocus = false;
  const active = document.activeElement;
  // An open dialog, or any surface that has already taken focus deliberately,
  // keeps it. Only the default resting places - the document body and the Start
  // control that just left the shell - are handed over.
  const yieldsFocus = active === null
    || active === document.body
    || active === document.documentElement
    || active === recordBtn;
  if (!yieldsFocus) return;
  stop.focus({ preventScroll: true });
}

/** Applies the reducer's projection to the shell's explicit state attributes. */
function projectState() {
  if (!app) return;
  const shellChanged = app.dataset.shell !== uiState.shell;
  app.dataset.uiState = uiState.name;
  app.dataset.capturePhase = uiState.capture;
  app.dataset.shell = uiState.shell;
  // `data-connection` on the document element belongs to app.js and keeps its
  // frozen vocabulary (`connecting|connected|disconnected|error`), which the
  // task-3 manifest pins and other surfaces read. The richer canonical state is
  // published ADDITIVELY under its own name so nothing is renamed or clobbered.
  app.dataset.connectionState = uiState.connection;
  // Panel visibility depends on the shell, so re-apply it whenever the shell
  // flips. Focus is never moved by a state projection.
  if (shellChanged) {
    setDetailTab(app.dataset.detailTab || "overview");
    applyDockDisclosureDefault(uiState.shell);
  }
  // Focus is never moved BY a state projection; it is moved by the user's own
  // Start, which this projection has just made perceivable.
  handOffStartFocus();
}

/**
 * Ingests one raw server frame through the pure reducers. Malformed frames are
 * dropped by the parsers and leave both projections untouched, exactly as the
 * canonical state model requires.
 */
function ingestServerFrame(raw) {
  const parsed = parseServerEvent(raw);
  if (parsed.ok) {
    const before = uiState;
    uiState = reduce(uiState, parsed.event);
    // Authoritative idle after a capture: the reducer parks in `idle-live` (the
    // just-ended meeting shell) and waits for an explicit intent. The library is
    // that intent's only destination, so the shell issues it once, here, exactly
    // when the transition happens. Todo 12 owns the live geometry either side.
    if (before.name !== "idle-live" && uiState.name === "idle-live") {
      uiState = reduce(uiState, { kind: "returnToLibrary" });
    }
    projectState();
  }
  const transcriptParsed = parseTranscriptEvent(raw);
  if (transcriptParsed.ok) {
    transcriptState = reduceTranscript(transcriptState, transcriptParsed.event);
  }
}

/** Transport transitions the socket reports; `app.js` calls this on open/close. */
function ingestTransport(status) {
  uiState = reduce(uiState, { kind: "transport", status });
  projectState();
}

// The shell is the only writer of these attributes, so `app.js` publishes into
// it rather than setting them itself. Both scripts stay on the same state.
window.__caretShell = {
  ingestServerFrame,
  ingestTransport,
  /** Local activation of the record control (start or stop). */
  activateCapture() {
    uiState = reduce(uiState, { kind: "activateCapture" });
    // `startRequested` is set by the reducer only for a local start the server
    // has not answered yet, which is precisely "this user just pressed Start".
    if (uiState.startRequested) pendingStartFocus = true;
    projectState();
    return uiState.outbox;
  },
  /** The user picked a meeting: the reducer tracks which response is current. */
  selectMeeting(meetingId) {
    uiState = reduce(uiState, { kind: "selectMeeting", meetingId });
    projectState();
  },
  /** True when a `meeting` payload is still the one the user asked for. */
  isCurrentMeeting(meetingId) {
    return uiState.selectedMeetingId === null || uiState.selectedMeetingId === meetingId;
  },
  /**
   * The canonical parser's verdict on one raw frame, so `app.js` renders exactly
   * what the reducer accepted. Without this the renderer had its own, laxer
   * notion of a valid line: `{type:"line"}` and `{type:"line", text:42}` both
   * produced a DOM row that the canonical transcript projection had rejected,
   * leaving the two out of sync after any malformed frame.
   */
  acceptsTranscriptFrame(raw) {
    return parseTranscriptEvent(raw).ok;
  },
  setStageState(state) {
    if (app) app.dataset.stageState = state;
  },
  get uiState() {
    return uiState;
  },
  get transcriptState() {
    return transcriptState;
  },
  minibar() {
    return minibarProjection(transcriptState);
  },
  setDetailTab(tab, options) {
    setDetailTab(tab, options);
  },
};

// ── detail tabs: a real tablist ─────────────────────────────────────────────

/**
 * Selects one tab. Exactly one panel is left in the accessibility tree; the
 * other two carry `hidden`, which also removes them from the layout via CSS.
 * `moveFocus` is true for keyboard and pointer activation and false for
 * programmatic sync (a shell change must never steal focus).
 */
function setDetailTab(tab, { moveFocus = false } = {}) {
  if (!app || !DETAIL_TABS.includes(tab)) return;
  app.dataset.detailTab = tab;

  // In the live shell the stage and the transcript are present together by
  // contract, and the tablist is not shown. Panel `hidden` bookkeeping is a
  // library-shell concern only; applying it in live would hide the transcript
  // column and remove it from the accessibility tree.
  //
  // Live when EITHER the reducer says so or the legacy `.app--capturing` class is
  // set (the compatibility signal a phase-less `capture` frame still produces).
  // `bindCaptureClassBridge` re-applies this on every class flip, so the return
  // to library re-hides the panels even though app.js clears the class after it
  // has already forwarded the frame to this module.
  const libraryShell = uiState.shell !== "live" && !app.classList.contains("app--capturing");

  for (const name of DETAIL_TABS) {
    const button = document.getElementById(`detail-tab-${name}`);
    const panel = panelFor(name);
    const selected = name === tab;
    if (button) {
      button.setAttribute("aria-selected", selected ? "true" : "false");
      // Roving tabindex: only the selected tab is in the document tab order.
      button.tabIndex = selected ? 0 : -1;
    }
    if (panel) panel.hidden = libraryShell ? !selected : false;
  }

  if (moveFocus) {
    document.getElementById(`detail-tab-${tab}`)?.focus({ preventScroll: true });
  }
}

function bindTablist() {
  const buttons = tabButtons();
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const tab = button.dataset.detailTab;
      if (tab) setDetailTab(tab, { moveFocus: true });
    });

    button.addEventListener("keydown", (event) => {
      const order = tabButtons();
      const index = order.indexOf(button);
      if (index === -1) return;
      let next = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (index + 1) % order.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (index - 1 + order.length) % order.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = order.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      const tab = order[next]?.dataset.detailTab;
      if (tab) setDetailTab(tab, { moveFocus: true });
    });
  }
}

// ── the output switcher reveals an existing surface ─────────────────────────

function bindOutputSwitcher() {
  const items = [...document.querySelectorAll(".output-switcher__item")];
  for (const item of items) {
    item.addEventListener("click", (event) => {
      if (!(item instanceof HTMLElement) || item.matches(":disabled")) return;
      const targetId = item.dataset.outputTarget;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (!target) return;

      event.preventDefault();
      for (const candidate of items) candidate.removeAttribute("aria-current");
      item.setAttribute("aria-current", "page");

      // The switcher never duplicates content: it selects the tab that already
      // owns the surface, then moves focus to it.
      if (targetId === "stage-pane") setDetailTab("overview");
      if (targetId === "transcript-pane") setDetailTab("transcript");
      if (!target.hidden) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }
}

// ── live controls that the library shell still hosts ────────────────────────

const recordBtn = document.getElementById("btn-record");
const liveStop = document.getElementById("btn-live-stop");
const captureTimer = document.getElementById("capture-timer");
const liveTimer = document.getElementById("live-topbar-timer");
const liveNote = document.getElementById("live-note");
const notesInput = document.getElementById("notes-input");
const chromeTitle = document.getElementById("meeting-chrome-title");
const chromeDate = document.getElementById("meeting-chrome-date");
const docTitle = document.getElementById("doc-title");

liveStop?.addEventListener("click", () => {
  if (recordBtn?.classList.contains("record-btn--on")) recordBtn.click();
});

function syncTimers() {
  if (liveTimer && captureTimer) {
    liveTimer.textContent = captureTimer.textContent || "00:00";
  }
}

function syncTitles() {
  if (chromeTitle && docTitle) {
    const text = (docTitle.textContent || "").trim();
    chromeTitle.textContent = text && text !== "새 회의 준비" ? text : "Untitled";
  }
  if (chromeDate) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    chromeDate.textContent = `${y}/${m}/${d}`;
  }
}

// Notes mirror: the live scratch note and #notes-input hold the same text, so
// the existing note-save and history contract keeps exactly one source.
let noteSyncing = false;
function bindNoteMirror() {
  if (!liveNote || !notesInput) return;
  liveNote.addEventListener("input", () => {
    if (noteSyncing) return;
    noteSyncing = true;
    notesInput.value = liveNote.value;
    notesInput.dispatchEvent(new Event("input", { bubbles: true }));
    noteSyncing = false;
  });
  notesInput.addEventListener("input", () => {
    if (noteSyncing) return;
    noteSyncing = true;
    liveNote.value = notesInput.value;
    noteSyncing = false;
  });
}

/**
 * Legacy compatibility: `.app--capturing` remains the class `app.js` toggles and
 * `public/operator-surface.js` reads. When it flips, the shell follows: entering
 * capture shows Overview, leaving it returns to the library document.
 */
function bindCaptureClassBridge() {
  if (!app) return;
  let wasCapturing = app.classList.contains("app--capturing");
  const observer = new MutationObserver(() => {
    const capturing = app.classList.contains("app--capturing");
    if (capturing !== wasCapturing) {
      wasCapturing = capturing;
      // Re-apply panel visibility in BOTH directions: entering live reveals the
      // stage and transcript together, leaving it restores the one-panel library
      // document. Focus is never moved by this bookkeeping.
      setDetailTab(capturing ? "overview" : app.dataset.detailTab || "overview");
      // A phase-less `capture` frame flips the shell through this class alone.
      // `applyDockDisclosureDefault` de-duplicates against the shell it last
      // applied, so the ordinary `starting` -> `capturing` sequence (which has
      // already moved the shell to `live`) leaves the user's own toggle intact.
      applyDockDisclosureDefault(capturing ? "live" : "library");
    }
    syncTimers();
    syncTitles();
  });
  observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  if (captureTimer) {
    observer.observe(captureTimer, { childList: true, characterData: true, subtree: true });
  }
  if (docTitle) {
    observer.observe(docTitle, { childList: true, characterData: true, subtree: true });
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

bindTablist();
bindOutputSwitcher();
bindNoteMirror();
bindCaptureClassBridge();
syncTitles();
syncTimers();
setDetailTab(app?.dataset.detailTab || "overview");
applyDockDisclosureDefault(uiState.shell);
projectState();
