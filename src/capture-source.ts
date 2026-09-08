import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CAPTURE_SOURCES = ["mic", "system"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export interface CaptureSourceSettings {
  readonly version: 1;
  readonly source: CaptureSource;
}

export function isCaptureSource(value: unknown): value is CaptureSource {
  return value === "mic" || value === "system";
}

export function parseCaptureSourceSettings(text: string): CaptureSourceSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid capture source settings JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid capture source settings object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error("Unsupported capture source settings version");
  if (!isCaptureSource(candidate.source)) {
    throw new Error(`Unknown capture source: ${String(candidate.source)}`);
  }
  return { version: 1, source: candidate.source };
}

export class CaptureSourceStore {
  readonly path: string;

  constructor(readonly projectRoot: string = process.cwd()) {
    this.path = join(projectRoot, ".meeting-slides", "capture-source.json");
  }

  load(): CaptureSource {
    if (!existsSync(this.path)) return "mic";
    return parseCaptureSourceSettings(readFileSync(this.path, "utf-8")).source;
  }

  save(source: CaptureSource): CaptureSourceSettings {
    if (!isCaptureSource(source)) throw new Error(`Unknown capture source: ${String(source)}`);
    const settings: CaptureSourceSettings = { version: 1, source };
    const directory = join(this.projectRoot, ".meeting-slides");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.capture-source-${process.pid}-${randomUUID()}.tmp`);
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
