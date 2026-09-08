import type { ClientListener, ExportUpdate, RefineUpdate } from "../protocol.ts";
import { MeetingStore } from "../store.ts";
import { MinutesStore } from "../minutes-store.ts";
import { validateSlidePlanRevision } from "../slide-plan-revision.ts";
import { SlidePlanStore } from "../slide-plan-store.ts";
import { LayoutRegistryError } from "../slides/layouts/contract.ts";
import { geometrySlidesForPlan } from "../slides/geometry/plan-geometry.ts";
import { parseSlidePlan, type SlidePlan } from "../slides/model/plan-parser.ts";
import { compileErrorText, runSlidePlanServerAction, type SlidePlanTranscriptInput } from "../slides/server-action.ts";
import { productionTextPolicies, ScriptAwareTextMeasurer } from "../slides/server-action-support.ts";
import { confirmedReviewEvidence } from "../slides/server-review-evidence.ts";
import { RefineFieldError, refineSlideField } from "../slides/planning/refine-field.ts";
import { randomUUID } from "node:crypto";
import type { CompileJobId, ExportJobId } from "../protocol.ts";
import type { DetectorState } from "./providers.ts";
import { validMeetingId, type WsActionHandler } from "./websocket.ts";

export type ArtifactJobs = {
  activeJob: {
    id: CompileJobId | ExportJobId;
    meetingId: number;
    action: "compileSlidePlan" | "persistSlidePlan" | "exportPdf" | "exportPng";
  } | null;
  activeExportUpdate: ExportUpdate | null;
  lastSavedPath: string | null;
  pending: Set<Promise<unknown>>;
};
export function createSlidesController(deps: {
  readonly store: MeetingStore;
  readonly minutesStore: MinutesStore;
  readonly slidePlanStore: SlidePlanStore;
  readonly artifacts: ArtifactJobs;
  readonly detector: DetectorState;
  readonly broadcast: ClientListener;
  readonly slidePlanRuntime: {
    outputRoot: string;
    cacheRoot: string;
    fontSourcePath: string;
    tools: {
      slidesGrabPath: string;
      playwrightBrowsersPath: string;
      sandboxExecutable: string;
      sandboxProfile: string;
      timeoutMs: number;
    };
  };
  readonly runSlidePlan?: typeof runSlidePlanServerAction;
}) {
  const { store, minutesStore, slidePlanStore, artifacts, detector, broadcast, slidePlanRuntime } = deps;
  const runSlidePlan = deps.runSlidePlan ?? runSlidePlanServerAction;
  function slidePlanTranscriptFor(meetingId: number): SlidePlanTranscriptInput {
    const canonical = minutesStore.canonicalVersion(meetingId);
    const review = canonical === null ? null : minutesStore.reviewForMeeting(meetingId, canonical.transcriptVersionId);
    const confirmedReview =
      canonical === null
        ? undefined
        : confirmedReviewEvidence(
            review,
            review?.status === "confirmed" ? minutesStore.itemsForReview(review.reviewId) : [],
            canonical.transcriptVersionId,
            minutesStore.attendeesFor(meetingId).map(({ attendeeId, displayName }) => ({ attendeeId, displayName })),
          );
    if (canonical?.contentSha256) {
      return {
        state: "finalized",
        transcriptVersionId: canonical.transcriptVersionId,
        contentSha256: canonical.contentSha256,
        ...(confirmedReview === undefined ? {} : { confirmedReview }),
        lines: minutesStore.transcriptVersionLines(canonical.transcriptVersionId).map((line) => ({
          seq: line.seq,
          speaker: line.speakerTurn === null ? null : String(line.speakerTurn),
          text: line.text,
        })),
      };
    }
    return {
      state: "live",
      lines: store.lines(meetingId).map((line) => ({
        seq: line.seq,
        speaker: line.speaker === null ? null : String(line.speaker),
        text: line.text,
      })),
    };
  }
  function geometryForSlidePlan(plan: SlidePlan) {
    try {
      return geometrySlidesForPlan(plan, {
        textMeasurer: new ScriptAwareTextMeasurer(),
        textPolicies: productionTextPolicies(),
      });
    } catch (error) {
      if (error instanceof LayoutRegistryError || error instanceof TypeError) return undefined;
      throw error;
    }
  }
  function startSlidePlanJob(
    action: "compileSlidePlan" | "persistSlidePlan",
    jobId: CompileJobId,
    meetingId: number,
    persistPlan?: SlidePlan,
  ): void {
    let transcript: SlidePlanTranscriptInput;
    let retainedDraftPlanId: string | undefined;
    try {
      transcript = slidePlanTranscriptFor(meetingId);
      if (persistPlan !== undefined) {
        validateSlidePlanRevision(slidePlanStore.one(persistPlan.planId), persistPlan, transcript);
      } else if (transcript.confirmedReview !== undefined) {
        retainedDraftPlanId = slidePlanStore
          .list(meetingId)
          .find((publication) => publication.publicationStatus === "draft")?.plan.planId;
      }
    } catch (error) {
      broadcast({
        type: "compile",
        status: "error",
        jobId,
        meetingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    artifacts.activeJob = { id: jobId, meetingId, action };
    broadcast({ type: "compile", status: "started", jobId, meetingId, stage: "planning" });
    const work = runSlidePlan({
      jobId,
      meetingId,
      transcript,
      ...(persistPlan === undefined ? {} : { persistPlan }),
      transport: detector.extractionTransport,
      ...slidePlanRuntime,
      createId: randomUUID,
      ...(retainedDraftPlanId === undefined ? {} : { retainedDraftPlanId }),
      now: () => new Date().toISOString(),
      send: broadcast,
      commit: (result) => {
        slidePlanStore.save(result);
        artifacts.lastSavedPath = result.directory;
        broadcast({ type: "saved", path: result.directory });
      },
    })
      .catch((error) => {
        console.error(`[slide-plan] ${compileErrorText(error)}`);
      })
      .finally(() => {
        if (artifacts.activeJob?.id === jobId) artifacts.activeJob = null;
        artifacts.pending.delete(work);
      });
    artifacts.pending.add(work);
  }
  function refineErrorUpdate(requestId: string, error: string): RefineUpdate {
    return { type: "refine", requestId, slideId: "", path: "", before: "", after: "", claimIds: [], error };
  }
  const handleRefineSlideField: WsActionHandler = ({ ws, cmd }) => {
    const meetingId = Number(cmd.meetingId ?? 0);
    const requestId = typeof cmd.requestId === "string" ? cmd.requestId : randomUUID();
    const slideId = typeof cmd.slideId === "string" ? cmd.slideId : "";
    const path = typeof cmd.path === "string" ? cmd.path : "";
    const text = typeof cmd.text === "string" ? cmd.text : "";
    const instruction = typeof cmd.instruction === "string" ? cmd.instruction : "";
    const claimIds = Array.isArray(cmd.claimIds)
      ? cmd.claimIds.filter((id): id is string => typeof id === "string")
      : [];
    if (!Number.isSafeInteger(meetingId) || meetingId < 1) {
      ws.send(JSON.stringify(refineErrorUpdate(requestId, "meetingId가 필요합니다")));
      return;
    }
    if (!detector.extractionTransport) {
      ws.send(JSON.stringify(refineErrorUpdate(requestId, "사용 가능한 LLM 프로바이더가 없습니다")));
      return;
    }
    const stored = slidePlanStore.latest(meetingId);
    if (stored === null) {
      ws.send(JSON.stringify(refineErrorUpdate(requestId, "저장된 슬라이드 초안이 없습니다")));
      return;
    }
    const work = refineSlideField(
      {
        plan: stored.plan,
        slideId,
        path,
        text,
        instruction,
        claimIds,
      },
      detector.extractionTransport,
    )
      .then((proposal) => {
        const update: RefineUpdate = {
          type: "refine",
          requestId,
          slideId: proposal.slideId,
          path: proposal.path,
          before: proposal.before,
          after: proposal.after,
          claimIds: [...proposal.claimIds],
        };
        if (ws.readyState === 1) ws.send(JSON.stringify(update));
      })
      .catch((error: unknown) => {
        const message = error instanceof RefineFieldError || error instanceof Error ? error.message : String(error);
        if (ws.readyState === 1) ws.send(JSON.stringify(refineErrorUpdate(requestId, message)));
      })
      .finally(() => artifacts.pending.delete(work));
    artifacts.pending.add(work);
  };
  const handlePersistSlidePlan: WsActionHandler = ({ ws, cmd }) => {
    const jobId: CompileJobId = `compile-${randomUUID()}`;
    const requestedMeetingId = validMeetingId(cmd.meetingId)
      ? cmd.meetingId
      : cmd.meetingId === undefined
        ? store.latestMeeting()?.id
        : undefined;
    if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
      broadcast({ type: "compile", status: "error", jobId, error: "meetingId must be a number" });
    } else if (requestedMeetingId === undefined || store.meeting(requestedMeetingId) === null) {
      broadcast({ type: "compile", status: "error", jobId, meetingId: requestedMeetingId, error: "meeting not found" });
    } else if (artifacts.activeJob !== null) {
      broadcast({
        type: "compile",
        status: "error",
        jobId,
        meetingId: requestedMeetingId,
        error: `A conflicting ${artifacts.activeJob.action} job is already in progress`,
      });
    } else {
      try {
        const persistPlan = parseSlidePlan(
          (
            cmd as {
              plan?: unknown;
            }
          ).plan,
        );
        startSlidePlanJob("persistSlidePlan", jobId, requestedMeetingId, persistPlan);
      } catch (error) {
        broadcast({
          type: "compile",
          status: "error",
          jobId,
          meetingId: requestedMeetingId,
          error: error instanceof Error ? error.message : "invalid SlidePlan",
        });
      }
    }
  };
  const handleCompileSlidePlan: WsActionHandler = ({ ws, cmd }) => {
    const jobId: CompileJobId = `compile-${randomUUID()}`;
    const requestedMeetingId = validMeetingId(cmd.meetingId)
      ? cmd.meetingId
      : cmd.meetingId === undefined
        ? store.latestMeeting()?.id
        : undefined;
    if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
      broadcast({ type: "compile", status: "error", jobId, error: "meetingId must be a number" });
    } else if (requestedMeetingId === undefined || store.meeting(requestedMeetingId) === null) {
      broadcast({ type: "compile", status: "error", jobId, meetingId: requestedMeetingId, error: "meeting not found" });
    } else if (artifacts.activeJob !== null) {
      broadcast({
        type: "compile",
        status: "error",
        jobId,
        meetingId: requestedMeetingId,
        error: `A conflicting ${artifacts.activeJob.action} job is already in progress`,
      });
    } else {
      startSlidePlanJob("compileSlidePlan", jobId, requestedMeetingId);
    }
  };
  const handleExportDeck: WsActionHandler = ({ ws, cmd }) => {
    if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
      ws.send(JSON.stringify({ type: "status" as const, text: "meetingId must be a number" }));
    } else {
      const requestedMeetingId = validMeetingId(cmd.meetingId) ? cmd.meetingId : store.latestMeeting()?.id;
      if (requestedMeetingId === undefined || store.meeting(requestedMeetingId) === null) {
        ws.send(JSON.stringify({ type: "status" as const, text: "저장된 회의가 없습니다" }));
      } else {
        const slidePlan = slidePlanStore.latest(requestedMeetingId);
        if (slidePlan === null) {
          ws.send(JSON.stringify({ type: "status" as const, text: "먼저 슬라이드 초안을 만들어 주세요" }));
        } else {
          artifacts.lastSavedPath = `/slide-plan-artifacts/${encodeURIComponent(slidePlan.plan.planId)}/standalone/index.html`;
          broadcast({ type: "saved", path: artifacts.lastSavedPath });
        }
      }
    }
  };
  return {
    handlers: new Map<string, WsActionHandler>([
      ["persistSlidePlan", handlePersistSlidePlan],
      ["compileSlidePlan", handleCompileSlidePlan],
      ["exportDeck", handleExportDeck],
      ["refineSlideField", handleRefineSlideField],
    ]),
    slidePlanTranscriptFor,
    geometryForSlidePlan,
  };
}
