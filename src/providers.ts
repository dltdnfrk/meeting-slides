// ============================================================
// providers.ts - provider registry compatibility surface + runtime factory
// ============================================================

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { cliProcessEnvironment, resolveCliExecutable, resolveLLMConfig } from "./config.js";
import { CliLLMClient } from "./llm-cli.js";
import { LLMClient, type ChatTransport, type MeetingLLM } from "./llm.js";
import {
  PROVIDER_ADAPTERS,
  inspectSubscriptionProviders,
  providerAdapter,
  providerConnectCommand,
  type ProviderRuntimeState,
  type SubscriptionProviderId,
} from "./provider-adapters.js";
import {
  HTTP_PROVIDER_DEFINITIONS,
  KEY_BY_PROVIDER,
  PROVIDER_PROBE_TIMEOUT_MS,
  providerModels,
} from "./provider-catalog.js";
import type { ProviderInfo } from "./session.js";

export {
  PROVIDER_ADAPTERS,
  KEY_BY_PROVIDER,
  inspectSubscriptionProviders,
  providerAdapter,
  providerConnectCommand,
};
export type { ProviderRuntimeState, SubscriptionProviderId };

/** Checks executable availability without making a billed model request. */
export function checkCliBin(
  bin: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const executable = resolveCliExecutable(bin, environment);
    const result = spawnSync(executable, ["--version"], {
      env: cliProcessEnvironment(executable, environment),
      stdio: "ignore",
      timeout: PROVIDER_PROBE_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Existing WebSocket-card projection. Rich installed/auth state is available via inspectSubscriptionProviders. */
export function buildProviderEntries(
  env: NodeJS.ProcessEnv,
  cliAvailable: Record<string, boolean>,
): ProviderInfo[] {
  const subscriptions = PROVIDER_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    detail: adapter.detail,
    available: cliAvailable[adapter.executable] ?? false,
    models: adapter.models.map((model) => model.id),
    ...(adapter.efforts.length > 0
      ? { efforts: adapter.efforts.map((effort) => effort.id) }
      : {}),
  }));
  const httpProviders = HTTP_PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    detail: env[definition.detailEnvironment] ?? definition.defaultDetail,
    available: Boolean(env[definition.availabilityEnvironment]),
    models: [...(providerModels(definition.id) ?? [])],
  }));
  return [...subscriptions, ...httpProviders];
}

/** Projects typed runtime states into the legacy provider-card protocol. */
export function buildProviderEntriesFromStates(
  env: NodeJS.ProcessEnv,
  states: readonly ProviderRuntimeState[],
): ProviderInfo[] {
  return buildProviderEntries(env, {}).map((entry) => {
    const state = states.find((candidate) => candidate.id === entry.id);
    if (!state) return entry;
    return {
      ...entry,
      available: state.auth === "connected",
      selectable: state.installed && state.auth !== "unavailable",
      installed: state.installed,
      auth: state.auth,
      ...(state.version ? { version: state.version } : {}),
    };
  });
}

/** Creates the selected live detector, returning null for unknown or incomplete HTTP providers. */
export function createDetector(
  id: string,
  opts: {
    cliTimeoutMs: number;
    model?: string;
    effort?: string;
    environment?: NodeJS.ProcessEnv;
  },
): (MeetingLLM & ChatTransport) | null {
  const adapter = providerAdapter(id);
  if (adapter) {
    return new CliLLMClient({
      bin: resolveCliExecutable(adapter.executable, opts.environment ?? process.env),
      preset: adapter.preset,
      timeoutMs: opts.cliTimeoutMs,
      model: opts.model ?? adapter.defaultModel,
      effort: opts.effort ?? adapter.defaultEffort,
    });
  }
  try {
    const config = resolveLLMConfig(id);
    if (opts.model) config.model = opts.model;
    return new LLMClient(config);
  } catch {
    return null;
  }
}

/** Upserts API-key settings while preserving unrelated .env lines. Subscription auth is never stored here. */
export function upsertEnvText(text: string, entries: Record<string, string>): string {
  const seen = new Set<string>();
  const out = text.split("\n").map((line) => {
    const index = line.indexOf("=");
    if (index <= 0) return line;
    const key = line.slice(0, index).trim();
    if (!(key in entries)) return line;
    seen.add(key);
    return `${key}=${entries[key]}`;
  });
  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return out.join("\n");
}

export function persistProviderKey(path: string, key: string, value: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, upsertEnvText(current, { [key]: value }), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
