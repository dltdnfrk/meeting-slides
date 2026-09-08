import { type ChatTransport, type MeetingLLM } from "../llm.ts";
import { MeetingSession } from "../session.ts";
import type { ClientListener, ProvidersUpdate } from "../protocol.ts";
import {
  buildProviderEntriesFromStates,
  createDetector,
  inspectSubscriptionProviders,
  KEY_BY_PROVIDER,
  persistProviderKey,
  providerAdapter,
  providerConnectCommand,
  type ProviderRuntimeState,
  type SubscriptionProviderId,
} from "../providers.ts";
import { AppSettingsStore } from "../app-settings.ts";
import { spawn } from "child_process";
import type { Config } from "../config.ts";
import type { ApplicationPaths } from "./application.ts";
import { type WsActionHandler } from "./websocket.ts";

export interface DetectorState {
  llm: MeetingLLM;
  extractionTransport: ChatTransport;
  llmLabel: string;
  currentProviderId: string;
  currentModel: string | undefined;
  currentEffort: string | undefined;
}
export function createProvidersController(deps: {
  readonly config: Config;
  readonly paths: ApplicationPaths;
  readonly detector: DetectorState;
  readonly session: MeetingSession;
  readonly broadcast: ClientListener;
  readonly discover?: typeof inspectSubscriptionProviders;
}) {
  const { config, paths, detector, session, broadcast } = deps;
  const discoveryAbort = new AbortController();
  const discover = deps.discover ?? inspectSubscriptionProviders;
  let discovery: Promise<void> | null = null;
  const children = new Set<ReturnType<typeof spawn>>();
  const checks = new Set<Promise<void>>();
  function ownChild(child: ReturnType<typeof spawn>) {
    children.add(child);
    child.once("close", () => children.delete(child));
    child.on("error", (error) => broadcast({ type: "status", text: error.message }));
  }
  function signalChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  function activateDetector(client: MeetingLLM & ChatTransport) {
    detector.llm = client;
    detector.extractionTransport = client;
    session.setDetector(client);
  }
  const appSettings = new AppSettingsStore(paths.settingsRoot);
  let providerStates: ProviderRuntimeState[] = [];
  let providerEntries = buildProviderEntriesFromStates(process.env, providerStates);
  function enrichProviderEntries(): void {
    providerEntries = buildProviderEntriesFromStates(process.env, providerStates);
    for (const entry of providerEntries) {
      const state = providerStates.find((candidate) => candidate.id === entry.id);
      if (state)
        Object.assign(entry, {
          installed: state.installed,
          auth: state.auth,
          ...(state.version ? { version: state.version } : {}),
        });
    }
  }
  enrichProviderEntries();
  const cliTimeoutMs = config.llm.cli?.timeoutMs ?? 120000;
  try {
    const saved = appSettings.load();
    if (saved) {
      const restored = createDetector(saved.providerId, { cliTimeoutMs, model: saved.model, effort: saved.effort });
      if (restored) {
        activateDetector(restored);
        detector.currentProviderId = saved.providerId;
        detector.currentModel = saved.model;
        detector.currentEffort = saved.effort;
        detector.llmLabel = `${saved.providerId}${saved.model ? `/${saved.model}` : ""}${saved.effort ? `·${saved.effort}` : ""}`;
      }
    }
  } catch (error) {
    console.warn(`[settings] 앱 설정 복원 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  function providersMessage(): ProvidersUpdate {
    return {
      type: "providers",
      list: providerEntries,
      current: detector.currentProviderId,
      currentModel: detector.currentModel,
      currentEffort: detector.currentEffort,
    };
  }
  function openUrl(url: string): void {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    ownChild(spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }));
  }
  function connectProvider(id: string): void {
    const adapter = providerAdapter(id);
    if (adapter) {
      const command = providerConnectCommand(id as SubscriptionProviderId);
      if (!command) return;
      broadcast({
        type: "status",
        text: `${adapter.label} 로그인 화면을 열었습니다. 로그인 후 연결 상태를 다시 확인해 주세요`,
      });
      const child = spawn(command.executable, command.args, {
        env: command.environment,
        stdio: "inherit",
        detached: true,
      });
      ownChild(child);
      return;
    }
    switch (id) {
      case "openai": {
        broadcast({ type: "status", text: "OpenAI API 키 발급 페이지를 열었습니다. 발급한 키를 입력해 주세요" });
        openUrl("https://platform.openai.com/api-keys");
        break;
      }
      default:
        broadcast({ type: "status", text: "로컬 모델 서버 주소를 설정해 주세요" });
    }
  }
  async function recheckProviders(): Promise<void> {
    providerStates = await discover(process.env, undefined, discoveryAbort.signal);
    if (discoveryAbort.signal.aborted) return;
    enrichProviderEntries();
    broadcast(providersMessage());
  }
  const handleSetProvider: WsActionHandler = ({ ws, cmd }) => {
    if (typeof cmd.id !== "string") return;
    const entry = providerEntries.find((e) => e.id === cmd.id);
    if (!entry) {
      ws.send(JSON.stringify({ type: "status" as const, text: `알 수 없는 프로바이더: ${cmd.id}` }));
    } else if (!(entry.selectable ?? entry.available)) {
      const reason =
        entry.installed === false
          ? "CLI가 설치되지 않음"
          : entry.auth === "unknown"
            ? "인증 상태를 확인할 수 없음"
            : entry.auth === "disconnected"
              ? "로그인되지 않음"
              : "설정되지 않음";
      ws.send(JSON.stringify({ type: "status" as const, text: `${entry.label}: ${reason}` }));
    } else {
      const adapter = providerAdapter(entry.id);
      const requestedModel = typeof cmd.model === "string" && cmd.model.trim() ? cmd.model.trim() : undefined;
      const model =
        requestedModel && (entry.models ?? []).includes(requestedModel) ? requestedModel : adapter?.defaultModel;
      const requestedEffort = typeof cmd.effort === "string" && cmd.effort.trim() ? cmd.effort.trim() : undefined;
      const effort =
        requestedEffort && (entry.efforts ?? []).includes(requestedEffort) ? requestedEffort : adapter?.defaultEffort;
      const candidate = createDetector(entry.id, { cliTimeoutMs, model, effort });
      if (candidate) {
        activateDetector(candidate);
        detector.currentProviderId = entry.id;
        detector.currentModel = model;
        detector.currentEffort = effort;
        detector.llmLabel = `${entry.label}${model ? `/${model}` : ""}${effort ? `·${effort}` : ""}`;
        appSettings.save({
          providerId: entry.id as Parameters<AppSettingsStore["save"]>[0]["providerId"],
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        });
        broadcast(providersMessage());
        broadcast({ type: "status", text: `LLM 변경됨: ${detector.llmLabel}` });
        const check = candidate
          .ping()
          .then((ok) => {
            if (!ok) broadcast({ type: "status", text: `⚠️ ${entry.label} 연결 확인에 실패했습니다` });
          })
          .catch((error) => broadcast({ type: "status", text: error instanceof Error ? error.message : String(error) }))
          .finally(() => checks.delete(check));
        checks.add(check);
      }
    }
  };
  const handleConnectProvider: WsActionHandler = ({ ws, cmd }) => {
    if (typeof cmd.id !== "string") return;
    connectProvider(cmd.id);
  };
  const handleSetProviderKey: WsActionHandler = ({ ws, cmd }) => {
    if (typeof cmd.id !== "string" || typeof cmd.key !== "string") return;
    const envKey = KEY_BY_PROVIDER[cmd.id];
    const key = cmd.key.trim();
    if (!envKey || !key || /[\r\n]/.test(key)) {
      ws.send(JSON.stringify({ type: "status" as const, text: "잘못된 키 형식입니다" }));
    } else {
      // 런타임 즉시 적용 + .env에도 기록 (0600). 기록 실패해도 세션은 동작.
      process.env[envKey] = key;
      try {
        const envPath = paths.envPath;
        persistProviderKey(envPath, envKey, key);
      } catch {
        broadcast({ type: "status", text: "(.env 기록 실패 — 이번 세션에만 적용됩니다)" });
      }
      const entry = providerEntries.find((e) => e.id === cmd.id);
      if (entry) entry.available = true;
      broadcast(providersMessage());
      broadcast({ type: "status", text: `${entry?.label ?? cmd.id} 키 저장됨 ✓` });
    }
  };
  const handleRecheckProviders: WsActionHandler = ({ ws, cmd }) => {
    void startDiscovery();
  };
  function startDiscovery(): Promise<void> {
    return (discovery ??= recheckProviders()
      .catch((error) => {
        if (!discoveryAbort.signal.aborted)
          broadcast({ type: "status", text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        discovery = null;
      }));
  }
  return {
    handlers: new Map<string, WsActionHandler>([
      ["setProvider", handleSetProvider],
      ["connectProvider", handleConnectProvider],
      ["setProviderKey", handleSetProviderKey],
      ["recheckProviders", handleRecheckProviders],
    ]),
    providersMessage,
    startDiscovery,
    async close() {
      discoveryAbort.abort();
      await Promise.all([
        discovery,
        ...checks,
        ...[...children].map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                try {
                  signalChild(child, "SIGKILL");
                } catch (error) {
                  reject(error);
                }
              }, 750);
              child.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
              try {
                signalChild(child, "SIGTERM");
              } catch (error) {
                clearTimeout(timer);
                reject(error);
              }
            }),
        ),
      ]);
    },
  };
}
