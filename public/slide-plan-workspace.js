import { applyDeckEditorCommand, createDeckEditorState } from "./deck-editor.js";
import { createDeckStageController } from "./deck-stage-controller.js";
import { createSlidePlanCanvas, overlayGeometry } from "./slide-plan-canvas.js";

const LAYOUT_LABELS = Object.freeze({
  hero: "Opening", summary: "Summary", decision: "Decision", comparison: "Comparison",
  timeline: "Timeline", metrics: "Metrics", actions: "Actions",
});
const EXPORT_FILES = Object.freeze({
  web: "standalone/index.html", pptx: "editable/deck.pptx",
  pdf: "raster/deck.pdf", png: "raster/png/slide-01.png",
});

const SCHEMA_KEYS = new Set(["variant", "mode"]);

function textValues(value, output = []) {
  if (typeof value === "string" && value.trim()) output.push(value);
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
  const { root, fallback, keyboardTarget, onChange = () => {} } = options ?? {};
  if (!(root instanceof HTMLElement) || !(fallback instanceof HTMLElement)) {
    throw new TypeError("SlidePlan workspace root and fallback are required");
  }

  const title = root.querySelector("[data-slide-plan-title]");
  const body = root.querySelector("[data-slide-plan-body]");
  const paper = root.querySelector("[data-slide-plan-paper]");
  const label = root.querySelector("[data-slide-plan-layout-label]");
  const publicationBadge = root.querySelector("[data-slide-plan-publication-status]");
  const overview = root.querySelector("[data-deck-overview]");
  const titleInput = root.querySelector("[data-slide-title-input]");
  const layoutSelect = root.querySelector("[data-slide-layout]");
  const status = root.querySelector("[data-slide-plan-status]");
  const exports = [...root.querySelectorAll("[data-slide-plan-export]")];
  const refineForm = root.querySelector("[data-slide-refine]");
  const refineInput = root.querySelector("[data-slide-refine-input]");
  const refineSubmit = root.querySelector("[data-slide-refine-submit]");
  const refineProposal = root.querySelector("[data-slide-refine-proposal]");
  const refineBefore = root.querySelector("[data-slide-refine-before]");
  const refineAfter = root.querySelector("[data-slide-refine-after]");
  const refineApply = root.querySelector("[data-slide-refine-apply]");
  const refineDismiss = root.querySelector("[data-slide-refine-dismiss]");
  if (!(titleInput instanceof HTMLInputElement) || !(layoutSelect instanceof HTMLSelectElement)) {
    throw new TypeError("SlidePlan editor controls are required");
  }

  let editor = null;
  let controller = null;
  let dirty = false;
  let busy = false;
  let exportHrefs = new Map();
  let geometries = new Map();
  let selection = null;
  let proposal = null;
  let refineHandler = null;
  let publicationStatus = "draft";
  let confirmedReviewContext = false;
  const syncAccessibleLabel = () => {
    const finalLabel = publicationStatus === "final" || (root.hidden && confirmedReviewContext);
    root.setAttribute("aria-label", finalLabel
      ? "편집 가능한 슬라이드 확정본" : "편집 가능한 슬라이드 초안");
    if (!editor && status) {
      status.textContent = finalLabel ? "저장된 확정본이 없습니다" : "저장된 초안이 없습니다";
    }
  };
  const canvasRoot = root.querySelector("[data-slide-plan-canvas]");
  const canvas = canvasRoot instanceof HTMLElement ? createSlidePlanCanvas({
    canvas: canvasRoot,
    onMove: ({ elementId, box }) => {
      const slide = activeSlide();
      if (slide) dispatchEdit({ type: "setBox", slideId: slide.id, elementId, box });
    },
    onMoveMany: (boxes) => {
      const slide = activeSlide();
      if (slide && boxes.length) dispatchEdit({ type: "setBoxes", slideId: slide.id, boxes });
    },
    onEditText: ({ path, text, claimIds }) => {
      const slide = activeSlide();
      if (slide) dispatchEdit({ type: "setText", slideId: slide.id, path, text, claimIds });
    },
    onSelect: (next) => {
      selection = next;
      syncRefine();
    },
  }) : null;

  const adaptedSlides = () => editor.deck.slides.map((slide) => ({
    ...slide, speakerNotes: slide.notes ?? "",
  }));

  const activeSlide = () => {
    const id = controller?.getState().activeSlideId;
    return editor?.deck.slides.find((slide) => slide.id === id) ?? null;
  };

  const hideProposal = () => {
    proposal = null;
    if (refineProposal instanceof HTMLElement) refineProposal.hidden = true;
  };

  const syncRefine = () => {
    const enabled = Boolean(selection && !busy && editor);
    if (refineInput instanceof HTMLInputElement) refineInput.disabled = !enabled;
    if (refineSubmit instanceof HTMLButtonElement) refineSubmit.disabled = !enabled;
    if (refineInput instanceof HTMLInputElement) {
      refineInput.placeholder = selection ? "더 짧게, 결정 문장으로" : "슬라이드에서 문구를 선택하세요";
    }
  };

  const showProposal = (next) => {
    if (!next || next.error) {
      hideProposal();
      if (status && next?.error) status.textContent = next.error;
      syncRefine();
      return;
    }
    proposal = next;
    if (refineBefore) refineBefore.textContent = next.before;
    if (refineAfter) refineAfter.textContent = next.after;
    if (refineProposal instanceof HTMLElement) refineProposal.hidden = false;
    syncRefine();
  };

  const syncExports = () => {
    for (const link of exports) {
      const href = exportHrefs.get(link);
      if (dirty || busy) {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        link.setAttribute("title", busy ? "슬라이드 저장 작업이 진행 중입니다" : "로컬 편집으로 내보내기가 오래되었습니다");
      } else {
        link.setAttribute("href", href);
        link.removeAttribute("aria-disabled");
        link.removeAttribute("title");
      }
    }
    onChange();
  };

  const render = () => {
    const slide = activeSlide();
    if (!slide) return;
    root.dataset.presenter = String(controller?.getState().presenterMode ?? false);
    title.textContent = slide.title;
    label.textContent = LAYOUT_LABELS[slide.layout] ?? slide.layout;
    paper.dataset.layout = slide.layout;
    const geometry = overlayGeometry(geometries.get(slide.id), slide);
    paper.dataset.canvas = geometry ? "true" : "false";
    canvas?.setGeometry(geometry);
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
    titleInput.disabled = busy;
    layoutSelect.disabled = busy;
    button("[data-deck-undo]", root).disabled = busy || editor.past.length === 0;
    button("[data-deck-redo]", root).disabled = busy || editor.future.length === 0;
    const lifecycle = publicationStatus === "final" ? "확정본" : "초안";
    status.textContent = busy ? "슬라이드를 저장하는 중…" : dirty
      ? `${lifecycle} · local revision ${editor.revision} · exports stale`
      : lifecycle;
    syncExports();
  };

  const dispatchEdit = (command) => {
    if (!editor || busy) return false;
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
    geometries = new Map();
    for (const slide of slidePlan.geometry ?? []) {
      if (slide && typeof slide.slideId === "string") geometries.set(slide.slideId, slide);
    }
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
    publicationStatus = slidePlan?.publicationStatus === "final" ? "final" : "draft";
    root.dataset.publicationStatus = publicationStatus;
    syncAccessibleLabel();
    if (publicationBadge instanceof HTMLElement) {
      publicationBadge.dataset.publicationStatus = publicationStatus;
      publicationBadge.textContent = publicationStatus === "final" ? "확정본" : "초안";
    }
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
    controller = createDeckStageController({ root, slides: adaptedSlides(), keyboardTarget: keyboardTarget ?? root,
      onChange: render });
    render();
    return true;
  };

  function clear() {
    controller?.destroy();
    controller = null;
    editor = null;
    geometries = new Map();
    canvas?.setGeometry(null);
    if (paper instanceof HTMLElement) paper.dataset.canvas = "false";
    selection = null;
    publicationStatus = "draft";
    confirmedReviewContext = false;
    delete root.dataset.publicationStatus;
    syncAccessibleLabel();
    if (publicationBadge instanceof HTMLElement) {
      delete publicationBadge.dataset.publicationStatus;
      publicationBadge.textContent = "";
    }
    hideProposal();
    dirty = false;
    root.hidden = true;
    fallback.hidden = false;
    fallback.style.removeProperty("display");
    syncExports();
    return false;
  }

  const setBusy = (value) => {
    busy = Boolean(value);
    if (editor) render();
    else syncExports();
    syncRefine();
  };

  refineForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const slide = activeSlide();
    const instruction = refineInput instanceof HTMLInputElement ? refineInput.value.trim() : "";
    if (!slide || !selection || !instruction || typeof refineHandler !== "function") return;
    refineHandler({
      slideId: slide.id,
      path: selection.path,
      text: selection.text,
      instruction,
      claimIds: selection.claimIds,
    });
  });
  refineApply?.addEventListener("click", () => {
    const slide = activeSlide();
    if (!slide || !proposal) return;
    dispatchEdit({
      type: "setText",
      slideId: slide.id,
      path: proposal.path,
      text: proposal.after,
      claimIds: proposal.claimIds ?? [],
    });
    hideProposal();
    if (refineInput instanceof HTMLInputElement) refineInput.value = "";
  });
  refineDismiss?.addEventListener("click", () => hideProposal());

  return Object.freeze({
    initialize, clear, setBusy,
    isActive: () => !root.hidden,
    isDirty: () => dirty,
    isBusy: () => busy,
    currentPlan: () => editor?.deck ?? null,
    currentPublicationStatus: () => editor ? publicationStatus : null,
    setConfirmedReviewContext: (value) => {
      confirmedReviewContext = Boolean(value);
      syncAccessibleLabel();
    },
    setRefineHandler: (handler) => { refineHandler = handler; },
    showProposal,
  });
}
