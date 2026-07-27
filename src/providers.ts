// ============================================================
// providers.ts - LLM 프로바이더 레지스트리 + 런타임 교체 팩터리
// ============================================================
// 사용자가 UI에서 백엔드를 직접 고를 수 있게, 사용 가능한 프로바이더 목록과
// 현재 선택을 관리한다. 사용 가능 여부는 CLI 설치 여부 / API 키 존재로 판정.

import { spawnSync } from "child_process";

import { LLMClient, type BlockDetector } from "./llm.js";
import { CliLLMClient } from "./llm-cli.js";
import { resolveLLMConfig } from "./config.js";
import type { ProviderInfo } from "./session.js";

/** CLI 바이너리가 실행 가능한지 (--version, 과금 없음) */
export function checkCliBin(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 프로바이더 카드 목록. cliAvailable은 {claude: bool, codex: bool}처럼
 * 바이너리 탐지 결과를 주입한다 (테스트에서 spawn을 피하기 위함).
 */
export function buildProviderEntries(
  env: NodeJS.ProcessEnv,
  cliAvailable: Record<string, boolean>,
): ProviderInfo[] {
  return [
    {
      id: "cli:claude",
      label: "Claude (구독)",
      detail: "claude CLI — Claude Pro/Max 구독 인증",
      available: cliAvailable["claude"] ?? false,
      models: PROVIDER_MODELS["cli:claude"],
    },
    {
      id: "cli:codex",
      label: "GPT (구독)",
      detail: "codex CLI — ChatGPT 구독 인증",
      available: cliAvailable["codex"] ?? false,
      models: PROVIDER_MODELS["cli:codex"],
      efforts: PROVIDER_EFFORTS["cli:codex"],
    },
    {
      id: "alibaba",
      label: "Alibaba GLM",
      detail: env.ALIBABA_TOKEN_PLAN_MODEL ?? "glm-5.2",
      available: Boolean(env.ALIBABA_TOKEN_PLAN_API_KEY),
      models: PROVIDER_MODELS["alibaba"],
    },
    {
      id: "openai",
      label: "OpenAI API",
      detail: env.OPENAI_MODEL ?? "gpt-4o-mini",
      available: Boolean(env.OPENAI_API_KEY),
      models: PROVIDER_MODELS["openai"],
    },
    {
      id: "local",
      label: "로컬 llama.cpp",
      detail: env.LOCAL_LLM_BASE_URL ?? "미설정",
      available: Boolean(env.LOCAL_LLM_BASE_URL),
      models: [],
    },
  ];
}

/** id로 BlockDetector 생성. model/effort 오버라이드 지원, 알 수 없거나 설정 누락이면 null. */
export function createDetector(
  id: string,
  opts: { cliTimeoutMs: number; model?: string; effort?: string },
): BlockDetector | null {
  if (id === "cli:claude") {
    return new CliLLMClient({ bin: "claude", preset: "claude", timeoutMs: opts.cliTimeoutMs, model: opts.model });
  }
  if (id === "cli:codex") {
    return new CliLLMClient({ bin: "codex", preset: "codex", timeoutMs: opts.cliTimeoutMs, model: opts.model, effort: opts.effort });
  }
  try {
    const cfg = resolveLLMConfig(id);
    if (opts.model) cfg.model = opts.model;
    return new LLMClient(cfg);
  } catch {
    return null;
  }
}

/** 프로바이더별 선택 가능 모델 프리셋 (빈 배열 = 프리셋 없음/기본 모델만)
 *  주의: ChatGPT 계정의 codex는 명시 모델(-m gpt-5.2/5.1/5)을 전부 거부한다
 *  ("not supported when using Codex with a ChatGPT account") — 기본 모델만
 *  사용 가능하고, 대신 reasoning effort는 조절할 수 있다. */
export const PROVIDER_MODELS: Record<string, string[]> = {
  "cli:codex": [],
  "cli:claude": ["opus", "sonnet", "haiku"],
  alibaba: ["glm-5.2", "glm-5.1", "glm-4.7"],
  openai: ["gpt-4o-mini", "gpt-4o"],
  local: [],
};

/** reasoning effort를 지원하는 프로바이더와 수준 */
export const PROVIDER_EFFORTS: Record<string, string[]> = {
  "cli:codex": ["low", "medium", "high"],
};

/** API 키로 연결하는 프로바이더의 env 변수 매핑 (카드의 키 붙여넣기용) */
export const KEY_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  alibaba: "ALIBABA_TOKEN_PLAN_API_KEY",
};

/**
 * .env 텍스트에 키를 upsert한다. 기존 줄은 값만 교체, 없으면 끝에 추가.
 * 주석·다른 키·개행 구조는 보존.
 */
export function upsertEnvText(text: string, entries: Record<string, string>): string {
  const seen = new Set<string>();
  const out = text.split("\n").map((line) => {
    const idx = line.indexOf("=");
    if (idx <= 0) return line;
    const key = line.slice(0, idx).trim();
    if (!(key in entries)) return line;
    seen.add(key);
    return `${key}=${entries[key]}`;
  });
  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return out.join("\n");
}
