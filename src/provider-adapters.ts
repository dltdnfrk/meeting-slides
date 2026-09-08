import { spawn } from "node:child_process";

import { cliProcessEnvironment, resolveCliExecutable } from "./config.js";

export type SubscriptionProviderId =
  | "cli:codex"
  | "cli:grok"
  | "cli:claude"
  | "cli:gemini";

export type ProviderId = SubscriptionProviderId | "openai" | "local";
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
  signal?: AbortSignal,
) => Promise<CommandResult>;

export const PROVIDER_PROBE_TIMEOUT_MS = 5_000;

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

const defaultCommandRunner: ProviderCommandRunner = async (executable, args, environment, signal) => {
  if (signal?.aborted) return { status: null, stdout: "", stderr: "", error: new DOMException("Probe cancelled", "AbortError") };
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(executable, [...args], {
      env: cliProcessEnvironment(executable, environment),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let error: Error | undefined;
    // The process group belongs to this probe, including vendor wrapper children.
    const terminate = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        if (!("code" in cause) || cause.code !== "ESRCH") error ??= cause;
      }
    };
    const abort = () => {
      error ??= new DOMException("Probe cancelled", "AbortError");
      terminate();
    };
    const timer = setTimeout(() => {
      error ??= new DOMException("Provider probe timed out", "TimeoutError");
      terminate();
    }, PROVIDER_PROBE_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = 1024 * 1024 - bytes;
      const accepted = Math.min(remaining, chunk.length);
      if (accepted > 0) chunks.push(Buffer.from(chunk.subarray(0, accepted)));
      bytes += accepted;
      if (chunk.length > remaining) {
        error ??= new RangeError("Provider probe output exceeds 1 MiB");
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (cause) => { error ??= cause; terminate(); });
    // `exit` is too early: pipe output can still be draining, or held by children.
    // Keep the deadline alive until close, then reap any remaining group members.
    child.once("close", (status, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      terminate();
      if (exitSignal) error ??= new Error(`Provider probe exited with ${exitSignal}`);
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf-8"), stderr: Buffer.concat(stderr).toString("utf-8"), ...(error ? { error } : {}) });
    });
    if (signal?.aborted) abort();
  });
};

export async function inspectSubscriptionProviders(
  environment: NodeJS.ProcessEnv = process.env,
  run: ProviderCommandRunner = defaultCommandRunner,
  signal?: AbortSignal,
): Promise<ProviderRuntimeState[]> {
  return Promise.all(PROVIDER_ADAPTERS.map(async (adapter): Promise<ProviderRuntimeState> => {
    const executable = resolveCliExecutable(adapter.executable, environment);
    if (signal?.aborted) return { id: adapter.id, installed: false, auth: "unavailable", executable };
    const versionResult = await run(executable, ["--version"], environment, signal);
    const installed = !versionResult.error && versionResult.status === 0;
    if (!installed) return { id: adapter.id, installed: false, auth: "unavailable", executable };

    const version = versionResult.stdout.trim() || versionResult.stderr.trim() || undefined;
    const auth = adapter.authProbe && !signal?.aborted
      ? adapter.authProbe.parse(await run(executable, adapter.authProbe.args, environment, signal))
      : "unknown";
    return { id: adapter.id, installed: true, auth, executable, ...(version ? { version } : {}) };
  }));
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
