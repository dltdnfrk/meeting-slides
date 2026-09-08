import { expect, test } from "bun:test";

import { deleteMeetingHistory } from "../src/meeting-deletion.ts";
import { deleteMeetingForJobState } from "../src/slides/server-action.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";

test("active meeting job blocks deletion before deleteMeetingHistory", () => {
  // Given: each compile, persist, PDF, and PNG action owns the requested meeting.
  let deleteCalls = 0;
  const actions = ["compileSlidePlan", "persistSlidePlan", "exportPdf", "exportPng"] as const;

  // When: server deletion orchestration evaluates every active action.
  const results = actions.map((action) => deleteMeetingForJobState({
    meetingId: 41,
    activeJob: { meetingId: 41, action },
    deleteHistory: () => { deleteCalls += 1; return true; },
  }));

  // Then: every action blocks before touching durable history.
  expect(results).toEqual(actions.map(() => ({
    kind: "blocked",
    message: "슬라이드 작업 중인 회의는 삭제할 수 없습니다",
  })));
  expect(deleteCalls).toBe(0);
});

test("unrelated and no-job meeting deletion remains allowed", () => {
  // Given: one request has no job and another belongs to a different job.
  let deleteCalls = 0;
  const deleteHistory = (): boolean => { deleteCalls += 1; return true; };

  // When: both safe requests cross server deletion orchestration.
  const withoutJob = deleteMeetingForJobState({ meetingId: 41, activeJob: null, deleteHistory });
  const unrelated = deleteMeetingForJobState({
    meetingId: 42,
    activeJob: { meetingId: 41, action: "exportPng" },
    deleteHistory,
  });

  // Then: both invoke durable deletion exactly once.
  expect(withoutJob).toEqual({ kind: "deleted" });
  expect(unrelated).toEqual({ kind: "deleted" });
  expect(deleteCalls).toBe(2);
});

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
