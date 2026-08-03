import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROVIDER_ADAPTERS,
  inspectSubscriptionProviders,
  providerConnectCommand,
} from "../src/provider-adapters.ts";
import { buildCliArgs, parseCliOutput, runCliPrompt } from "../src/llm-cli.ts";
import { buildProviderEntriesFromStates } from "../src/providers.ts";

function fakeCli(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

describe("subscription provider registry", () => {
  test("contains one strict adapter for every supported subscription CLI", () => {
    expect(PROVIDER_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "cli:codex",
      "cli:grok",
      "cli:claude",
      "cli:gemini",
    ]);
    expect(new Set(PROVIDER_ADAPTERS.map((adapter) => adapter.executable)).size).toBe(4);
  });

  test("projects installed and authenticated state without conflating them", () => {
    const cards = buildProviderEntriesFromStates({}, [
      { id: "cli:grok", installed: true, auth: "unknown", executable: "/tmp/grok", version: "1.2.3" },
      { id: "cli:codex", installed: true, auth: "connected", executable: "/tmp/codex" },
      { id: "cli:claude", installed: true, auth: "disconnected", executable: "/tmp/claude" },
      { id: "cli:gemini", installed: false, auth: "unavailable", executable: "/tmp/gemini" },
    ]);
    const byId = Object.fromEntries(cards.map((card) => [card.id, card]));

    expect(byId["cli:codex"]).toMatchObject({ installed: true, auth: "connected", available: true });
    expect(byId["cli:grok"]).toMatchObject({ installed: true, auth: "unknown", available: false, selectable: true, version: "1.2.3" });
    expect(byId["cli:claude"]).toMatchObject({ installed: true, auth: "disconnected", available: false, selectable: true });
    expect(byId["cli:gemini"]).toMatchObject({ installed: false, auth: "unavailable", available: false, selectable: false });
  });

  test("connect descriptors use the vendor-supported interactive flows", () => {
    const home = mkdtempSync(join(tmpdir(), "provider-connect-"));
    const bin = join(home, ".npm-global", "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["codex", "grok", "claude", "gemini"]) fakeCli(bin, name, "exit 0");
    const environment = { HOME: home, PATH: "/usr/bin:/bin" };
    try {
      expect(providerConnectCommand("cli:codex", environment)).toMatchObject({
        providerId: "cli:codex",
        executable: join(bin, "codex"),
        args: ["login"],
        interactive: true,
        environment: expect.any(Object),
      });
      expect(providerConnectCommand("cli:grok", environment)).toMatchObject({ providerId: "cli:grok", args: ["login"] });
      expect(providerConnectCommand("cli:claude", environment)).toMatchObject({ providerId: "cli:claude", args: ["auth", "login"] });
      expect(providerConnectCommand("cli:gemini", environment)).toMatchObject({ providerId: "cli:gemini", args: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Finder-like PATH discovers executables and never guesses unverifiable auth", () => {
    const home = mkdtempSync(join(tmpdir(), "provider-probe-"));
    const bin = join(home, ".npm-global", "bin");
    const grokBin = join(home, ".grok", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(grokBin, { recursive: true });
    fakeCli(bin, "codex", `if [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo 'Logged in'; exit 0; fi\nexit 2`);
    fakeCli(bin, "claude", `if [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":false}'; exit 0; fi\nexit 2`);
    fakeCli(grokBin, "grok", `test "$1" = "--version"`);

    try {
      const states = inspectSubscriptionProviders({ HOME: home, PATH: "/usr/bin:/bin" });
      const byId = Object.fromEntries(states.map((state) => [state.id, state]));
      expect(byId["cli:codex"]).toMatchObject({ installed: true, auth: "connected" });
      expect(byId["cli:claude"]).toMatchObject({ installed: true, auth: "disconnected" });
      expect(byId["cli:grok"]).toMatchObject({ installed: true, auth: "unknown" });
      expect(byId["cli:gemini"]).toMatchObject({ installed: false, auth: "unavailable" });
      expect(byId["cli:codex"].executable).toBe(join(bin, "codex"));
      expect(byId["cli:grok"].executable).toBe(join(grokBin, "grok"));

      const cards = buildProviderEntriesFromStates({}, states);
      expect(cards.find((card) => card.id === "cli:codex")?.available).toBe(true);
      expect(cards.find((card) => card.id === "cli:grok")?.available).toBe(false);
      expect(cards.find((card) => card.id === "cli:grok")?.selectable).toBe(true);
      expect(cards.find((card) => card.id === "cli:claude")?.available).toBe(false);
      expect(cards.find((card) => card.id === "cli:claude")?.selectable).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("provider CLI contracts", () => {
  test("builds exact noninteractive argv", () => {
    expect(buildCliArgs({ bin: "codex", preset: "codex", timeoutMs: 1000, model: "gpt-5.6-sol", effort: "high" }, "P", "/tmp/out")).toEqual([
      "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
      "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "-o", "/tmp/out", "P",
    ]);
    expect(buildCliArgs({ bin: "grok", preset: "grok", timeoutMs: 1000, model: "grok-4.5" }, "P")).toEqual([
      "-p", "P", "--output-format", "streaming-json", "-m", "grok-4.5",
    ]);
    expect(buildCliArgs({ bin: "claude", preset: "claude", timeoutMs: 1000, model: "sonnet" }, "P")).toEqual([
      "-p", "P", "--output-format", "text", "--model", "sonnet",
    ]);
    expect(buildCliArgs({ bin: "gemini", preset: "gemini", timeoutMs: 1000, model: "gemini-2.5-pro" }, "P")).toEqual([
      "-p", "P", "--output-format", "json", "-m", "gemini-2.5-pro",
    ]);
  });

  test("parses Grok ACP streaming JSON and Gemini JSON without leaking envelopes", () => {
    const grok = [
      JSON.stringify({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } }),
      JSON.stringify({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } }),
    ].join("\n");
    expect(parseCliOutput("grok", grok)).toBe("hello world");
    expect(parseCliOutput("gemini", JSON.stringify({ response: "answer", stats: {} }))).toBe("answer");
    expect(() => parseCliOutput("gemini", "not json")).toThrow("Gemini");
  });

  test("runs every adapter through hermetic fake CLIs with GUI-safe PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-run-"));
    const codex = fakeCli(root, "codex", `while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf '%s' 'codex answer' > "$1"; exit 0; fi; shift; done; exit 2`);
    const grok = fakeCli(root, "grok", `printf '%s\\n' '{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"grok answer"}}}'`);
    const claude = fakeCli(root, "claude", `printf '%s' 'claude answer'`);
    const gemini = fakeCli(root, "gemini", `printf '%s' '{"response":"gemini answer","stats":{}}'`);
    const environment = { HOME: root, PATH: "/usr/bin:/bin" };
    try {
      await expect(runCliPrompt({ bin: codex, preset: "codex", timeoutMs: 2000 }, "P", environment)).resolves.toBe("codex answer");
      await expect(runCliPrompt({ bin: grok, preset: "grok", timeoutMs: 2000 }, "P", environment)).resolves.toBe("grok answer");
      await expect(runCliPrompt({ bin: claude, preset: "claude", timeoutMs: 2000 }, "P", environment)).resolves.toBe("claude answer");
      await expect(runCliPrompt({ bin: gemini, preset: "gemini", timeoutMs: 2000 }, "P", environment)).resolves.toBe("gemini answer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
