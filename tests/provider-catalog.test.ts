import { describe, expect, test } from "bun:test";

import { validateProviderSelection } from "../src/app-settings.ts";
import {
  HTTP_PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  PROVIDER_PROBE_TIMEOUT_MS,
  isProviderId,
  providerEfforts,
  providerModels,
} from "../src/provider-catalog.ts";
import { buildProviderEntries } from "../src/providers.ts";

describe("typed provider catalog", () => {
  test("drives provider IDs, advertised models, and settings validation", () => {
    const entries = buildProviderEntries(
      {
        OPENAI_API_KEY: "configured",
        OPENAI_MODEL: "gpt-4o",
        LOCAL_LLM_BASE_URL: "http://localhost:8080/v1",
      },
      { codex: true, grok: true, claude: true, gemini: true },
    );

    expect(entries.map((entry) => entry.id)).toEqual(PROVIDER_IDS);
    for (const entry of entries) {
      expect(isProviderId(entry.id)).toBe(true);
      if (!isProviderId(entry.id)) throw new Error(`Unexpected provider: ${entry.id}`);
      expect(entry.models).toEqual(providerModels(entry.id) ?? []);
      expect(entry.efforts ?? []).toEqual(providerEfforts(entry.id));
      expect(() => validateProviderSelection({ providerId: entry.id })).not.toThrow();
    }
  });

  test("keeps configurable local models distinct from catalog-constrained providers", () => {
    expect(providerModels("local")).toBeNull();
    expect(() => validateProviderSelection({
      providerId: "local",
      model: "operator-selected-local-model",
    })).not.toThrow();
    expect(() => validateProviderSelection({
      providerId: "openai",
      model: "operator-selected-local-model",
    })).toThrow(/Unsupported model/);
  });

  test("owns HTTP credential metadata and CLI probe timing once", () => {
    expect(HTTP_PROVIDER_DEFINITIONS).toEqual([
      {
        id: "openai",
        label: "OpenAI API",
        detailEnvironment: "OPENAI_MODEL",
        availabilityEnvironment: "OPENAI_API_KEY",
        defaultDetail: "gpt-4o-mini",
        models: ["gpt-4o-mini", "gpt-4o"],
        keyEnvironment: "OPENAI_API_KEY",
      },
      {
        id: "local",
        label: "로컬 모델",
        detailEnvironment: "LOCAL_LLM_BASE_URL",
        availabilityEnvironment: "LOCAL_LLM_BASE_URL",
        defaultDetail: "설정 필요",
        models: null,
      },
    ]);
    expect(PROVIDER_PROBE_TIMEOUT_MS).toBe(5_000);
  });
});
