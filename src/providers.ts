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
    },
    {
      id: "cli:codex",
      label: "GPT (구독)",
      detail: "codex CLI — ChatGPT 구독 인증",
      available: cliAvailable["codex"] ?? false,
    },
    {
      id: "alibaba",
      label: "Alibaba GLM",
      detail: env.ALIBABA_TOKEN_PLAN_MODEL ?? "glm-5.2",
      available: Boolean(env.ALIBABA_TOKEN_PLAN_API_KEY),
    },
    {
      id: "openai",
      label: "OpenAI API",
      detail: env.OPENAI_MODEL ?? "gpt-4o-mini",
      available: Boolean(env.OPENAI_API_KEY),
    },
    {
      id: "local",
      label: "로컬 llama.cpp",
      detail: env.LOCAL_LLM_BASE_URL ?? "미설정",
      available: Boolean(env.LOCAL_LLM_BASE_URL),
    },
  ];
}

/** id로 BlockDetector 생성. 알 수 없거나 설정 누락이면 null. */
export function createDetector(id: string, opts: { cliTimeoutMs: number }): BlockDetector | null {
  if (id === "cli:claude") {
    return new CliLLMClient({ bin: "claude", preset: "claude", timeoutMs: opts.cliTimeoutMs });
  }
  if (id === "cli:codex") {
    return new CliLLMClient({ bin: "codex", preset: "codex", timeoutMs: opts.cliTimeoutMs });
  }
  try {
    return new LLMClient(resolveLLMConfig(id));
  } catch {
    return null;
  }
}
