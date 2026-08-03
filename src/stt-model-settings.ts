import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isSttModelId, type SttModelId } from "./stt-model-catalog.js";

export interface SttModelSettings {
  readonly version: 1;
  readonly selectedModelId: SttModelId;
}

function parseSettings(text: string): SttModelSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid STT model settings JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid STT model settings object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error("Unsupported STT model settings version");
  if (!isSttModelId(candidate.selectedModelId)) {
    throw new Error(`Unknown selected STT model: ${String(candidate.selectedModelId)}`);
  }
  return { version: 1, selectedModelId: candidate.selectedModelId };
}

/** Dedicated project-local persistence for the whisper.cpp model selection. */
export class SttModelSettingsStore {
  readonly path: string;

  constructor(readonly projectRoot: string = process.cwd()) {
    this.path = join(projectRoot, ".meeting-slides", "stt-settings.json");
  }

  load(): SttModelSettings | null {
    if (!existsSync(this.path)) return null;
    return parseSettings(readFileSync(this.path, "utf-8"));
  }

  save(selectedModelId: SttModelId): SttModelSettings {
    if (!isSttModelId(selectedModelId)) throw new Error(`Unknown STT model: ${String(selectedModelId)}`);
    const settings: SttModelSettings = { version: 1, selectedModelId };
    const directory = join(this.projectRoot, ".meeting-slides");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.stt-settings-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return settings;
  }
}
