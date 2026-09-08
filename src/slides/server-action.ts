import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { ChatTransport } from "../llm.ts";
import { SlidePlanFinalityError } from "../slide-plan-finality.ts";
import type { CompileJobId, CompileUpdate } from "../session.ts";
import { SlidePlannerError, type SlidePlannerCompletion } from "./planning/planner.ts";
import type { SlidePlan } from "./model/plan.ts";
import { parseSlidePlan } from "./model/plan-parser.ts";
import { productionTextPolicies, ScriptAwareTextMeasurer } from "./geometry/production-text.ts";
import { runSlidePlanPipeline, type SlidePlanPublicationResult } from "./server-pipeline.ts";
import { publicationStatusForReview } from "./server-pipeline-publication.ts";
import {
  createProductionAssetPolicy,
  identifyTranscript,
  installMeetingPaperFont,
  sha256,
  type SlidePlanTranscriptInput,
} from "./server-action-support.ts";
import { createSlidePlanPublishers, type SlidePlanPublisherTools } from "./server-publishers.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "./theme/meeting-paper.ts";

export type { SlidePlanTranscriptInput } from "./server-action-support.ts";
export type { SlidePlanPublisherTools } from "./server-publishers.ts";

export interface RunSlidePlanServerActionInput {
  readonly jobId: CompileJobId;
  readonly meetingId: number;
  readonly transcript: SlidePlanTranscriptInput;
  readonly persistPlan?: SlidePlan;
  readonly transport: ChatTransport;
  readonly outputRoot: string;
  readonly cacheRoot: string;
  readonly fontSourcePath: string;
  readonly tools: SlidePlanPublisherTools;
  readonly createId: () => string;
  readonly retainedDraftPlanId?: string;
  readonly now: () => string;
  readonly send: (event: CompileUpdate) => void;
  /** Durable commit boundary. Success is emitted only after this resolves. */
  readonly commit?: (result: SlidePlanPublicationResult) => void | Promise<void>;
}

const SLIDE_PLANNER_TIMEOUT_MS = 600_000;

export type SlidePlanJobOwner = Readonly<{
  meetingId: number;
  action: "compileSlidePlan" | "persistSlidePlan" | "exportPdf" | "exportPng";
}>;

type MeetingDeletionResult =
  | Readonly<{ kind: "blocked"; message: string }>
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "not-found" }>;

export function deleteMeetingForJobState(input: Readonly<{
  meetingId: number;
  activeJob: SlidePlanJobOwner | null;
  deleteHistory: (meetingId: number) => boolean;
}>): MeetingDeletionResult {
  if (input.activeJob?.meetingId === input.meetingId) {
    return { kind: "blocked", message: "슬라이드 작업 중인 회의는 삭제할 수 없습니다" };
  }
  return input.deleteHistory(input.meetingId) ? { kind: "deleted" } : { kind: "not-found" };
}

function completionFor(transport: ChatTransport, forcedRevision?: 0): SlidePlannerCompletion {
  return async (request) => {
    const output = await transport.chat(request.userPrompt, {
      system: request.systemPrompt,
      temperature: 0,
      maxTokens: 16_000,
      timeoutMs: SLIDE_PLANNER_TIMEOUT_MS,
    });
    if (forcedRevision === undefined) return output;
    const decoded: unknown = JSON.parse(output);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return output;
    return JSON.stringify({ ...decoded, revision: forcedRevision });
  };
}

export function compileErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof SlidePlannerError) || error.validationFailure === undefined) return message;
  const failure = error.validationFailure;
  const location = failure.path === undefined ? "" : ` @ ${failure.path}`;
  return `${message} [${failure.kind}] ${failure.message}${location}`;
}

function confirmedReviewConfirmedAt(input: RunSlidePlanServerActionInput): number | undefined {
  const review = input.transcript.confirmedReview;
  if (review === undefined) return undefined;
  const value = Object.getOwnPropertyDescriptor(review, "confirmedAt")?.value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("confirmed Review evidence is missing confirmedAt");
  }
  return value;
}

function validatePaths(input: RunSlidePlanServerActionInput): void {
  for (const [name, value] of [["outputRoot", input.outputRoot], ["cacheRoot", input.cacheRoot], ["fontSourcePath", input.fontSourcePath]] as const) {
    if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new TypeError(`${name} must be a non-empty path`);
  }
  if (typeof input.createId !== "function" || typeof input.now !== "function" || typeof input.send !== "function") {
    throw new TypeError("createId, now, and send callbacks are required");
  }
}

export async function runSlidePlanServerAction(
  input: RunSlidePlanServerActionInput,
): Promise<SlidePlanPublicationResult> {
  let terminalSent = false;
  try {
    validatePaths(input);
    const confirmedAt = confirmedReviewConfirmedAt(input);
    const snapshot = identifyTranscript(input.meetingId, input.transcript);
    const outputRoot = resolve(input.outputRoot);
    const cacheRoot = resolve(input.cacheRoot);
    await installMeetingPaperFont(cacheRoot, input.fontSourcePath);
    const timestamp = input.now();
    const persistedRevision = input.persistPlan === undefined ? undefined : parseSlidePlan({
      ...input.persistPlan,
      updatedAt: timestamp,
    });
    const planId = persistedRevision?.planId ?? input.createId();
    if (snapshot.confirmedReview !== undefined && persistedRevision === undefined && planId === input.retainedDraftPlanId) {
      throw new TypeError("confirmed compile cannot reuse the retained draft plan ID");
    }
    const publicationStatus = publicationStatusForReview(snapshot.confirmedReview?.reviewId);
    const revisionSuffix = persistedRevision === undefined
      ? ""
      : `-r${persistedRevision.revision}-${sha256(JSON.stringify(persistedRevision)).slice(0, 12)}`;
    const publicationName = `meeting-${input.meetingId}-${snapshot.contentSha256}-${sha256(planId).slice(0, 12)}-${publicationStatus}${revisionSuffix}`;
    const result = await runSlidePlanPipeline({
      snapshot,
      planner: {
        complete: completionFor(
          input.transport,
          publicationStatus === "final" && persistedRevision === undefined ? 0 : undefined,
        ),
        createId: () => planId,
        now: () => timestamp,
      },
      ...(persistedRevision === undefined ? {} : { existingPlan: persistedRevision }),
      theme: MEETING_PAPER_STYLE_PROFILE,
      managedAssetRoot: cacheRoot,
      assetPolicy: createProductionAssetPolicy(cacheRoot),
      textMeasurer: new ScriptAwareTextMeasurer(),
      textPolicies: productionTextPolicies(),
      preflight: {},
      stagingDirectory: resolve(outputRoot, `.${publicationName}.tmp`),
      finalDirectory: resolve(outputRoot, publicationName),
      ...(confirmedAt === undefined ? {} : { confirmedReviewConfirmedAt: confirmedAt }),
      publishers: createSlidePlanPublishers(input.tools),
      onProgress: (progress) => input.send({
        type: "compile", status: "progress", jobId: input.jobId, meetingId: input.meetingId,
        stage: progress.phase, completed: progress.completed, total: progress.total,
      }),
    });
    try {
      await input.commit?.(result);
    } catch (error) {
      // The publication is not durable without its SQLite receipt. Do not leave
      // an unaddressable final directory behind after a failed commit.
      await rm(result.directory, { recursive: true, force: true });
      throw error;
    }
    terminalSent = true;
    input.send({
      type: "compile", status: "success", jobId: input.jobId,
      meetingId: input.meetingId, path: result.directory,
      publicationStatus: result.publicationStatus,
    });
    return result;
  } catch (error) {
    if (!terminalSent) {
      terminalSent = true;
      const update: CompileUpdate = {
        type: "compile", status: "error", jobId: input.jobId,
        meetingId: input.meetingId, error: compileErrorText(error),
        ...(error instanceof SlidePlanFinalityError ? { code: "stale-review-lineage" as const } : {}),
      };
      input.send(update);
    }
    throw error;
  }
}
