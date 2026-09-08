import { BoxOverrideError, parseBoxOverrides } from "../geometry/box-overrides.ts";
import { array, exact, oneOf, record, stableId, text, unique, SlidePlanParseError } from "./parse-helpers.ts";
import type { PlanSlide } from "./plan.ts";

const LAYOUTS = ["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"] as const;
const ROLES = ["opening", "context", "argument", "decision", "commitment", "closing"] as const;

type Layout = PlanSlide["layout"];
interface PayloadPaths { factual: string[]; editorial: string[] }

function textList(value: unknown, path: string): string[] {
  return array(value, path, true).map((item, index) => text(item, `${path}[${index}]`));
}

function parsePayload(layout: Layout, value: unknown, path: string): PayloadPaths {
  const factual: string[] = [];
  const editorial: string[] = [];
  switch (layout) {
    case "hero": {
      const payload = exact(value, path, ["variant", "statement"]);
      oneOf(payload.variant, `${path}.variant`, ["cover", "statement"]);
      text(payload.statement, `${path}.statement`);
      factual.push("statement");
      break;
    }
    case "summary": {
      const payload = exact(value, path, ["mode", "items"]);
      oneOf(payload.mode, `${path}.mode`, ["overview", "takeaways"]);
      textList(payload.items, `${path}.items`).forEach((_, index) => factual.push(`items[${index}]`));
      break;
    }
    case "decision": {
      const payload = exact(value, path, ["decision", "rationale"]);
      text(payload.decision, `${path}.decision`);
      factual.push("decision");
      textList(payload.rationale, `${path}.rationale`).forEach((_, index) => factual.push(`rationale[${index}]`));
      break;
    }
    case "comparison": {
      const payload = exact(value, path, ["sides"]);
      array(payload.sides, `${path}.sides`, true).forEach((side, sideIndex) => {
        const sidePath = `${path}.sides[${sideIndex}]`;
        const parsed = exact(side, sidePath, ["label", "items"]);
        text(parsed.label, `${sidePath}.label`);
        editorial.push(`sides[${sideIndex}].label`);
        textList(parsed.items, `${sidePath}.items`).forEach((_, itemIndex) =>
          factual.push(`sides[${sideIndex}].items[${itemIndex}]`));
      });
      break;
    }
    case "timeline": {
      const payload = exact(value, path, ["mode", "events"]);
      oneOf(payload.mode, `${path}.mode`, ["process", "chronology"]);
      array(payload.events, `${path}.events`, true).forEach((event, index) => {
        const eventPath = `${path}.events[${index}]`;
        const parsed = exact(event, eventPath, ["label", "text"]);
        text(parsed.label, `${eventPath}.label`);
        text(parsed.text, `${eventPath}.text`);
        editorial.push(`events[${index}].label`);
        factual.push(`events[${index}].text`);
      });
      break;
    }
    case "metrics": {
      const payload = exact(value, path, ["mode", "metrics"]);
      oneOf(payload.mode, `${path}.mode`, ["chart", "cards"]);
      array(payload.metrics, `${path}.metrics`, true).forEach((metric, index) => {
        const metricPath = `${path}.metrics[${index}]`;
        const parsed = exact(metric, metricPath, ["label", "value", "detail"]);
        for (const key of ["label", "value", "detail"] as const) {
          text(parsed[key], `${metricPath}.${key}`);
          factual.push(`metrics[${index}].${key}`);
        }
      });
      break;
    }
    case "actions": {
      const payload = exact(value, path, ["items"]);
      array(payload.items, `${path}.items`, true).forEach((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        const parsed = exact(item, itemPath, ["task", "owner", "due"]);
        for (const key of ["task", "owner", "due"] as const) {
          text(parsed[key], `${itemPath}.${key}`);
          factual.push(`items[${index}].${key}`);
        }
      });
      break;
    }
    default: {
      const exhaustive: never = layout;
      throw new SlidePlanParseError(path, `unsupported layout ${String(exhaustive)}`);
    }
  }
  return { factual, editorial };
}

function validateBindings(
  value: unknown,
  path: string,
  factualPaths: readonly string[],
  claimIds: ReadonlySet<string>,
): void {
  const bindings = record(value, path);
  const permitted = new Set(factualPaths);
  for (const [fieldPath, references] of Object.entries(bindings)) {
    if (!permitted.has(fieldPath)) {
      throw new SlidePlanParseError(`${path}.${fieldPath}`, "binding path is not a factual payload field");
    }
    const ids = array(references, `${path}.${fieldPath}`, true).map((id, index) => {
      const claimId = stableId(id, `${path}.${fieldPath}[${index}]`);
      if (!claimIds.has(claimId)) {
        throw new SlidePlanParseError(`${path}.${fieldPath}[${index}]`, `unknown claim '${claimId}'`);
      }
      return claimId;
    });
    unique(ids, `${path}.${fieldPath}`, "claim reference");
  }
  for (const fieldPath of factualPaths) {
    if (!Object.prototype.hasOwnProperty.call(bindings, fieldPath)) {
      const payloadPath = fieldPath === "title" ? path.replace(/\.bindings$/, ".title") :
        `${path.replace(/\.bindings$/, ".payload")}.${fieldPath}`;
      throw new SlidePlanParseError(payloadPath, "unbound fact; a claim binding is required");
    }
  }
}

export function validateSlides(
  value: unknown,
  claimIds: ReadonlySet<string>,
  assetIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  array(value, "slides", true).forEach((slide, index) => {
    const path = `slides[${index}]`;
    const parsed = exact(slide, path,
      ["id", "layout", "storyRole", "title", "payload", "bindings", "editorialPaths", "assetIds"],
      ["notes", "boxOverrides"]);
    ids.push(stableId(parsed.id, `${path}.id`));
    const layout = oneOf(parsed.layout, `${path}.layout`, LAYOUTS);
    oneOf(parsed.storyRole, `${path}.storyRole`, ROLES);
    text(parsed.title, `${path}.title`);
    if (parsed.notes !== undefined) text(parsed.notes, `${path}.notes`);
    if (parsed.boxOverrides !== undefined) {
      try {
        parseBoxOverrides(parsed.boxOverrides, `${path}.boxOverrides`);
      } catch (error) {
        if (error instanceof BoxOverrideError) {
          throw new SlidePlanParseError(error.path, error.message.replace(`${error.path}: `, ""));
        }
        throw error;
      }
    }
    const payloadPaths = parsePayload(layout, parsed.payload, `${path}.payload`);
    validateBindings(parsed.bindings, `${path}.bindings`, ["title", ...payloadPaths.factual], claimIds);
    const declared = array(parsed.editorialPaths, `${path}.editorialPaths`).map((item, itemIndex) =>
      text(item, `${path}.editorialPaths[${itemIndex}]`));
    unique(declared, `${path}.editorialPaths`, "editorial path");
    for (const editorialPath of declared) {
      if (!payloadPaths.editorial.includes(editorialPath)) {
        throw new SlidePlanParseError(`${path}.editorialPaths`, `unknown editorial path '${editorialPath}'`);
      }
    }
    for (const editorialPath of payloadPaths.editorial) {
      if (!declared.includes(editorialPath)) {
        throw new SlidePlanParseError(`${path}.payload.${editorialPath}`, "must be declared in editorialPaths");
      }
    }
    const slideAssets = array(parsed.assetIds, `${path}.assetIds`).map((item, itemIndex) => {
      const id = stableId(item, `${path}.assetIds[${itemIndex}]`);
      if (!assetIds.has(id)) throw new SlidePlanParseError(`${path}.assetIds[${itemIndex}]`, `unknown asset '${id}'`);
      return id;
    });
    unique(slideAssets, `${path}.assetIds`, "asset reference");
  });
  unique(ids, "slides", "slide ID", ".id");
  return ids;
}
