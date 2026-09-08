import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMeetingServer } from "./helpers/meeting-server.ts";
import { MeetingStore } from "../src/store.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const liveActions = ["ask", "attendees", "audio", "cancelSttModel", "compileSlidePlan", "confirmReview", "connectProvider", "deleteMeeting", "exportDeck", "exportPdf", "exportPng", "installSttModel", "listMeetings", "persistSlidePlan", "recheckProviders", "recheckSttModels", "refineSlideField", "reset", "saveJson", "saveNotes", "saveTranscript", "selectMeeting", "selectSttModel", "setAttendees", "setCaptureSource", "setProvider", "setProviderKey", "startCapture", "startReview", "status", "stopCapture", "transcript", "updateItem"];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "handler-map-"));
  const dbPath = join(directory, "meeting.db");
  const running = startMeetingServer({ ...process.env, LLM_PROVIDER: "cli", LLM_CLI_BIN: "/usr/bin/false", LLM_CLI_PRESET: "claude", MEETINGS_DB_PATH: dbPath, MEETING_SLIDES_SETTINGS_ROOT: directory });
  return { running, dbPath, async close() { await running.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("one complete registry owns every live action and excludes retired actions", async () => {
  const app = fixture();
  try {
    expect([...app.running.handlerMap.keys()].sort()).toEqual([...liveActions].sort());
    for (const action of liveActions) expect(typeof app.running.handlerMap.get(action)).toBe("function");
    for (const action of ["unknownAction", "", "compileDeck", "compileTranscriptSnapshot", "exportPptx"]) expect(app.running.handlerMap.has(action)).toBe(false);
  } finally { await app.close(); }
});

test("SlidePlan compile evidence includes attendee display names for confirmed owners", async () => {
  const app = fixture();
  const legacy = new MeetingStore(app.dbPath);
  try {
    const minutes = new MinutesStore(legacy.databaseHandle());
    const meetingId = legacy.startMeeting("cli:test");
    minutes.registerCapturingMeeting(meetingId);
    minutes.addAttendees(meetingId, [{ attendeeId: "att-minsu", displayName: "김민수" }]);
    const version = minutes.addTranscriptVersion(meetingId, { transcriptVersionId: "canonical-v1", sourceKind: "live_capture" });
    minutes.addTranscriptVersionLines(version.transcriptVersionId, [{ seq: 1, text: "Please publish the release notes." }]);
    minutes.finalizeTranscriptVersion(version.transcriptVersionId, transcriptContentSha256(minutes, version.transcriptVersionId));
    minutes.setCanonical(meetingId, version.transcriptVersionId);
    const reviewId = minutes.saveCandidates({      
meetingId, transcriptVersionId: version.transcriptVersionId, actionItems: [{
        id: "action-1", description: "Publish the release notes", evidenceQuote: "Please publish the release notes.",
        source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 }, assigneeAttendeeId: "att-minsu", attributedAttendeeId: "att-minsu", deadline: "2026-08-28", reviewState: "confirmed",
      }]    
});
    minutes.confirmReview(reviewId, "reviewer");
    expect(app.running.slidePlanTranscriptFor(meetingId).confirmedReview).toMatchObject({ attendees: [{ attendeeId: "att-minsu", displayName: "김민수" }] });
  } finally { legacy.close(); await app.close(); }
});
