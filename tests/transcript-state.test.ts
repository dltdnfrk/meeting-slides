// Pure transcript projection reducer (plan todo 8).
//
// Every assertion here runs the reducer directly: no DOM, no socket, no clock,
// no storage. Timestamps are literals so the projection is fully deterministic.
// Protocol spellings (`caption`, `line`, `transcript`, `meeting`, `snapshot`,
// `export`, `meetingId`, numeric `speaker`) are consumed exactly as
// `src/session.ts` and `tests/fixtures/public-protocol-contract.json` declare them.
import { describe, expect, test } from "bun:test";

import {
  initialTranscriptState,
  minibarProjection,
  parseTranscriptEvent,
  reduceTranscript,
  reduceTranscriptAll,
  type TranscriptEvent,
  type TranscriptState,
} from "../public/transcript-state.ts";

const T0 = 1_700_000_000_000;
const ts = (offsetSeconds: number): number => T0 + offsetSeconds * 1_000;

/** 5 deterministic Korean lines, two speakers, 3 s apart. */
const KO_LINES = [
  "이번 분기 로드맵을 먼저 정렬하고 시작하겠습니다.",
  "온보딩 이탈률이 지난달보다 12퍼센트 줄었습니다.",
  "설치 시간은 평균 4분에서 2분 30초로 짧아졌습니다.",
  "튜토리얼 단계가 여전히 많다는 피드백이 반복됩니다.",
  "그래서 네 단계로 줄이는 방안을 제안합니다.",
] as const;

function line(text: string, at: number, speaker?: number): TranscriptEvent {
  return {
    kind: "server",
    message: "line",
    entry: { text, ts: at, speaker: speaker ?? null },
  };
}

function caption(text: string, at: number, speaker?: number): TranscriptEvent {
  return {
    kind: "server",
    message: "caption",
    entry: { text, ts: at, speaker: speaker ?? null },
  };
}

function snapshot(
  entries: ReadonlyArray<{ text: string; ts: number; speaker?: number }>,
  truncated = false,
): TranscriptEvent {
  return {
    kind: "server",
    message: "transcript",
    reason: "snapshot",
    truncated,
    entries: entries.map((entry) => ({ text: entry.text, ts: entry.ts, speaker: entry.speaker ?? null })),
  };
}

/** Hydrated live projection: no history meeting selected. */
function liveState(): TranscriptState {
  return reduceTranscript(initialTranscriptState(), { kind: "activateMeeting", meetingId: null });
}

const texts = (state: TranscriptState): readonly string[] => state.finalized.map((entry) => entry.text);

describe("transcript projection — finalized lines", () => {
  test("Korean multiline finals keep arrival order and speaker metadata", () => {
    const state = reduceTranscriptAll(
      liveState(),
      KO_LINES.map((text, i) => line(text, ts(i * 3), (i % 2) + 1)),
    );

    expect(texts(state)).toEqual([...KO_LINES]);
    expect(state.finalized.map((entry) => entry.speaker)).toEqual([1, 2, 1, 2, 1]);
    expect(state.count).toBe(5);
    expect(state.provisional).toBeNull();
  });

  test("multiline text collapses interior whitespace without losing content", () => {
    const multiline = "첫 번째 문장입니다.\n두 번째 줄도  같은 발화입니다.";
    const state = reduceTranscript(liveState(), line(multiline, ts(0), 1));

    expect(texts(state)).toEqual(["첫 번째 문장입니다. 두 번째 줄도 같은 발화입니다."]);
  });

  test("blank finalized text is ignored instead of creating an empty row", () => {
    const state = reduceTranscriptAll(liveState(), [line("   ", ts(0), 1), line("\n\n", ts(3), 1)]);

    expect(state.finalized).toEqual([]);
    expect(state.count).toBe(0);
  });

  test("a speaker-less final carries a null speaker, not a fabricated one", () => {
    const state = reduceTranscript(liveState(), line(KO_LINES[0]!, ts(0)));

    expect(state.finalized[0]?.speaker).toBeNull();
  });
});

describe("transcript projection — duplicate suppression", () => {
  test("the same finalized line delivered twice appears once", () => {
    const repeated = line(KO_LINES[0]!, ts(0), 1);
    const state = reduceTranscriptAll(liveState(), [repeated, repeated]);

    expect(texts(state)).toEqual([KO_LINES[0]!]);
    expect(state.count).toBe(1);
  });

  test("duplicate detection normalizes whitespace but respects ts and speaker", () => {
    const state = reduceTranscriptAll(liveState(), [
      line(KO_LINES[0]!, ts(0), 1),
      line(`  ${KO_LINES[0]!}  `, ts(0), 1), // same key after normalization -> suppressed
      line(KO_LINES[0]!, ts(0), 2), // different speaker -> distinct turn
      line(KO_LINES[0]!, ts(3), 1), // same words later -> genuine repetition
    ]);

    expect(state.count).toBe(3);
    expect(state.finalized.map((entry) => [entry.ts, entry.speaker])).toEqual([
      [ts(0), 1],
      [ts(0), 2],
      [ts(3), 1],
    ]);
  });

  test("a duplicate arriving after later lines does not reorder the projection", () => {
    const state = reduceTranscriptAll(liveState(), [
      line(KO_LINES[0]!, ts(0), 1),
      line(KO_LINES[1]!, ts(3), 2),
      line(KO_LINES[0]!, ts(0), 1),
    ]);

    expect(texts(state)).toEqual([KO_LINES[0]!, KO_LINES[1]!]);
  });
});

describe("transcript projection — provisional captions", () => {
  test("a caption is provisional only and never enters the finalized list", () => {
    const state = reduceTranscript(liveState(), caption("이번 분기 로드맵을", ts(0), 1));

    expect(state.finalized).toEqual([]);
    expect(state.provisional).toEqual({ text: "이번 분기 로드맵을", speaker: 1, ts: ts(0) });
  });

  test("each caption replaces the previous provisional row", () => {
    const state = reduceTranscriptAll(liveState(), [
      caption("이번 분기", ts(0), 1),
      caption("이번 분기 로드맵을 먼저", ts(1), 1),
    ]);

    expect(state.provisional?.text).toBe("이번 분기 로드맵을 먼저");
    expect(state.finalized).toEqual([]);
  });

  test("an empty caption clears the provisional row", () => {
    const state = reduceTranscriptAll(liveState(), [caption("이번 분기", ts(0), 1), caption("", ts(1), 1)]);

    expect(state.provisional).toBeNull();
  });

  test("the matching final replaces its provisional caption", () => {
    const state = reduceTranscriptAll(liveState(), [
      caption(KO_LINES[0]!, ts(0), 1),
      line(KO_LINES[0]!, ts(0), 1),
    ]);

    expect(state.provisional).toBeNull();
    expect(texts(state)).toEqual([KO_LINES[0]!]);
  });

  test("a corrected final replaces the provisional caption it supersedes", () => {
    // Interim text is corrected by the final: different words, same speaker turn.
    const state = reduceTranscriptAll(liveState(), [
      caption("온보딩 이탈률이 지난달보다 십이", ts(3), 2),
      line(KO_LINES[1]!, ts(3), 2),
    ]);

    expect(state.provisional).toBeNull();
    expect(texts(state)).toEqual([KO_LINES[1]!]);
    expect(state.count).toBe(1);
  });

  test("a final for a different speaker leaves another speaker's caption standing", () => {
    const state = reduceTranscriptAll(liveState(), [
      caption("아직 말하는 중입니다", ts(4), 2),
      line(KO_LINES[0]!, ts(0), 1),
    ]);

    expect(state.provisional?.text).toBe("아직 말하는 중입니다");
  });
});

describe("transcript projection — out-of-order delivery", () => {
  test("an interim caption arriving after its final does not resurrect it", () => {
    const state = reduceTranscriptAll(liveState(), [
      line(KO_LINES[0]!, ts(0), 1),
      caption(KO_LINES[0]!, ts(0), 1),
    ]);

    expect(state.provisional).toBeNull();
    expect(texts(state)).toEqual([KO_LINES[0]!]);
  });

  test("a late final older than the newest line is inserted, not appended", () => {
    const state = reduceTranscriptAll(liveState(), [
      line(KO_LINES[0]!, ts(0), 1),
      line(KO_LINES[2]!, ts(6), 1),
      line(KO_LINES[1]!, ts(3), 2),
    ]);

    expect(texts(state)).toEqual([KO_LINES[0]!, KO_LINES[1]!, KO_LINES[2]!]);
  });

  test("equal timestamps keep arrival order (stable ordering)", () => {
    const state = reduceTranscriptAll(liveState(), [
      line("먼저 도착한 문장", ts(0), 1),
      line("나중에 도착한 문장", ts(0), 2),
    ]);

    expect(texts(state)).toEqual(["먼저 도착한 문장", "나중에 도착한 문장"]);
  });
});

describe("transcript projection — snapshots", () => {
  test("a snapshot replaces the projection instead of appending", () => {
    const state = reduceTranscriptAll(liveState(), [
      line("이전 회의에서 남은 문장", ts(-9), 1),
      snapshot([
        { text: KO_LINES[0]!, ts: ts(0), speaker: 1 },
        { text: KO_LINES[1]!, ts: ts(3), speaker: 2 },
      ]),
    ]);

    expect(texts(state)).toEqual([KO_LINES[0]!, KO_LINES[1]!]);
    expect(state.count).toBe(2);
  });

  test("a repeated snapshot is idempotent", () => {
    const frame = snapshot([
      { text: KO_LINES[0]!, ts: ts(0), speaker: 1 },
      { text: KO_LINES[1]!, ts: ts(3), speaker: 2 },
    ]);
    const once = reduceTranscript(liveState(), frame);
    const twice = reduceTranscript(once, frame);

    expect(twice.finalized).toEqual(once.finalized);
    expect(twice.count).toBe(2);
  });

  test("a snapshot clears the provisional caption and carries truncation", () => {
    const state = reduceTranscriptAll(liveState(), [
      caption("진행 중인 발화", ts(9), 1),
      snapshot([{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }], true),
    ]);

    expect(state.provisional).toBeNull();
    expect(state.truncated).toBe(true);
  });

  test("a snapshot sorts out-of-order entries and drops in-snapshot duplicates", () => {
    const state = reduceTranscript(
      liveState(),
      snapshot([
        { text: KO_LINES[1]!, ts: ts(3), speaker: 2 },
        { text: KO_LINES[0]!, ts: ts(0), speaker: 1 },
        { text: KO_LINES[1]!, ts: ts(3), speaker: 2 },
      ]),
    );

    expect(texts(state)).toEqual([KO_LINES[0]!, KO_LINES[1]!]);
  });

  test("an export-reason transcript never touches the projection", () => {
    const before = reduceTranscript(liveState(), line(KO_LINES[0]!, ts(0), 1));
    const after = reduceTranscript(before, {
      kind: "server",
      message: "transcript",
      reason: "export",
      truncated: false,
      entries: [{ text: "내보내기 전용 문장", ts: ts(99), speaker: null }],
    });

    expect(after.finalized).toEqual(before.finalized);
    expect(after.count).toBe(1);
  });

  test("an empty snapshot clears the projection", () => {
    const state = reduceTranscriptAll(liveState(), [line(KO_LINES[0]!, ts(0), 1), snapshot([])]);

    expect(state.finalized).toEqual([]);
    expect(state.count).toBe(0);
  });
});

describe("transcript projection — meeting boundaries", () => {
  test("live lines are rejected while a history meeting is active", () => {
    const history = reduceTranscript(liveState(), { kind: "activateMeeting", meetingId: 101 });
    const state = reduceTranscript(history, line(KO_LINES[0]!, ts(0), 1));

    expect(state.finalized).toEqual([]);
    expect(state.rejected).toBe(1);
  });

  test("a live snapshot is rejected while a history meeting is active", () => {
    const history = reduceTranscript(liveState(), { kind: "activateMeeting", meetingId: 101 });
    const state = reduceTranscript(history, snapshot([{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }]));

    expect(state.finalized).toEqual([]);
    expect(state.rejected).toBe(1);
  });

  test("meeting detail for the active meeting replaces the projection", () => {
    const history = reduceTranscript(liveState(), { kind: "activateMeeting", meetingId: 101 });
    const state = reduceTranscript(history, {
      kind: "server",
      message: "meeting",
      meetingId: 101,
      entries: [
        { text: KO_LINES[0]!, ts: ts(0), speaker: 1 },
        { text: KO_LINES[1]!, ts: ts(3), speaker: 2 },
      ],
    });

    expect(texts(state)).toEqual([KO_LINES[0]!, KO_LINES[1]!]);
    expect(state.meetingId).toBe(101);
  });

  test("stale meeting detail for a superseded selection is rejected", () => {
    const selected = reduceTranscript(liveState(), { kind: "activateMeeting", meetingId: 202 });
    const state = reduceTranscript(selected, {
      kind: "server",
      message: "meeting",
      meetingId: 101,
      entries: [{ text: "지난 회의 문장", ts: ts(0), speaker: 1 }],
    });

    expect(state.finalized).toEqual([]);
    expect(state.rejected).toBe(1);
  });

  test("switching meetings isolates projections and clears the provisional row", () => {
    const first = reduceTranscriptAll(liveState(), [
      { kind: "activateMeeting", meetingId: 101 },
      {
        kind: "server",
        message: "meeting",
        meetingId: 101,
        entries: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }],
      },
    ]);
    const switched = reduceTranscript(first, { kind: "activateMeeting", meetingId: 202 });

    expect(switched.finalized).toEqual([]);
    expect(switched.provisional).toBeNull();
    expect(switched.count).toBe(0);
    expect(switched.meetingId).toBe(202);
  });

  test("returning to live clears history content", () => {
    const history = reduceTranscriptAll(liveState(), [
      { kind: "activateMeeting", meetingId: 101 },
      {
        kind: "server",
        message: "meeting",
        meetingId: 101,
        entries: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }],
      },
    ]);
    const back = reduceTranscript(history, { kind: "activateMeeting", meetingId: null });

    expect(back.meetingId).toBeNull();
    expect(back.finalized).toEqual([]);
  });

  test("re-activating the same meeting is a no-op on content", () => {
    const loaded = reduceTranscriptAll(liveState(), [
      { kind: "activateMeeting", meetingId: 101 },
      {
        kind: "server",
        message: "meeting",
        meetingId: 101,
        entries: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }],
      },
    ]);
    const again = reduceTranscript(loaded, { kind: "activateMeeting", meetingId: 101 });

    expect(texts(again)).toEqual([KO_LINES[0]!]);
  });
});

describe("transcript projection — reset and empty", () => {
  test("reset clears finalized, provisional, truncation and counters", () => {
    const state = reduceTranscriptAll(liveState(), [
      line(KO_LINES[0]!, ts(0), 1),
      caption("진행 중", ts(3), 2),
      snapshot([{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }], true),
      { kind: "reset" },
    ]);

    expect(state.finalized).toEqual([]);
    expect(state.provisional).toBeNull();
    expect(state.truncated).toBe(false);
    expect(state.count).toBe(0);
    expect(state.rejected).toBe(0);
  });

  test("the initial state is empty and live", () => {
    const state = initialTranscriptState();

    expect(state.finalized).toEqual([]);
    expect(state.provisional).toBeNull();
    expect(state.count).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.meetingId).toBeNull();
  });

  test("reducing an empty event sequence returns the same projection", () => {
    const state = liveState();

    expect(reduceTranscriptAll(state, [])).toEqual(state);
  });
});

describe("transcript projection — purity", () => {
  test("the reducer never mutates the state it was given", () => {
    const before = reduceTranscript(liveState(), line(KO_LINES[0]!, ts(0), 1));
    const snapshotOfBefore = JSON.stringify(before);
    reduceTranscript(before, line(KO_LINES[1]!, ts(3), 2));

    expect(JSON.stringify(before)).toBe(snapshotOfBefore);
  });

  test("the returned projection is frozen", () => {
    const state = reduceTranscript(liveState(), line(KO_LINES[0]!, ts(0), 1));

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.finalized)).toBe(true);
  });

  test("the same event sequence produces an identical projection twice", () => {
    const events = KO_LINES.map((text, i) => line(text, ts(i * 3), (i % 2) + 1));

    expect(reduceTranscriptAll(liveState(), events)).toEqual(reduceTranscriptAll(liveState(), events));
  });
});

describe("transcript projection — minibar", () => {
  test("the minibar shows at most three finals plus one provisional", () => {
    const state = reduceTranscriptAll(liveState(), [
      ...KO_LINES.map((text, i) => line(text, ts(i * 3), (i % 2) + 1)),
      caption("아직 정리 중인 발화", ts(15), 2),
    ]);
    const projection = minibarProjection(state);

    expect(projection.finalized.map((entry) => entry.text)).toEqual([KO_LINES[2]!, KO_LINES[3]!, KO_LINES[4]!]);
    expect(projection.provisional?.text).toBe("아직 정리 중인 발화");
  });

  test("the minibar derives from the same store, with no duplicate rows", () => {
    const repeated = line(KO_LINES[0]!, ts(0), 1);
    const projection = minibarProjection(reduceTranscriptAll(liveState(), [repeated, repeated]));

    expect(projection.finalized).toHaveLength(1);
  });

  test("an empty projection yields no minibar rows", () => {
    const projection = minibarProjection(initialTranscriptState());

    expect(projection.finalized).toEqual([]);
    expect(projection.provisional).toBeNull();
  });
});

describe("transcript parse boundary", () => {
  test("a well-formed line frame parses into a typed event", () => {
    const result = parseTranscriptEvent({ type: "line", text: KO_LINES[0]!, ts: ts(0), speaker: 1 });

    expect(result).toEqual({
      ok: true,
      event: { kind: "server", message: "line", entry: { text: KO_LINES[0]!, ts: ts(0), speaker: 1 } },
    });
  });

  test("an absent speaker parses to null rather than undefined", () => {
    const result = parseTranscriptEvent({ type: "caption", text: "발화 중", ts: ts(0) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      kind: "server",
      message: "caption",
      entry: { text: "발화 중", ts: ts(0), speaker: null },
    });
  });

  test("a transcript frame keeps its declared reason and truncation flag", () => {
    const result = parseTranscriptEvent({
      type: "transcript",
      entries: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }],
      reason: "snapshot",
      truncated: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      kind: "server",
      message: "transcript",
      reason: "snapshot",
      truncated: true,
      entries: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 1 }],
    });
  });

  test("a reason-less transcript frame defaults to the export reason", () => {
    const result = parseTranscriptEvent({ type: "transcript", entries: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      kind: "server",
      message: "transcript",
      reason: "export",
      truncated: false,
      entries: [],
    });
  });

  test("meeting detail parses meetingId and its transcript entries", () => {
    const result = parseTranscriptEvent({
      type: "meeting",
      meetingId: 101,
      transcript: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 2 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      kind: "server",
      message: "meeting",
      meetingId: 101,
      entries: [{ text: KO_LINES[0]!, ts: ts(0), speaker: 2 }],
    });
  });

  test.each([
    ["a non-object frame", null],
    ["a frame with no type", { text: "x", ts: T0 }],
    ["a line with a non-string text", { type: "line", text: 12, ts: T0 }],
    ["a line with a non-numeric ts", { type: "line", text: "x", ts: "later" }],
    ["a line with a NaN ts", { type: "line", text: "x", ts: Number.NaN }],
    ["a caption with a non-numeric speaker", { type: "caption", text: "x", ts: T0, speaker: "화자 1" }],
    ["a transcript with non-array entries", { type: "transcript", entries: { text: "x" } }],
    ["a transcript with an undeclared reason", { type: "transcript", entries: [], reason: "backlog" }],
    ["a transcript with a malformed entry", { type: "transcript", entries: [{ text: "x" }] }],
    ["a meeting with a non-numeric meetingId", { type: "meeting", meetingId: "101", transcript: [] }],
  ])("%s is a typed failure, not an exception", (_label, frame) => {
    const result = parseTranscriptEvent(frame);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason.length).toBeGreaterThan(0);
  });

  test("an unrelated declared message parses to an ignorable event", () => {
    const result = parseTranscriptEvent({ type: "capture", capturing: true, mode: "mic" });

    expect(result).toEqual({ ok: true, event: { kind: "server", message: "other", type: "capture" } });
  });

  test("an ignorable event leaves the projection untouched", () => {
    const before = reduceTranscript(liveState(), line(KO_LINES[0]!, ts(0), 1));
    const after = reduceTranscript(before, { kind: "server", message: "other", type: "capture" });

    expect(after).toEqual(before);
  });

  test("a rejected frame is recorded without disturbing content", () => {
    const before = reduceTranscript(liveState(), line(KO_LINES[0]!, ts(0), 1));
    const after = reduceTranscript(before, { kind: "malformed", reason: "line.ts is not a number" });

    expect(texts(after)).toEqual([KO_LINES[0]!]);
    expect(after.rejected).toBe(1);
    expect(after.lastError).toBe("line.ts is not a number");
  });
});
