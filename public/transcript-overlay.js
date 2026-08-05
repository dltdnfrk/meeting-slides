const MAX_CONFIRMED_LINES = 3;
const SPEAKER_COLORS = ["#10b981", "#60a5fa", "#f59e0b", "#f472b6"];
const GEOMETRY_KEY = "meeting-slides.transcript-overlay.geometry";
const DRAG_THRESHOLD_PX = 4;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 120;

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function entryKey(entry) {
  return [
    Number(entry.ts) || 0,
    Number(entry.speaker) || 0,
    normalizeText(entry.text),
  ].join(":");
}

function speakerColor(speaker) {
  return SPEAKER_COLORS[(Number(speaker) - 1) % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0];
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function readStoredGeometry() {
  try {
    const raw = localStorage.getItem(GEOMETRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.left !== "number" ||
      typeof parsed?.top !== "number" ||
      typeof parsed?.width !== "number" ||
      typeof parsed?.height !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredGeometry(geometry) {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geometry));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function createTranscriptOverlay(root, { onOpenFullTranscript }) {
  const stage = root.closest(".stage") ?? root.parentElement;
  const toggle = root.querySelector("#transcript-overlay-toggle");
  const body = root.querySelector("#transcript-overlay-body");
  const summary = root.querySelector("#transcript-overlay-summary");
  const status = root.querySelector("#transcript-overlay-status");
  const confirmedList = root.querySelector("#transcript-overlay-confirmed");
  const currentRow = root.querySelector("#transcript-overlay-current");
  const currentSpeaker = root.querySelector("#transcript-overlay-current-speaker");
  const currentText = root.querySelector("#transcript-overlay-current-text");
  const fullButton = root.querySelector("#transcript-overlay-full");
  const announcer = root.querySelector("#transcript-overlay-announcer");
  const resizeHandle = root.querySelector("#transcript-overlay-resize");

  let confirmed = [];
  let currentCaption = null;
  let expanded = true;
  let activity = { capturing: false, detecting: false };
  let geometry = null;
  let dragSession = null;
  let resizeSession = null;

  function stageRect() {
    return (stage ?? document.body).getBoundingClientRect();
  }

  function defaultGeometry() {
    const bounds = stageRect();
    const width = Math.min(720, Math.max(MIN_WIDTH, bounds.width - 32));
    const height = Math.min(300, Math.max(MIN_HEIGHT, bounds.height * 0.42));
    return {
      left: Math.max(16, (bounds.width - width) / 2),
      top: clamp(bounds.height * 0.48 - height / 2, 24, Math.max(24, bounds.height - height - 24)),
      width,
      height,
    };
  }

  function applyGeometry(next, { persist = true } = {}) {
    const bounds = stageRect();
    const width = clamp(next.width, MIN_WIDTH, Math.max(MIN_WIDTH, bounds.width - 16));
    const height = clamp(
      next.height,
      expanded ? MIN_HEIGHT : 54,
      Math.max(expanded ? MIN_HEIGHT : 54, bounds.height - 16),
    );
    const left = clamp(next.left, 8, Math.max(8, bounds.width - width - 8));
    const top = clamp(next.top, 8, Math.max(8, bounds.height - height - 8));
    geometry = { left, top, width, height };

    root.dataset.positioned = "true";
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.width = `${width}px`;
    root.style.height = expanded ? `${height}px` : "54px";
    root.style.maxHeight = "none";
    root.style.transform = "none";

    if (persist) writeStoredGeometry(geometry);
  }

  function ensureGeometry() {
    if (geometry) return geometry;
    const stored = readStoredGeometry();
    applyGeometry(stored ?? defaultGeometry(), { persist: false });
    return geometry;
  }

  function setExpanded(nextExpanded) {
    expanded = nextExpanded;
    root.dataset.state = expanded ? "expanded" : "minimized";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute(
      "aria-label",
      expanded ? "실시간 전사 최소화" : "실시간 전사 펼치기",
    );
    body.hidden = !expanded;
    if (resizeHandle) resizeHandle.hidden = !expanded;
    if (geometry) {
      applyGeometry(geometry, { persist: false });
    }
  }

  function renderConfirmed() {
    confirmedList.replaceChildren();
    for (const entry of confirmed) {
      const item = document.createElement("li");
      item.className = "transcript-overlay__line";

      if (entry.speaker) {
        const speaker = document.createElement("span");
        speaker.className = "transcript-overlay__speaker";
        speaker.textContent = `화자 ${entry.speaker}`;
        speaker.style.setProperty("--speaker-color", speakerColor(entry.speaker));
        item.appendChild(speaker);
      }

      const text = document.createElement("span");
      text.className = "transcript-overlay__line-text";
      text.textContent = entry.text;
      item.appendChild(text);
      confirmedList.appendChild(item);
    }
  }

  function renderCurrent() {
    const text = normalizeText(currentCaption?.text);
    if (!text) {
      currentRow.hidden = true;
      currentSpeaker.hidden = true;
      currentSpeaker.textContent = "";
      currentText.textContent = "";
      return;
    }

    currentRow.hidden = false;
    currentText.textContent = text;
    if (currentCaption?.speaker) {
      currentSpeaker.hidden = false;
      currentSpeaker.textContent = `화자 ${currentCaption.speaker}`;
      currentSpeaker.style.setProperty(
        "--speaker-color",
        speakerColor(currentCaption.speaker),
      );
    } else {
      currentSpeaker.hidden = true;
      currentSpeaker.textContent = "";
    }
  }

  function renderActivity() {
    root.classList.toggle("transcript-overlay--capturing", Boolean(activity.capturing));
    root.classList.toggle("transcript-overlay--detecting", Boolean(activity.detecting));
    status.textContent = activity.detecting ? "AI 정리 중" : "전사";
  }

  function renderSummary() {
    if (currentCaption?.text) {
      summary.textContent = normalizeText(currentCaption.text);
      return;
    }
    const last = confirmed[confirmed.length - 1];
    summary.textContent = last ? last.text : "";
  }

  function announce(text) {
    announcer.textContent = text;
  }

  function caption(partial) {
    const text = normalizeText(partial?.text);
    if (!text) {
      currentCaption = null;
      renderCurrent();
      renderSummary();
      if (confirmed.length === 0) root.hidden = true;
      return;
    }
    ensureGeometry();
    root.hidden = false;
    currentCaption = {
      text,
      speaker: partial?.speaker ? Number(partial.speaker) : 0,
    };
    renderCurrent();
    renderSummary();
  }

  function line(entry) {
    ensureGeometry();
    root.hidden = false;
    const text = normalizeText(entry?.text);
    if (!text) return;

    const next = {
      text,
      speaker: entry?.speaker ? Number(entry.speaker) : 0,
      ts: Number(entry?.ts) || Date.now(),
    };
    const key = entryKey(next);
    if (!confirmed.some((item) => entryKey(item) === key)) {
      confirmed = [...confirmed, next].slice(-MAX_CONFIRMED_LINES);
    }
    if (
      currentCaption &&
      normalizeText(currentCaption.text) === text &&
      (!currentCaption.speaker || currentCaption.speaker === next.speaker)
    ) {
      currentCaption = null;
    }
    renderConfirmed();
    renderCurrent();
    renderSummary();
    announce(text);
  }

  function snapshot(entries) {
    ensureGeometry();
    const list = Array.isArray(entries) ? entries : [];
    confirmed = list
      .map((entry) => ({
        text: normalizeText(entry?.text),
        speaker: entry?.speaker ? Number(entry.speaker) : 0,
        ts: Number(entry?.ts) || 0,
      }))
      .filter((entry) => entry.text)
      .slice(-MAX_CONFIRMED_LINES);
    currentCaption = null;
    root.hidden = confirmed.length === 0;
    if (!root.hidden) ensureGeometry();
    renderConfirmed();
    renderCurrent();
    renderSummary();
  }

  function reset() {
    confirmed = [];
    currentCaption = null;
    root.hidden = true;
    renderConfirmed();
    renderCurrent();
    renderSummary();
    announce("");
  }

  let suppressClick = false;

  function endPointerSessions() {
    dragSession = null;
    resizeSession = null;
    root.classList.remove("transcript-overlay--dragging");
    root.classList.remove("transcript-overlay--resizing");
  }

  function eventId(event) {
    return event.pointerId ?? "mouse";
  }

  function beginDrag(event) {
    if (event.button != null && event.button !== 0) return;
    ensureGeometry();
    dragSession = {
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...geometry },
      moved: false,
      pointerId: eventId(event),
    };
    if (event.pointerId != null) toggle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function beginResize(event) {
    if (event.button != null && event.button !== 0) return;
    if (!expanded || !resizeHandle) return;
    ensureGeometry();
    resizeSession = {
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...geometry },
      pointerId: eventId(event),
    };
    if (event.pointerId != null) resizeHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function onMove(event) {
    const id = eventId(event);
    if (dragSession && dragSession.pointerId === id) {
      const dx = event.clientX - dragSession.startX;
      const dy = event.clientY - dragSession.startY;
      if (!dragSession.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragSession.moved = true;
        root.classList.add("transcript-overlay--dragging");
      }
      applyGeometry({
        left: dragSession.origin.left + dx,
        top: dragSession.origin.top + dy,
        width: dragSession.origin.width,
        height: dragSession.origin.height,
      });
      return;
    }

    if (resizeSession && resizeSession.pointerId === id) {
      const dx = event.clientX - resizeSession.startX;
      const dy = event.clientY - resizeSession.startY;
      root.classList.add("transcript-overlay--resizing");
      applyGeometry({
        left: resizeSession.origin.left,
        top: resizeSession.origin.top,
        width: resizeSession.origin.width + dx,
        height: resizeSession.origin.height + dy,
      });
    }
  }

  function onUp(event) {
    const id = eventId(event);
    if (dragSession && dragSession.pointerId === id) {
      const wasDrag = dragSession.moved;
      endPointerSessions();
      if (!wasDrag) {
        setExpanded(!expanded);
        suppressClick = true;
      } else {
        suppressClick = true;
      }
      return;
    }
    if (resizeSession && resizeSession.pointerId === id) {
      endPointerSessions();
      suppressClick = true;
    }
  }

  toggle.addEventListener("pointerdown", beginDrag);
  toggle.addEventListener("mousedown", (event) => {
    if (event.sourceCapabilities?.firesTouchEvents) return;
    // Fallback when PointerEvent is unavailable.
    if (typeof PointerEvent === "undefined") beginDrag(event);
  });
  toggle.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      return;
    }
    // Keyboard / accessibility activation.
    setExpanded(!expanded);
  });
  if (resizeHandle) {
    resizeHandle.addEventListener("pointerdown", beginResize);
    resizeHandle.addEventListener("mousedown", (event) => {
      if (typeof PointerEvent === "undefined") beginResize(event);
    });
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("pointercancel", endPointerSessions);
  window.addEventListener("resize", () => {
    if (!root.hidden && geometry) applyGeometry(geometry, { persist: false });
  });

  fullButton.addEventListener("click", onOpenFullTranscript);

  setExpanded(true);
  renderActivity();
  // Keep default CSS centering until first show; geometry applies on first content.

  return {
    caption,
    line,
    snapshot,
    reset,
    setActivity(nextActivity) {
      activity = { ...activity, ...nextActivity };
      renderActivity();
    },
    collapseFromEscape() {
      if (root.hidden || !expanded) return false;
      setExpanded(false);
      toggle.focus();
      return true;
    },
  };
}
