import { createSelectSttModel } from "../stt-model-selection.ts";
import { isSttModelId } from "../stt-model-catalog.ts";
import { requestError, type WsActionHandler } from "./websocket.ts";
import { WhisperStream, WhisperCLI } from "../whisper.ts";
import { TranscribeStream, TranscribeCLI } from "../transcribe.ts";
import type { ClientListener, CaptureUpdate } from "../protocol.ts";
import { SttModelManager } from "../stt-model-downloader.ts";
import { resolveSttCaptureIdentity } from "../stt-model-selection.ts";
import { sttModelsMessage } from "../stt-model-protocol.ts";
import { SttModelSettingsStore } from "../stt-model-settings.ts";
import { CaptureSourceStore, isCaptureSource, type CaptureSource } from "../capture-source.ts";
import { PcmIngest } from "../pcm-ingest.ts";
import { WhisperPcmStream } from "../whisper-pcm.ts";
import type { CanonicalAudioCaptureHandle } from "../audio-recorder.ts";
import type { Config } from "../config.ts";
import type { ApplicationPaths } from "./application.ts";

export interface CaptureRuntime {
  capture: { start(handlers: Parameters<WhisperStream["start"]>[0]): Promise<void>; stop(): Promise<void> };
  identity: ReturnType<typeof resolveSttCaptureIdentity>;
  audioCapture: CanonicalAudioCaptureHandle | null;
}

export function createCaptureInput(config: Config, paths: ApplicationPaths, broadcast: ClientListener) {
  const sttManager = new SttModelManager(paths.modelsRoot, new SttModelSettingsStore(paths.settingsRoot));
  const unsubscribe = sttManager.subscribe(() => broadcast(sttModelsMessage(sttManager.allStates())));
  const captureSourceStore = new CaptureSourceStore(paths.settingsRoot);
  let captureSource: CaptureSource = captureSourceStore.load();
  let pcmIngest: PcmIngest | null = null;
  function createCapture(audio?: { outputPath: string; initialPrompt?: string }) {
    const selected = sttManager.selectedArtifact();
    const selectedPath = sttManager.selectedPath();
    const identity = resolveSttCaptureIdentity({
      selectedArtifact: selected,
      selectedPath,
      fallbackModelPath: config.whisper.modelPath,
    });
    const whisperConfig = { ...config.whisper, modelPath: identity.engineModel };
    const useSystemAudio = config.input.mode === "mic" && captureSource === "system";
    pcmIngest = useSystemAudio ? new PcmIngest(audio ? { outputPath: audio.outputPath } : {}) : null;
    if (selected?.backend === "transcribe") {
      const transcribeConfig = {
        modelPath: identity.engineModel,
        captureId: config.whisper.captureId,
        threads: config.whisper.threads,
        gpu: config.whisper.gpu,
        ffmpegBin: process.env.FFMPEG_BIN?.trim() || "ffmpeg",
        ...(audio ? { audioOutputPath: audio.outputPath } : {}),
        ...(pcmIngest ? { pcmSource: pcmIngest } : {}),
      };
      const capture =
        config.input.mode === "file" && config.input.filePath
          ? new TranscribeCLI(transcribeConfig, config.input.filePath)
          : new TranscribeStream(transcribeConfig);
      const audioCapture: CanonicalAudioCaptureHandle | null =
        audio && capture instanceof TranscribeStream
          ? {
              stop: async () => {
                await capture.stop();
                return capture.stoppedAudio();
              },
              retranscribe: (recording) => capture.retranscribe(recording),
            }
          : null;
      return { capture, identity, audioCapture };
    }
    if (config.input.mode === "file" && config.input.filePath) {
      return { capture: new WhisperCLI(whisperConfig, config.input.filePath), identity, audioCapture: null };
    }
    if (pcmIngest) {
      const capture = new WhisperPcmStream(whisperConfig, pcmIngest, audio);
      const audioCapture: CanonicalAudioCaptureHandle | null = audio
        ? {
            stop: async () => {
              await capture.stop();
              return capture.stoppedAudio();
            },
            retranscribe: (recording) => capture.retranscribe(recording),
          }
        : null;
      return { capture, identity, audioCapture };
    }
    const capture = new WhisperStream(whisperConfig, audio);
    const audioCapture: CanonicalAudioCaptureHandle | null = audio
      ? {
          stop: async () => {
            await capture.stop();
            return capture.stoppedAudio();
          },
          retranscribe: (recording) => capture.retranscribe(recording),
        }
      : null;
    return { capture, identity, audioCapture };
  }

  const tasks = new Set<Promise<void>>();
  function modelHandlers(controls: Parameters<typeof createSelectSttModel>[1]) {
    const selectSttModel = createSelectSttModel(sttManager, controls);
    const handleInstallSttModel: WsActionHandler = ({ ws, cmd }) => {
      if (!isSttModelId(cmd.modelId))
        ws.send(JSON.stringify({ type: "status" as const, text: "알 수 없는 STT 모델입니다" }));
      else {
        const work = sttManager
          .install(cmd.modelId)
          .catch((error) => requestError(ws, error))
          .finally(() => tasks.delete(work));
        tasks.add(work);
      }
    };
    const handleCancelSttModel: WsActionHandler = ({ ws, cmd }) => {
      if (!isSttModelId(cmd.modelId) || !sttManager.cancel(cmd.modelId)) {
        ws.send(JSON.stringify({ type: "status" as const, text: "취소할 STT 다운로드가 없습니다" }));
      }
    };
    const handleSelectSttModel: WsActionHandler = ({ ws, cmd }) => {
      if (!isSttModelId(cmd.modelId))
        ws.send(JSON.stringify({ type: "status" as const, text: "알 수 없는 STT 모델입니다" }));
      else {
        const work = selectSttModel(cmd.modelId)
          .catch((error) => requestError(ws, error))
          .finally(() => tasks.delete(work));
        tasks.add(work);
      }
    };
    const handleRecheckSttModels: WsActionHandler = ({ ws, cmd }) => {
      broadcast(sttModelsMessage(sttManager.recheck()));
    };

    return new Map<string, WsActionHandler>([
      ["installSttModel", handleInstallSttModel],
      ["cancelSttModel", handleCancelSttModel],
      ["selectSttModel", handleSelectSttModel],
      ["recheckSttModels", handleRecheckSttModels],
    ]);
  }
  function captureHandlers(controls: {
    readonly capturing: boolean;
    startCapture(meetingId?: unknown): Promise<void>;
    stopCapture(): Promise<void>;
    captureMessage(): CaptureUpdate;
    reportCaptureActionError(action: "start" | "stop", error: unknown): void;
  }) {
    const { startCapture, stopCapture, captureMessage, reportCaptureActionError } = controls;
    const handleStartCapture: WsActionHandler = ({ ws, cmd }) => {
      void startCapture(cmd.meeting_id).catch((error) => requestError(ws, error));
    };
    const handleStopCapture: WsActionHandler = ({ ws }) => {
      void stopCapture().catch((error) => reportCaptureActionError("stop", error));
    };
    const handleSetCaptureSource: WsActionHandler = ({ ws, cmd }) => {
      if (controls.capturing) {
        requestError(ws, new Error("녹음을 중지한 뒤 오디오 소스를 변경해 주세요"));
        return;
      }
      if (!isCaptureSource(cmd.source)) {
        requestError(ws, new Error("audio source must be mic or system"));
        return;
      }
      captureSource = captureSourceStore.save(cmd.source).source;
      broadcast(captureMessage());
      broadcast({
        type: "status",
        text: captureSource === "system" ? "컴퓨터 소리를 전사합니다" : "마이크로 전사합니다",
      });
    };
    const handleAudio: WsActionHandler = ({ cmd }) => {
      if (!controls.capturing || captureSource !== "system") return;
      if (typeof cmd.data !== "string" || cmd.data.length === 0) return;
      try {
        pcmIngest?.appendBase64(cmd.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        broadcast({ type: "status", text: `컴퓨터 소리 수신 오류: ${message}` });
      }
    };

    return new Map<string, WsActionHandler>([
      ["startCapture", handleStartCapture],
      ["stopCapture", handleStopCapture],
      ["setCaptureSource", handleSetCaptureSource],
      ["audio", handleAudio],
    ]);
  }
  return {
    sttManager,
    createCapture,
    modelHandlers,
    captureHandlers,
    async close() {
      unsubscribe();
      for (const state of sttManager.allStates()) sttManager.cancel(state.model.id);
      await Promise.all(tasks);
    },
    get source() {
      return captureSource;
    },
  };
}
