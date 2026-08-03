import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildCliArgs } from "../src/llm-cli.ts";
import { checkCliBin } from "../src/providers.ts";
import { MeetingSession } from "../src/session.ts";

type SessionLLM = ConstructorParameters<typeof MeetingSession>[0];
type SessionSenders = ConstructorParameters<typeof MeetingSession>[3];
type SessionSender = SessionSenders extends Set<infer Sender> ? Sender : never;
type ServerMessage = SessionSender extends (message: infer Message) => void
  ? Message
  : never;

const ENV_KEYS = [
  "HOME",
  "PATH",
  "LLM_PROVIDER",
  "LLM_CLI_BIN",
  "LLM_CLI_PRESET",
  "LLM_CLI_MODEL",
  "LLM_CLI_EFFORT",
] as const;

const originalEnvironment = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Codex runtime routing", () => {
  test("GUI PATH에서도 Codex 경로와 GPT-5.6을 명시한다", () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "meeting-slides-cli-"));
    const executableDirectory = join(homeDirectory, ".npm-global", "bin");
    const nodeDirectory = join(homeDirectory, ".bun", "bin");
    mkdirSync(executableDirectory, { recursive: true });
    mkdirSync(nodeDirectory, { recursive: true });
    const executable = join(executableDirectory, "codex-probe");
    const node = join(nodeDirectory, "node-probe");
    writeFileSync(executable, "#!/usr/bin/env node-probe\n");
    writeFileSync(node, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    chmodSync(node, 0o755);

    process.env.HOME = homeDirectory;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    process.env.LLM_PROVIDER = "cli";
    process.env.LLM_CLI_BIN = "codex-probe";
    process.env.LLM_CLI_PRESET = "codex";
    delete process.env.LLM_CLI_MODEL;
    delete process.env.LLM_CLI_EFFORT;

    try {
      const config = loadConfig([]);
      expect(config.llm.cli).toEqual({
        bin: executable,
        preset: "codex",
        timeoutMs: 120_000,
        model: "gpt-5.6-sol",
        effort: "high",
      });
      expect(checkCliBin("codex-probe", {
        ...process.env,
        HOME: homeDirectory,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      })).toBe(true);
    } finally {
      rmSync(homeDirectory, { recursive: true, force: true });
    }
  });

  test("Codex 호출은 사용자 플러그인과 세션 기록을 격리한다", () => {
    const args = buildCliArgs(
      {
        bin: "/tmp/codex",
        preset: "codex",
        timeoutMs: 120_000,
        model: "gpt-5.6-sol",
        effort: "high",
      },
      "Return JSON",
      "/tmp/result.json",
    );

    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toEqual(expect.arrayContaining(["-m", "gpt-5.6-sol"]));
  });

  test("LLM 실행 실패를 가짜 로컬 슬라이드로 숨기지 않는다", async () => {
    const messages: ServerMessage[] = [];
    const failingClient = {
      detectBlock: async () => {
        throw new Error("spawn codex ENOENT");
      },
      ping: async () => false,
    } as unknown as SessionLLM;
    const senders: SessionSenders = new Set([
      (message: ServerMessage) => messages.push(message),
    ]);
    const session = new MeetingSession(
      failingClient,
      1,
      12,
      senders,
    );

    session.onChunk({
      text: "8월 농업 전시회에서 조기진단 키트를 공개합니다.",
      ts: Date.now(),
    });
    await session.flush();

    expect(
      messages.some((message) => message.type === "status"
        && message.text.includes("LLM 오류")),
    ).toBe(true);
    expect(messages.some((message) => message.type === "slide")).toBe(false);
  });
});
