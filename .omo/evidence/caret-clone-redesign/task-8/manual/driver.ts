// Manual QA driver for task 8: drives the REAL public/transcript-state.ts module
// through a realistic Korean session and prints the projection after each frame.
// Frames are exactly what src/session.ts broadcasts, fed through the parse
// boundary so untrusted-payload handling is exercised too. Deterministic: every
// timestamp is a literal, nothing here reads a clock, socket, DOM or storage.
import {
  initialTranscriptState,
  minibarProjection,
  parseTranscriptEvent,
  reduceTranscript,
  type TranscriptState,
} from "../../../../../public/transcript-state.ts";

const T0 = 1_700_000_000_000;
const at = (s: number): number => T0 + s * 1_000;

let state: TranscriptState = initialTranscriptState();

function show(label: string): void {
  const bar = minibarProjection(state);
  console.log(`\n── ${label}`);
  console.log(`   meetingId=${state.meetingId} count=${state.count} truncated=${state.truncated} rejected=${state.rejected}`);
  for (const line of state.finalized) {
    console.log(`   final   [${line.ts - T0}ms, 화자 ${line.speaker ?? "-"}] ${line.text}`);
  }
  console.log(
    state.provisional === null
      ? "   interim (none)"
      : `   interim [${state.provisional.ts - T0}ms, 화자 ${state.provisional.speaker ?? "-"}] ${state.provisional.text}`,
  );
  console.log(`   minibar finals=${bar.finalized.length} provisional=${bar.provisional === null ? "none" : "yes"}`);
  if (state.lastError !== null) console.log(`   lastError=${state.lastError}`);
}

function feed(label: string, frame: unknown): void {
  const parsed = parseTranscriptEvent(frame);
  state = parsed.ok
    ? reduceTranscript(state, parsed.event)
    : reduceTranscript(state, { kind: "malformed", reason: parsed.error.reason });
  show(parsed.ok ? label : `${label} → REJECTED: ${parsed.error.reason}`);
}

console.log("=== task 8 manual QA: pure transcript projection ===");
show("initial (empty, live)");

// 1. Korean interim → final.
feed("interim: 화자 1 partial", { type: "caption", text: "이번 분기 로드맵을", ts: at(0), speaker: 1 });
feed("interim: 화자 1 longer", { type: "caption", text: "이번 분기 로드맵을 먼저 정렬하고", ts: at(1), speaker: 1 });
feed("final: 화자 1", { type: "line", text: "이번 분기 로드맵을 먼저 정렬하고 시작하겠습니다.", ts: at(2), speaker: 1 });

// 2. Interim corrected by a different-worded final for the same speaker turn.
feed("interim: 화자 2 misheard", { type: "caption", text: "온보딩 이탈률이 지난달보다 십이", ts: at(4), speaker: 2 });
feed("final: 화자 2 corrected", { type: "line", text: "온보딩 이탈률이 지난달보다 12퍼센트 줄었습니다.", ts: at(5), speaker: 2 });

// 3. The same final re-delivered (reconnect replay).
feed("duplicate final replay", { type: "line", text: "온보딩 이탈률이 지난달보다 12퍼센트 줄었습니다.", ts: at(5), speaker: 2 });

// 4. Multiline final + late out-of-order final.
feed("multiline final", { type: "line", text: "설치 시간은 평균 4분에서\n2분 30초로  짧아졌습니다.", ts: at(8), speaker: 1 });
feed("late final (older ts)", { type: "line", text: "튜토리얼 단계가 여전히 많다는 피드백이 있습니다.", ts: at(6), speaker: 2 });

// 5. Snapshot replacement + truncation.
feed("snapshot replaces projection", {
  type: "transcript",
  reason: "snapshot",
  truncated: true,
  entries: [
    { text: "그래서 네 단계로 줄이는 방안을 제안합니다.", ts: at(10), speaker: 1 },
    { text: "지원팀 문의 중 절반이 3단계에서 발생했습니다.", ts: at(13), speaker: 2 },
  ],
});
feed("export transcript (must not touch projection)", {
  type: "transcript",
  reason: "export",
  entries: [{ text: "내보내기 전용", ts: at(99), speaker: 1 }],
});

// 6. Meeting switch isolation.
state = reduceTranscript(state, { kind: "activateMeeting", meetingId: 101 });
show("activate history meeting 101");
feed("stale detail for meeting 77", { type: "meeting", meetingId: 77, transcript: [{ text: "다른 회의", ts: at(0), speaker: 1 }] });
feed("live line while history is active", { type: "line", text: "라이브 문장", ts: at(20), speaker: 1 });
feed("detail for meeting 101", {
  type: "meeting",
  meetingId: 101,
  transcript: [
    { text: "각 팀 리드가 금요일까지 범위를 확정합니다.", ts: at(30), speaker: 1 },
    { text: "리뷰 결과는 회의록으로 공유하겠습니다.", ts: at(33), speaker: 2 },
  ],
});

// 7. Malformed payloads at the boundary.
feed("malformed: speaker is a label", { type: "line", text: "화자 이름이 문자열", ts: at(40), speaker: "화자 1" });
feed("malformed: not an object", null);
feed("malformed: unknown type", { type: "transcriptDelta", entries: [] });

// 8. Back to live, then reset.
state = reduceTranscript(state, { kind: "activateMeeting", meetingId: null });
show("return to live");
state = reduceTranscript(state, { kind: "reset" });
show("reset");
