import { applyDeckEditorCommand, createDeckEditorState } from "./deck-editor.js";
import { createDeckStageController } from "./deck-stage-controller.js";

const LAYOUT_LABELS = Object.freeze({
  hero: "Opening", summary: "Summary", decision: "Decision", comparison: "Comparison",
  timeline: "Timeline", metrics: "Metrics", actions: "Actions",
});
const EXPORT_FILES = Object.freeze({
  web: "standalone/index.html", pptx: "editable/deck.pptx",
  pdf: "raster/deck.pdf", png: "raster/png/slide-01.png",
});

const SCHEMA_KEYS = new Set(["variant"]);

function textValues(value, output = []) {
  if (typeof value === "string" && value.trim() && !SCHEMA_KEYS.has(value)) output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => textValues(item, output));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!SCHEMA_KEYS.has(key)) textValues(item, output);
    }
  }
  return output;
}

function button(selector, root) {
  const value = root.querySelector(selector);
  if (!(value instanceof HTMLButtonElement)) throw new TypeError(`${selector} button is required`);
  return value;
}

export function createSlidePlanWorkspace(options) {
  const { root, fallback, keyboardTarget = window, exportControls = [] } = options ?? {};
  if (!(root instanceof HTMLElement) || !(fallback instanceof HTMLElement)) {
    throw new TypeError("SlidePlan workspace root and fallback are required");
  }

  const title = root.querySelector("[data-slide-plan-title]");
  const body = root.querySelector("[data-slide-plan-body]");
  const paper = root.querySelector("[data-slide-plan-paper]");
  const label = root.querySelector("[data-slide-plan-layout-label]");
  const overview = root.querySelector("[data-deck-overview]");
  const titleInput = root.querySelector("[data-slide-title-input]");
  const layoutSelect = root.querySelector("[data-slide-layout]");
  const status = root.querySelector("[data-slide-plan-status]");
  const exports = [...root.querySelectorAll("[data-slide-plan-export]")];
  if (!(titleInput instanceof HTMLInputElement) || !(layoutSelect instanceof HTMLSelectElement)) {
    throw new TypeError("SlidePlan editor controls are required");
  }

  let editor = null;
  let controller = null;
  let dirty = false;
  let exportHrefs = new Map();

  const adaptedSlides = () => editor.deck.slides.map((slide) => ({
    ...slide, speakerNotes: slide.notes ?? "",
  }));

  const activeSlide = () => {
    const id = controller?.getState().activeSlideId;
    return editor?.deck.slides.find((slide) => slide.id === id) ?? null;
  };

  const syncExports = () => {
    for (const link of exports) {
      const href = exportHrefs.get(link);
      if (dirty) {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        link.setAttribute("title", "로컬 편집으로 내보내기가 오래되었습니다");
      } else {
        link.setAttribute("href", href);
        link.removeAttribute("aria-disabled");
        link.removeAttribute("title");
      }
    }
    for (const control of exportControls) {
      control.disabled = dirty;
      if (dirty) {
        control.setAttribute("title", "로컬 편집으로 내보내기가 오래되었습니다");
        control.setAttribute("aria-label", "로컬 편집으로 내보내기가 오래되었습니다");
      }
    }
  };

  const render = () => {
    const slide = activeSlide();
    if (!slide) return;
    root.dataset.presenter = String(controller?.getState().presenterMode ?? false);
    title.textContent = slide.title;
    label.textContent = LAYOUT_LABELS[slide.layout] ?? slide.layout;
    paper.dataset.layout = slide.layout;
    body.replaceChildren(...textValues(slide.payload).map((text) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    }));
    titleInput.value = slide.title;
    layoutSelect.value = slide.layout;
    for (const option of overview.querySelectorAll("[data-slide-id]")) {
      const candidate = editor.deck.slides.find((item) => item.id === option.dataset.slideId);
      if (candidate) option.textContent = candidate.title;
    }
    button("[data-deck-undo]", root).disabled = editor.past.length === 0;
    button("[data-deck-redo]", root).disabled = editor.future.length === 0;
    status.textContent = dirty
      ? `Local draft · revision ${editor.revision} · exports stale`
      : `Saved revision ${editor.revision} · exports current`;
    syncExports();
  };

  const dispatchEdit = (command) => {
    if (!editor) return false;
    const result = applyDeckEditorCommand(editor, { ...command, expectedRevision: editor.revision });
    if (!result.ok) {
      status.textContent = `Local edit rejected · ${result.error.code}`;
      return false;
    }
    if (result.state !== editor) dirty = true;
    editor = result.state;
    controller.setSlides(adaptedSlides());
    render();
    return true;
  };

  titleInput.addEventListener("change", () => {
    const slide = activeSlide();
    if (!slide || titleInput.value === slide.title) return;
    dispatchEdit({ type: "setText", slideId: slide.id, path: "title", text: titleInput.value,
      claimIds: slide.bindings.title });
  });
  layoutSelect.addEventListener("change", () => {
    const slide = activeSlide();
    if (slide) dispatchEdit({ type: "chooseLayout", slideId: slide.id, layout: layoutSelect.value });
  });
  button("[data-deck-undo]", root).addEventListener("click", () => dispatchEdit({ type: "undo" }));
  button("[data-deck-redo]", root).addEventListener("click", () => dispatchEdit({ type: "redo" }));

  const initialize = (slidePlan) => {
    const plan = slidePlan?.plan;
    if (!plan) return clear();
    let nextEditor;
    try { nextEditor = createDeckEditorState(plan); }
    catch (error) {
      clear();
      status.textContent = "SlidePlan을 열 수 없습니다";
      console.error("invalid SlidePlan", error);
      return false;
    }
    controller?.destroy();
    editor = nextEditor;
    dirty = false;
    overview.replaceChildren(...editor.deck.slides.map((slide) => {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.slideId = slide.id;
      option.setAttribute("role", "option");
      option.textContent = slide.title;
      return option;
    }));
    const base = `/slide-plan-artifacts/${encodeURIComponent(editor.deck.planId)}/`;
    exportHrefs = new Map(exports.map((link) => [link, base + EXPORT_FILES[link.dataset.slidePlanExport]]));
    root.hidden = false;
    fallback.hidden = true;
    fallback.style.display = "none";
    controller = createDeckStageController({ root, slides: adaptedSlides(), keyboardTarget,
      onChange: render });
    render();
    return true;
  };

  function clear() {
    controller?.destroy();
    controller = null;
    editor = null;
    dirty = false;
    root.hidden = true;
    fallback.hidden = false;
    fallback.style.removeProperty("display");
    for (const control of exportControls) control.disabled = false;
    return false;
  }

  return Object.freeze({ initialize, clear, isActive: () => !root.hidden, isDirty: () => dirty, currentPlan: () => editor?.deck ?? null });
}

const root = document.querySelector("[data-slide-plan-workspace]");
const fallback = document.getElementById("current-slide");
window.__slidePlanWorkspace = root && fallback ? createSlidePlanWorkspace({
  root, fallback, keyboardTarget: window,
  exportControls: ["btn-export-deck", "btn-export-pdf", "btn-export-png"]
    .map((id) => document.getElementById(id)).filter(Boolean),
}) : null;
