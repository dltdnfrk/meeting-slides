// ============================================================
// config.ts - 환경 설정 로더
// ============================================================

import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface LLMProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface CliLLMConfig {
  bin: string;                    // provider CLI name or absolute path
  preset: "claude" | "codex" | "grok" | "gemini";
  timeoutMs: number;
  model?: string;                 // 미지정 시 CLI 기본 모델
  effort?: string;                // codex: model_reasoning_effort (low|medium|high)
}

export interface WhisperConfig {
  streamBin: string;   // whisper-stream (마이크)
  cliBin: string;       // whisper-cli (파일)
  modelPath: string;
  captureId: number;
  threads: number;
  stepMs: number;
  diarize: boolean;     // tinydiarize 화자 전환 감지
  tdrzModelPath: string; // diarize=true일 때 사용하는 tdrz 모델 (현재 영어 전용만 존재)
}

export type InputMode = "mic" | "file";

export interface FileInputConfig {
  mode: InputMode;
  filePath: string | null;  // mode=file일 때만 사용
}

export interface Config {
  whisper: WhisperConfig;
  input: FileInputConfig;
  llm: {
    provider: string;
    config: LLMProviderConfig | null;  // HTTP 프로바이더 (alibaba|openai|local)
    cli: CliLLMConfig | null;          // provider=cli (구독 서비스 백엔드)
  };
  block: {
    detectInterval: number;
    contextWindow: number;
  };
  server: {
    httpPort: number;
    openBrowser: boolean;
  };
}

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`환경 변수 누락: ${key}`);
  return v;
}

function intEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const trimmed = v.trim();
  const n = Number(trimmed);
  // Number + 정수 왕복 검사로 "8787abc", "0x10", "1e3" 같은 오염 입력 거부.
  if (!Number.isInteger(n) || String(n) !== trimmed) {
    throw new Error(`정수 아님: ${key}=${v}`);
  }
  return n;
}

export function resolveLLMConfig(provider: string): LLMProviderConfig {
  switch (provider) {
    case "alibaba":
      return {
        baseURL: env("ALIBABA_TOKEN_PLAN_BASE_URL", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
        apiKey: env("ALIBABA_TOKEN_PLAN_API_KEY"),
        model: env("ALIBABA_TOKEN_PLAN_MODEL", "glm-5.2"),
      };
    case "openai":
      return {
        baseURL: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        apiKey: env("OPENAI_API_KEY"),
        model: env("OPENAI_MODEL", "gpt-4o-mini"),
      };
    case "local":
      return {
        baseURL: env("LOCAL_LLM_BASE_URL"),
        apiKey: "none",
        model: env("LOCAL_LLM_MODEL"),
      };
    default:
      throw new Error(`알 수 없는 LLM_PROVIDER: ${provider}. alibaba|openai|local|cli 중 하나.`);
  }
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cliSearchDirectories(environment: NodeJS.ProcessEnv): string[] {
  const home = environment.HOME?.trim();
  return [
    ...(environment.PATH ?? "").split(delimiter),
    ...(home ? [
      join(home, ".npm-global", "bin"),
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
      join(home, ".grok", "bin"),
    ] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((directory, index, directories) =>
    directory.length > 0 && directories.indexOf(directory) === index
  );
}

export function resolveCliExecutable(
  bin: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (bin.includes("/")) return bin;

  return cliSearchDirectories(environment)
    .map((directory) => join(directory, bin))
    .find(canExecute) ?? bin;
}

export function cliProcessEnvironment(
  bin: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const path = [
    ...(bin.includes("/") ? [dirname(bin)] : []),
    ...cliSearchDirectories(environment),
  ].filter((directory, index, directories) =>
    directories.indexOf(directory) === index
  ).join(delimiter);
  return { ...environment, PATH: path };
}

function resolveCliConfig(): CliLLMConfig {
  const bin = resolveCliExecutable(env("LLM_CLI_BIN", "claude"));
  const presetEnv = env("LLM_CLI_PRESET", "").trim();
  const supportedPresets: readonly CliLLMConfig["preset"][] = ["claude", "codex", "grok", "gemini"];
  if (presetEnv && !supportedPresets.includes(presetEnv as CliLLMConfig["preset"])) {
    throw new Error(`LLM_CLI_PRESET은 claude|codex|grok|gemini 중 하나여야 함: ${presetEnv}`);
  }
  const inferredPreset = supportedPresets.find((candidate) => bin.includes(candidate));
  const preset: CliLLMConfig["preset"] = presetEnv
    ? presetEnv as CliLLMConfig["preset"]
    : inferredPreset ?? "claude";
  const timeoutMs = intEnv("LLM_CLI_TIMEOUT_MS", 120_000);
  if (timeoutMs < 1000) throw new Error(`LLM_CLI_TIMEOUT_MS는 1000 이상이어야 함: ${timeoutMs}`);
  const model = env("LLM_CLI_MODEL", preset === "codex" ? "gpt-5.6-sol" : "").trim();
  const effort = env("LLM_CLI_EFFORT", preset === "codex" ? "high" : "").trim();
  return {
    bin,
    preset,
    timeoutMs,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function loadWhisperConfig(): WhisperConfig {
  return {
    streamBin: env("WHISPER_STREAM_BIN", "/opt/homebrew/bin/whisper-stream"),
    cliBin: env("WHISPER_CLI_BIN", "/opt/homebrew/bin/whisper-cli"),
    modelPath: env("WHISPER_MODEL_PATH", "./models/ggml-medium.bin"),
    captureId: intEnv("WHISPER_CAPTURE_ID", -1),
    threads: intEnv("WHISPER_THREADS", 4),
    stepMs: intEnv("WHISPER_STEP_MS", 3000),
    diarize: ["true", "1", "yes", "on"].includes(env("WHISPER_DIARIZE", "false").toLowerCase()),
    tdrzModelPath: env("WHISPER_TDRZ_MODEL_PATH", "./models/ggml-small.en-tdrz.bin"),
  };
}

export function loadConfig(args: string[] = []): Config {
  // 입력 모드 우선순위: CLI 인자 > 환경변수 > mic
  let inputMode = env("WHISPER_INPUT_MODE", "mic") as InputMode;
  let filePath: string | null = env("WHISPER_FILE_PATH", "") || null;
  if (inputMode !== "mic" && inputMode !== "file") {
    throw new Error(`WHISPER_INPUT_MODE는 mic 또는 file이어야 함: ${inputMode}`);
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file" && args[i + 1]) {
      inputMode = "file";
      filePath = args[++i];
    } else if (a === "--mic") {
      inputMode = "mic";
      filePath = null;
    }
  }

  const finalMode: InputMode = inputMode;
  const finalFile = filePath;
  if (finalMode === "file" && !finalFile) {
    throw new Error("file 모드이지만 파일 경로 없음. --file <path> 또는 WHISPER_FILE_PATH 설정.");
  }

  const provider = env("LLM_PROVIDER", "alibaba");
  const llm = provider === "cli"
    ? { provider, config: null, cli: resolveCliConfig() }
    : { provider, config: resolveLLMConfig(provider), cli: null };
  const detectInterval = intEnv("BLOCK_DETECT_SENTENCE_INTERVAL", 4);
  const contextWindow = intEnv("BLOCK_CONTEXT_WINDOW", 12);
  const httpPort = intEnv("HTTP_PORT", 8787);
  const openBrowser = !["false", "0", "no", "off"].includes(env("OPEN_BROWSER", "true").toLowerCase());
  if (detectInterval < 1) throw new Error(`BLOCK_DETECT_SENTENCE_INTERVAL은 1 이상이어야 함: ${detectInterval}`);
  if (contextWindow < 1) throw new Error(`BLOCK_CONTEXT_WINDOW는 1 이상이어야 함: ${contextWindow}`);
  if (httpPort < 1 || httpPort > 65535) throw new Error(`HTTP_PORT는 1-65535 범위여야 함: ${httpPort}`);
  return {
    whisper: loadWhisperConfig(),
    input: {
      mode: finalMode,
      filePath: finalFile,
    },
    llm,
    block: {
      detectInterval,
      contextWindow,
    },
    server: {
      httpPort,
      openBrowser,
    },
  };
}
