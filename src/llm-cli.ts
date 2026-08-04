// ============================================================
// llm-cli.ts - subscription-backed CLI LLM runtime
// ============================================================

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DECK_PLANNER_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  buildDeckPlannerUserPrompt,
  parseBlockDetectionJson,
  type BlockDetectionResult,
  type ChatOptions,
  type ChatTransport,
  type DeckPlannerInput,
  type DeckPlannerRepair,
  type MeetingLLM,
} from "./llm.js";
import { cliProcessEnvironment } from "./config.js";
import type { ProviderCliPreset } from "./provider-adapters.js";

export interface ProviderCliConfig {
  bin: string;
  preset: ProviderCliPreset;
  timeoutMs: number;
  model?: string;
  effort?: string;
}

export function buildCliArgs(cfg: ProviderCliConfig, prompt: string, outFile?: string): string[] {
  switch (cfg.preset) {
    case "codex": {
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
      ];
      if (cfg.model) args.push("-m", cfg.model);
      if (cfg.effort) args.push("-c", `model_reasoning_effort="${cfg.effort}"`);
      args.push("-o", outFile ?? join(tmpdir(), "codex-last.txt"), prompt);
      return args;
    }
    case "grok": {
      const args = ["-p", prompt, "--output-format", "streaming-json"];
      if (cfg.model) args.push("-m", cfg.model);
      return args;
    }
    case "gemini": {
      const args = ["-p", prompt, "--output-format", "json"];
      if (cfg.model) args.push("-m", cfg.model);
      return args;
    }
    case "claude": {
      const args = ["-p", prompt, "--output-format", "text"];
      if (cfg.model) args.push("--model", cfg.model);
      return args;
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseGrokStreamingJson(output: string): string {
  const chunks: string[] = [];
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error("Invalid Grok streaming-json event", { cause: error });
    }
    const update = record(record(event)?.update);
    if (update?.sessionUpdate !== "agent_message_chunk") continue;
    const content = record(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      chunks.push(content.text);
    }
  }
  if (chunks.length === 0) throw new Error("Grok streaming-json contained no assistant text");
  return chunks.join("");
}

export function parseCliOutput(preset: ProviderCliPreset, output: string): string {
  if (preset === "grok") return parseGrokStreamingJson(output);
  if (preset === "gemini") {
    try {
      const value = record(JSON.parse(output));
      if (!value || typeof value.response !== "string") throw new Error("missing response");
      return value.response;
    } catch (error) {
      throw new Error("Invalid Gemini JSON output", { cause: error });
    }
  }
  return output;
}

let codexInvocation = 0;

export function runCliPrompt(
  cfg: ProviderCliConfig,
  prompt: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const outFile = cfg.preset === "codex"
    ? join(tmpdir(), `meeting-slides-codex-${process.pid}-${++codexInvocation}.txt`)
    : undefined;
  const cleanup = () => {
    if (!outFile) return;
    try { rmSync(outFile, { force: true }); } catch { /* best-effort temporary cleanup */ }
  };

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cfg.bin, buildCliArgs(cfg, prompt, outFile), {
      env: cliProcessEnvironment(cfg.bin, environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      cleanup();
      reject(new Error(`CLI timeout (${cfg.timeoutMs}ms): ${cfg.bin}`));
    }, cfg.timeoutMs);

    proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString("utf-8"); });
    proc.stderr?.on("data", (data: Buffer) => {
      stderrTail = (stderrTail + data.toString("utf-8")).slice(-500);
    });
    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code !== 0) {
          reject(new Error(`${cfg.bin} exited with code ${code}: ${stderrTail.trim() || "(no stderr)"}`));
          return;
        }
        const raw = outFile ? readFileSync(outFile, "utf-8") : stdout;
        resolve(parseCliOutput(cfg.preset, raw));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    });
  });
}

export class CliLLMClient implements MeetingLLM, ChatTransport {
  constructor(private cfg: ProviderCliConfig) {}

  /**
   * 범용 chat: 프롬프트를 CLI에 그대로 전달하고 출력 원문을 반환한다.
   * detectBlock과 달리 SYSTEM_PROMPT를 붙이지 않음 — 필요하면 options.system 사용.
   * temperature/maxTokens는 CLI 계약에 없으므로 무시된다.
   */
  async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
    const fullPrompt = options.system ? `${options.system}\n\n${prompt}` : prompt;
    const cfg = options.timeoutMs ? { ...this.cfg, timeoutMs: options.timeoutMs } : this.cfg;
    return runCliPrompt(cfg, fullPrompt);
  }

  async detectBlock(sentences: string[]): Promise<BlockDetectionResult> {
    if (sentences.length === 0) return { shouldAdvance: false, title: "", bullets: [] };
    const userPrompt = `최근 회의 문장들:
${sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join("\n")}

JSON으로만 응답하세요.`;
    const output = await runCliPrompt(this.cfg, `${SYSTEM_PROMPT}\n\n${userPrompt}`);
    return parseBlockDetectionJson(output);
  }

  async planDeck(input: DeckPlannerInput, repair?: DeckPlannerRepair): Promise<unknown> {
    const prompt = `${DECK_PLANNER_SYSTEM_PROMPT}\n\n${buildDeckPlannerUserPrompt(input, repair)}`;
    return runCliPrompt(this.cfg, prompt);
  }

  async ping(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn(this.cfg.bin, ["--version"], {
        env: cliProcessEnvironment(this.cfg.bin),
        stdio: "ignore",
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }
}
