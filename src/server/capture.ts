import { createCaptureInput, type CaptureRuntime } from "./capture-input.ts";
import { whisperVocabularyPrompt, type TranscriptChunk } from "../whisper.ts";
import { MeetingSession } from "../session.ts";
import type { ServerMessage, ClientListener, CaptureUpdate, CapturePhase } from "../protocol.ts";
import { sttModelsMessage } from "../stt-model-protocol.ts";
import { MeetingStore } from "../store.ts";
import { MinutesStore } from "../minutes-store.ts";
import {
  CaptureFinalizer,
  TranscriptVersionWriter,
  claimFileAudioSource,
  sha256File,
} from "../transcript-versioning.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "../config.ts";
import type { ApplicationPaths } from "./application.ts";
import type { MeetingState } from "./meetings.ts";
import type { DetectorState } from "./providers.ts";
import { type WsActionHandler } from "./websocket.ts";

export type { CaptureRuntime } from "./capture-input.ts";
export type CaptureController = ReturnType<typeof createCaptureController>;
export function createCaptureController(deps: {
  readonly config: Config;
  readonly paths: ApplicationPaths;
  readonly store: MeetingStore;
  readonly minutesStore: MinutesStore;
  readonly transcriptWriter: TranscriptVersionWriter;
  readonly session: MeetingSession;
  readonly meeting: MeetingState;
  readonly detector: DetectorState;
  readonly broadcast: ClientListener;
  readonly meetingsMessage: () => ServerMessage;
  readonly createCapture?: (audio?: { outputPath: string; initialPrompt?: string }) => CaptureRuntime;
}) {
  const {
    config,
    paths,
    store,
    minutesStore,
    transcriptWriter,
    session,
    meeting,
    detector,
    broadcast,
    meetingsMessage,
  } = deps;
  const input = createCaptureInput(config, paths, broadcast);
  const { sttManager } = input;
  const createWhisperCapture = deps.createCapture ?? input.createCapture;
  let sttCaptureRuntime = createWhisperCapture();
  let whisper = sttCaptureRuntime.capture;
  let capturing = false;
  let captureStartedAt: number | null = null;
  let stopPromise: Promise<void> | null = null;
  let captureRun: Promise<void> | null = null;
  let stopRequested = false;
  let captureFinalizer: CaptureFinalizer | null = null;
  const modelHandlers = input.modelHandlers({
    isCapturing: () => capturing,
    stopCapture,
    startCapture,
    rebuildCapture() {
      sttCaptureRuntime = createWhisperCapture();
      whisper = sttCaptureRuntime.capture;
      broadcast(sttModelsMessage(sttManager.allStates()));
      broadcast({ type: "status", text: "음성 인식 모델을 변경했습니다" });
    },
  });
  /**
   * The authoritative capture phase.
   *
   * `capturing` alone cannot express the stop window: `stopCapture()` sets
   * `capturing = false` and broadcasts BEFORE `whisper.stop()` and the session
   * flush, so trailing `line` frames arrive while both surfaces would otherwise
   * already be claiming idle. `stopping` names that window truthfully, and the
   * browser and the native minibar both keep Stop and the timer through it.
   *
   * Additive only: `CaptureUpdate.phase` is already declared optional in
   * `src/session.ts`, and every consumer maps a phase-less frame from `capturing`,
   * so nothing about the existing wire shape changes for a client that ignores it.
   */
  function capturePhase(): CapturePhase {
    if (capturing) return "capturing";
    // A stop that has been requested but whose capture run has not finished yet.
    return stopRequested && captureRun !== null ? "stopping" : "idle";
  }
  function captureMessage(): CaptureUpdate {
    const phase = capturePhase();
    // The recording origin stays on the wire for the whole time the server still
    // owns a capture, so neither surface has to invent a stopwatch to keep the
    // timer alive across the stop window.
    const startedAt = capturing || phase === "stopping" ? captureStartedAt : null;
    return {
      type: "capture",
      capturing,
      mode: config.input.mode,
      phase,
      ...(startedAt !== null ? { startedAt } : {}),
      ...(config.input.mode === "mic" ? { audioSource: input.source } : {}),
    };
  }
  function reportCaptureActionError(action: "start" | "stop", error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capture] ${action} failed: ${message}`);
    broadcast({ type: "status", text: `녹음을 ${action === "start" ? "시작" : "중지"}하지 못했습니다: ${message}` });
    broadcast(captureMessage());
  }
  const whisperHandlers = {
    onChunk: (c: TranscriptChunk) => session.onChunk(c),
    onStatus: (s: string) => {
      console.log(`[whisper] ${s}`);
      broadcast({ type: "status", text: s });
    },
    onError: (e: Error) => {
      console.error(`[whisper error] ${e.message}`);
      broadcast({ type: "status", text: `음성 인식 오류: ${e.message}` });
    },
  };
  async function startCapture(requestedMeetingId?: unknown): Promise<void> {
    if (capturing) {
      if (requestedMeetingId === undefined) return;
      throw new Error("capture is already running");
    }
    if (stopPromise) await stopPromise;
    let preparedMeetingId: number | null = null;
    if (requestedMeetingId !== undefined) {
      if (!Number.isInteger(requestedMeetingId) || (requestedMeetingId as number) < 1) {
        throw new Error("meeting_id must be a positive integer");
      }
      preparedMeetingId = requestedMeetingId as number;
      if (meeting.currentMeetingId === null || preparedMeetingId !== meeting.currentMeetingId) {
        throw new Error(`meeting ${preparedMeetingId} does not match the current prepared meeting`);
      }
      if (minutesStore.meetingMeta(preparedMeetingId)?.phase !== "prepared") {
        throw new Error(`meeting ${preparedMeetingId} is not prepared`);
      }
    }
    if (config.input.mode === "file" && config.input.filePath) {
      const duplicateMeetingId = minutesStore.findMeetingByAudioHash(sha256File(config.input.filePath));
      if (duplicateMeetingId !== null) {
        meeting.currentMeetingId = duplicateMeetingId;
        throw new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${duplicateMeetingId}`);
      }
    }
    if (preparedMeetingId === null) {
      meeting.currentMeetingId = store.startMeeting(detector.currentProviderId);
      minutesStore.registerCapturingMeeting(meeting.currentMeetingId);
    } else {
      minutesStore.activatePreparedMeeting(preparedMeetingId);
      store.activateMeeting(preparedMeetingId);
    }
    if (meeting.currentMeetingId === null) throw new Error("capture meeting was not created");
    const meetingId = meeting.currentMeetingId;
    if (config.input.mode === "file" && config.input.filePath) {
      const claimed = claimFileAudioSource(minutesStore, meetingId, config.input.filePath);
      if (claimed.duplicateMeetingId !== null)
        throw new Error(`[DUPLICATE_AUDIO] audio already belongs to meeting ${claimed.duplicateMeetingId}`);
    }
    const initialPrompt =
      whisperVocabularyPrompt(minutesStore.attendeesFor(meetingId).map((attendee) => attendee.displayName)) ??
      undefined;
    if (config.input.mode === "mic") {
      mkdirSync(paths.exportRoot, { recursive: true });
      const outputPath = join(paths.exportRoot, `audio-${meetingId}-${Date.now()}.wav`);
      sttCaptureRuntime = createWhisperCapture({ outputPath, initialPrompt });
      whisper = sttCaptureRuntime.capture;
    }
    transcriptWriter.begin(meetingId, {
      sourceKind: config.input.mode === "file" ? "file_transcription" : "live_capture",
      engine: sttCaptureRuntime.identity.engine,
      engineModel: sttCaptureRuntime.identity.engineModel,
      dualWriteLegacy: true,
    });
    captureFinalizer = new CaptureFinalizer(minutesStore, transcriptWriter, meetingId, sttCaptureRuntime.audioCapture);
    capturing = true;
    captureStartedAt = Date.now();
    stopRequested = false;
    broadcast(captureMessage());
    broadcast(meetingsMessage());
    broadcast({ type: "status", text: "녹음을 시작했습니다. 말씀해 주세요" });
    const finalizer = captureFinalizer;
    captureRun = (async () => {
      let failure: unknown = null;
      try {
        await whisper.start({
          ...whisperHandlers,
          initialPrompt,
        });
      } catch (error) {
        failure = error;
      } finally {
        try {
          await session.flush();
          const finalized = await finalizer.finish();
          if (finalized.audio.status === "unavailable" && config.input.mode === "mic") {
            broadcast({ type: "status", text: "원본 오디오를 저장하지 못했습니다" });
          }
          if (finalized.retranscription.status === "failed") {
            broadcast({
              type: "status",
              text: `보존 오디오 재전사에 실패해 라이브 전사를 사용했습니다: ${finalized.retranscription.error}`,
            });
          }
        } finally {
          captureFinalizer = null;
          store.endMeeting();
          if (minutesStore.meetingMeta(meetingId)?.phase === "capturing") minutesStore.endMeeting(meetingId);
          const endedNaturally = capturing && !stopRequested;
          capturing = false;
          captureStartedAt = null;
          // This is the authoritative END of the capture, so the stop window is
          // over before the snapshot goes out. Without clearing the request here
          // `capturePhase()` would still read `stopping` and this frame - the one
          // that actually ends the meeting for both surfaces - would claim the
          // capture was merely winding down.
          const wasRequestedStop = stopRequested;
          stopRequested = false;
          broadcast(captureMessage());
          if (endedNaturally && config.input.mode === "mic") {
            broadcast({
              type: "status",
              text: "마이크 입력이 중단되었습니다. 마이크와 권한을 확인한 뒤 다시 시작해 주세요",
            });
          } else if (!wasRequestedStop) {
            broadcast({ type: "status", text: "음성 입력이 종료되었습니다" });
          }
        }
      }
      if (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        console.error(`[capture fatal] ${message}`);
        broadcast({ type: "status", text: `녹음 오류: ${message}` });
      }
    })().finally(() => {
      captureRun = null;
    });
  }
  async function stopCapture(): Promise<void> {
    if (!capturing || !captureRun) {
      broadcast(captureMessage());
      broadcast({ type: "status", text: "이미 녹음이 중지된 상태입니다" });
      return;
    }
    capturing = false;
    stopRequested = true;
    broadcast(captureMessage());
    const run = captureRun;
    stopPromise = (async () => {
      try {
        await whisper.stop();
        await run;
        broadcast(meetingsMessage());
        broadcast({ type: "status", text: "녹음 중지 완료. 슬라이드와 전사 원문을 저장할 수 있습니다" });
      } finally {
        captureRun = null;
        stopPromise = null;
      }
    })();
    await stopPromise;
  }
  return {
    handlers: new Map<string, WsActionHandler>([
      ...input.captureHandlers({
        get capturing() {
          return capturing;
        },
        startCapture,
        stopCapture,
        captureMessage,
        reportCaptureActionError,
      }),
      ...modelHandlers,
    ]),
    startCapture,
    stopCapture,
    captureMessage,
    sttMessage: () => sttModelsMessage(sttManager.allStates()),
    get capturing() {
      return capturing;
    },
    get captureRun() {
      return captureRun;
    },
    async close() {
      const modelsClosed = input.close();
      if (capturing && captureRun) await stopCapture();
      else if (captureRun) await captureRun;
      if (stopPromise) await stopPromise;
      await modelsClosed;
    },
  };
}
