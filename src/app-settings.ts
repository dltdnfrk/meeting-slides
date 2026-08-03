import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { providerAdapter, type ProviderId } from "./provider-adapters.js";

export interface ProviderSelection {
  providerId: ProviderId;
  model?: string;
  effort?: string;
}

export interface AppSettings extends ProviderSelection {
  version: 1;
}

const PROVIDER_IDS = new Set<ProviderId>([
  "cli:codex",
  "cli:grok",
  "cli:claude",
  "cli:gemini",
  "alibaba",
  "openai",
  "local",
]);

const HTTP_MODELS: Partial<Record<ProviderId, readonly string[]>> = {
  alibaba: ["glm-5.2", "glm-5.1", "glm-4.7"],
  openai: ["gpt-4o-mini", "gpt-4o"],
};

function nonEmptyOptional(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`Invalid provider setting: ${field}`);
  }
  return value;
}

export function validateProviderSelection(value: unknown): ProviderSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider settings object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.providerId !== "string" || !PROVIDER_IDS.has(candidate.providerId as ProviderId)) {
    throw new Error(`Unknown provider: ${String(candidate.providerId)}`);
  }
  const providerId = candidate.providerId as ProviderId;
  const model = nonEmptyOptional(candidate.model, "model");
  const effort = nonEmptyOptional(candidate.effort, "effort");
  const adapter = providerAdapter(providerId);

  const allowedModels = adapter?.models.map((entry) => entry.id) ?? HTTP_MODELS[providerId];
  if (model && allowedModels && !allowedModels.includes(model)) {
    throw new Error(`Unsupported model for ${providerId}: ${model}`);
  }
  const allowedEfforts = adapter?.efforts.map((entry) => entry.id) ?? [];
  if (effort && !allowedEfforts.includes(effort)) {
    throw new Error(`Unsupported effort for ${providerId}: ${effort}`);
  }

  return { providerId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function parseSettings(text: string): AppSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid app settings JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    throw new Error("Unsupported app settings version");
  }
  return { version: 1, ...validateProviderSelection(value) };
}

/** Project-local application preferences. Vendor credential files are never read or written. */
export class AppSettingsStore {
  readonly path: string;

  constructor(readonly projectRoot: string = process.cwd()) {
    this.path = join(projectRoot, ".meeting-slides", "settings.json");
  }

  load(): AppSettings | null {
    if (!existsSync(this.path)) return null;
    return parseSettings(readFileSync(this.path, "utf-8"));
  }

  save(selection: ProviderSelection): AppSettings {
    const settings: AppSettings = { version: 1, ...validateProviderSelection(selection) };
    const directory = join(this.projectRoot, ".meeting-slides");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(directory, `.settings-${process.pid}-${randomUUID()}.tmp`);
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
