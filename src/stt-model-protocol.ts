import { STT_MODEL_CATALOG, type SttModelId } from "./stt-model-catalog.js";
import type { SttModelState } from "./stt-model-downloader.js";
import type { SttModelsUpdate, SttModelInfo } from "./session.js";

export function toSttModelInfo(state: SttModelState): SttModelInfo {
  return {
    id: state.model.id,
    label: state.model.label,
    sizeBytes: state.model.sizeBytes,
    license: state.model.license,
    status: state.status,
    ...(state.status === "installed" || state.status === "selected" ? { path: state.path } : {}),
    ...(state.status === "downloading" ? { receivedBytes: state.receivedBytes, totalBytes: state.totalBytes } : {}),
    ...(state.status === "failed" ? { error: state.error } : {}),
  };
}

export function sttModelsMessage(states: readonly SttModelState[]): SttModelsUpdate {
  const models = STT_MODEL_CATALOG.map((model) => {
    const state = states.find((entry) => entry.model.id === model.id);
    if (!state) throw new Error(`Missing STT state for ${model.id}`);
    return toSttModelInfo(state);
  });
  return {
    type: "sttModels",
    models,
    selectedModelId: models.find((model) => model.status === "selected")?.id ?? null,
  };
}

export function isSelectableSttModelId(value: unknown): value is SttModelId {
  return typeof value === "string" && (STT_MODEL_CATALOG as readonly { id: SttModelId }[]).some((model) => model.id === value);
}
