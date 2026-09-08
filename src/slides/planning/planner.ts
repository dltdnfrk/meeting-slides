import { randomUUID } from "node:crypto";

import { parseSlidePlan, SlidePlanParseError } from "../model/plan-parser.ts";
import { findLayoutSelectionFailure } from "../layouts/selection.ts";
import type { SlidePlan, SnapshotIdentity, Theme } from "../model/plan.ts";
import { findEvidenceMismatch } from "./evidence.ts";
import {
  EditorialCopyingError,
  EditorialProvenanceError,
  EditorialStatusError,
  findEditorialCopying,
  findEditorialProvenanceFailure,
  findEditorialStatusFailure,
} from "./editorial-validation.ts";
import { sanitizeModelContent } from "./model-output.ts";
import { buildSlidePlannerUserPrompt, SLIDE_PLANNER_SYSTEM_PROMPT } from "./prompt.ts";
import { hasUsableTranscript } from "./transcript-quality.ts";
import {
  validateConfirmedReview,
  type ConfirmedReviewEvidence,
} from "./review-evidence.ts";

export type {
  ConfirmedReviewEvidence, ConfirmedReviewItem, ConfirmedReviewItemKind,
} from "./review-evidence.ts";

export interface TranscriptLine {
  readonly seq: number;
  readonly speaker: string | null;
  readonly text: string;
}

export interface TranscriptSnapshot {
  readonly state: "live" | "finalized";
  readonly meetingId: number;
  readonly transcriptVersionId: string;
  readonly contentSha256: string;
  readonly lines: readonly TranscriptLine[];
  readonly confirmedReview?: ConfirmedReviewEvidence;
}

export type SlidePlannerAttempt = "initial" | "repair";

export interface SlidePlannerValidationFailure {
  readonly kind: "contract-invalid" | "evidence-mismatch" | "editorial-copying" |
    "editorial-status" | "editorial-provenance" | "completion-failed";
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SlidePlannerCompletionRequest {
  readonly attempt: SlidePlannerAttempt;
  readonly responseFormat: "json";
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly snapshot: TranscriptSnapshot;
  readonly validationFailure?: SlidePlannerValidationFailure;
}

export type SlidePlannerCompletion = (
  request: SlidePlannerCompletionRequest,
) => Promise<string>;

export interface SlidePlannerOptions {
  readonly complete: SlidePlannerCompletion;
  readonly createId?: () => string;
  readonly now?: () => string;
  /** Server-owned style profile; when supplied it replaces whatever theme the model emitted. */
  readonly theme?: Theme;
}

export type SlidePlannerErrorCode = "insufficient-transcript" | "model-output-invalid";

export class SlidePlannerError extends Error {
  readonly code: SlidePlannerErrorCode;
  readonly attempts: number;
  readonly validationFailure?: SlidePlannerValidationFailure;

  constructor(
    code: SlidePlannerErrorCode,
    attempts: number,
    message: string,
    validationFailure?: SlidePlannerValidationFailure,
  ) {
    super(message);
    this.name = "SlidePlannerError";
    this.code = code;
    this.attempts = attempts;
    this.validationFailure = validationFailure;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function captureSnapshot(snapshot: TranscriptSnapshot): TranscriptSnapshot {
  const captured = structuredClone(snapshot);
  validateConfirmedReview(captured);
  return deepFreeze(captured);
}

function snapshotIdentity(snapshot: TranscriptSnapshot): SnapshotIdentity {
  return {
    meetingId: snapshot.meetingId,
    transcriptVersionId: snapshot.transcriptVersionId,
    contentSha256: snapshot.contentSha256,
    lineCount: snapshot.lines.length,
  };
}

function decodeModelObject(output: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(output);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError("model output must be one JSON object");
  }
  return decoded as Record<string, unknown>;
}

function validationFailure(error: unknown): SlidePlannerValidationFailure {
  if (error instanceof SlidePlanParseError) {
    return { kind: "contract-invalid", message: error.message, path: error.path };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "contract-invalid", message };
}

function parseBoundPlan(
  output: string,
  metadata: Pick<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt"> & Partial<Pick<SlidePlan, "theme">>,
  snapshot: TranscriptSnapshot,
): SlidePlan {
  const content = sanitizeModelContent(decodeModelObject(output));
  const plan = parseSlidePlan({ ...content, ...metadata });
  validateSlidePlanAgainstSnapshot(plan, snapshot);
  return plan;
}

export function validateSlidePlanAgainstSnapshot(
  plan: SlidePlan,
  snapshot: TranscriptSnapshot,
): void {
  validateConfirmedReview(snapshot);
  const layoutFailure = findLayoutSelectionFailure(plan.slides);
  if (layoutFailure !== undefined) {
    throw new SlidePlanParseError("slides", layoutFailure.message);
  }
  const mismatch = findEvidenceMismatch(plan, snapshot);
  if (mismatch !== undefined) {
    const error = new Error(
      mismatch.reason.startsWith("review-")
        ? `claim '${mismatch.claimId}' does not preserve confirmed Review evidence (${mismatch.reason})`
        : `claim '${mismatch.claimId}' source ${mismatch.sourceIndex} is not verbatim within seq ${mismatch.startSeq}-${mismatch.endSeq}`,
    );
    Object.assign(error, { evidenceMismatch: mismatch });
    throw error;
  }
  const copying = findEditorialCopying(plan, [
    ...snapshot.lines.map((line) => line.text),
    ...(snapshot.confirmedReview?.items.map((item) => item.description) ?? []),
    ...plan.claims.flatMap((claim) => claim.sources.map((source) => source.evidenceQuote)),
  ]);
  if (copying !== undefined) throw new EditorialCopyingError(copying);
  const openClaimIds = snapshot.confirmedReview?.items
    .filter((item) => item.kind === "open_item")
    .map((item) => item.id) ?? [];
  const statusFailure = findEditorialStatusFailure(plan.slides, openClaimIds);
  if (statusFailure !== undefined) throw new EditorialStatusError(statusFailure);
  const provenanceFailure = findEditorialProvenanceFailure(plan);
  if (provenanceFailure !== undefined) throw new EditorialProvenanceError(provenanceFailure);
}

function failureFrom(error: unknown): SlidePlannerValidationFailure {
  if (error instanceof EditorialProvenanceError) {
    return {
      kind: "editorial-provenance",
      message: error.message,
      path: error.failure.path,
      details: {
        unsupportedAtoms: error.failure.unsupportedAtoms,
        claimIds: error.failure.claimIds,
      },
    };
  }
  if (error instanceof EditorialStatusError) {
    return {
      kind: "editorial-status",
      message: error.message,
      path: error.failure.path,
      details: { openClaimIds: error.failure.openClaimIds },
    };
  }
  if (error instanceof EditorialCopyingError) {
    return {
      kind: "editorial-copying",
      message: error.message,
      details: {
        copiedPaths: error.failure.copiedPaths,
        copiedFields: error.failure.copiedFields,
        eligibleFields: error.failure.eligibleFields,
      },
    };
  }
  if (error instanceof Error && "evidenceMismatch" in error) {
    const details = error.evidenceMismatch;
    if (typeof details === "object" && details !== null) {
      return { kind: "evidence-mismatch", message: error.message, details: { ...details } };
    }
  }
  return validationFailure(error);
}

export async function planTranscriptToSlides(
  suppliedSnapshot: TranscriptSnapshot,
  options: SlidePlannerOptions,
): Promise<SlidePlan> {
  if (!hasUsableTranscript(suppliedSnapshot.lines)) {
    throw new SlidePlannerError(
      "insufficient-transcript",
      0,
      "Transcript contains no substantive source material.",
    );
  }

  const snapshot = captureSnapshot(suppliedSnapshot);
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const metadata = {
    planId: createId(),
    snapshot: snapshotIdentity(snapshot),
    createdAt: now(),
    updatedAt: now(),
    ...(options.theme === undefined ? {} : { theme: structuredClone(options.theme) }),
  };
  let previousOutput: string | undefined;
  let failure: SlidePlannerValidationFailure | undefined;

  for (const attempt of ["initial", "repair"] as const) {
    const request: SlidePlannerCompletionRequest = deepFreeze({
      attempt,
      responseFormat: "json",
      systemPrompt: SLIDE_PLANNER_SYSTEM_PROMPT,
      userPrompt: buildSlidePlannerUserPrompt({
        snapshot,
        attempt,
        validationFailure: failure,
        previousOutput,
      }),
      snapshot,
      ...(failure === undefined ? {} : { validationFailure: failure }),
    });
    try {
      previousOutput = await options.complete(request);
      return parseBoundPlan(previousOutput, metadata, snapshot);
    } catch (error) {
      failure = failureFrom(error);
      if (previousOutput === undefined) {
        failure = { kind: "completion-failed", message: failure.message };
      }
    }
  }

  throw new SlidePlannerError(
    "model-output-invalid",
    2,
    "Model output did not satisfy the SlidePlan contract after one repair attempt.",
    failure,
  );
}
