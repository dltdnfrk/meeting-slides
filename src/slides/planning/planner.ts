import { randomUUID } from "node:crypto";

import { parseSlidePlan, SlidePlanParseError } from "../model/plan-parser.ts";
import type { SlidePlan, SnapshotIdentity } from "../model/plan.ts";
import { findEvidenceMismatch } from "./evidence.ts";
import { buildSlidePlannerUserPrompt, SLIDE_PLANNER_SYSTEM_PROMPT } from "./prompt.ts";
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
  readonly kind: "contract-invalid" | "evidence-mismatch" | "completion-failed";
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

const NOISE = /^(?:[\s\p{P}\p{S}]|um+|uh+|hmm+|mm+|ok(?:ay)?|yes|yeah|yep|no|thanks?|thank\s+you|hello|hi|bye|네+|예+|음+|어+|아+|감사합니다?|고맙습니다?|안녕하세요|좋아요|알겠습니다)+$/iu;

function hasUsableTranscript(snapshot: TranscriptSnapshot): boolean {
  return snapshot.lines.some((line) => {
    const text = line.text.trim();
    return text.length > 0 && /[\p{L}\p{N}]/u.test(text) && !NOISE.test(text);
  });
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
  metadata: Pick<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt">,
  snapshot: TranscriptSnapshot,
): SlidePlan {
  const content = decodeModelObject(output);
  const plan = parseSlidePlan({ ...content, ...metadata });
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
  return plan;
}

function failureFrom(error: unknown): SlidePlannerValidationFailure {
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
  if (!hasUsableTranscript(suppliedSnapshot)) {
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
