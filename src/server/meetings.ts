import { MeetingSession } from "../session.ts";
import type { ServerMessage, ClientListener } from "../protocol.ts";
import { MeetingStore } from "../store.ts";
import { deleteMeetingHistory } from "../meeting-deletion.ts";
import { MinutesStore, type AttendeeInput } from "../minutes-store.ts";
import { SlidePlanStore } from "../slide-plan-store.ts";
import { geometrySlidesForPlan } from "../slides/geometry/plan-geometry.ts";
import { type SlidePlan } from "../slides/model/plan-parser.ts";
import { deleteMeetingForJobState } from "../slides/server-action.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ApplicationPaths } from "./application.ts";
import type { ArtifactJobs } from "./slides.ts";
import type { DetectorState } from "./providers.ts";
import type { CaptureController } from "./capture.ts";
import { requestError, validMeetingId, type WsActionHandler } from "./websocket.ts";
import { reviewSnapshotForMeeting as durableReviewSnapshot } from "../review-snapshot.ts";

export interface MeetingState {
  currentMeetingId: number | null;
}
export function createMeetingsController(deps: {
  readonly store: MeetingStore;
  readonly minutesStore: MinutesStore;
  readonly slidePlanStore: SlidePlanStore;
  readonly meeting: MeetingState;
  readonly artifacts: ArtifactJobs;
  readonly detector: DetectorState;
  readonly capture: CaptureController;
  readonly session: MeetingSession;
  readonly broadcast: ClientListener;
  readonly paths: ApplicationPaths;
  readonly geometryForSlidePlan: (plan: SlidePlan) => ReturnType<typeof geometrySlidesForPlan> | undefined;
}) {
  const {
    store,
    minutesStore,
    slidePlanStore,
    meeting,
    artifacts,
    detector,
    capture,
    session,
    broadcast,
    paths,
    geometryForSlidePlan,
  } = deps;
  const reviewSnapshotForMeeting = (id: number) => durableReviewSnapshot(minutesStore, id);
  function meetingsMessage(): ServerMessage {
    return { type: "meetings", items: store.listMeetings() };
  }
  function parseAttendees(value: unknown): AttendeeInput[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error("attendees must contain at least one attendee");
    }
    const attendeeIds = new Set<string>();
    const crmPersonIds = new Set<string>();
    return value.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`attendees[${index}] must be an object`);
      }
      const attendee = raw as Record<string, unknown>;
      if (typeof attendee.name !== "string" || !attendee.name.trim()) {
        throw new Error(`attendees[${index}].name must be a non-blank string`);
      }
      let attendeeId: string;
      if (attendee.attendeeId === undefined) attendeeId = randomUUID();
      else if (typeof attendee.attendeeId !== "string" || !attendee.attendeeId.trim()) {
        throw new Error(`attendees[${index}].attendeeId must be a non-blank string when provided`);
      } else attendeeId = attendee.attendeeId.trim();
      if (attendeeIds.has(attendeeId)) throw new Error(`duplicate attendeeId: ${attendeeId}`);
      attendeeIds.add(attendeeId);
      let crmPersonEntityId: string | null = null;
      if (attendee.crmPersonId !== undefined && attendee.crmPersonId !== null) {
        if (typeof attendee.crmPersonId !== "string" || !attendee.crmPersonId.trim()) {
          throw new Error(`attendees[${index}].crmPersonId must be a non-blank string or null`);
        }
        crmPersonEntityId = attendee.crmPersonId.trim();
        if (crmPersonIds.has(crmPersonEntityId)) throw new Error(`duplicate crmPersonId: ${crmPersonEntityId}`);
        crmPersonIds.add(crmPersonEntityId);
      }
      return { attendeeId, displayName: attendee.name.trim(), crmPersonEntityId, sortOrder: index };
    });
  }
  function parsePurpose(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim()) throw new Error("purpose must be a non-blank string or null");
    return value.trim();
  }
  const handleReset: WsActionHandler = ({ ws }) => {
    if (capture.capturing || capture.captureRun) {
      requestError(ws, new Error("capture must be stopped before reset"));
      return;
    }
    session.reset();
    store.endMeeting();
    if (meeting.currentMeetingId !== null && minutesStore.meetingMeta(meeting.currentMeetingId)?.phase !== "ended") {
      minutesStore.endMeeting(meeting.currentMeetingId);
    }
    meeting.currentMeetingId = null;
    broadcast(session.transcript("snapshot"));
    broadcast(meetingsMessage());
  };
  const handleSetAttendees: WsActionHandler = ({ cmd }) => {
    const attendees = parseAttendees(cmd.attendees);
    const purpose = parsePurpose(cmd.purpose);
    const currentPhase =
      meeting.currentMeetingId === null ? null : minutesStore.meetingMeta(meeting.currentMeetingId)?.phase;
    if (meeting.currentMeetingId !== null && currentPhase === "capturing") {
      throw new Error(`meeting ${meeting.currentMeetingId} is not prepared`);
    }
    const endedReview =
      meeting.currentMeetingId !== null && currentPhase === "ended"
        ? minutesStore.reviewForMeeting(meeting.currentMeetingId)
        : null;
    if (endedReview?.status === "confirmed") {
      throw new Error(`meeting ${meeting.currentMeetingId} attendees are locked after review confirmation`);
    }
    const reusableMeetingId =
      meeting.currentMeetingId !== null && (currentPhase === "prepared" || endedReview?.status === "draft")
        ? meeting.currentMeetingId
        : null;
    const meetingId =
      reusableMeetingId ?? minutesStore.ensurePreparedMeeting(detector.currentProviderId, purpose ?? null);
    const meta = minutesStore.meetingMeta(meetingId);
    if (!meta) throw new Error(`unknown meeting ${meetingId}`);
    if (meta.phase !== "prepared" && !(meta.phase === "ended" && endedReview?.status === "draft")) {
      throw new Error(`meeting ${meetingId} is not prepared`);
    }
    minutesStore.replaceAttendees(meetingId, attendees);
    if (purpose !== undefined) minutesStore.setMeetingPurpose(meetingId, purpose);
    meeting.currentMeetingId = meetingId;
    broadcast({
      type: "attendees",
      meeting_id: meetingId,
      attendees: minutesStore.attendeesFor(meetingId).map((attendee) => ({
        attendee_id: attendee.attendeeId,
        display_name: attendee.displayName,
        ...(attendee.crmPersonEntityId === null ? {} : { crm_person_entity_id: attendee.crmPersonEntityId }),
      })),
    });
  };
  const handleAttendeesQuery: WsActionHandler = ({ ws }) => {
    const restoredId = meeting.currentMeetingId;
    const canReuse = restoredId !== null && minutesStore.meetingMeta(restoredId)?.phase === "prepared";
    ws.send(
      JSON.stringify({
        type: "attendees" as const,
        meeting_id: canReuse ? restoredId : null,
        attendees:
          !canReuse || restoredId === null
            ? []
            : minutesStore.attendeesFor(restoredId).map((attendee) => ({
                attendee_id: attendee.attendeeId,
                display_name: attendee.displayName,
                ...(attendee.crmPersonEntityId === null ? {} : { crm_person_entity_id: attendee.crmPersonEntityId }),
              })),
      }),
    );
  };
  const handleListMeetings: WsActionHandler = ({ ws, cmd }) => {
    ws.send(JSON.stringify(meetingsMessage()));
  };
  const handleSelectMeeting: WsActionHandler = ({ ws, cmd }) => {
    if (typeof cmd.meetingId !== "number" || !Number.isSafeInteger(cmd.meetingId)) {
      ws.send(JSON.stringify({ type: "status" as const, text: "meetingId must be a number" }));
    } else {
      const detail = store.meetingDetail(cmd.meetingId);
      const slidePlan = detail === null ? null : slidePlanStore.latest(cmd.meetingId);
      const review = detail === null ? null : reviewSnapshotForMeeting(cmd.meetingId);
      const conclusion = review?.conclusion ?? null;
      const geometry = slidePlan === null ? undefined : geometryForSlidePlan(slidePlan.plan);
      ws.send(
        JSON.stringify(
          detail === null
            ? { type: "status" as const, text: `회의 ${cmd.meetingId}을 찾을 수 없습니다` }
            : {
                type: "meeting" as const,
                ...detail,
                purpose: minutesStore.meetingMeta(cmd.meetingId)?.purpose ?? null,
                review,
                conclusion,
                ...(slidePlan
                  ? {
                      slidePlan: {
                        plan: slidePlan.plan,
                        path: slidePlan.path,
                        publicationSha256: slidePlan.publicationSha256,
                        publicationStatus: slidePlan.publicationStatus,
                        publicationSeq: slidePlan.publicationSeq,
                        publishedAt: slidePlan.publishedAt,
                        ...(slidePlan.reviewId === undefined ? {} : { reviewId: slidePlan.reviewId }),
                        ...(slidePlan.reviewedItemIds === undefined
                          ? {}
                          : { reviewedItemIds: slidePlan.reviewedItemIds }),
                        ...(geometry === undefined ? {} : { geometry }),
                      },
                    }
                  : {}),
              },
        ),
      );
    }
  };
  const handleDeleteMeeting: WsActionHandler = ({ ws, cmd }) => {
    if (!validMeetingId(cmd.meetingId)) {
      requestError(ws, new Error("유효한 회의 ID가 필요합니다"));
    } else if (capture.capturing && cmd.meetingId === meeting.currentMeetingId) {
      requestError(ws, new Error("녹음 중인 회의는 삭제할 수 없습니다"));
    } else {
      const deletion = deleteMeetingForJobState({
        meetingId: cmd.meetingId,
        activeJob: artifacts.activeJob,
        deleteHistory: (meetingId) => deleteMeetingHistory(store.databaseHandle(), meetingId),
      });
      switch (deletion.kind) {
        case "blocked":
          requestError(ws, new Error(deletion.message));
          break;
        case "deleted":
          if (cmd.meetingId === meeting.currentMeetingId) {
            session.reset();
            meeting.currentMeetingId = null;
          }
          broadcast(meetingsMessage());
          ws.send(JSON.stringify({ type: "status" as const, text: "회의 기록을 삭제했습니다" }));
          break;
        case "not-found":
          requestError(ws, new Error(`회의 ${cmd.meetingId}을 찾을 수 없습니다`));
          break;
        default:
          deletion satisfies never;
      }
    }
  };
  const handleSave: WsActionHandler = ({ ws, cmd }) => {
    try {
      if (cmd.meetingId !== undefined && !validMeetingId(cmd.meetingId)) {
        throw new Error("meetingId must be a positive safe integer");
      }
      const meetingId = cmd.meetingId ?? store.latestMeeting()?.id;
      if (meetingId === undefined || store.meeting(meetingId) === null) throw new Error("Meeting was not found");
      const dir = paths.exportRoot;
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let filename: string;
      let contents: string;
      if (cmd.action === "saveJson") {
        const meta = store.meeting(meetingId);
        filename = `meeting-${stamp}.json`;
        contents = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            provider: meta?.provider ?? null,
            slides: store.slides(meetingId),
            lines: store.lines(meetingId),
          },
          null,
          2,
        );
      } else if (cmd.action === "saveTranscript") {
        filename = `transcript-${stamp}.md`;
        contents = store.exportTranscript(meetingId);
      } else {
        filename = `meeting-${stamp}.md`;
        contents = store.exportMarkdown(meetingId);
      }
      writeFileSync(join(dir, filename), contents, "utf-8");
      artifacts.lastSavedPath = `exports/${filename}`;
      broadcast({ type: "saved", path: artifacts.lastSavedPath });
      broadcast({ type: "status", text: `저장됨: ${artifacts.lastSavedPath}` });
    } catch (error) {
      broadcast({ type: "status", text: `저장 실패: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  return {
    handlers: new Map<string, WsActionHandler>([
      ["listMeetings", handleListMeetings],
      ["selectMeeting", handleSelectMeeting],
      ["deleteMeeting", handleDeleteMeeting],
      ["saveNotes", handleSave],
      ["saveTranscript", handleSave],
      ["saveJson", handleSave],
      ["reset", handleReset],
      ["setAttendees", handleSetAttendees],
      ["attendees", handleAttendeesQuery],
    ]),
    meetingsMessage,
  };
}
