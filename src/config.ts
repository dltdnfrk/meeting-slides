// ============================================================
// config.ts - 환경 설정 로더
// ============================================================

export interface LLMProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface CliLLMConfig {
  bin: string;                    // claude | codex (또는 전체 경로)
  preset: "claude" | "codex";     // 출력 계약 프리셋
  timeoutMs: number;
}

export interface WhisperConfig {
  streamBin: string;   // whisper-stream (마이크)
  cliBin: string;       // whisper-cli (파일)
  modelPath: string;
  captureId: number;
  threads: number;
  stepMs: number;
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

function resolveLLMConfig(provider: string): LLMProviderConfig {
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

function resolveCliConfig(): CliLLMConfig {
  const bin = env("LLM_CLI_BIN", "claude");
  const presetEnv = env("LLM_CLI_PRESET", "").trim();
  if (presetEnv && presetEnv !== "claude" && presetEnv !== "codex") {
    throw new Error(`LLM_CLI_PRESET은 claude|codex 중 하나여야 함: ${presetEnv}`);
  }
  // 프리셋 미지정 시 바이너리 이름에서 자동 감지
  const preset: CliLLMConfig["preset"] = presetEnv === "claude" || presetEnv === "codex"
    ? presetEnv
    : bin.includes("codex") ? "codex" : "claude";
  const timeoutMs = intEnv("LLM_CLI_TIMEOUT_MS", 120_000);
  if (timeoutMs < 1000) throw new Error(`LLM_CLI_TIMEOUT_MS는 1000 이상이어야 함: ${timeoutMs}`);
  return { bin, preset, timeoutMs };
}

export function loadWhisperConfig(): WhisperConfig {
  return {
    streamBin: env("WHISPER_STREAM_BIN", "/opt/homebrew/bin/whisper-stream"),
    cliBin: env("WHISPER_CLI_BIN", "/opt/homebrew/bin/whisper-cli"),
    modelPath: env("WHISPER_MODEL_PATH", "./models/ggml-medium.bin"),
    captureId: intEnv("WHISPER_CAPTURE_ID", -1),
    threads: intEnv("WHISPER_THREADS", 4),
    stepMs: intEnv("WHISPER_STEP_MS", 3000),
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
