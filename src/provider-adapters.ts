import { spawnSync } from "node:child_process";

import { cliProcessEnvironment, resolveCliExecutable } from "./config.js";

export type SubscriptionProviderId =
  | "cli:codex"
  | "cli:grok"
  | "cli:claude"
  | "cli:gemini";

export type ProviderId = SubscriptionProviderId | "alibaba" | "openai" | "local";
export type ProviderCliPreset = "codex" | "grok" | "claude" | "gemini";
export type ProviderAuthState = "connected" | "disconnected" | "unknown" | "unavailable";

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderEffort {
  id: string;
  label: string;
}

export interface AuthProbeDescriptor {
  args: readonly string[];
  parse(result: CommandResult): Exclude<ProviderAuthState, "unavailable">;
}

export interface SubscriptionProviderAdapter {
  id: SubscriptionProviderId;
  preset: ProviderCliPreset;
  executable: string;
  label: string;
  detail: string;
  models: readonly ProviderModel[];
  efforts: readonly ProviderEffort[];
  defaultModel?: string;
  defaultEffort?: string;
  connectArgs: readonly string[];
  authProbe?: AuthProbeDescriptor;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface ProviderRuntimeState {
  id: SubscriptionProviderId;
  installed: boolean;
  auth: ProviderAuthState;
  executable: string;
  version?: string;
}

export interface ProviderConnectCommand {
  providerId: SubscriptionProviderId;
  executable: string;
  args: string[];
  interactive: true;
  environment: NodeJS.ProcessEnv;
}

export type ProviderCommandRunner = (
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => CommandResult;

function parseClaudeAuth(result: CommandResult): Exclude<ProviderAuthState, "unavailable"> {
  if (result.error) return "unknown";
  if (result.status !== 0) return "disconnected";
  try {
    const value = JSON.parse(result.stdout) as { loggedIn?: unknown };
    return typeof value.loggedIn === "boolean"
      ? value.loggedIn ? "connected" : "disconnected"
      : "unknown";
  } catch {
    return "unknown";
  }
}

const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]
  .map((id) => ({ id, label: id }));
const CODEX_EFFORTS = ["low", "medium", "high"]
  .map((id) => ({ id, label: id }));

export const PROVIDER_ADAPTERS: readonly SubscriptionProviderAdapter[] = [
  {
    id: "cli:codex",
    preset: "codex",
    executable: "codex",
    label: "ChatGPT",
    detail: "구독 계정",
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
    defaultModel: "gpt-5.6-sol",
    defaultEffort: "high",
    connectArgs: ["login"],
    authProbe: {
      args: ["login", "status"],
      parse: (result) => result.error ? "unknown" : result.status === 0 ? "connected" : "disconnected",
    },
  },
  {
    id: "cli:grok",
    preset: "grok",
    executable: "grok",
    label: "Grok",
    detail: "xAI 계정",
    models: [{ id: "grok-4.5", label: "Grok 4.5" }],
    efforts: [],
    defaultModel: "grok-4.5",
    connectArgs: ["login"],
  },
  {
    id: "cli:claude",
    preset: "claude",
    executable: "claude",
    label: "Claude",
    detail: "Claude Pro 또는 Max 계정",
    models: ["opus", "sonnet", "haiku"].map((id) => ({ id, label: id })),
    efforts: [],
    connectArgs: ["auth", "login"],
    authProbe: {
      args: ["auth", "status", "--json"],
      parse: parseClaudeAuth,
    },
  },
  {
    id: "cli:gemini",
    preset: "gemini",
    executable: "gemini",
    label: "Gemini",
    detail: "Google 계정",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"].map((id) => ({ id, label: id })),
    efforts: [],
    connectArgs: [],
  },
] as const;

const ADAPTER_BY_ID = new Map(PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function providerAdapter(id: string): SubscriptionProviderAdapter | undefined {
  return ADAPTER_BY_ID.get(id as SubscriptionProviderId);
}

const defaultCommandRunner: ProviderCommandRunner = (executable, args, environment) => {
  const result = spawnSync(executable, [...args], {
    env: cliProcessEnvironment(executable, environment),
    encoding: "utf-8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

export function inspectSubscriptionProviders(
  environment: NodeJS.ProcessEnv = process.env,
  run: ProviderCommandRunner = defaultCommandRunner,
): ProviderRuntimeState[] {
  return PROVIDER_ADAPTERS.map((adapter) => {
    const executable = resolveCliExecutable(adapter.executable, environment);
    const versionResult = run(executable, ["--version"], environment);
    const installed = !versionResult.error && versionResult.status === 0;
    if (!installed) return { id: adapter.id, installed: false, auth: "unavailable", executable };

    const version = versionResult.stdout.trim() || versionResult.stderr.trim() || undefined;
    const auth = adapter.authProbe
      ? adapter.authProbe.parse(run(executable, adapter.authProbe.args, environment))
      : "unknown";
    return { id: adapter.id, installed: true, auth, executable, ...(version ? { version } : {}) };
  });
}

export function providerConnectCommand(
  id: SubscriptionProviderId,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderConnectCommand | null {
  const adapter = providerAdapter(id);
  if (!adapter) return null;
  const executable = resolveCliExecutable(adapter.executable, environment);
  return {
    providerId: id,
    executable,
    args: [...adapter.connectArgs],
    interactive: true,
    environment: cliProcessEnvironment(executable, environment),
  };
}
