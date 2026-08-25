import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { ChatTransport } from "../llm.ts";
import type { CompileJobId, CompileUpdate } from "../session.ts";
import type { SlidePlannerCompletion } from "./planning/planner.ts";
import type { SlidePlan } from "./model/plan.ts";
import { parseSlidePlan } from "./model/plan-parser.ts";
import { runSlidePlanPipeline, type SlidePlanPublicationResult } from "./server-pipeline.ts";
import {
  createProductionAssetPolicy,
  identifyTranscript,
  installMeetingPaperFont,
  productionTextPolicies,
  sha256,
  ScriptAwareTextMeasurer,
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
  readonly now: () => string;
  readonly send: (event: CompileUpdate) => void;
  /** Durable commit boundary. Success is emitted only after this resolves. */
  readonly commit?: (result: SlidePlanPublicationResult) => void | Promise<void>;
}

function completionFor(transport: ChatTransport): SlidePlannerCompletion {
  return (request) => transport.chat(request.userPrompt, {
    system: request.systemPrompt,
    temperature: 0,
    maxTokens: 16_000,
  });
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
    const revisionSuffix = persistedRevision === undefined
      ? ""
      : `-r${persistedRevision.revision}-${sha256(JSON.stringify(persistedRevision)).slice(0, 12)}`;
    const publicationName = `meeting-${input.meetingId}-${snapshot.contentSha256}-${sha256(planId).slice(0, 12)}${revisionSuffix}`;
    const result = await runSlidePlanPipeline({
      snapshot,
      planner: { complete: completionFor(input.transport), createId: () => planId, now: () => timestamp },
      ...(persistedRevision === undefined ? {} : { existingPlan: persistedRevision }),
      theme: MEETING_PAPER_STYLE_PROFILE,
      managedAssetRoot: cacheRoot,
      assetPolicy: createProductionAssetPolicy(cacheRoot),
      textMeasurer: new ScriptAwareTextMeasurer(),
      textPolicies: productionTextPolicies(),
      preflight: {},
      stagingDirectory: resolve(outputRoot, `.${publicationName}.tmp`),
      finalDirectory: resolve(outputRoot, publicationName),
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
    });
    return result;
  } catch (error) {
    if (!terminalSent) {
      terminalSent = true;
      input.send({
        type: "compile", status: "error", jobId: input.jobId,
        meetingId: input.meetingId, error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
