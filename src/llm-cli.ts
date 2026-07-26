// ============================================================
// llm-cli.ts - 구독 서비스 CLI 백엔드 (API 키 대신 기존 구독 인증 사용)
// ============================================================
// claude (Claude Pro/Max) 또는 codex (ChatGPT) CLI를 자식 프로세스로 실행해
// 블록 감지를 수행한다. 별도의 LLM API 키 없이 사용자의 구독 인증을 재사용한다.
//
// 출력 계약:
//   claude: `claude -p <prompt> --output-format text` → 최종 텍스트가 stdout
//   codex:  `codex exec -o <file> <prompt>` → 진행 로그가 stdout에 섞이므로
//           최종 메시지만 파일로 받아 읽는다 (실행 후 임시 디렉터리 삭제).

import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    return ["exec", "--skip-git-repo-check", "-o", outFile ?? join(tmpdir(), "codex-last.txt"), prompt];
  }
  return ["-p", prompt, "--output-format", "text"];
}

function runCli(cfg: CliLLMConfig, prompt: string): Promise<string> {
  const dir = cfg.preset === "codex" ? mkdtempSync(join(tmpdir(), "meeting-slides-codex-")) : null;
  const outFile = dir ? join(dir, "last.txt") : undefined;
  const cleanup = () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  };

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cfg.bin, buildCliArgs(cfg, prompt, outFile), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderrTail = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      cleanup();
      reject(new Error(`CLI 타임아웃 (${cfg.timeoutMs}ms): ${cfg.bin}`));
    }, cfg.timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf-8")).slice(-500); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
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
