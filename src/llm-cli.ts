// ============================================================
// llm-cli.ts - 구독 서비스 CLI 백엔드 (API 키 대신 기존 구독 인증 사용)
// ============================================================
// claude (Claude Pro/Max) 또는 codex (ChatGPT) CLI를 자식 프로세스로 실행해
// 블록 감지를 수행한다. 별도의 LLM API 키 없이 사용자의 구독 인증을 재사용한다.
//
// 출력 계약:
//   claude: `claude -p <prompt> --output-format text` → 최종 텍스트가 stdout
//           최종 메시지만 파일로 받아 읽는다 (서버 종료 시 자동 정리되는 단일 재사용 파일).

import { spawn } from "child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SYSTEM_PROMPT,
  parseBlockDetectionJson,
  type BlockDetectionResult,
  type BlockDetector,
} from "./llm.js";
import type { CliLLMConfig } from "./config.js";

export function buildCliArgs(cfg: CliLLMConfig, prompt: string, outFile?: string): string[] {
  if (cfg.preset === "codex") {
    const args = ["exec", "--skip-git-repo-check"];
    if (cfg.model) args.push("-m", cfg.model);
    // reasoning effort는 codex config 오버라이드로 전달 (TOML 문자열)
    if (cfg.effort) args.push("-c", `model_reasoning_effort="${cfg.effort}"`);
    args.push("-o", outFile ?? join(tmpdir(), "codex-last.txt"), prompt);
    return args;
  }
  const args = ["-p", prompt, "--output-format", "text"];
  if (cfg.model) args.push("--model", cfg.model);
  return args;
}

function runCli(cfg: CliLLMConfig, prompt: string): Promise<string> {
  // codex preset만 임시 출력 파일이 필요. 매 호출마다 mkdtempSync/rmSync 하면
  // 회의 한 번에 수십~수백 회 I/O 발생 → 파일 하나 재사용 (서버 종료 시 OS가 정리).
  const outFile = cfg.preset === "codex" ? join(tmpdir(), `meeting-slides-codex-${process.pid}.txt`) : undefined;
  const cleanup = () => {
    if (outFile) try { rmSync(outFile, { force: true }); } catch {}
  };

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cfg.bin, buildCliArgs(cfg, prompt, outFile), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      proc.kill("SIGKILL");
      // 타임아웃 후에도 stdout/stderr 'data' 콜백이 들어와 메모리/CPU 낭비 → 파괴.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      cleanup();
      settled = true;
      reject(new Error(`CLI 타임아웃 (${cfg.timeoutMs}ms): ${cfg.bin}`));
    }, cfg.timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf-8")).slice(-500); });
    proc.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      cleanup();
      settled = true;
      reject(err);
    });
    proc.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      try {
        if (code !== 0) {
          reject(new Error(`${cfg.bin} 종료 코드 ${code}: ${stderrTail.trim() || "(stderr 없음)"}`));
          return;
        }
        resolve(outFile ? readFileSync(outFile, "utf-8") : stdout);
      } finally {
        cleanup();
      }
    });
  });
}

export class CliLLMClient implements BlockDetector {
  constructor(private cfg: CliLLMConfig) {}

  async detectBlock(sentences: string[]): Promise<BlockDetectionResult> {
    if (sentences.length === 0) {
      return { shouldAdvance: false, blockTitle: "", bullets: [] };
    }
    const userPrompt = `최근 회의 문장들:
${sentences.map((s, i) => `${i + 1}. ${s}`).join("\n")}

JSON으로만 응답하세요.`;
    const output = await runCli(this.cfg, `${SYSTEM_PROMPT}\n\n${userPrompt}`);
    return parseBlockDetectionJson(output);
  }

  async ping(): Promise<boolean> {
    // 구독 과금 없이 바이너리 존재/실행 가능 여부만 확인한다.
    return new Promise<boolean>((resolve) => {
      const proc = spawn(this.cfg.bin, ["--version"], { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }
}
