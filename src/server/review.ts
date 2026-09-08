import type { ClientListener, ReviewUpdate } from "../protocol.ts";
import { MinutesStore, type ReviewState } from "../minutes-store.ts";
import { MinutesExtractor } from "../extract.ts";
import { startReview } from "../start-review.ts";
import { concludeMeeting } from "../conclusion.ts";
import type { ServerWebSocket } from "bun";
import type { ApplicationPaths } from "./application.ts";
import type { DetectorState } from "./providers.ts";
import type { CaptureController } from "./capture.ts";
import {
  requestError,
  validMeetingId,
  type WsActionHandler,
  type WsCommand,
  type ReviewMutationIdentity,
} from "./websocket.ts";
import { reviewSnapshotForMeeting as durableReviewSnapshot } from "../review-snapshot.ts";

export function createReviewController(deps: {
  readonly minutesStore: MinutesStore;
  readonly detector: DetectorState;
  readonly capture: CaptureController;
  readonly broadcast: ClientListener;
  readonly paths: ApplicationPaths;
}) {
  const { minutesStore, detector, capture, broadcast, paths } = deps;
  const { bundleOutputRoot, bundleTargetCommit } = paths;
  const reviewSnapshotForMeeting = (id: number) => durableReviewSnapshot(minutesStore, id);
  type ReviewItemKind = "decision" | "action_item" | "open_item";
  type ReviewItemPatch = Parameters<MinutesStore["updateItem"]>[3];
  function reviewRequestError(code: string, message: string): Error {
    return new Error(`[${code}] ${message}`);
  }
  function parseReviewId(value: unknown, field: "reviewId" | "itemId"): string {
    if (typeof value !== "string" || !value.trim()) {
      throw reviewRequestError("INVALID_REVIEW_REQUEST", `${field} must be a non-blank string`);
    }
    return value.trim();
  }
  function parseReviewKind(value: unknown): ReviewItemKind {
    if (value !== "decision" && value !== "action_item" && value !== "open_item") {
      throw reviewRequestError("INVALID_REVIEW_REQUEST", "kind must be decision, action_item, or open_item");
    }
    return value;
  }
  function parseReviewPatch(value: unknown, kind: ReviewItemKind): ReviewItemPatch {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw reviewRequestError("INVALID_REVIEW_PATCH", "patch must be an object");
    }
    const raw = value as Record<string, unknown>;
    const allowed = new Set(["description", "attributedAttendeeId", "reviewState"]);
    if (kind === "action_item") {
      allowed.add("assigneeAttendeeId");
      allowed.add("deadline");
      allowed.add("deadlineText");
    }
    const unsupported = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unsupported.length > 0) {
      throw reviewRequestError("INVALID_REVIEW_PATCH", `unsupported patch field: ${unsupported.sort()[0]}`);
    }
    if (Object.keys(raw).length === 0) throw reviewRequestError("INVALID_REVIEW_PATCH", "patch must not be empty");
    const patch: ReviewItemPatch = {};
    if (raw.description !== undefined) {
      if (typeof raw.description !== "string" || !raw.description.trim()) {
        throw reviewRequestError("INVALID_REVIEW_PATCH", "description must be a non-blank string");
      }
      patch.description = raw.description.trim();
    }
    for (const field of ["attributedAttendeeId", "assigneeAttendeeId"] as const) {
      if (raw[field] !== undefined) {
        if (raw[field] !== null && (typeof raw[field] !== "string" || !raw[field].trim())) {
          throw reviewRequestError("INVALID_REVIEW_PATCH", `${field} must be a non-blank string or null`);
        }
        patch[field] = raw[field] === null ? null : (raw[field] as string).trim();
      }
    }
    if (raw.deadline !== undefined) {
      if (raw.deadline !== null && (typeof raw.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.deadline))) {
        throw reviewRequestError("INVALID_REVIEW_PATCH", "deadline must be YYYY-MM-DD or null");
      }
      patch.deadline = raw.deadline as string | null;
    }
    if (raw.deadlineText !== undefined) {
      if (raw.deadlineText !== null && (typeof raw.deadlineText !== "string" || !raw.deadlineText.trim())) {
        throw reviewRequestError("INVALID_REVIEW_PATCH", "deadlineText must be a non-blank string or null");
      }
      patch.deadlineText = raw.deadlineText === null ? null : (raw.deadlineText as string).trim();
    }
    if (raw.reviewState !== undefined) {
      if (raw.reviewState !== "candidate" && raw.reviewState !== "confirmed" && raw.reviewState !== "rejected") {
        throw reviewRequestError("INVALID_REVIEW_PATCH", "reviewState must be candidate, confirmed, or rejected");
      }
      patch.reviewState = raw.reviewState as ReviewState;
    }
    return patch;
  }
  function reviewMutationIdentity(cmd: WsCommand): ReviewMutationIdentity {
    const reviewId = typeof cmd.reviewId === "string" && cmd.reviewId.trim() ? cmd.reviewId.trim() : null;
    const persisted = reviewId === null ? null : minutesStore.review(reviewId);
    return {
      mutationAction: cmd.action === "confirmReview" ? "confirmReview" : "updateItem",
      meetingId: persisted?.meetingId ?? (validMeetingId(cmd.meetingId) ? cmd.meetingId : null),
      reviewId,
      ...(cmd.action === "updateItem"
        ? {
            itemId: typeof cmd.itemId === "string" && cmd.itemId.trim() ? cmd.itemId.trim() : null,
          }
        : {}),
    };
  }
  const confirmations = new Set<Promise<void>>();
  const deliveries = new Set<Promise<void>>();
  const reviewRuns = new Map<
    string,
    {
      promise: Promise<ReviewUpdate>;
      requesters: Set<ServerWebSocket<undefined>>;
    }
  >();
  const handleStartReview: WsActionHandler = ({ ws, cmd }) => {
    if (capture.capturing) {
      requestError(ws, new Error("capture must be stopped before starting review"));
      return;
    }
    if (!validMeetingId(cmd.meetingId)) {
      requestError(ws, new Error("검토할 회의 ID가 올바르지 않습니다"));
      return;
    }
    const meetingId = cmd.meetingId;
    const meta = minutesStore.meetingMeta(meetingId);
    if (!meta) {
      requestError(ws, new Error("검토할 회의를 찾을 수 없습니다"));
      return;
    }
    if (meta?.phase !== "ended") {
      requestError(ws, new Error(`meeting ${meetingId} must be ended before review`));
      return;
    }
    const canonical = minutesStore.canonicalVersion(meetingId);
    if (!canonical) {
      requestError(ws, new Error(`meeting ${meetingId} has no canonical transcript version`));
      return;
    }
    const key = `${meetingId}:${canonical.transcriptVersionId}`;
    const notes = typeof cmd.notes === "string" && cmd.notes.trim() ? cmd.notes.trim() : undefined;
    const existingReview = minutesStore.reviewForMeeting(meetingId, canonical.transcriptVersionId);
    const shouldReplace = existingReview?.status === "draft" && (notes !== undefined || cmd.retry === true);
    const persisted = reviewSnapshotForMeeting(meetingId);
    if (persisted && !shouldReplace) {
      ws.send(JSON.stringify(persisted));
      return;
    }
    const active = reviewRuns.get(key);
    if (active) {
      active.requesters.add(ws);
      return;
    }
    ws.send(JSON.stringify({ type: "status" as const, text: "회의록 정리 중…" }));
    const promise = startReview({
      meetingId,
      store: minutesStore,
      extractor: new MinutesExtractor(detector.extractionTransport),
      ...(notes === undefined ? {} : { notes }),
    }).then((update) => {
      const snapshot = reviewSnapshotForMeeting(meetingId);
      if (!snapshot) throw new Error(`review snapshot for meeting ${meetingId} was not persisted`);
      return update.usedFallback === true ? { ...snapshot, usedFallback: true } : snapshot;
    });
    const run = { promise, requesters: new Set([ws]) };
    reviewRuns.set(key, run);
    const delivery = promise
      .then((review) => {
        for (const requester of run.requesters) {
          if (requester.readyState === 1) requester.send(JSON.stringify(review));
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[review] 추출 실패: ${message}`);
        for (const requester of run.requesters) {
          try {
            requester.send(JSON.stringify({ type: "status" as const, text: "회의록을 정리하지 못했습니다" }));
          } catch {
            /* requester disconnected */
          }
        }
      })
      .finally(() => {
        if (reviewRuns.get(key) === run) reviewRuns.delete(key);
        deliveries.delete(delivery);
      });
    deliveries.add(delivery);
  };
  const handleUpdateItem: WsActionHandler = ({ cmd }) => {
    const reviewId = parseReviewId(cmd.reviewId, "reviewId");
    const itemId = parseReviewId(cmd.itemId, "itemId");
    const kind = parseReviewKind(cmd.kind);
    const patch = parseReviewPatch(cmd.patch, kind);
    const review = minutesStore.review(reviewId);
    if (review && cmd.meetingId !== undefined && cmd.meetingId !== review.meetingId) {
      throw reviewRequestError(
        "REVIEW_MEETING_MISMATCH",
        `review ${reviewId} does not belong to meeting ${String(cmd.meetingId)}`,
      );
    }
    minutesStore.updateItem(reviewId, kind, itemId, patch);
    const updated = minutesStore.review(reviewId)!;
    broadcast({ type: "reviewItemUpdated", meetingId: updated.meetingId, reviewId, itemId, kind });
    const snapshot = reviewSnapshotForMeeting(updated.meetingId);
    if (snapshot) broadcast(snapshot);
  };
  const handleConfirmReview: WsActionHandler = ({ ws, cmd }) => {
    const reviewId = parseReviewId(cmd.reviewId, "reviewId");
    const initialReview = minutesStore.review(reviewId);
    if (initialReview && cmd.meetingId !== undefined && cmd.meetingId !== initialReview.meetingId) {
      throw reviewRequestError(
        "REVIEW_MEETING_MISMATCH",
        `review ${reviewId} does not belong to meeting ${String(cmd.meetingId)}`,
      );
    }
    const work = concludeMeeting(reviewId, {
      store: minutesStore,
      outputRoot: bundleOutputRoot,
      projectRoot: paths.projectRoot,
      targetCommit: bundleTargetCommit,
    })
      .then((conclusion) => {
        const review = minutesStore.review(reviewId)!;
        broadcast({
          type: "reviewConfirmed",
          meetingId: review.meetingId,
          reviewId,
          transcriptVersionId: review.transcriptVersionId,
          confirmedAt: review.confirmedAt!,
        });
        broadcast(conclusion);
        const snapshot = reviewSnapshotForMeeting(review.meetingId);
        if (snapshot) broadcast(snapshot);
      })
      .catch((error: unknown) => requestError(ws, error, reviewMutationIdentity(cmd)))
      .finally(() => confirmations.delete(work));
    confirmations.add(work);
  };
  return {
    handlers: new Map<string, WsActionHandler>([
      ["startReview", handleStartReview],
      ["updateItem", handleUpdateItem],
      ["confirmReview", handleConfirmReview],
    ]),
    reviewMutationIdentity,
    async close() {
      await Promise.all([...confirmations, ...deliveries]);
    },
  };
}
