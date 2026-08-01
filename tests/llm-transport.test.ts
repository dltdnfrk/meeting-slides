import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliLLMClient } from "../src/llm-cli.ts";
import { LLMClient, SYSTEM_PROMPT } from "../src/llm.ts";

const tempDir = mkdtempSync(join(tmpdir(), "meeting-slides-llm-baseline-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function cliStub(name: string, body: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("existing LLM detectBlock transport behavior", () => {
  test("HTTP sends the unchanged system prompt and parses provider content", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content:
          '{"shouldAdvance":true,"blockTitle":"실제 HTTP","bullets":["원문"]}' } }] });
      },
    });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "stub-key", model: "stub-model" });
      await expect(client.detectBlock(["첫 문장"])).resolves.toEqual({
        shouldAdvance: true,
        blockTitle: "실제 HTTP",
        bullets: ["원문"],
      });
      expect(requestBody).toMatchObject({
        model: "stub-model",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: expect.stringContaining("1. 첫 문장") },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: "json_object" },
      });
    } finally {
      server.stop(true);
    }
  });

  test("HTTP preserves status and response text in rejection", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("provider exploded", { status: 503 }) });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "x", model: "stub" });
      await expect(client.detectBlock(["문장"])).rejects.toThrow("LLM API 503: provider exploded");
    } finally {
      server.stop(true);
    }
  });

  test("CLI sends the unchanged combined prompt and returns parsed stdout", async () => {
    const capture = join(tempDir, "detect-prompt.txt");
    const bin = cliStub("detect-ok", `printf '%s' "$2" > "${capture}"\nprintf '%s' '{"shouldAdvance":false,"blockTitle":"실제 CLI","bullets":["원문"]}'`);
    const client = new CliLLMClient({ bin, preset: "claude", timeoutMs: 1000 });

    await expect(client.detectBlock(["CLI 문장"])).resolves.toEqual({
      shouldAdvance: false,
      blockTitle: "실제 CLI",
      bullets: ["원문"],
    });
    expect(await Bun.file(capture).text()).toBe(`${SYSTEM_PROMPT}\n\n최근 회의 문장들:\n1. CLI 문장\n\nJSON으로만 응답하세요.`);
  });

  test("CLI preserves nonzero exit code and stderr in rejection", async () => {
    const bin = cliStub("detect-error", "printf '%s' 'provider stderr' >&2\nexit 17");
    const client = new CliLLMClient({ bin, preset: "claude", timeoutMs: 1000 });
    await expect(client.detectBlock(["문장"])).rejects.toThrow("종료 코드 17: provider stderr");
  });
});

describe("generic chat transport", () => {
  test("HTTP returns the provider's raw text", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: "raw provider text" } }] }),
    });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "x", model: "stub" });
      await expect(client.chat("raw prompt")).resolves.toBe("raw provider text");
    } finally {
      server.stop(true);
    }
  });

  test("HTTP sends user-only message with defaults and no response_format", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "x", model: "stub-model" });
      await client.chat("추출 프롬프트");
      expect(requestBody).toEqual({
        model: "stub-model",
        messages: [{ role: "user", content: "추출 프롬프트" }],
        temperature: 0.3,
        max_tokens: 4000,
      });
      expect(requestBody).not.toHaveProperty("response_format");
    } finally {
      server.stop(true);
    }
  });

  test("HTTP applies system/temperature/maxTokens options", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "x", model: "stub" });
      await client.chat("사용자 입력", { system: "추출기 역할", temperature: 0.7, maxTokens: 200 });
      expect(requestBody).toMatchObject({
        messages: [
          { role: "system", content: "추출기 역할" },
          { role: "user", content: "사용자 입력" },
        ],
        temperature: 0.7,
        max_tokens: 200,
      });
    } finally {
      server.stop(true);
    }
  });

  test("HTTP chat preserves status and response text in rejection", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("chat exploded", { status: 500 }) });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "x", model: "stub" });
      await expect(client.chat("프롬프트")).rejects.toThrow("LLM API 500: chat exploded");
    } finally {
      server.stop(true);
    }
  });

  test("HTTP chat falls back to reasoning_content when content is empty", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { reasoning_content: "reasoning raw" } }] }),
    });
    try {
      const client = new LLMClient({ baseURL: server.url.toString(), apiKey: "x", model: "stub" });
      await expect(client.chat("프롬프트")).resolves.toBe("reasoning raw");
    } finally {
      server.stop(true);
    }
  });

  test("CLI passes the prompt verbatim (no SYSTEM_PROMPT) and returns raw stdout", async () => {
    const capture = join(tempDir, "chat-prompt.txt");
    const bin = cliStub("chat-ok", `printf '%s' "$2" > "${capture}"\nprintf '%s' 'raw cli text, not JSON'`);
    const client = new CliLLMClient({ bin, preset: "claude", timeoutMs: 1000 });

    await expect(client.chat("범용 프롬프트")).resolves.toBe("raw cli text, not JSON");
    expect(await Bun.file(capture).text()).toBe("범용 프롬프트");
  });

  test("CLI prepends options.system to the prompt", async () => {
    const capture = join(tempDir, "chat-system-prompt.txt");
    const bin = cliStub("chat-system", `printf '%s' "$2" > "${capture}"\nprintf '%s' 'ok'`);
    const client = new CliLLMClient({ bin, preset: "claude", timeoutMs: 1000 });

    await client.chat("사용자 입력", { system: "추출기 역할" });
    expect(await Bun.file(capture).text()).toBe("추출기 역할\n\n사용자 입력");
  });

  test("CLI chat preserves nonzero exit code and stderr in rejection", async () => {
    const bin = cliStub("chat-error", "printf '%s' 'chat stderr' >&2\nexit 9");
    const client = new CliLLMClient({ bin, preset: "claude", timeoutMs: 1000 });
    await expect(client.chat("프롬프트")).rejects.toThrow("종료 코드 9: chat stderr");
  });

  test("CLI chat honors options.timeoutMs override", async () => {
    // 타임아웃 자체가 검증 대상: 서버 timeoutMs(10s)보다 짧은 오버라이드가 먼저 발화해야 한다.
    const bin = cliStub("chat-hang", "sleep 5");
    const client = new CliLLMClient({ bin, preset: "claude", timeoutMs: 10_000 });
    await expect(client.chat("프롬프트", { timeoutMs: 250 })).rejects.toThrow("CLI 타임아웃 (250ms)");
  });
});
