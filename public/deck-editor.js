import {
  arrayValue, canonicalJson, clone, deepFreeze, exact, integer, oneOf, sha256, stableId,
  stringValue, unique,
} from "./deck-editor-utils.js";
import { LAYOUTS, preparePlan, validateSlide } from "./deck-editor-validation.js";

export const DECK_EDITOR_COMMAND_TYPES = Object.freeze([
  "setText", "setBox", "setBoxes", "chooseLayout", "replaceAsset", "reorderSlide", "insertSlide",
  "deleteSlide", "regenerateSlide", "undo", "redo",
]);

const COMMAND_FIELDS = {
  setText: ["type", "expectedRevision", "slideId", "path", "text", "claimIds"],
  setBox: ["type", "expectedRevision", "slideId", "elementId", "box"],
  setBoxes: ["type", "expectedRevision", "slideId", "boxes"],
  chooseLayout: ["type", "expectedRevision", "slideId", "layout"],
  replaceAsset: ["type", "expectedRevision", "slideId", "assetId", "replacementAssetId"],
  reorderSlide: ["type", "expectedRevision", "slideId", "toIndex"],
  insertSlide: ["type", "expectedRevision", "index", "slide"],
  deleteSlide: ["type", "expectedRevision", "slideId"],
  regenerateSlide: ["type", "expectedRevision", "slideId", "preserveClaimIds", "replacement"],
  undo: ["type", "expectedRevision"],
  redo: ["type", "expectedRevision"],
};
const OPTIONAL_FIELDS = { setText: ["claimIds"] };

function failure(state, code, details = {}) {
  const error = deepFreeze({ code, ...details });
  return Object.freeze({ ok: false, state, error });
}

function success(state) {
  return Object.freeze({ ok: true, state });
}

function hashesFor(slides) {
  const hashes = {};
  for (const slide of slides) hashes[slide.id] = sha256(canonicalJson(slide));
  return Object.freeze(hashes);
}

function makeState(deck, revision, past, future) {
  return Object.freeze({ deck, revision, past: Object.freeze(past), future: Object.freeze(future), slideHashes: hashesFor(deck.slides) });
}

export function createDeckEditorState(input) {
  const deck = preparePlan(input);
  return makeState(deck, deck.revision, [], []);
}

function normalizedCommand(command) {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw new TypeError("command must be a plain object");
  const type = Object.prototype.hasOwnProperty.call(command, "type") ? command.type : undefined;
  if (typeof type !== "string" || !DECK_EDITOR_COMMAND_TYPES.includes(type)) return null;
  const required = COMMAND_FIELDS[type].filter((key) => !(OPTIONAL_FIELDS[type] ?? []).includes(key));
  exact(command, "command", required, OPTIONAL_FIELDS[type] ?? []);
  const result = {};
  for (const key of COMMAND_FIELDS[type]) if (Object.prototype.hasOwnProperty.call(command, key)) result[key] = clone(command[key]);
  return deepFreeze(result);
}

function knownIds(deck, field) {
  return new Set(deck[field].map((item) => item.id));
}

function checkedIds(value, path, known, nonEmpty = true) {
  const ids = arrayValue(value, path, nonEmpty).map((item, index) => {
    const id = stableId(item, `${path}[${index}]`);
    if (!known.has(id)) throw Object.freeze({ code: "UNKNOWN_CLAIM_ID", path: `${path}[${index}]` });
    return id;
  });
  unique(ids, path);
  return ids;
}

function findSlide(state, command) {
  stableId(command.slideId, "command.slideId");
  const index = state.deck.slides.findIndex((slide) => slide.id === command.slideId);
  if (index < 0) throw Object.freeze({ code: "UNKNOWN_SLIDE_ID", slideId: command.slideId });
  return index;
}

function pathParts(path) {
  if (path === "title") return ["title"];
  if (typeof path !== "string" || !/^payload(?:\.[A-Za-z][A-Za-z0-9_]*|\[(?:0|[1-9]\d*)\])+$/.test(path)) return null;
  const parts = [];
  for (const match of path.matchAll(/(?:^|\.)([A-Za-z][A-Za-z0-9_]*)|\[(\d+)\]/g)) parts.push(match[1] ?? Number(match[2]));
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) return null;
  return parts;
}

function editText(state, command, index) {
  stringValue(command.text, "command.text", { empty: true });
  const parts = pathParts(command.path);
  let cursor = state.deck.slides[index];
  if (!parts) throw Object.freeze({ code: "INVALID_PATH", path: command.path });
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      throw Object.freeze({ code: "INVALID_PATH", path: command.path });
    }
    cursor = cursor[part];
  }
  if (typeof cursor !== "string") throw Object.freeze({ code: "INVALID_PATH", path: command.path });
  const bindingPath = command.path === "title" ? "title" : command.path.slice(8);
  const editorial = state.deck.slides[index].editorialPaths.includes(bindingPath);
  let claimIds;
  if (!editorial) {
    if (!Object.prototype.hasOwnProperty.call(command, "claimIds")) throw Object.freeze({ code: "CLAIM_IDS_REQUIRED", path: command.path });
    claimIds = checkedIds(command.claimIds, "claimIds", knownIds(state.deck, "claims"));
  } else if (command.claimIds !== undefined) checkedIds(command.claimIds, "claimIds", knownIds(state.deck, "claims"), false);
  const slide = clone(state.deck.slides[index]);
  let target = slide;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = command.text;
  if (!editorial) slide.bindings[bindingPath] = claimIds;
  validateSlide(slide, "editedSlide", knownIds(state.deck, "claims"), knownIds(state.deck, "assets"));
  return deepFreeze(slide);
}

function parsedBox(boxValue, path = "box") {
  if (boxValue === null || typeof boxValue !== "object" || Array.isArray(boxValue)) {
    throw Object.freeze({ code: "INVALID_BOX", path });
  }
  const box = exact(boxValue, `command.${path}`, ["x", "y", "width", "height"]);
  for (const key of ["x", "y", "width", "height"]) {
    if (typeof box[key] !== "number" || !Number.isFinite(box[key])) {
      throw Object.freeze({ code: "INVALID_BOX", path: `${path}.${key}` });
    }
  }
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 ||
      box.x + box.width > 1280 || box.y + box.height > 720) {
    throw Object.freeze({ code: "INVALID_BOX", path });
  }
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function putBoxOverride(slide, elementId, nextBox) {
  const previous = (slide.boxOverrides ?? []).find((entry) => entry.elementId === elementId);
  if (previous && previous.box.x === nextBox.x && previous.box.y === nextBox.y &&
      previous.box.width === nextBox.width && previous.box.height === nextBox.height) {
    return false;
  }
  const rest = (slide.boxOverrides ?? []).filter((entry) => entry.elementId !== elementId);
  slide.boxOverrides = [...rest, { elementId, box: nextBox }];
  return true;
}

function editBox(state, command, index) {
  const elementId = stableId(command.elementId, "command.elementId");
  const nextBox = parsedBox(command.box);
  const slide = clone(state.deck.slides[index]);
  if (!putBoxOverride(slide, elementId, nextBox)) return state.deck.slides[index];
  validateSlide(slide, "editedSlide", knownIds(state.deck, "claims"), knownIds(state.deck, "assets"));
  return deepFreeze(slide);
}

function editBoxes(state, command, index) {
  const items = arrayValue(command.boxes, "command.boxes", true);
  const parsed = [];
  const seen = new Set();
  items.forEach((item, itemIndex) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw Object.freeze({ code: "INVALID_COMMAND", path: `boxes[${itemIndex}]` });
    }
    exact(item, `command.boxes[${itemIndex}]`, ["elementId", "box"]);
    const elementId = stableId(item.elementId, `command.boxes[${itemIndex}].elementId`);
    if (seen.has(elementId)) throw Object.freeze({ code: "DUPLICATE_ELEMENT_ID", path: `boxes[${itemIndex}].elementId` });
    seen.add(elementId);
    parsed.push({ elementId, box: parsedBox(item.box, `boxes[${itemIndex}].box`) });
  });
  const slide = clone(state.deck.slides[index]);
  let changed = false;
  for (const { elementId, box } of parsed) {
    if (putBoxOverride(slide, elementId, box)) changed = true;
  }
  if (!changed) return state.deck.slides[index];
  validateSlide(slide, "editedSlide", knownIds(state.deck, "claims"), knownIds(state.deck, "assets"));
  return deepFreeze(slide);
}

function replaceOne(slides, index, slide) {
  const next = slides.slice(); next[index] = slide; return Object.freeze(next);
}

function uniqueClaimIds(slide) {
  return [...new Set(Object.values(slide.bindings).flat())];
}

function convertLayout(deck, slide, layout) {
  const claimById = new Map(deck.claims.map((claim) => [claim.id, claim]));
  const ids = uniqueClaimIds(slide).filter((id) => claimById.has(id));
  const fallbackIds = slide.bindings.title?.filter((id) => claimById.has(id)) ?? [];
  const usableIds = ids.length > 0 ? ids : fallbackIds;
  if (usableIds.length === 0) throw Object.freeze({ code: "CLAIM_IDS_REQUIRED", path: "layout" });
  const fact = (index) => {
    const id = usableIds[index % usableIds.length];
    return { text: claimById.get(id).text, ids: [id] };
  };
  const bindings = { title: [...slide.bindings.title] };
  let payload;
  let editorialPaths = [];
  if (layout === "hero") {
    const value = fact(0); payload = { variant: "statement", statement: value.text };
    bindings.statement = value.ids;
  } else if (layout === "summary") {
    const values = usableIds.map((_, index) => fact(index));
    payload = { mode: "takeaways", items: values.map((value) => value.text) };
    values.forEach((value, index) => { bindings[`items[${index}]`] = value.ids; });
  } else if (layout === "decision") {
    const decision = fact(0); const rationale = fact(1);
    payload = { decision: decision.text, rationale: [rationale.text] };
    bindings.decision = decision.ids; bindings["rationale[0]"] = rationale.ids;
  } else if (layout === "comparison") {
    const left = fact(0); const right = fact(1);
    payload = { sides: [{ label: "관점 A", items: [left.text] }, { label: "관점 B", items: [right.text] }] };
    bindings["sides[0].items[0]"] = left.ids; bindings["sides[1].items[0]"] = right.ids;
    editorialPaths = ["sides[0].label", "sides[1].label"];
  } else if (layout === "timeline") {
    const values = usableIds.map((_, index) => fact(index));
    payload = { mode: "process", events: values.map((value, index) => ({ label: `단계 ${index + 1}`, text: value.text })) };
    values.forEach((value, index) => { bindings[`events[${index}].text`] = value.ids; });
    editorialPaths = values.map((_, index) => `events[${index}].label`);
  } else if (layout === "metrics") {
    const label = fact(0); const value = fact(1); const detail = fact(2);
    payload = { mode: "cards", metrics: [{ label: label.text, value: value.text, detail: detail.text }] };
    bindings["metrics[0].label"] = label.ids; bindings["metrics[0].value"] = value.ids; bindings["metrics[0].detail"] = detail.ids;
  } else {
    const task = fact(0); const owner = fact(1); const due = fact(2);
    payload = { items: [{ task: task.text, owner: owner.text, due: due.text }] };
    bindings["items[0].task"] = task.ids; bindings["items[0].owner"] = owner.ids; bindings["items[0].due"] = due.ids;
  }
  const converted = { ...slide, layout, payload, bindings, editorialPaths };
  delete converted.boxOverrides;
  validateSlide(converted, "convertedSlide", knownIds(deck, "claims"), knownIds(deck, "assets"));
  return deepFreeze(converted);
}

function editedState(state, slides) {
  const revision = state.revision + 1;
  const deck = deepFreeze({ ...state.deck, revision, slides });
  return makeState(deck, revision, [...state.past, state.deck], []);
}

function historyState(state, direction) {
  const source = direction === "undo" ? state.past : state.future;
  if (source.length === 0) return state;
  const target = source[source.length - 1];
  const revision = state.revision + 1;
  const deck = deepFreeze({ ...target, revision });
  const past = direction === "undo" ? state.past.slice(0, -1) : [...state.past, state.deck];
  const future = direction === "undo" ? [...state.future, state.deck] : state.future.slice(0, -1);
  return makeState(deck, revision, past, future);
}

function execute(state, command) {
  if (command.type === "undo" || command.type === "redo") return historyState(state, command.type);
  if (command.type === "insertSlide") {
    integer(command.index, "command.index");
    if (command.index > state.deck.slides.length) throw Object.freeze({ code: "INVALID_INDEX", path: "index" });
    const slide = clone(command.slide);
    try { validateSlide(slide, "command.slide", knownIds(state.deck, "claims"), knownIds(state.deck, "assets")); }
    catch (error) { throw Object.freeze({ code: "INVALID_SLIDE", path: error.path ?? "slide", message: error.message }); }
    if (state.deck.slides.some((item) => item.id === slide.id)) throw Object.freeze({ code: "DUPLICATE_SLIDE_ID", slideId: slide.id });
    const slides = state.deck.slides.slice(); slides.splice(command.index, 0, deepFreeze(slide));
    return editedState(state, Object.freeze(slides));
  }
  const index = findSlide(state, command);
  if (command.type === "setText") return editedState(state, replaceOne(state.deck.slides, index, editText(state, command, index)));
  if (command.type === "setBox") {
    const slide = editBox(state, command, index);
    if (slide === state.deck.slides[index]) return state;
    return editedState(state, replaceOne(state.deck.slides, index, slide));
  }
  if (command.type === "setBoxes") {
    const slide = editBoxes(state, command, index);
    if (slide === state.deck.slides[index]) return state;
    return editedState(state, replaceOne(state.deck.slides, index, slide));
  }
  if (command.type === "chooseLayout") {
    oneOf(command.layout, "command.layout", LAYOUTS);
    if (command.layout === state.deck.slides[index].layout) return state;
    return editedState(state, replaceOne(
      state.deck.slides, index, convertLayout(state.deck, state.deck.slides[index], command.layout),
    ));
  }
  if (command.type === "replaceAsset") {
    stableId(command.assetId, "command.assetId"); stableId(command.replacementAssetId, "command.replacementAssetId");
    if (!knownIds(state.deck, "assets").has(command.replacementAssetId)) throw Object.freeze({ code: "UNKNOWN_ASSET_ID", assetId: command.replacementAssetId });
    const at = state.deck.slides[index].assetIds.indexOf(command.assetId);
    if (at < 0) throw Object.freeze({ code: "ASSET_NOT_ON_SLIDE", assetId: command.assetId });
    const assetIds = state.deck.slides[index].assetIds.slice(); assetIds[at] = command.replacementAssetId;
    if (new Set(assetIds).size !== assetIds.length) throw Object.freeze({ code: "DUPLICATE_ASSET_ID", assetId: command.replacementAssetId });
    const slide = deepFreeze({ ...state.deck.slides[index], assetIds: Object.freeze(assetIds) });
    return editedState(state, replaceOne(state.deck.slides, index, slide));
  }
  if (command.type === "reorderSlide") {
    integer(command.toIndex, "command.toIndex");
    if (command.toIndex >= state.deck.slides.length) throw Object.freeze({ code: "INVALID_INDEX", path: "toIndex" });
    if (command.toIndex === index) return state;
    const slides = state.deck.slides.slice(); const [slide] = slides.splice(index, 1); slides.splice(command.toIndex, 0, slide);
    return editedState(state, Object.freeze(slides));
  }
  if (command.type === "deleteSlide") {
    if (state.deck.slides.length === 1) throw Object.freeze({ code: "LAST_SLIDE_REQUIRED", slideId: command.slideId });
    return editedState(state, Object.freeze(state.deck.slides.filter((_, slideIndex) => slideIndex !== index)));
  }
  const preserve = checkedIds(command.preserveClaimIds, "preserveClaimIds", knownIds(state.deck, "claims"), false);
  const replacement = clone(command.replacement);
  try { validateSlide(replacement, "command.replacement", knownIds(state.deck, "claims"), knownIds(state.deck, "assets")); }
  catch (error) { throw Object.freeze({ code: "INVALID_SLIDE", path: error.path ?? "replacement", message: error.message }); }
  const bound = new Set(Object.values(replacement.bindings).flat());
  preserve.forEach((id, preserveIndex) => { if (!bound.has(id)) throw Object.freeze({ code: "PRESERVED_CLAIM_MISSING", path: `preserveClaimIds[${preserveIndex}]` }); });
  replacement.id = command.slideId;
  return editedState(state, replaceOne(state.deck.slides, index, deepFreeze(replacement)));
}

export function applyDeckEditorCommand(state, input) {
  let command;
  try { command = normalizedCommand(input); }
  catch (error) { return failure(state, "INVALID_COMMAND", { message: error.message }); }
  if (!command) return failure(state, "UNKNOWN_COMMAND");
  if (!Number.isInteger(command.expectedRevision)) return failure(state, "INVALID_COMMAND", { path: "expectedRevision" });
  if (command.expectedRevision !== state.revision) return failure(state, "STALE_REVISION", { expectedRevision: command.expectedRevision, actualRevision: state.revision });
  try { return success(execute(state, command)); }
  catch (error) { return failure(state, error.code ?? "INVALID_COMMAND", Object.fromEntries(Object.entries(error).filter(([key]) => key !== "code"))); }
}

export function serializeDeckEditorCommand(command) { return canonicalJson(command); }
export function serializeDeckEditorResult(result) { return canonicalJson(result); }

export function createDeckEditProtocolPayload(state, input) {
  const command = normalizedCommand(input);
  if (!command) throw new TypeError("unknown deck editor command");
  if (command.expectedRevision !== state.revision) throw new TypeError("stale deck editor command");
  return deepFreeze({ action: "editDeck", planId: state.deck.planId, expectedRevision: command.expectedRevision, command });
}
