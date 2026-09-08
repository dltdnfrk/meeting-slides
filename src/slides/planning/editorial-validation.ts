import type { PlanSlide, SlidePlan } from "../model/plan.ts";

export interface EditorialCopyingFailure {
  readonly copiedPaths: readonly string[];
  readonly copiedFields: number;
  readonly eligibleFields: number;
}

export class EditorialCopyingError extends Error {
  readonly failure: EditorialCopyingFailure;

  constructor(failure: EditorialCopyingFailure) {
    super(
      `presentation copy repeats ${failure.copiedFields} of ${failure.eligibleFields} source-derived fields`,
    );
    this.name = "EditorialCopyingError";
    this.failure = failure;
  }
}

interface DisplayField {
  readonly path: string;
  readonly text: string;
  readonly bindingKey: string;
}

function normalizedCopy(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function displayFields(slide: PlanSlide, index: number): readonly DisplayField[] {
  const root = `slides[${index}]`;
  const fields: DisplayField[] = [{
    path: `${root}.title`,
    text: slide.title,
    bindingKey: "title",
  }];
  switch (slide.layout) {
    case "hero":
      fields.push({
        path: `${root}.payload.statement`,
        text: slide.payload.statement,
        bindingKey: "statement",
      });
      break;
    case "summary":
      slide.payload.items.forEach((text, item) =>
        fields.push({
          path: `${root}.payload.items[${item}]`,
          text,
          bindingKey: `items[${item}]`,
        }));
      break;
    case "decision":
      fields.push({
        path: `${root}.payload.decision`,
        text: slide.payload.decision,
        bindingKey: "decision",
      });
      slide.payload.rationale.forEach((text, item) =>
        fields.push({
          path: `${root}.payload.rationale[${item}]`,
          text,
          bindingKey: `rationale[${item}]`,
        }));
      break;
    case "comparison":
      slide.payload.sides.forEach((side, sideIndex) =>
        side.items.forEach((text, itemIndex) =>
          fields.push({
            path: `${root}.payload.sides[${sideIndex}].items[${itemIndex}]`,
            text,
            bindingKey: `sides[${sideIndex}].items[${itemIndex}]`,
          })));
      break;
    case "timeline":
      slide.payload.events.forEach((event, item) =>
        fields.push({
          path: `${root}.payload.events[${item}].text`,
          text: event.text,
          bindingKey: `events[${item}].text`,
        }));
      break;
    case "metrics":
      slide.payload.metrics.forEach((metric, item) => {
        fields.push({
          path: `${root}.payload.metrics[${item}].label`,
          text: metric.label,
          bindingKey: `metrics[${item}].label`,
        });
        fields.push({
          path: `${root}.payload.metrics[${item}].value`,
          text: metric.value,
          bindingKey: `metrics[${item}].value`,
        });
        fields.push({
          path: `${root}.payload.metrics[${item}].detail`,
          text: metric.detail,
          bindingKey: `metrics[${item}].detail`,
        });
      });
      break;
    case "actions":
      slide.payload.items.forEach((action, item) => {
        fields.push({
          path: `${root}.payload.items[${item}].task`,
          text: action.task,
          bindingKey: `items[${item}].task`,
        });
        fields.push({
          path: `${root}.payload.items[${item}].owner`,
          text: action.owner,
          bindingKey: `items[${item}].owner`,
        });
        fields.push({
          path: `${root}.payload.items[${item}].due`,
          text: action.due,
          bindingKey: `items[${item}].due`,
        });
      });
      break;
  }
  return fields;
}

export function findEditorialCopying(
  plan: Pick<SlidePlan, "slides" | "claims">,
  sourceTexts: readonly string[],
): EditorialCopyingFailure | undefined {
  const sources = new Set(sourceTexts.map(normalizedCopy).filter((text) => text.length >= 12));
  const quoteClaims = new Set(
    plan.claims.filter((claim) => claim.kind === "quote").map((claim) => claim.id),
  );
  const eligible = plan.slides
    .flatMap((slide, index) => displayFields(slide, index).map((field) => ({
      ...field,
      boundClaimIds: slide.bindings[field.bindingKey] ?? [],
      normalized: normalizedCopy(field.text),
    })))
    .filter((field) =>
      field.normalized.length >= 12 &&
      !(field.boundClaimIds.length > 0 &&
        field.boundClaimIds.every((claimId) => quoteClaims.has(claimId))));
  const copied = eligible.filter((field) => sources.has(field.normalized));
  if (copied.length < 3 || copied.length * 2 < eligible.length) return undefined;
  return {
    copiedPaths: copied.map((field) => field.path),
    copiedFields: copied.length,
    eligibleFields: eligible.length,
  };
}

export interface EditorialStatusFailure {
  readonly path: string;
  readonly openClaimIds: readonly string[];
}

export class EditorialStatusError extends Error {
  readonly failure: EditorialStatusFailure;

  constructor(failure: EditorialStatusFailure) {
    super(`presentation copy resolves an open item at ${failure.path}`);
    this.name = "EditorialStatusError";
    this.failure = failure;
  }
}

const OPEN_STATUS = /(?:미정|미결|미확정|확정되지 않(?:음|았|은)|확정 전|확인 필요|추가 확인|추가 검토|검토 중|결정 필요|남(?:은|아|았습니다)|열린|아직|pending|open|unresolved|still unresolved|not (?:completed|resolved|closed|finali[sz]ed)|needs? (?:review|confirmation))/iu;

export function findEditorialStatusFailure(
  slides: readonly PlanSlide[],
  openClaimIds: readonly string[],
): EditorialStatusFailure | undefined {
  const openClaims = new Set(openClaimIds);
  if (openClaims.size === 0) return undefined;
  for (const [index, slide] of slides.entries()) {
    for (const field of displayFields(slide, index)) {
      const boundOpenClaims = (slide.bindings[field.bindingKey] ?? [])
        .filter((claimId) => openClaims.has(claimId));
      if (boundOpenClaims.length === 0) continue;
      if (!OPEN_STATUS.test(field.text)) {
        return { path: field.path, openClaimIds: boundOpenClaims };
      }
    }
  }
  return undefined;
}

export interface EditorialProvenanceFailure {
  readonly path: string;
  readonly unsupportedAtoms: readonly string[];
  readonly claimIds: readonly string[];
}

export class EditorialProvenanceError extends Error {
  readonly failure: EditorialProvenanceFailure;

  constructor(failure: EditorialProvenanceFailure) {
    super(`presentation copy introduces unsupported atomic facts at ${failure.path}`);
    this.name = "EditorialProvenanceError";
    this.failure = failure;
  }
}

function normalizedAtom(value: string): string {
  const compact = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const match = compact.match(/^([+-]?\d+(?:[.,]\d+)?)(.*)$/u);
  if (!match) return compact;
  const number = Number(match[1]?.replace(/,/gu, ""));
  const unit = (match[2] ?? "").replace(/퍼센트/gu, "%");
  return `${Number.isFinite(number) ? number : match[1]}${unit}`;
}

function atomicFacts(text: string): readonly string[] {
  const tokens = [
    ...text.matchAll(/[+-]?\d+(?:[.,]\d+)?\s*(?:%|퍼센트|년|월|일|시|분|명|건|단계|차|회|개)?/gu),
    ...text.matchAll(/\b[A-Z]{2,}[A-Z0-9._-]*\b/gu),
    ...text.matchAll(/\b[A-Za-z]+[0-9][A-Za-z0-9._-]*\b/gu),
    ...text.matchAll(/\b(?:Mon(?:day)?|Tue(?:sday)?|Tues|Wed(?:nesday)?|Thu(?:rsday)?|Thur|Thurs|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/giu),
    ...text.matchAll(/(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)/gu),
    ...text.matchAll(/\b[a-z][a-z0-9]*(?:[_./-][a-z0-9]+)+\b/gu),
    ...text.matchAll(/\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g),
    ...text.matchAll(/`[^`\s]+`/gu),
    ...text.matchAll(/https?:\/\/[^\s]+|[^\s@]+@[^\s@]+/gu),
  ].map((match) => normalizedAtom(match[0]));
  return [...new Set(tokens)];
}

export function findEditorialProvenanceFailure(
  plan: Pick<SlidePlan, "slides" | "claims">,
): EditorialProvenanceFailure | undefined {
  const claims = new Map(plan.claims.map((claim) => [claim.id, claim] as const));
  for (const [index, slide] of plan.slides.entries()) {
    for (const field of displayFields(slide, index)) {
      const claimIds = slide.bindings[field.bindingKey] ?? [];
      const supported = new Set(claimIds.flatMap((claimId) => {
        const claim = claims.get(claimId);
        if (claim === undefined) return [];
        return atomicFacts([
          claim.text,
          ...claim.sources.map((source) => source.evidenceQuote),
        ].join("\n"));
      }));
      const unsupportedAtoms = atomicFacts(field.text)
        .filter((atom) => !supported.has(atom));
      if (unsupportedAtoms.length > 0) {
        return { path: field.path, unsupportedAtoms, claimIds };
      }
    }
  }
  return undefined;
}
