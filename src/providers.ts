// ============================================================
// providers.ts - provider registry compatibility surface + runtime factory
// ============================================================

import { spawnSync } from "node:child_process";

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
import type { ProviderInfo } from "./session.js";

export {
  PROVIDER_ADAPTERS,
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
      timeout: 5_000,
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
  return [
    ...subscriptions,
    {
      id: "alibaba",
      label: "Alibaba GLM",
      detail: env.ALIBABA_TOKEN_PLAN_MODEL ?? "glm-5.2",
      available: Boolean(env.ALIBABA_TOKEN_PLAN_API_KEY),
      models: PROVIDER_MODELS.alibaba,
    },
    {
      id: "openai",
      label: "OpenAI API",
      detail: env.OPENAI_MODEL ?? "gpt-4o-mini",
      available: Boolean(env.OPENAI_API_KEY),
      models: PROVIDER_MODELS.openai,
    },
    {
      id: "local",
      label: "Local llama.cpp",
      detail: env.LOCAL_LLM_BASE_URL ?? "Not configured",
      available: Boolean(env.LOCAL_LLM_BASE_URL),
      models: [],
    },
  ];
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

export const PROVIDER_MODELS: Record<string, string[]> = {
  ...Object.fromEntries(PROVIDER_ADAPTERS.map((adapter) => [
    adapter.id,
    adapter.models.map((model) => model.id),
  ])),
  alibaba: ["glm-5.2", "glm-5.1", "glm-4.7"],
  openai: ["gpt-4o-mini", "gpt-4o"],
  local: [],
};

export const PROVIDER_EFFORTS: Record<string, string[]> = Object.fromEntries(
  PROVIDER_ADAPTERS
    .filter((adapter) => adapter.efforts.length > 0)
    .map((adapter) => [adapter.id, adapter.efforts.map((effort) => effort.id)]),
);

export const KEY_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  alibaba: "ALIBABA_TOKEN_PLAN_API_KEY",
};

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
