import { SttModelManager } from "./stt-model-downloader.js";
import type { SttModelId } from "./stt-model-catalog.js";

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
      const nextPath = sttManager.select(id);
      if (currentPath === nextPath) return;
      const wasCapturing = capture.isCapturing();
      if (wasCapturing) {
        await capture.stopCapture();
      }
      capture.rebuildCapture();
      if (wasCapturing) {
        await capture.startCapture();
      }
    });
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}
