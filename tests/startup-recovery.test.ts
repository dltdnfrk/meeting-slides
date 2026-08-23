import { expect, test } from "bun:test";
import { MeetingStore } from "../src/store.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { TranscriptVersionWriter } from "../src/transcript-versioning.ts";
import { reconcileInterruptedMeetings } from "../src/startup-recovery.ts";

test("startup recovery atomically finalizes a crash-left draft transcript and ends its meeting", () => {
 const meetings=new MeetingStore(":memory:"); const minutes=new MinutesStore(meetings.databaseHandle());
 const id=meetings.startMeeting("cli:codex"); const writer=new TranscriptVersionWriter(minutes); writer.begin(id,{sourceKind:"live_capture",dualWriteLegacy:true}); writer.append({ts:10,text:"복구할 문장"});
 expect(reconcileInterruptedMeetings(minutes,999)).toEqual([id]);
 expect(meetings.meeting(id)?.ended_at).toBe(999); const canonical=minutes.canonicalVersion(id); expect(canonical?.finalizedAt).not.toBeNull(); expect(canonical?.contentSha256).toMatch(/^[0-9a-f]{64}$/); expect(minutes.transcriptVersionLines(canonical!.transcriptVersionId)[0]?.text).toBe("복구할 문장"); meetings.close();
});
test("startup recovery creates canonical truth for a legacy-only open meeting and is idempotent", () => {
 const meetings=new MeetingStore(":memory:"); const minutes=new MinutesStore(meetings.databaseHandle()); const id=meetings.startMeeting("legacy"); meetings.addLine({ts:1,text:"legacy"});
 expect(reconcileInterruptedMeetings(minutes,123)).toEqual([id]); expect(reconcileInterruptedMeetings(minutes,456)).toEqual([]); expect(minutes.canonicalVersion(id)).not.toBeNull(); expect(meetings.listMeetings()[0]?.status).toBe("ended"); meetings.close();
});
