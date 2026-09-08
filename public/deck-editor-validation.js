import {
  arrayValue, clone, deepFreeze, exact, integer, oneOf, stableId, stringValue, unique,
} from "./deck-editor-utils.js";

export const LAYOUTS = Object.freeze([
  "hero", "summary", "decision", "comparison", "timeline", "metrics", "actions",
]);
const ROLES = ["opening", "context", "argument", "decision", "commitment", "closing"];
const CLAIM_KINDS = ["fact", "decision", "quote", "action"];
const CLAIM_METHODS = ["extractive", "verbatim", "reviewed"];
const ASSET_PURPOSES = ["informative", "decorative"];
const ASSET_KINDS = ["image", "diagram", "chart", "icon"];

function positive(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path}: must be a positive number`);
  }
}

function hash(value, path) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new TypeError(`${path}: must be a SHA-256 hash`);
  }
}

function ids(value, path, known, nonEmpty = false) {
  const result = arrayValue(value, path, nonEmpty).map((item, index) => {
    const id = stableId(item, `${path}[${index}]`);
    if (known && !known.has(id)) throw new TypeError(`${path}[${index}]: unknown ID '${id}'`);
    return id;
  });
  return unique(result, path);
}

function textList(value, path, factual) {
  arrayValue(value, path, true).forEach((item, index) => {
    stringValue(item, `${path}[${index}]`);
    factual.push(`${path.slice(path.indexOf("payload.") + 8)}[${index}]`);
  });
}

function payloadPaths(layout, value, path) {
  const factual = [];
  const editorial = [];
  if (layout === "hero") {
    const payload = exact(value, path, ["variant", "statement"]);
    oneOf(payload.variant, `${path}.variant`, ["cover", "statement"]);
    stringValue(payload.statement, `${path}.statement`);
    factual.push("statement");
  } else if (layout === "summary") {
    const payload = exact(value, path, ["mode", "items"]);
    oneOf(payload.mode, `${path}.mode`, ["overview", "takeaways"]);
    textList(payload.items, `${path}.items`, factual);
  } else if (layout === "decision") {
    const payload = exact(value, path, ["decision", "rationale"]);
    stringValue(payload.decision, `${path}.decision`);
    factual.push("decision");
    textList(payload.rationale, `${path}.rationale`, factual);
  } else if (layout === "comparison") {
    const payload = exact(value, path, ["sides"]);
    arrayValue(payload.sides, `${path}.sides`, true).forEach((side, index) => {
      const parsed = exact(side, `${path}.sides[${index}]`, ["label", "items"]);
      stringValue(parsed.label, `${path}.sides[${index}].label`);
      editorial.push(`sides[${index}].label`);
      arrayValue(parsed.items, `${path}.sides[${index}].items`, true).forEach((item, itemIndex) => {
        stringValue(item, `${path}.sides[${index}].items[${itemIndex}]`);
        factual.push(`sides[${index}].items[${itemIndex}]`);
      });
    });
  } else if (layout === "timeline") {
    const payload = exact(value, path, ["mode", "events"]);
    oneOf(payload.mode, `${path}.mode`, ["process", "chronology"]);
    arrayValue(payload.events, `${path}.events`, true).forEach((event, index) => {
      const parsed = exact(event, `${path}.events[${index}]`, ["label", "text"]);
      stringValue(parsed.label, `${path}.events[${index}].label`);
      stringValue(parsed.text, `${path}.events[${index}].text`);
      editorial.push(`events[${index}].label`);
      factual.push(`events[${index}].text`);
    });
  } else if (layout === "metrics") {
    const payload = exact(value, path, ["mode", "metrics"]);
    oneOf(payload.mode, `${path}.mode`, ["chart", "cards"]);
    arrayValue(payload.metrics, `${path}.metrics`, true).forEach((metric, index) => {
      const parsed = exact(metric, `${path}.metrics[${index}]`, ["label", "value", "detail"]);
      for (const key of ["label", "value", "detail"]) {
        stringValue(parsed[key], `${path}.metrics[${index}].${key}`);
        factual.push(`metrics[${index}].${key}`);
      }
    });
  } else {
    const payload = exact(value, path, ["items"]);
    arrayValue(payload.items, `${path}.items`, true).forEach((item, index) => {
      const parsed = exact(item, `${path}.items[${index}]`, ["task", "owner", "due"]);
      for (const key of ["task", "owner", "due"]) {
        stringValue(parsed[key], `${path}.items[${index}].${key}`);
        factual.push(`items[${index}].${key}`);
      }
    });
  }
  return { factual, editorial };
}

function parseBoxOverrides(value, path) {
  const items = arrayValue(value, path, true);
  const seen = new Set();
  return items.map((item, index) => {
    const entry = exact(item, `${path}[${index}]`, ["elementId", "box"]);
    const elementId = stableId(entry.elementId, `${path}[${index}].elementId`);
    if (seen.has(elementId)) throw new TypeError(`${path}[${index}].elementId: duplicate element ID`);
    seen.add(elementId);
    const box = exact(entry.box, `${path}[${index}].box`, ["x", "y", "width", "height"]);
    for (const key of ["x", "y", "width", "height"]) {
      if (typeof box[key] !== "number" || !Number.isFinite(box[key])) {
        throw new TypeError(`${path}[${index}].box.${key}: must be a finite number`);
      }
    }
    if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 ||
        box.x + box.width > 1280 || box.y + box.height > 720) {
      throw new TypeError(`${path}[${index}].box: must stay inside the 1280x720 canvas`);
    }
    return { elementId, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });
}

export function validateSlide(value, path, claimIds, assetIds) {
  const slide = exact(value, path,
    ["id", "layout", "storyRole", "title", "payload", "bindings", "editorialPaths", "assetIds"],
    ["notes", "boxOverrides"]);
  stableId(slide.id, `${path}.id`);
  const layout = oneOf(slide.layout, `${path}.layout`, LAYOUTS);
  oneOf(slide.storyRole, `${path}.storyRole`, ROLES);
  stringValue(slide.title, `${path}.title`);
  if (slide.notes !== undefined) stringValue(slide.notes, `${path}.notes`);
  if (slide.boxOverrides !== undefined) parseBoxOverrides(slide.boxOverrides, `${path}.boxOverrides`);
  const paths = payloadPaths(layout, slide.payload, `${path}.payload`);
  const bindings = exact(slide.bindings, `${path}.bindings`, ["title", ...paths.factual]);
  for (const fieldPath of ["title", ...paths.factual]) ids(bindings[fieldPath], `${path}.bindings.${fieldPath}`, claimIds, true);
  const declared = arrayValue(slide.editorialPaths, `${path}.editorialPaths`).map((item, index) =>
    stringValue(item, `${path}.editorialPaths[${index}]`));
  unique(declared, `${path}.editorialPaths`);
  if (declared.length !== paths.editorial.length || declared.some((item) => !paths.editorial.includes(item))) {
    throw new TypeError(`${path}.editorialPaths: must exactly declare editorial payload paths`);
  }
  ids(slide.assetIds, `${path}.assetIds`, assetIds);
  return slide;
}

function validateTheme(value) {
  const theme = exact(value, "plan.theme", ["id", "canvas", "font", "colors", "spacing", "typography", "stroke", "radius"]);
  stableId(theme.id, "plan.theme.id");
  const canvas = exact(theme.canvas, "plan.theme.canvas", ["width", "height"]);
  positive(canvas.width, "plan.theme.canvas.width"); positive(canvas.height, "plan.theme.canvas.height");
  const font = exact(theme.font, "plan.theme.font", ["family", "localPath", "sha256"]);
  stringValue(font.family, "plan.theme.font.family"); stringValue(font.localPath, "plan.theme.font.localPath"); hash(font.sha256, "plan.theme.font.sha256");
  const colors = exact(theme.colors, "plan.theme.colors", ["paper", "raised", "ink", "muted", "rule", "coral", "blue", "focus"]);
  for (const key of Object.keys(colors)) {
    if (typeof colors[key] !== "string" || !/^[0-9a-f]{6}$/i.test(colors[key])) throw new TypeError(`plan.theme.colors.${key}: invalid color`);
  }
  const spacing = exact(theme.spacing, "plan.theme.spacing", ["xs", "sm", "md", "lg", "xl"]);
  for (const key of Object.keys(spacing)) positive(spacing[key], `plan.theme.spacing.${key}`);
  const typography = exact(theme.typography, "plan.theme.typography", ["display", "heading", "body", "label"]);
  for (const name of Object.keys(typography)) {
    const style = exact(typography[name], `plan.theme.typography.${name}`, ["size", "lineHeight", "weight"]);
    for (const key of Object.keys(style)) positive(style[key], `plan.theme.typography.${name}.${key}`);
  }
  for (const group of ["stroke", "radius"]) {
    const keys = group === "stroke" ? ["thin", "strong"] : ["small", "large"];
    const values = exact(theme[group], `plan.theme.${group}`, keys);
    for (const key of keys) positive(values[key], `plan.theme.${group}.${key}`);
  }
}

export function preparePlan(input) {
  const plan = clone(input);
  exact(plan, "plan", ["schemaVersion", "planId", "revision", "snapshot", "title", "theme", "claims", "assets", "slides", "createdAt", "updatedAt"]);
  if (plan.schemaVersion !== 1) throw new TypeError("plan.schemaVersion: must equal 1");
  stableId(plan.planId, "plan.planId"); integer(plan.revision, "plan.revision"); stringValue(plan.title, "plan.title");
  const snapshot = exact(plan.snapshot, "plan.snapshot", ["meetingId", "transcriptVersionId", "contentSha256", "lineCount"]);
  integer(snapshot.meetingId, "plan.snapshot.meetingId", 1); stableId(snapshot.transcriptVersionId, "plan.snapshot.transcriptVersionId");
  hash(snapshot.contentSha256, "plan.snapshot.contentSha256"); integer(snapshot.lineCount, "plan.snapshot.lineCount");
  validateTheme(plan.theme);
  const claimIds = new Set();
  arrayValue(plan.claims, "plan.claims", true).forEach((value, index) => {
    const claim = exact(value, `plan.claims[${index}]`, ["id", "kind", "text", "method", "sources"]);
    const id = stableId(claim.id, `plan.claims[${index}].id`); if (claimIds.has(id)) throw new TypeError(`duplicate claim ID '${id}'`); claimIds.add(id);
    oneOf(claim.kind, `plan.claims[${index}].kind`, CLAIM_KINDS); oneOf(claim.method, `plan.claims[${index}].method`, CLAIM_METHODS); stringValue(claim.text, `plan.claims[${index}].text`);
    arrayValue(claim.sources, `plan.claims[${index}].sources`, true).forEach((value, sourceIndex) => {
      const source = exact(value, `plan.claims[${index}].sources[${sourceIndex}]`, ["transcriptVersionId", "startSeq", "endSeq", "evidenceQuote"]);
      if (source.transcriptVersionId !== snapshot.transcriptVersionId) throw new TypeError(`plan.claims[${index}].sources[${sourceIndex}]: transcript mismatch`);
      integer(source.startSeq, "source.startSeq", 1); integer(source.endSeq, "source.endSeq", 1); stringValue(source.evidenceQuote, "source.evidenceQuote");
      if (source.endSeq < source.startSeq || source.endSeq > snapshot.lineCount) throw new TypeError("claim source range is invalid");
    });
  });
  const assetIds = new Set();
  arrayValue(plan.assets, "plan.assets").forEach((value, index) => {
    const asset = exact(value, `plan.assets[${index}]`, ["id", "purpose", "kind", "localPath", "mediaType", "width", "height", "byteLength", "sha256", "altDescription", "source", "claimIds"]);
    const id = stableId(asset.id, `plan.assets[${index}].id`); if (assetIds.has(id)) throw new TypeError(`duplicate asset ID '${id}'`); assetIds.add(id);
    oneOf(asset.purpose, "asset.purpose", ASSET_PURPOSES); oneOf(asset.kind, "asset.kind", ASSET_KINDS); stringValue(asset.localPath, "asset.localPath"); stringValue(asset.mediaType, "asset.mediaType");
    positive(asset.width, "asset.width"); positive(asset.height, "asset.height"); integer(asset.byteLength, "asset.byteLength", 1); hash(asset.sha256, "asset.sha256"); stringValue(asset.altDescription, "asset.altDescription"); ids(asset.claimIds, "asset.claimIds", claimIds);
    const sourceKeys = asset.source?.kind === "local" ? ["kind", "originalPath"] : asset.source?.kind === "generated" ? ["kind", "generator"] : ["kind", "url", "retrievedAt"];
    const source = exact(asset.source, "asset.source", sourceKeys); oneOf(source.kind, "asset.source.kind", ["local", "generated", "retrieved"]); for (const key of sourceKeys.slice(1)) stringValue(source[key], `asset.source.${key}`);
  });
  const slideIds = new Set();
  arrayValue(plan.slides, "plan.slides", true).forEach((slide, index) => { validateSlide(slide, `plan.slides[${index}]`, claimIds, assetIds); if (slideIds.has(slide.id)) throw new TypeError(`duplicate slide ID '${slide.id}'`); slideIds.add(slide.id); });
  for (const key of ["createdAt", "updatedAt"]) if (typeof plan[key] !== "string" || Number.isNaN(Date.parse(plan[key]))) throw new TypeError(`plan.${key}: invalid timestamp`);
  return deepFreeze(plan);
}
