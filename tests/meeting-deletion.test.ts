import { expect, test } from "bun:test";

import { deleteMeetingHistory } from "../src/meeting-deletion.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";

test("회의 삭제는 해당 히스토리와 연결된 로컬 기록을 원자적으로 제거한다", () => {
  const store = new MeetingStore(":memory:");
  const minutesStore = new MinutesStore(store.databaseHandle());
  const meetingId = store.startMeeting("cli:codex");
  minutesStore.registerCapturingMeeting(meetingId);
  minutesStore.addAttendees(meetingId, [{
    attendeeId: "attendee-1",
    displayName: "민지",
    sortOrder: 0,
  }]);
  store.addLine({ ts: 1, speaker: 1, text: "삭제 대상 전사" });
  store.addSlide({ idx: 1, title: "삭제 대상", bullets: ["내용"], startedAt: 1 });
  store.endMeeting();
  minutesStore.endMeeting(meetingId);

  expect(deleteMeetingHistory(store.databaseHandle(), meetingId)).toBe(true);
  expect(store.listMeetings()).toEqual([]);
  expect(store.lines(meetingId)).toEqual([]);
  expect(store.slides(meetingId)).toEqual([]);
  expect(minutesStore.meetingMeta(meetingId)).toBeNull();
  store.close();
});
