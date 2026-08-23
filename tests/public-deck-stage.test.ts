import { describe, expect, test } from "bun:test";

import {
  createDeckState,
  deckStageProjection,
  keyboardAction,
  projectDeckStage,
  reduceDeckState,
} from "../public/deck-stage.js";

const SLIDES = [
  { id: "opening", title: "Opening", speakerNotes: "Welcome the room." },
  { id: "decision", title: "Decision", speakerNotes: "Pause for questions." },
  { id: "close", title: "Close", speakerNotes: "Confirm the owner." },
] as const;

const act = (state: ReturnType<typeof createDeckState>, type: string, extra = {}) =>
  reduceDeckState(state, { type, ...extra });

function moveToDecision() {
  return act(createDeckState(SLIDES), "goTo", { slideId: "decision" });
}

describe("deck stage state", () => {
  test("creation is deterministic, copies stable slide IDs, and deeply freezes its state", () => {
    const input = SLIDES.map((slide) => ({ ...slide }));
    const first = createDeckState(input);
    const second = createDeckState(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).toEqual({
      slides: SLIDES,
      activeSlideId: "opening",
      overviewOpen: false,
      presenterMode: false,
      speakerNotesVisible: false,
    });
    expect(first.slides).not.toBe(input);
    expect(first.slides[0]).not.toBe(input[0]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.slides)).toBe(true);
    expect(first.slides.every(Object.isFrozen)).toBe(true);
    expect(() => createDeckState([{ id: "same" }, { id: "same" }])).toThrow();
  });

  test("an empty deck has no active slide and every deck action is a no-op", () => {
    const empty = createDeckState([]);
    const actions = [
      { type: "next" },
      { type: "previous" },
      { type: "goTo", slideId: "missing" },
      { type: "home" },
      { type: "end" },
      { type: "toggleOverview" },
      { type: "openOverview" },
      { type: "closeOverview" },
      { type: "selectOverviewSlide", slideId: "missing" },
      { type: "togglePresenter" },
      { type: "toggleSpeakerNotes" },
    ];

    expect(empty.activeSlideId).toBeNull();
    for (const action of actions) expect(reduceDeckState(empty, action)).toBe(empty);
    expect(deckStageProjection(empty)).toMatchObject({
      activeIndex: -1,
      slideCount: 0,
      slideCounter: "0 / 0",
    });
  });

  test("next, previous, direct navigation, home, and end clamp to the deck", () => {
    const initial = createDeckState(SLIDES);
    const second = act(initial, "next");
    const last = act(second, "end");

    expect(second.activeSlideId).toBe("decision");
    expect(act(second, "previous").activeSlideId).toBe("opening");
    expect(act(second, "goTo", { slideId: "close" }).activeSlideId).toBe("close");
    expect(act(last, "next")).toBe(last);
    expect(act(last, "home").activeSlideId).toBe("opening");
    expect(act(initial, "previous")).toBe(initial);
    expect(act(initial, "goTo", { slideId: "missing" })).toBe(initial);
  });

  test("overview opens and closes independently; grid selection navigates and closes it", () => {
    const initial = createDeckState(SLIDES);
    const open = act(initial, "openOverview");
    const selected = act(open, "selectOverviewSlide", { slideId: "close" });

    expect(open.overviewOpen).toBe(true);
    expect(act(open, "openOverview")).toBe(open);
    expect(selected.activeSlideId).toBe("close");
    expect(selected.overviewOpen).toBe(false);
    expect(act(selected, "closeOverview")).toBe(selected);
    expect(act(selected, "toggleOverview").overviewOpen).toBe(true);
  });

  test("presenter mode owns speaker-note visibility and exposes a stable slide counter", () => {
    const presenting = act(moveToDecision(), "togglePresenter");
    const notesShown = act(presenting, "toggleSpeakerNotes");

    expect(presenting.presenterMode).toBe(true);
    expect(presenting.speakerNotesVisible).toBe(false);
    expect(notesShown.speakerNotesVisible).toBe(true);
    expect(deckStageProjection(notesShown)).toMatchObject({
      activeSlideId: "decision",
      activeIndex: 1,
      slideCount: 3,
      slideCounter: "2 / 3",
      speakerNotes: "Pause for questions.",
    });

    const leftPresenter = act(notesShown, "togglePresenter");
    const notPresenting = moveToDecision();
    expect(leftPresenter.presenterMode).toBe(false);
    expect(leftPresenter.speakerNotesVisible).toBe(false);
    expect(act(notPresenting, "toggleSpeakerNotes")).toBe(notPresenting);
  });

  test("slide updates preserve the active slide by ID across reorder and replace slide data", () => {
    const current = moveToDecision();
    const reordered = act(current, "setSlides", {
      slides: [
        { id: "close", title: "Close" },
        { id: "decision", title: "Updated decision", speakerNotes: "Updated note." },
        { id: "opening", title: "Opening" },
      ],
    });

    expect(reordered.activeSlideId).toBe("decision");
    expect(deckStageProjection(reordered)).toMatchObject({
      activeIndex: 1,
      activeSlide: { id: "decision", title: "Updated decision", speakerNotes: "Updated note." },
    });
    expect(current.slides[1]?.title).toBe("Decision");
  });

  test("a removed active slide falls back to its clamped prior position deterministically", () => {
    const current = moveToDecision();
    const removed = act(current, "setSlides", {
      slides: [
        { id: "opening", title: "Opening" },
        { id: "close", title: "Close" },
      ],
    });
    const removedAtEnd = act(act(createDeckState(SLIDES), "end"), "setSlides", {
      slides: [{ id: "opening", title: "Opening" }],
    });
    const emptied = act(current, "setSlides", { slides: [] });

    expect(removed.activeSlideId).toBe("close");
    expect(removedAtEnd.activeSlideId).toBe("opening");
    expect(emptied).toEqual(createDeckState([]));
  });
});

type KeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

function key(
  value: string,
  target: KeyTarget = { tagName: "DIV", isContentEditable: false, closest: () => null },
  modifiers: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {},
) {
  return keyboardAction({
    key: value,
    target,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  });
}

describe("deck stage keyboard mapping", () => {
  test("maps unmodified deck keys to explicit reducer actions", () => {
    expect([
      key("ArrowRight"), key("ArrowDown"), key("PageDown"),
      key("ArrowLeft"), key("ArrowUp"), key("PageUp"),
      key("Home"), key("End"), key("Escape"), key("o"), key("O"), key("p"), key("n"),
    ]).toEqual([
      { type: "next" }, { type: "next" }, { type: "next" },
      { type: "previous" }, { type: "previous" }, { type: "previous" },
      { type: "home" }, { type: "end" }, { type: "closeOverview" },
      { type: "toggleOverview" }, { type: "toggleOverview" },
      { type: "togglePresenter" }, { type: "toggleSpeakerNotes" },
    ]);
  });

  test("does not steal keys from form controls or editable descendants", () => {
    const targets: KeyTarget[] = [
      { tagName: "INPUT", closest: () => null },
      { tagName: "TEXTAREA", closest: () => null },
      { tagName: "SELECT", closest: () => null },
      { tagName: "DIV", isContentEditable: true, closest: () => null },
      { tagName: "SPAN", closest: (selector) => selector === "[contenteditable]" ? {} : null },
    ];

    for (const target of targets) {
      expect(key("ArrowRight", target)).toBeNull();
      expect(key("o", target)).toBeNull();
    }
  });

  test("ignores modified and unrelated shortcuts", () => {
    expect(key("ArrowRight", undefined, { altKey: true })).toBeNull();
    expect(key("p", undefined, { ctrlKey: true })).toBeNull();
    expect(key("n", undefined, { metaKey: true })).toBeNull();
    expect(key("Enter")).toBeNull();
  });
});

class FakeElement {
  textContent = "";
  hidden = false;
  readonly attributes = new Map<string, string>();

  constructor(readonly slideId?: string) {}

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDeckRoot {
  readonly stage = new FakeElement();
  readonly overviewToggle = new FakeElement();
  readonly overview = new FakeElement();
  readonly presenterToggle = new FakeElement();
  readonly notesToggle = new FakeElement();
  readonly speakerNotes = new FakeElement();
  readonly slideCounter = new FakeElement();
  readonly options = SLIDES.map((slide) => new FakeElement(slide.id));

  querySelector(selector: string) {
    return ({
      "[data-deck-stage]": this.stage,
      "[data-deck-overview-toggle]": this.overviewToggle,
      "[data-deck-overview]": this.overview,
      "[data-presenter-toggle]": this.presenterToggle,
      "[data-speaker-notes-toggle]": this.notesToggle,
      "[data-speaker-notes]": this.speakerNotes,
      "[data-slide-counter]": this.slideCounter,
    } as Record<string, FakeElement>)[selector] ?? null;
  }

  querySelectorAll(selector: string) {
    return selector === "[data-slide-id]" ? this.options : [];
  }
}

describe("deck stage DOM projector", () => {
  test("projects current/selected/expanded ARIA state, notes, and the slide counter", () => {
    const root = new FakeDeckRoot();
    const state = act(
      act(act(act(createDeckState(SLIDES), "goTo", { slideId: "decision" }), "openOverview"), "togglePresenter"),
      "toggleSpeakerNotes",
    );

    projectDeckStage(root, state);

    expect(root.stage.getAttribute("aria-current")).toBe("true");
    expect(root.stage.getAttribute("aria-label")).toBe("Slide 2 of 3");
    expect(root.overviewToggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.overview.hidden).toBe(false);
    expect(root.options.map((option) => ({
      id: option.slideId,
      current: option.getAttribute("aria-current"),
      selected: option.getAttribute("aria-selected"),
      label: option.getAttribute("aria-label"),
    }))).toEqual([
      { id: "opening", current: null, selected: "false", label: "Slide 1 of 3" },
      { id: "decision", current: "true", selected: "true", label: "Slide 2 of 3" },
      { id: "close", current: null, selected: "false", label: "Slide 3 of 3" },
    ]);
    expect(root.presenterToggle.getAttribute("aria-pressed")).toBe("true");
    expect(root.notesToggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.speakerNotes.hidden).toBe(false);
    expect(root.speakerNotes.getAttribute("aria-hidden")).toBe("false");
    expect(root.speakerNotes.textContent).toBe("Pause for questions.");
    expect(root.slideCounter.textContent).toBe("2 / 3");
    expect(root.slideCounter.getAttribute("aria-label")).toBe("Slide 2 of 3");
  });

  test("reprojection removes stale current state and hides overview and notes", () => {
    const root = new FakeDeckRoot();
    const selected = root.options[1]!;
    selected.setAttribute("aria-current", "true");
    selected.setAttribute("aria-selected", "true");

    projectDeckStage(root, createDeckState(SLIDES));

    expect(root.overviewToggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.overview.hidden).toBe(true);
    expect(root.options[0]?.getAttribute("aria-current")).toBe("true");
    expect(root.options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(selected.getAttribute("aria-current")).toBeNull();
    expect(selected.getAttribute("aria-selected")).toBe("false");
    expect(root.presenterToggle.getAttribute("aria-pressed")).toBe("false");
    expect(root.notesToggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.speakerNotes.hidden).toBe(true);
    expect(root.speakerNotes.getAttribute("aria-hidden")).toBe("true");
  });
});
