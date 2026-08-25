function cloneValue(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], seen);
  return copy;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function copySlides(slides) {
  if (!Array.isArray(slides)) throw new TypeError("slides must be an array");

  const ids = new Set();
  const copies = slides.map((slide) => {
    if (slide === null || typeof slide !== "object" || Array.isArray(slide)) {
      throw new TypeError("each slide must be an object");
    }
    if (typeof slide.id !== "string" || slide.id.length === 0 || slide.id.trim() !== slide.id) {
      throw new TypeError("each slide must have a stable, non-empty string id");
    }
    if (ids.has(slide.id)) throw new TypeError(`duplicate slide id: ${slide.id}`);
    ids.add(slide.id);
    return cloneValue(slide);
  });

  return deepFreeze(copies);
}

function makeState(slides, activeSlideId, overviewOpen, presenterMode, speakerNotesVisible) {
  return Object.freeze({
    slides,
    activeSlideId,
    overviewOpen,
    presenterMode,
    speakerNotesVisible,
  });
}

export function createDeckState(slides) {
  const copiedSlides = copySlides(slides);
  return makeState(copiedSlides, copiedSlides[0]?.id ?? null, false, false, false);
}

export function reduceDeckState(state, action) {
  if (!action || typeof action.type !== "string") return state;

  if (action.type === "setSlides") {
    const oldIndex = state.slides.findIndex((slide) => slide.id === state.activeSlideId);
    const slides = copySlides(action.slides);
    if (slides.length === 0) return createDeckState([]);
    const retained = slides.some((slide) => slide.id === state.activeSlideId);
    const fallbackIndex = Math.min(Math.max(oldIndex, 0), slides.length - 1);
    const activeSlideId = retained ? state.activeSlideId : slides[fallbackIndex].id;
    return makeState(
      slides,
      activeSlideId,
      state.overviewOpen,
      state.presenterMode,
      state.speakerNotesVisible,
    );
  }

  if (state.slides.length === 0) return state;

  const index = state.slides.findIndex((slide) => slide.id === state.activeSlideId);
  const currentIndex = index < 0 ? 0 : index;
  let activeSlideId = state.activeSlideId;
  let overviewOpen = state.overviewOpen;
  let presenterMode = state.presenterMode;
  let speakerNotesVisible = state.speakerNotesVisible;

  switch (action.type) {
    case "next":
      activeSlideId = state.slides[Math.min(currentIndex + 1, state.slides.length - 1)].id;
      break;
    case "previous":
      activeSlideId = state.slides[Math.max(currentIndex - 1, 0)].id;
      break;
    case "home":
      activeSlideId = state.slides[0].id;
      break;
    case "end":
      activeSlideId = state.slides[state.slides.length - 1].id;
      break;
    case "goTo":
      if (!state.slides.some((slide) => slide.id === action.slideId)) return state;
      activeSlideId = action.slideId;
      break;
    case "toggleOverview":
      overviewOpen = !overviewOpen;
      break;
    case "openOverview":
      overviewOpen = true;
      break;
    case "closeOverview":
      overviewOpen = false;
      break;
    case "selectOverviewSlide":
      if (!state.slides.some((slide) => slide.id === action.slideId)) return state;
      activeSlideId = action.slideId;
      overviewOpen = false;
      break;
    case "togglePresenter":
      presenterMode = !presenterMode;
      if (!presenterMode) speakerNotesVisible = false;
      break;
    case "toggleSpeakerNotes":
      if (!presenterMode) return state;
      speakerNotesVisible = !speakerNotesVisible;
      break;
    default:
      return state;
  }

  if (
    activeSlideId === state.activeSlideId &&
    overviewOpen === state.overviewOpen &&
    presenterMode === state.presenterMode &&
    speakerNotesVisible === state.speakerNotesVisible
  ) return state;

  return makeState(state.slides, activeSlideId, overviewOpen, presenterMode, speakerNotesVisible);
}

export function keyboardAction(event) {
  if (!event || event.altKey || event.ctrlKey || event.metaKey) return null;
  const target = event.target;
  const tagName = typeof target?.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tagName)) return null;
  if (target?.isContentEditable || target?.closest?.("[contenteditable]")) return null;

  if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key)) return { type: "next" };
  if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) return { type: "previous" };
  if (event.key === "Home") return { type: "home" };
  if (event.key === "End") return { type: "end" };
  if (event.key === "Escape") return { type: "closeOverview" };
  if (event.key === "o" || event.key === "O") return { type: "toggleOverview" };
  if (event.key === "p") return { type: "togglePresenter" };
  if (event.key === "n") return { type: "toggleSpeakerNotes" };
  return null;
}

export function deckStageProjection(state) {
  const activeIndex = state.slides.findIndex((slide) => slide.id === state.activeSlideId);
  const activeSlide = activeIndex < 0 ? null : state.slides[activeIndex];
  const slideCount = state.slides.length;
  return Object.freeze({
    activeSlideId: activeSlide?.id ?? null,
    activeIndex,
    activeSlide,
    slideCount,
    slideCounter: activeIndex < 0 ? `0 / ${slideCount}` : `${activeIndex + 1} / ${slideCount}`,
    overviewOpen: state.overviewOpen,
    presenterMode: state.presenterMode,
    speakerNotesVisible: state.speakerNotesVisible,
    speakerNotes: activeSlide?.speakerNotes ?? "",
  });
}

function setBooleanAttribute(element, name, value) {
  if (element) element.setAttribute(name, String(value));
}

function optionSlideId(option) {
  return option.getAttribute?.("data-slide-id") ?? option.dataset?.slideId ?? option.slideId ?? null;
}

export function projectDeckStage(root, state) {
  const projection = deckStageProjection(state);
  const slideLabel = projection.activeIndex < 0
    ? "No slides"
    : `Slide ${projection.activeIndex + 1} of ${projection.slideCount}`;
  const stage = root.querySelector("[data-deck-stage]");
  if (stage) {
    if (projection.activeIndex < 0) stage.removeAttribute("aria-current");
    else stage.setAttribute("aria-current", "true");
    stage.setAttribute("aria-label", slideLabel);
  }

  const overviewToggle = root.querySelector("[data-deck-overview-toggle]");
  setBooleanAttribute(overviewToggle, "aria-expanded", projection.overviewOpen);
  const overview = root.querySelector("[data-deck-overview]");
  if (overview) overview.hidden = !projection.overviewOpen;

  for (const option of root.querySelectorAll("[data-slide-id]")) {
    const id = optionSlideId(option);
    const index = state.slides.findIndex((slide) => slide.id === id);
    const selected = index >= 0 && id === projection.activeSlideId;
    if (selected) option.setAttribute("aria-current", "true");
    else option.removeAttribute("aria-current");
    option.setAttribute("aria-selected", String(selected));
    if (index >= 0) {
      const title = option.textContent?.trim();
      option.setAttribute("aria-label", title ? `${title}, Slide ${index + 1} of ${projection.slideCount}` : `Slide ${index + 1} of ${projection.slideCount}`);
    }
    else option.removeAttribute("aria-label");
  }

  setBooleanAttribute(root.querySelector("[data-presenter-toggle]"), "aria-pressed", projection.presenterMode);
  setBooleanAttribute(root.querySelector("[data-speaker-notes-toggle]"), "aria-expanded", projection.speakerNotesVisible);
  const notes = root.querySelector("[data-speaker-notes]");
  if (notes) {
    notes.hidden = !projection.speakerNotesVisible;
    notes.setAttribute("aria-hidden", String(!projection.speakerNotesVisible));
    notes.textContent = projection.speakerNotes;
  }
  const counter = root.querySelector("[data-slide-counter]");
  if (counter) {
    counter.textContent = projection.slideCounter;
    counter.setAttribute("aria-label", slideLabel);
  }

  return projection;
}
