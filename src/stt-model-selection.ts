import { SttModelManager } from "./stt-model-downloader.js";
import type { SttModelArtifact, SttModelId } from "./stt-model-catalog.js";

export interface SttCaptureIdentity {
  readonly engine: "whisper.cpp" | "transcribe.cpp";
  readonly engineModel: string;
}

export function resolveSttCaptureIdentity(input: {
  readonly selectedArtifact: Pick<SttModelArtifact, "backend"> | null;
  readonly selectedPath: string | null;
  readonly fallbackModelPath: string;
}): SttCaptureIdentity {
  if (input.selectedArtifact?.backend === "transcribe" && input.selectedPath === null) {
    throw new Error("selected transcribe model is not installed");
  }
  const engineModel = input.selectedPath ?? input.fallbackModelPath;
  if (engineModel.trim() === "") throw new Error("capture model path must not be blank");
  return Object.freeze({
    engine: input.selectedArtifact?.backend === "transcribe" ? "transcribe.cpp" : "whisper.cpp",
    engineModel,
  });
}

export interface SttCaptureController {
  isCapturing(): boolean;
  stopCapture(): Promise<void>;
  startCapture(): Promise<void>;
  rebuildCapture(): void;
}

/** Serialize selection changes and restart active capture only after the new model is selected. */
export function createSelectSttModel(
  sttManager: SttModelManager,
  capture: SttCaptureController,
): (id: SttModelId) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (id: SttModelId) => {
    const next = chain.then(async () => {
      const currentPath = sttManager.selectedPath();
      if (capture.isCapturing()) {
        throw new Error("녹음을 중지한 뒤 음성 인식 모델을 변경해 주세요");
      }
      const nextPath = sttManager.select(id);
      if (currentPath === nextPath) return;
      capture.rebuildCapture();
    });
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}
