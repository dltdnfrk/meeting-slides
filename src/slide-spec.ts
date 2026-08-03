export const MAX_TITLE_LENGTH = 120;
export const MAX_SHORT_TEXT_LENGTH = 240;
export const MAX_BULLET_LENGTH = 240;
export const MAX_BULLETS = 6;
export const MAX_ACTIONS = 8;
export const MAX_SLIDES = 60;
export const MAX_STYLE_LENGTH = 80;

export type LiveMeetingCardKind =
  | "cover"
  | "section"
  | "topic"
  | "decision"
  | "actions"
  | "summary";

export const LIVE_MEETING_CARD_KINDS = [
  "cover",
  "section",
  "topic",
  "decision",
  "actions",
  "summary",
] as const satisfies readonly LiveMeetingCardKind[];

export interface LiveMeetingCard {
  title: string;
  kicker?: string;
  bullets: string[];
  emphasis?: string;
  /** 라이브 무대 레이아웃. 없으면 UI가 내용으로 추론한다. */
  kind?: LiveMeetingCardKind;
}

export type SlideKind = "cover" | "section" | "summary" | "decision" | "actions" | "closing";

export interface CoverSlideSpec {
  kind: "cover";
  title: string;
  subtitle?: string;
  kicker?: string;
}

export interface SectionSlideSpec {
  kind: "section";
  title: string;
  kicker?: string;
  bullets: string[];
}

export interface SummarySlideSpec {
  kind: "summary";
  title: string;
  bullets: string[];
  emphasis?: string;
}

export interface DecisionSlideSpec {
  kind: "decision";
  title: string;
  decision: string;
  rationale?: string[];
}

export interface ActionItem {
  text: string;
  owner?: string;
  due?: string;
}

export interface ActionsSlideSpec {
  kind: "actions";
  title: string;
  actions: ActionItem[];
}

export interface ClosingSlideSpec {
  kind: "closing";
  title: string;
  bullets: string[];
  emphasis?: string;
}

export type SlideSpec =
  | CoverSlideSpec
  | SectionSlideSpec
  | SummarySlideSpec
  | DecisionSlideSpec
  | ActionsSlideSpec
  | ClosingSlideSpec;

export interface DeckOutlineSource {
  transcriptLineCount: number;
  liveSlideCount: number;
  generatedAt?: string;
}

export interface DeckOutline {
  meetingId: number;
  title: string;
  style: string;
  slides: SlideSpec[];
  source?: DeckOutlineSource;
}

export interface LegacySlide {
  index: number;
  title: string;
  bullets: string[];
  startedAt: number;
  sentenceCount: number;
}

type JsonObject = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${path}.${unknown}`, "is not allowed");
}

function textAt(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.trim().length === 0) fail(path, "must not be empty");
  if ([...value].length > max) fail(path, `must be at most ${max} characters`);
  return value;
}

function integerAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value;
}

function stringsAt(value: unknown, path: string, min: number, max = MAX_BULLETS): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < min || value.length > max) fail(path, `must contain ${min}-${max} items`);
  return value.map((item, index) => textAt(item, `${path}[${index}]`, MAX_BULLET_LENGTH));
}

function actionAt(value: unknown, path: string): ActionItem {
  const item = objectAt(value, path);
  exactKeys(item, ["text", "owner", "due"], path);
  return {
    text: textAt(item.text, `${path}.text`, MAX_BULLET_LENGTH),
    ...(item.owner === undefined ? {} : { owner: textAt(item.owner, `${path}.owner`, MAX_SHORT_TEXT_LENGTH) }),
    ...(item.due === undefined ? {} : { due: textAt(item.due, `${path}.due`, MAX_SHORT_TEXT_LENGTH) }),
  };
}

function actionsAt(value: unknown, path: string): ActionItem[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length < 1 || value.length > MAX_ACTIONS) fail(path, `must contain 1-${MAX_ACTIONS} items`);
  return value.map((item, index) => actionAt(item, `${path}[${index}]`));
}

function parseJsonRoot(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(label, "must be valid JSON");
  }
}

function parseSlideValue(value: unknown, path = "slide"): SlideSpec {
  const slide = objectAt(value, path);
  const title = textAt(slide.title, `${path}.title`, MAX_TITLE_LENGTH);
  switch (slide.kind) {
    case "cover":
      exactKeys(slide, ["kind", "title", "subtitle", "kicker"], path);
      return { kind: "cover", title, ...(slide.subtitle === undefined ? {} : { subtitle: textAt(slide.subtitle, `${path}.subtitle`, MAX_SHORT_TEXT_LENGTH) }), ...(slide.kicker === undefined ? {} : { kicker: textAt(slide.kicker, `${path}.kicker`, MAX_SHORT_TEXT_LENGTH) }) };
    case "section":
      exactKeys(slide, ["kind", "title", "kicker", "bullets"], path);
      return { kind: "section", title, ...(slide.kicker === undefined ? {} : { kicker: textAt(slide.kicker, `${path}.kicker`, MAX_SHORT_TEXT_LENGTH) }), bullets: stringsAt(slide.bullets, `${path}.bullets`, 1) };
    case "summary":
      exactKeys(slide, ["kind", "title", "bullets", "emphasis"], path);
      return { kind: "summary", title, bullets: stringsAt(slide.bullets, `${path}.bullets`, 1), ...(slide.emphasis === undefined ? {} : { emphasis: textAt(slide.emphasis, `${path}.emphasis`, MAX_SHORT_TEXT_LENGTH) }) };
    case "decision":
      exactKeys(slide, ["kind", "title", "decision", "rationale"], path);
      return { kind: "decision", title, decision: textAt(slide.decision, `${path}.decision`, MAX_SHORT_TEXT_LENGTH), ...(slide.rationale === undefined ? {} : { rationale: stringsAt(slide.rationale, `${path}.rationale`, 0) }) };
    case "actions":
      exactKeys(slide, ["kind", "title", "actions"], path);
      return { kind: "actions", title, actions: actionsAt(slide.actions, `${path}.actions`) };
    case "closing":
      exactKeys(slide, ["kind", "title", "bullets", "emphasis"], path);
      return { kind: "closing", title, bullets: stringsAt(slide.bullets, `${path}.bullets`, 0), ...(slide.emphasis === undefined ? {} : { emphasis: textAt(slide.emphasis, `${path}.emphasis`, MAX_SHORT_TEXT_LENGTH) }) };
    default:
      fail(`${path}.kind`, "must be cover, section, summary, decision, actions, or closing");
  }
}

export function parseSlideSpec(value: unknown): SlideSpec {
  return parseSlideValue(parseJsonRoot(value, "slide"));
}

export function assertSlideSpec(value: unknown): asserts value is SlideSpec {
  parseSlideValue(value);
}

function parseDeckValue(value: unknown): DeckOutline {
  const outline = objectAt(value, "outline");
  exactKeys(outline, ["meetingId", "title", "style", "slides", "source"], "outline");
  if (!Array.isArray(outline.slides)) fail("outline.slides", "must be an array");
  if (outline.slides.length < 1 || outline.slides.length > MAX_SLIDES) fail("outline.slides", `must contain 1-${MAX_SLIDES} items`);
  let source: DeckOutlineSource | undefined;
  if (outline.source !== undefined) {
    const raw = objectAt(outline.source, "outline.source");
    exactKeys(raw, ["transcriptLineCount", "liveSlideCount", "generatedAt"], "outline.source");
    source = {
      transcriptLineCount: integerAt(raw.transcriptLineCount, "outline.source.transcriptLineCount"),
      liveSlideCount: integerAt(raw.liveSlideCount, "outline.source.liveSlideCount"),
      ...(raw.generatedAt === undefined ? {} : { generatedAt: textAt(raw.generatedAt, "outline.source.generatedAt", MAX_SHORT_TEXT_LENGTH) }),
    };
  }
  return {
    meetingId: integerAt(outline.meetingId, "outline.meetingId"),
    title: textAt(outline.title, "outline.title", MAX_TITLE_LENGTH),
    style: textAt(outline.style, "outline.style", MAX_STYLE_LENGTH),
    slides: outline.slides.map((slide, index) => parseSlideValue(slide, `outline.slides[${index}]`)),
    ...(source === undefined ? {} : { source }),
  };
}

export function parseDeckOutline(value: unknown): DeckOutline {
  return parseDeckValue(parseJsonRoot(value, "outline"));
}

export function assertDeckOutline(value: unknown): asserts value is DeckOutline {
  parseDeckValue(value);
}

export function parseLiveMeetingCard(value: unknown): LiveMeetingCard {
  const card = objectAt(parseJsonRoot(value, "card"), "card");
  exactKeys(card, ["title", "kicker", "bullets", "emphasis", "kind"], "card");
  const kindRaw = card.kind;
  let kind: LiveMeetingCardKind | undefined;
  if (kindRaw !== undefined) {
    if (typeof kindRaw !== "string" || !(LIVE_MEETING_CARD_KINDS as readonly string[]).includes(kindRaw)) {
      throw new TypeError(`card.kind must be one of ${LIVE_MEETING_CARD_KINDS.join("|")}`);
    }
    kind = kindRaw as LiveMeetingCardKind;
  }
  return {
    title: textAt(card.title, "card.title", MAX_TITLE_LENGTH),
    ...(card.kicker === undefined ? {} : { kicker: textAt(card.kicker, "card.kicker", MAX_SHORT_TEXT_LENGTH) }),
    bullets: stringsAt(card.bullets, "card.bullets", 0),
    ...(card.emphasis === undefined ? {} : { emphasis: textAt(card.emphasis, "card.emphasis", MAX_SHORT_TEXT_LENGTH) }),
    ...(kind === undefined ? {} : { kind }),
  };
}

export function assertLiveMeetingCard(value: unknown): asserts value is LiveMeetingCard {
  parseLiveMeetingCard(value);
}

export function legacySlideToMeetingCard(slide: LegacySlide): LiveMeetingCard {
  return parseLiveMeetingCard({ title: slide.title, bullets: [...slide.bullets] });
}
