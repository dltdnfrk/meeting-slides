import {
  createDeckState,
  keyboardAction,
  projectDeckStage,
  reduceDeckState,
} from "./deck-stage.js";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MOVING_CLASS = "deck-stage--moving";

function defaultScheduleMotion(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 0);
}

function defaultCancelMotion(handle) {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

function findSlideOption(root, slideId) {
  if (slideId === null) return null;
  for (const option of root.querySelectorAll("[data-slide-id]")) {
    const id = option.getAttribute?.("data-slide-id") ?? option.dataset?.slideId ?? null;
    if (id === slideId) return option;
  }
  return null;
}

function closest(target, selector) {
  return target?.closest?.(selector) ?? null;
}

/**
 * Owns the event, focus, and reduced-motion lifecycle around the pure deck stage.
 * Dependencies are injectable so callers can bind a component root instead of
 * relying on document globals, and tests can drive every transition directly.
 *
 * @param {{
 *   root: any,
 *   slides: any,
 *   keyboardTarget?: any,
 *   matchMedia?: ((query: string) => any) | null,
 *   scheduleMotion?: (callback: () => void) => any,
 *   cancelMotion?: (handle: any) => void,
 *   onChange?: ((state: any, previous: any) => void) | null,
 * }} options
 */
export function createDeckStageController(options) {
  const {
    root,
    slides,
    keyboardTarget = root,
    matchMedia = typeof globalThis.matchMedia === "function"
      ? (query) => globalThis.matchMedia(query)
      : null,
    scheduleMotion = defaultScheduleMotion,
    cancelMotion = defaultCancelMotion,
    onChange = null,
  } = options ?? {};
  if (!root || typeof root.querySelector !== "function"
    || typeof root.querySelectorAll !== "function"
    || typeof root.addEventListener !== "function"
    || typeof root.removeEventListener !== "function") {
    throw new TypeError("root must be an event-capable deck stage root");
  }
  if (!keyboardTarget || typeof keyboardTarget.addEventListener !== "function"
    || typeof keyboardTarget.removeEventListener !== "function") {
    throw new TypeError("keyboardTarget must be an event target");
  }
  if (typeof scheduleMotion !== "function" || typeof cancelMotion !== "function") {
    throw new TypeError("motion scheduler dependencies must be functions");
  }

  let state = createDeckState(slides);
  let destroyed = false;
  let reducedMotion = false;
  let motionHandle = null;
  const stage = root.querySelector("[data-deck-stage]");
  if (stage && !stage.hasAttribute?.("tabindex")) stage.setAttribute("tabindex", "0");

  const stopMotion = () => {
    if (motionHandle !== null) {
      cancelMotion(motionHandle);
      motionHandle = null;
    }
    stage?.classList?.remove(MOVING_CLASS);
  };

  const beginMotion = () => {
    if (reducedMotion || !stage) return;
    stopMotion();
    stage.classList?.add(MOVING_CLASS);
    motionHandle = scheduleMotion(() => {
      motionHandle = null;
      stage.classList?.remove(MOVING_CLASS);
    });
  };

  const focusStage = () => stage?.focus?.({ preventScroll: true });
  const focusCurrentOption = () => findSlideOption(root, state.activeSlideId)?.focus?.({ preventScroll: true });

  const apply = (action) => {
    if (destroyed) return state;
    const previous = state;
    const next = reduceDeckState(previous, action);
    if (next === previous) return state;
    state = next;
    projectDeckStage(root, state);
    onChange?.(state, previous);

    if (!previous.overviewOpen && state.overviewOpen) {
      focusCurrentOption();
    } else if (previous.overviewOpen && !state.overviewOpen) {
      focusStage();
    } else if (previous.activeSlideId !== state.activeSlideId) {
      focusStage();
    }

    if (previous.activeSlideId !== state.activeSlideId) beginMotion();
    return state;
  };

  const onKeyDown = (event) => {
    const overviewEscape = state.overviewOpen
      && event?.key === "Escape"
      && closest(event.target, "[data-slide-id]");
    const action = overviewEscape ? { type: "closeOverview" } : keyboardAction(event);
    if (!action) return;
    event.preventDefault?.();
    apply(action);
  };

  const onClick = (event) => {
    const target = event.target;
    const option = closest(target, "[data-slide-id]");
    if (option) {
      const slideId = option.getAttribute?.("data-slide-id") ?? option.dataset?.slideId ?? null;
      apply({ type: "selectOverviewSlide", slideId });
      return;
    }
    if (closest(target, "[data-deck-previous]")) {
      apply({ type: "previous" });
      return;
    }
    if (closest(target, "[data-deck-next]")) {
      apply({ type: "next" });
      return;
    }
    if (closest(target, "[data-deck-overview-toggle]")) {
      apply({ type: "toggleOverview" });
      return;
    }
    if (closest(target, "[data-presenter-toggle]")) {
      apply({ type: "togglePresenter" });
      return;
    }
    if (closest(target, "[data-speaker-notes-toggle]")) {
      apply({ type: "toggleSpeakerNotes" });
    }
  };

  let mediaQuery = null;
  let removeMediaListener = null;
  const setReducedMotion = (matches) => {
    reducedMotion = Boolean(matches);
    if (reducedMotion) {
      root.setAttribute("data-reduced-motion", "true");
      stopMotion();
    } else {
      root.removeAttribute("data-reduced-motion");
    }
  };
  const onMediaChange = (event) => setReducedMotion(event?.matches ?? mediaQuery?.matches);

  projectDeckStage(root, state);
  root.addEventListener("click", onClick);
  keyboardTarget.addEventListener("keydown", onKeyDown);

  if (typeof matchMedia === "function") {
    mediaQuery = matchMedia(REDUCED_MOTION_QUERY);
    if (mediaQuery && typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onMediaChange);
      removeMediaListener = () => mediaQuery.removeEventListener("change", onMediaChange);
    } else if (mediaQuery && typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onMediaChange);
      removeMediaListener = () => mediaQuery.removeListener(onMediaChange);
    }
    setReducedMotion(mediaQuery?.matches ?? false);
  } else {
    setReducedMotion(false);
  }

  return Object.freeze({
    getState: () => state,
    getReducedMotion: () => reducedMotion,
    dispatch: apply,
    setSlides(nextSlides) {
      return apply({ type: "setSlides", slides: nextSlides });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener("click", onClick);
      keyboardTarget.removeEventListener("keydown", onKeyDown);
      removeMediaListener?.();
      removeMediaListener = null;
      stopMotion();
      root.removeAttribute("data-reduced-motion");
    },
  });
}
