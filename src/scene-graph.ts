export type SlideIntent =
  | "cover"
  | "statement"
  | "comparison"
  | "timeline"
  | "decision"
  | "actions"
  | "quote"
  | "closing";

interface NarrativeBase {
  readonly intent: SlideIntent;
  readonly title: string;
}

export interface NarrativeCover extends NarrativeBase {
  readonly intent: "cover";
  readonly subtitle?: string;
}

export interface NarrativeStatement extends NarrativeBase {
  readonly intent: "statement";
  readonly statement: string;
  readonly support?: string;
}

export interface NarrativeComparison extends NarrativeBase {
  readonly intent: "comparison";
  readonly left: { readonly label: string; readonly text: string };
  readonly right: { readonly label: string; readonly text: string };
}

export interface NarrativeTimeline extends NarrativeBase {
  readonly intent: "timeline";
  readonly events: ReadonlyArray<{ readonly label: string; readonly text: string }>;
}

export interface NarrativeDecision extends NarrativeBase {
  readonly intent: "decision";
  readonly decision: string;
  readonly rationale?: string;
}

export interface NarrativeActions extends NarrativeBase {
  readonly intent: "actions";
  readonly items: ReadonlyArray<{
    readonly task: string;
    readonly owner?: string;
    readonly due?: string;
  }>;
}

export interface NarrativeQuote extends NarrativeBase {
  readonly intent: "quote";
  readonly quote: string;
  readonly attribution?: string;
}

export interface NarrativeClosing extends NarrativeBase {
  readonly intent: "closing";
  readonly statement?: string;
}

export type NarrativeSlide =
  | NarrativeCover
  | NarrativeStatement
  | NarrativeComparison
  | NarrativeTimeline
  | NarrativeDecision
  | NarrativeActions
  | NarrativeQuote
  | NarrativeClosing;

export interface NarrativeDeck {
  readonly meetingId: number;
  readonly title: string;
  readonly slides: readonly NarrativeSlide[];
}

export interface SceneFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SceneTextElement extends SceneFrame {
  readonly type: "text";
  readonly role: "label" | "title" | "statement" | "body" | "meta" | "quote";
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  readonly weight?: "regular" | "semibold" | "bold";
  readonly align?: "left" | "center" | "right";
}

export interface SceneShapeElement extends SceneFrame {
  readonly type: "shape";
  readonly shape: "rect" | "ellipse" | "line";
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export type SceneElement = SceneTextElement | SceneShapeElement;

export interface SceneSlide {
  readonly id: string;
  readonly intent: SlideIntent;
  readonly background: string;
  readonly elements: readonly SceneElement[];
  readonly notes?: string;
}

export interface SceneDeck {
  readonly meetingId: number;
  readonly title: string;
  readonly width: 100;
  readonly height: 56.25;
  readonly slides: readonly SceneSlide[];
}

const PAPER = "F6F1E8";
const INK = "14213D";
const MUTED = "5B6475";
const CORAL = "AD4B2F";
const RULE = "D9D2C4";
const RAISED = "FFFDF8";

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function rejectLegacyBullets(value: unknown, path = "deck"): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectLegacyBullets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "bullets") throw new Error(`${path}.bullets is a removed legacy field`);
    rejectLegacyBullets(child, `${path}.${key}`);
  }
}

function parseSlide(value: unknown, index: number): NarrativeSlide {
  const slide = object(value, `slides[${index}]`);
  const intent = string(slide.intent, `slides[${index}].intent`) as SlideIntent;
  const title = string(slide.title, `slides[${index}].title`);
  switch (intent) {
    case "cover":
      return { intent, title, ...(optionalString(slide.subtitle, `slides[${index}].subtitle`) ? { subtitle: optionalString(slide.subtitle, `slides[${index}].subtitle`) } : {}) };
    case "statement":
      return { intent, title, statement: string(slide.statement, `slides[${index}].statement`), ...(optionalString(slide.support, `slides[${index}].support`) ? { support: optionalString(slide.support, `slides[${index}].support`) } : {}) };
    case "comparison": {
      const left = object(slide.left, `slides[${index}].left`);
      const right = object(slide.right, `slides[${index}].right`);
      return { intent, title, left: { label: string(left.label, `slides[${index}].left.label`), text: string(left.text, `slides[${index}].left.text`) }, right: { label: string(right.label, `slides[${index}].right.label`), text: string(right.text, `slides[${index}].right.text`) } };
    }
    case "timeline": {
      if (!Array.isArray(slide.events) || slide.events.length === 0) throw new Error(`slides[${index}].events must be non-empty`);
      return { intent, title, events: slide.events.map((event, eventIndex) => {
        const item = object(event, `slides[${index}].events[${eventIndex}]`);
        return { label: string(item.label, `slides[${index}].events[${eventIndex}].label`), text: string(item.text, `slides[${index}].events[${eventIndex}].text`) };
      }) };
    }
    case "decision":
      return { intent, title, decision: string(slide.decision, `slides[${index}].decision`), ...(optionalString(slide.rationale, `slides[${index}].rationale`) ? { rationale: optionalString(slide.rationale, `slides[${index}].rationale`) } : {}) };
    case "actions": {
      if (!Array.isArray(slide.items) || slide.items.length === 0) throw new Error(`slides[${index}].items must be non-empty`);
      return { intent, title, items: slide.items.map((entry, itemIndex) => {
        const item = object(entry, `slides[${index}].items[${itemIndex}]`);
        return { task: string(item.task, `slides[${index}].items[${itemIndex}].task`), ...(optionalString(item.owner, `slides[${index}].items[${itemIndex}].owner`) ? { owner: optionalString(item.owner, `slides[${index}].items[${itemIndex}].owner`) } : {}), ...(optionalString(item.due, `slides[${index}].items[${itemIndex}].due`) ? { due: optionalString(item.due, `slides[${index}].items[${itemIndex}].due`) } : {}) };
      }) };
    }
    case "quote":
      return { intent, title, quote: string(slide.quote, `slides[${index}].quote`), ...(optionalString(slide.attribution, `slides[${index}].attribution`) ? { attribution: optionalString(slide.attribution, `slides[${index}].attribution`) } : {}) };
    case "closing":
      return { intent, title, ...(optionalString(slide.statement, `slides[${index}].statement`) ? { statement: optionalString(slide.statement, `slides[${index}].statement`) } : {}) };
    default:
      throw new Error(`slides[${index}].intent is unsupported: ${intent}`);
  }
}

export function parseNarrativeDeck(value: unknown): NarrativeDeck {
  rejectLegacyBullets(value);
  const deck = object(value, "deck");
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) throw new Error("deck.slides must be non-empty");
  return {
    meetingId: typeof deck.meetingId === "number" ? deck.meetingId : (() => { throw new Error("deck.meetingId must be a number"); })(),
    title: string(deck.title, "deck.title"),
    slides: deck.slides.map(parseSlide),
  };
}

const text = (role: SceneTextElement["role"], value: string, frame: SceneFrame, fontSize: number, color = INK, weight: SceneTextElement["weight"] = "regular"): SceneTextElement => ({ type: "text", role, text: value, ...frame, fontSize, color, weight });
const shape = (kind: SceneShapeElement["shape"], frame: SceneFrame, options: Pick<SceneShapeElement, "fill" | "stroke" | "strokeWidth"> = {}): SceneShapeElement => ({ type: "shape", shape: kind, ...frame, ...options });

function composeSlide(slide: NarrativeSlide, index: number): SceneSlide {
  const base = [text("label", String(index + 1).padStart(2, "0"), { x: 6, y: 5, w: 10, h: 4 }, 11, CORAL, "semibold")];
  const title = text("title", slide.title, { x: 6, y: 11, w: 84, h: 10 }, 28, INK, "bold");
  let elements: SceneElement[];
  switch (slide.intent) {
    case "cover":
      elements = [
        ...base,
        text("title", slide.title, { x: 6, y: 18, w: 82, h: 18 }, 38, INK, "bold"),
        ...(slide.subtitle ? [text("meta", slide.subtitle, { x: 6, y: 39, w: 72, h: 6 }, 16, MUTED)] : []),
        shape("line", { x: 6, y: 49, w: 88, h: 0 }, { stroke: CORAL, strokeWidth: 2 }),
      ];
      break;
    case "statement":
      elements = [...base, title, shape("rect", { x: 6, y: 26, w: 88, h: 19 }, { fill: RAISED, stroke: RULE, strokeWidth: 1 }), text("statement", slide.statement, { x: 10, y: 29, w: 80, h: 10 }, 25, INK, "semibold"), ...(slide.support ? [text("body", slide.support, { x: 10, y: 41, w: 78, h: 6 }, 14, MUTED)] : [])];
      break;
    case "comparison":
      elements = [...base, title, shape("rect", { x: 6, y: 25, w: 41, h: 23 }, { fill: RAISED, stroke: RULE, strokeWidth: 1 }), shape("rect", { x: 53, y: 25, w: 41, h: 23 }, { fill: RAISED, stroke: RULE, strokeWidth: 1 }), text("label", slide.left.label, { x: 9, y: 28, w: 34, h: 4 }, 12, CORAL, "bold"), text("body", slide.left.text, { x: 9, y: 34, w: 34, h: 10 }, 21, INK, "semibold"), text("label", slide.right.label, { x: 56, y: 28, w: 34, h: 4 }, 12, CORAL, "bold"), text("body", slide.right.text, { x: 56, y: 34, w: 34, h: 10 }, 21, INK, "semibold")];
      break;
    case "timeline": {
      const width = 84 / Math.max(1, slide.events.length);
      elements = [...base, title, shape("line", { x: 9, y: 34, w: 82, h: 0 }, { stroke: RULE, strokeWidth: 2 }), ...slide.events.flatMap((event, eventIndex) => {
        const x = 8 + eventIndex * width;
        return [shape("ellipse", { x, y: 31.8, w: 3.8, h: 3.8 }, { fill: eventIndex === slide.events.length - 1 ? CORAL : INK }), text("label", event.label, { x: x - 2, y: 25, w: width, h: 4 }, 11, CORAL, "bold"), text("body", event.text, { x: x - 2, y: 37, w: Math.max(12, width - 2), h: 9 }, 13, INK)];
      })];
      break;
    }
    case "decision":
      elements = [...base, title, shape("rect", { x: 6, y: 26, w: 88, h: 20 }, { fill: RAISED, stroke: CORAL, strokeWidth: 2 }), text("label", "결정 사항", { x: 10, y: 29, w: 20, h: 4 }, 11, CORAL, "bold"), text("statement", slide.decision, { x: 10, y: 34, w: 78, h: 8 }, 24, INK, "semibold"), ...(slide.rationale ? [text("body", slide.rationale, { x: 10, y: 44, w: 78, h: 5 }, 13, MUTED)] : [])];
      break;
    case "actions":
      elements = [...base, title, ...slide.items.slice(0, 4).flatMap((item, itemIndex) => {
        const y = 25 + itemIndex * 7;
        return [shape("line", { x: 6, y, w: 88, h: 0 }, { stroke: RULE, strokeWidth: 1 }), text("label", String(itemIndex + 1).padStart(2, "0"), { x: 7, y: y + 1, w: 6, h: 4 }, 11, CORAL, "bold"), text("body", item.task, { x: 15, y: y + 1, w: 55, h: 5 }, 16, INK, "semibold"), text("meta", [item.owner, item.due].filter(Boolean).join(" · "), { x: 72, y: y + 1, w: 20, h: 5 }, 11, MUTED, "regular")];
      })];
      break;
    case "quote":
      elements = [...base, title, text("quote", `“${slide.quote}”`, { x: 12, y: 25, w: 76, h: 18 }, 27, INK, "semibold"), ...(slide.attribution ? [text("meta", `— ${slide.attribution}`, { x: 56, y: 45, w: 32, h: 4 }, 12, MUTED, "regular")] : [])];
      break;
    case "closing":
      elements = [...base, text("title", slide.title, { x: 10, y: 20, w: 80, h: 14 }, 36, INK, "bold"), ...(slide.statement ? [text("statement", slide.statement, { x: 18, y: 37, w: 64, h: 7 }, 18, MUTED, "regular")] : []), shape("line", { x: 38, y: 48, w: 24, h: 0 }, { stroke: CORAL, strokeWidth: 3 })];
      break;
  }
  return { id: `slide-${index + 1}`, intent: slide.intent, background: PAPER, elements };
}

export function composeNarrativeDeck(input: NarrativeDeck): SceneDeck {
  const deck = parseNarrativeDeck(input);
  return { meetingId: deck.meetingId, title: deck.title, width: 100, height: 56.25, slides: deck.slides.map(composeSlide) };
}
