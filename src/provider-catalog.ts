import {
  PROVIDER_ADAPTERS,
  PROVIDER_PROBE_TIMEOUT_MS,
  providerAdapter,
  type ProviderId,
  type SubscriptionProviderId,
} from "./provider-adapters.js";

type HttpProviderId = Exclude<ProviderId, SubscriptionProviderId>;
type HttpProviderEnvironmentKey =
  | "LOCAL_LLM_BASE_URL"
  | "OPENAI_API_KEY"
  | "OPENAI_MODEL";

export interface HttpProviderDefinition {
  readonly id: HttpProviderId;
  readonly label: string;
  readonly detailEnvironment: HttpProviderEnvironmentKey;
  readonly availabilityEnvironment: HttpProviderEnvironmentKey;
  readonly defaultDetail: string;
  /** `null` means the operator may enter any model exposed by the local endpoint. */
  readonly models: readonly string[] | null;
  readonly keyEnvironment?: HttpProviderEnvironmentKey;
}

const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4o"] as const;

export const HTTP_PROVIDER_DEFINITIONS = [
  {
    id: "openai",
    label: "OpenAI API",
    detailEnvironment: "OPENAI_MODEL",
    availabilityEnvironment: "OPENAI_API_KEY",
    defaultDetail: OPENAI_MODELS[0],
    models: OPENAI_MODELS,
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
] as const satisfies readonly HttpProviderDefinition[];

export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze([
  ...PROVIDER_ADAPTERS.map((adapter) => adapter.id),
  ...HTTP_PROVIDER_DEFINITIONS.map((definition) => definition.id),
]);

const PROVIDER_ID_SET: ReadonlySet<string> = new Set(PROVIDER_IDS);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_ID_SET.has(value);
}

export function providerModels(id: ProviderId): readonly string[] | null {
  const adapter = providerAdapter(id);
  if (adapter) return adapter.models.map((model) => model.id);
  return HTTP_PROVIDER_DEFINITIONS.find((definition) => definition.id === id)?.models ?? null;
}

export function providerEfforts(id: ProviderId): readonly string[] {
  return providerAdapter(id)?.efforts.map((effort) => effort.id) ?? [];
}

export const KEY_BY_PROVIDER: Readonly<Record<string, string>> = Object.fromEntries(
  HTTP_PROVIDER_DEFINITIONS.flatMap((definition): [string, string][] =>
    "keyEnvironment" in definition ? [[definition.id, definition.keyEnvironment]] : []
  ),
);

export { PROVIDER_PROBE_TIMEOUT_MS };
