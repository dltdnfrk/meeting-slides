import { describe, expect, test } from "bun:test";

import { buildProviderEntries, buildProviderEntriesFromStates, createDetector, upsertEnvText } from "../src/providers.ts";

describe("buildProviderEntries", () => {
  test("구독 CLI 가용성은 주입된 탐지 결과를 따른다", () => {
    const list = buildProviderEntries({}, { claude: true, codex: false });
    expect(list.find((p) => p.id === "cli:claude")?.available).toBe(true);
    expect(list.find((p) => p.id === "cli:codex")?.available).toBe(false);
  });

  test("설치된 CLI 는 auth unknown 이어도 선택 가능하다", () => {
    const list = buildProviderEntriesFromStates({}, [
      { id: "cli:grok", installed: true, auth: "unknown", executable: "/tmp/grok" },
      { id: "cli:claude", installed: true, auth: "disconnected", executable: "/tmp/claude" },
      { id: "cli:codex", installed: false, auth: "unavailable", executable: "/tmp/codex" },
    ]);
    expect(list.find((p) => p.id === "cli:grok")?.available).toBe(false);
    expect(list.find((p) => p.id === "cli:grok")?.selectable).toBe(true);
    expect(list.find((p) => p.id === "cli:claude")?.available).toBe(false);
    expect(list.find((p) => p.id === "cli:claude")?.selectable).toBe(true);
    expect(list.find((p) => p.id === "cli:codex")?.available).toBe(false);
    expect(list.find((p) => p.id === "cli:codex")?.selectable).toBe(false);
  });

  test("HTTP 프로바이더는 키/URL 존재로 가용 판정", () => {
    const list = buildProviderEntries(
      { ALIBABA_TOKEN_PLAN_API_KEY: "sk-x", OPENAI_API_KEY: "", LOCAL_LLM_BASE_URL: "" } as NodeJS.ProcessEnv,
      {},
    );
    expect(list.find((p) => p.id === "alibaba")?.available).toBe(true);
    expect(list.find((p) => p.id === "openai")?.available).toBe(false);
    expect(list.find((p) => p.id === "local")?.available).toBe(false);
  });

  test("7개 카드를 순서대로 제공 (구독 4 + API 3)", () => {
    const list = buildProviderEntries({}, {});
    expect(list.map((p) => p.id)).toEqual([
      "cli:codex", "cli:grok", "cli:claude", "cli:gemini", "alibaba", "openai", "local",
    ]);
  });

  test("모델/effort 옵션 목록 제공", () => {
    const list = buildProviderEntries({}, {});
    // codex는 이 계정에서 검증된 gpt-5.6 시리즈 + effort 제공
    expect(list.find((p) => p.id === "cli:codex")?.models).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(list.find((p) => p.id === "cli:codex")?.efforts).toEqual(["low", "medium", "high"]);
    expect(list.find((p) => p.id === "cli:claude")?.models).toEqual(["opus", "sonnet", "haiku"]);
    expect(list.find((p) => p.id === "cli:claude")?.efforts).toBeUndefined();
    expect(list.find((p) => p.id === "alibaba")?.models).toContain("glm-5.2");
  });
});

describe("upsertEnvText", () => {
  test("기존 키는 값만 교체하고 다른 줄은 보존", () => {
    const before = "# comment\nFOO=old\nBAR=keep\n";
    const after = upsertEnvText(before, { FOO: "new" });
    expect(after).toBe("# comment\nFOO=new\nBAR=keep\n");
  });

  test("없는 키는 끝에 추가", () => {
    const after = upsertEnvText("A=1\n", { B: "2" });
    expect(after).toBe("A=1\n\nB=2");
  });

  test("여러 키 동시 upsert", () => {
    const after = upsertEnvText("A=1\nC=3", { A: "10", B: "2" });
    expect(after).toBe("A=10\nC=3\nB=2");
  });

  test("키 주변 공백이 있어도 매칭", () => {
    const after = upsertEnvText("FOO = old\nBAR=keep", { FOO: "new" });
    expect(after).toBe("FOO=new\nBAR=keep");
  });
});

describe("createDetector", () => {
  test("cli 프리셋은 API 키 없이 생성", () => {
    for (const id of ["cli:codex", "cli:grok", "cli:claude", "cli:gemini"]) {
      expect(createDetector(id, { cliTimeoutMs: 1000 })).not.toBeNull();
    }
  });

  test("알 수 없는 id는 null", () => {
    expect(createDetector("nope", { cliTimeoutMs: 1000 })).toBeNull();
  });
});
