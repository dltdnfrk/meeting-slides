export const STT_MODEL_IDS = ["small", "medium", "large-v3-turbo", "large-v3"] as const;

export type SttModelId = (typeof STT_MODEL_IDS)[number];

export interface SttModelArtifact {
  readonly id: SttModelId;
  readonly label: string;
  readonly fileName: `${string}.bin`;
  readonly url: string;
  readonly sizeBytes: number;
  /** SHA-256 of the downloaded payload, published as the Hugging Face LFS OID. */
  readonly sha256: string;
  /** Xet object hash returned as the final CDN ETag. It is not a payload checksum. */
  readonly xetEtag: string;
  readonly license: "MIT" | "Apache-2.0";
}

const OFFICIAL_REPOSITORY = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const LARGE_V3_Q8_REPOSITORY = "https://huggingface.co/Pomni/whisper-large-v3-ggml-allquants/resolve/main";

/**
 * whisper.cpp GGML artifacts accepted by models/download-ggml-model.sh and whisper-cli -m.
 * Sizes, LFS OIDs, and Xet hashes come from the official ggerganov/whisper.cpp repository.
 */
export const STT_MODEL_CATALOG: readonly SttModelArtifact[] = [
  {
    id: "small",
    label: "Small (Q8_0)",
    fileName: "ggml-small-q8_0.bin",
    url: `${OFFICIAL_REPOSITORY}/ggml-small-q8_0.bin`,
    sizeBytes: 264_464_607,
    sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
    xetEtag: "53268772a59b455b5582e60c9330689fe313317bdff7f38d5df9a9190f2dc598",
    license: "MIT",
  },
  {
    id: "medium",
    label: "Medium (Q8_0)",
    fileName: "ggml-medium-q8_0.bin",
    url: `${OFFICIAL_REPOSITORY}/ggml-medium-q8_0.bin`,
    sizeBytes: 823_369_779,
    sha256: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502",
    xetEtag: "c8116b244ec4960951435c4a244acdaee9efec098f3c7ca763a13762e66f7351",
    license: "MIT",
  },
  {
    id: "large-v3-turbo",
    label: "Large v3 Turbo (Q8_0)",
    fileName: "ggml-large-v3-turbo-q8_0.bin",
    url: `${OFFICIAL_REPOSITORY}/ggml-large-v3-turbo-q8_0.bin`,
    sizeBytes: 874_188_075,
    sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    xetEtag: "971539eabfa951d62cc5e06672e676da1e5e8768115056362fe6301b664b4ea4",
    license: "MIT",
  },
  {
    id: "large-v3",
    label: "Large v3 (Q8_0)",
    fileName: "ggml-large-v3-q8_0.bin",
    url: `${LARGE_V3_Q8_REPOSITORY}/ggml-large-v3-q8_0.bin`,
    sizeBytes: 1_656_538_283,
    sha256: "24bc434f372355688ab9a623077a63e5361a1c41f4d8d648977e39f9b060f09e",
    xetEtag: "f058e72bf9e0527ff2b514f91968430051c4dda3333b127b6f1077e53d008a0f",
    license: "Apache-2.0",
  },
] as const;

export function sttModelArtifact(id: SttModelId): SttModelArtifact {
  const artifact = STT_MODEL_CATALOG.find((entry) => entry.id === id);
  if (!artifact) throw new Error(`Unknown STT model: ${String(id)}`);
  return artifact;
}

export function isSttModelId(value: unknown): value is SttModelId {
  return typeof value === "string" && (STT_MODEL_IDS as readonly string[]).includes(value);
}
