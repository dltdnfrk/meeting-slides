import { describe, expect, test } from "bun:test";

import { createDeckStageController } from "../public/deck-stage-controller.js";

const SLIDES = [
  { id: "opening", title: "Opening", speakerNotes: "Welcome." },
  { id: "decision", title: "Decision", speakerNotes: "Pause." },
  { id: "close", title: "Close", speakerNotes: "Confirm." },
] as const;

type Listener = (event: FakeEvent) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(event: FakeEvent) {
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeClassList {
  private readonly values = new Set<string>();
  add(value: string) { this.values.add(value); }
  remove(value: string) { this.values.delete(value); }
  contains(value: string) { return this.values.has(value); }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
}

class FakeElement {
  textContent = "";
  hidden = false;
  isContentEditable = false;
  readonly attributes = new Map<string, string>();
  readonly classList = new FakeClassList();

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName = "DIV",
    attributes: Record<string, string> = {},
    readonly editableAncestor = false,
  ) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  focus() { this.ownerDocument.activeElement = this; }
  closest(selector: string) {
    if (selector === "[contenteditable]") return this.editableAncestor ? this : null;
    const match = /^\[([^\]]+)\]$/.exec(selector);
    return match && this.hasAttribute(match[1]!) ? this : null;
  }
}

class FakeDeckRoot extends FakeEventTarget {
  readonly document = new FakeDocument();
  readonly stage = new FakeElement(this.document, "DIV", { "data-deck-stage": "", tabindex: "0" });
  readonly overviewToggle = new FakeElement(this.document, "BUTTON", { "data-deck-overview-toggle": "" });
  readonly overview = new FakeElement(this.document, "DIV", { "data-deck-overview": "" });
  readonly presenterToggle = new FakeElement(this.document, "BUTTON", { "data-presenter-toggle": "" });
  readonly notesToggle = new FakeElement(this.document, "BUTTON", { "data-speaker-notes-toggle": "" });
  readonly speakerNotes = new FakeElement(this.document, "DIV", { "data-speaker-notes": "" });
  readonly slideCounter = new FakeElement(this.document, "DIV", { "data-slide-counter": "" });
  readonly options: FakeElement[];
  readonly attributes = new Map<string, string>();

  constructor(slides: readonly { id: string }[] = SLIDES) {
    super();
    this.options = slides.map((slide) => new FakeElement(
      this.document,
      "BUTTON",
      { "data-slide-id": slide.id },
    ));
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }

  querySelector(selector: string) {
    const fixed = ({
      "[data-deck-stage]": this.stage,
      "[data-deck-overview-toggle]": this.overviewToggle,
      "[data-deck-overview]": this.overview,
      "[data-presenter-toggle]": this.presenterToggle,
      "[data-speaker-notes-toggle]": this.notesToggle,
      "[data-speaker-notes]": this.speakerNotes,
      "[data-slide-counter]": this.slideCounter,
    } as Record<string, FakeElement>)[selector];
    if (fixed) return fixed;
    const slideId = /^\[data-slide-id="(.+)"\]$/.exec(selector)?.[1];
    return slideId === undefined
      ? null
      : this.options.find((option) => option.getAttribute("data-slide-id") === slideId) ?? null;
  }

  querySelectorAll(selector: string) {
    return selector === "[data-slide-id]" ? this.options : [];
  }
}

class FakeMediaQueryList extends FakeEventTarget {
  constructor(public matches: boolean) { super(); }
  change(matches: boolean) {
    this.matches = matches;
    this.dispatch(new FakeEvent("change", this, { matches }));
  }
}

class FakeEvent {
  currentTarget: unknown = null;
  defaultPrevented = false;
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly matches?: boolean;

  constructor(
    readonly type: string,
    readonly target: unknown,
    values: Partial<Pick<FakeEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "matches">> = {},
  ) {
    this.key = values.key ?? "";
    this.altKey = values.altKey ?? false;
    this.ctrlKey = values.ctrlKey ?? false;
    this.metaKey = values.metaKey ?? false;
    this.matches = values.matches;
  }

  preventDefault() { this.defaultPrevented = true; }
}

function key(target: unknown, value: string) {
  return new FakeEvent("keydown", target, { key: value });
}

function click(target: unknown) {
  return new FakeEvent("click", target);
}

function setup(options: { reduced?: boolean; slides?: readonly { id: string; title?: string; speakerNotes?: string }[] } = {}) {
  const slides = options.slides ?? SLIDES;
  const root = new FakeDeckRoot(slides);
  const keyboardTarget = new FakeEventTarget();
  const media = new FakeMediaQueryList(options.reduced ?? false);
  let nextMotionId = 0;
  const scheduled = new Map<number, () => void>();
  const cancelled: number[] = [];
  const controller = createDeckStageController({
    root,
    slides,
    keyboardTarget,
    matchMedia(query: string) {
      expect(query).toBe("(prefers-reduced-motion: reduce)");
      return media;
    },
    scheduleMotion(callback: () => void) {
      const id = ++nextMotionId;
      scheduled.set(id, callback);
      return id;
    },
    cancelMotion(id: number) {
      cancelled.push(id);
      scheduled.delete(id);
    },
  });
  return { root, keyboardTarget, media, scheduled, cancelled, controller };
}

describe("deck stage focus and keyboard lifecycle", () => {
  test("opens overview onto the current option, then selection and Escape restore stage focus", () => {
    const { root, keyboardTarget, controller } = setup();
    root.stage.focus();

    const next = key(root.stage, "ArrowRight");
    keyboardTarget.dispatch(next);
    expect(next.defaultPrevented).toBe(true);
    expect(controller.getState().activeSlideId).toBe("decision");
    expect(root.document.activeElement).toBe(root.stage);

    const open = key(root.stage, "o");
    keyboardTarget.dispatch(open);
    expect(controller.getState().overviewOpen).toBe(true);
    expect(root.document.activeElement).toBe(root.options[1]);

    root.dispatch(click(root.options[2]));
    expect(controller.getState()).toMatchObject({ activeSlideId: "close", overviewOpen: false });
    expect(root.document.activeElement).toBe(root.stage);

    root.dispatch(click(root.overviewToggle));
    expect(root.document.activeElement).toBe(root.options[2]);
    const escape = key(root.options[2], "Escape");
    keyboardTarget.dispatch(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(controller.getState().overviewOpen).toBe(false);
    expect(root.document.activeElement).toBe(root.stage);
  });

  test("ignores commands from every editable or interactive target", () => {
    const { root, keyboardTarget, controller } = setup();
    const targets = [
      new FakeElement(root.document, "INPUT"),
      new FakeElement(root.document, "TEXTAREA"),
      new FakeElement(root.document, "SELECT"),
      new FakeElement(root.document, "BUTTON"),
      Object.assign(new FakeElement(root.document), { isContentEditable: true }),
      new FakeElement(root.document, "SPAN", {}, true),
    ];

    for (const target of targets) {
      keyboardTarget.dispatch(key(target, "ArrowRight"));
      keyboardTarget.dispatch(key(target, "o"));
    }
    expect(controller.getState()).toMatchObject({ activeSlideId: "opening", overviewOpen: false });
  });

  test("next and previous navigation retain the stage as a visible focus target", () => {
    const { root, keyboardTarget, controller } = setup();
    root.overviewToggle.focus();

    keyboardTarget.dispatch(key(root.stage, "ArrowRight"));
    expect(root.document.activeElement).toBe(root.stage);
    expect(controller.getState().activeSlideId).toBe("decision");

    keyboardTarget.dispatch(key(root.stage, "ArrowLeft"));
    expect(root.document.activeElement).toBe(root.stage);
    expect(controller.getState().activeSlideId).toBe("opening");
  });

  test("presenter and notes controls project their exact ARIA state", () => {
    const { root, controller } = setup();
    expect(root.presenterToggle.getAttribute("aria-pressed")).toBe("false");
    expect(root.notesToggle.getAttribute("aria-expanded")).toBe("false");

    root.dispatch(click(root.presenterToggle));
    expect(controller.getState().presenterMode).toBe(true);
    expect(root.presenterToggle.getAttribute("aria-pressed")).toBe("true");
    root.dispatch(click(root.notesToggle));
    expect(controller.getState().speakerNotesVisible).toBe(true);
    expect(root.notesToggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.speakerNotes.getAttribute("aria-hidden")).toBe("false");

    root.dispatch(click(root.presenterToggle));
    expect(controller.getState()).toMatchObject({ presenterMode: false, speakerNotesVisible: false });
    expect(root.presenterToggle.getAttribute("aria-pressed")).toBe("false");
    expect(root.notesToggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.speakerNotes.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("deck stage reduced motion and cleanup", () => {
  test("tracks media changes with a stable DOM attribute and never schedules motion while reduced", () => {
    const { root, keyboardTarget, media, scheduled, cancelled, controller } = setup({ reduced: true });
    expect(controller.getReducedMotion()).toBe(true);
    expect(root.getAttribute("data-reduced-motion")).toBe("true");

    keyboardTarget.dispatch(key(root.stage, "ArrowRight"));
    expect(controller.getState().activeSlideId).toBe("decision");
    expect(scheduled.size).toBe(0);
    expect(root.stage.classList.contains("deck-stage--moving")).toBe(false);

    media.change(false);
    expect(controller.getReducedMotion()).toBe(false);
    expect(root.getAttribute("data-reduced-motion")).toBeNull();
    keyboardTarget.dispatch(key(root.stage, "ArrowRight"));
    expect(scheduled.size).toBe(1);
    expect(root.stage.classList.contains("deck-stage--moving")).toBe(true);

    media.change(true);
    expect(cancelled).toEqual([1]);
    expect(scheduled.size).toBe(0);
    expect(root.stage.classList.contains("deck-stage--moving")).toBe(false);
    expect(root.getAttribute("data-reduced-motion")).toBe("true");
  });

  test("cleanup removes keyboard, click, media, and pending motion subscriptions", () => {
    const { root, keyboardTarget, media, scheduled, cancelled, controller } = setup();
    expect(root.listenerCount("click")).toBe(1);
    expect(keyboardTarget.listenerCount("keydown")).toBe(1);
    expect(media.listenerCount("change")).toBe(1);

    keyboardTarget.dispatch(key(root.stage, "ArrowRight"));
    expect(scheduled.size).toBe(1);
    controller.destroy();
    controller.destroy();

    expect(root.listenerCount("click")).toBe(0);
    expect(keyboardTarget.listenerCount("keydown")).toBe(0);
    expect(media.listenerCount("change")).toBe(0);
    expect(cancelled).toEqual([1]);
    expect(root.getAttribute("data-reduced-motion")).toBeNull();
    const state = controller.getState();
    keyboardTarget.dispatch(key(root.stage, "ArrowRight"));
    root.dispatch(click(root.presenterToggle));
    media.change(true);
    expect(controller.getState()).toBe(state);
  });

  test("empty decks are inert and malformed boundaries fail synchronously", () => {
    const { root, keyboardTarget, scheduled, controller } = setup({ slides: [] });
    expect(controller.getState().activeSlideId).toBeNull();
    expect(root.stage.getAttribute("aria-label")).toBe("No slides");

    keyboardTarget.dispatch(key(root.stage, "ArrowRight"));
    root.dispatch(click(root.overviewToggle));
    expect(controller.getState().activeSlideId).toBeNull();
    expect(scheduled.size).toBe(0);
    expect(root.document.activeElement).toBeNull();
    controller.destroy();

    expect(() => createDeckStageController({ root: null, slides: [] })).toThrow(TypeError);
    expect(() => createDeckStageController({ root: new FakeDeckRoot(), slides: null })).toThrow(TypeError);
  });
});
