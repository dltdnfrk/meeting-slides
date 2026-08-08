export const STT_MODEL_IDS = [
  "small", "medium", "large-v3-turbo", "large-v3",
  "nemotron-3.5", "qwen3-asr-0.6b", "qwen3-asr-1.7b",
] as const;

export type SttModelId = (typeof STT_MODEL_IDS)[number];

export type SttBackend = "whisper" | "transcribe";
export type SttLicense = "MIT" | "Apache-2.0" | "OpenMDW-1.1";

export interface SttModelArtifact {
  readonly id: SttModelId;
  readonly label: string;
  readonly backend: SttBackend;
  readonly fileName: string;
  readonly url: string;
  readonly sizeBytes: number;
  /** SHA-256 of the downloaded payload, published as the Hugging Face LFS OID. */
  readonly sha256: string;
  /** Xet object hash returned as the final CDN ETag. It is not a payload checksum. */
  readonly xetEtag: string;
  readonly license: SttLicense;
}

const OFFICIAL_REPOSITORY = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const LARGE_V3_Q8_REPOSITORY = "https://huggingface.co/Pomni/whisper-large-v3-ggml-allquants/resolve/main";
const TRANSCRIBE_REPOSITORY = "https://huggingface.co/handy-computer";

/**
 * whisper.cpp GGML artifacts accepted by models/download-ggml-model.sh and whisper-cli -m.
 * Sizes, LFS OIDs, and Xet hashes come from the official ggerganov/whisper.cpp repository.
 */
export const STT_MODEL_CATALOG: readonly SttModelArtifact[] = [
  {
    id: "small",
    backend: "whisper",
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
    backend: "whisper",
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
    backend: "whisper",
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
    backend: "whisper",
    label: "Large v3 (Q8_0)",
    fileName: "ggml-large-v3-q8_0.bin",
    url: `${LARGE_V3_Q8_REPOSITORY}/ggml-large-v3-q8_0.bin`,
    sizeBytes: 1_656_538_283,
    sha256: "24bc434f372355688ab9a623077a63e5361a1c41f4d8d648977e39f9b060f09e",
    xetEtag: "f058e72bf9e0527ff2b514f91968430051c4dda3333b127b6f1077e53d008a0f",
    license: "Apache-2.0",
  },
  {
    id: "nemotron-3.5",
    label: "Nemotron 3.5 Streaming (Q8_0)",
    backend: "transcribe",
    fileName: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
    url: `${TRANSCRIBE_REPOSITORY}/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/main/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf`,
    sizeBytes: 751_094_240,
    sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
    xetEtag: "",
    license: "OpenMDW-1.1",
  },
  {
    id: "qwen3-asr-0.6b",
    label: "Qwen3-ASR 0.6B (Q8_0)",
    backend: "transcribe",
    fileName: "Qwen3-ASR-0.6B-Q8_0.gguf",
    url: `${TRANSCRIBE_REPOSITORY}/Qwen3-ASR-0.6B-gguf/resolve/main/Qwen3-ASR-0.6B-Q8_0.gguf`,
    sizeBytes: 850_423_456,
    sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
    xetEtag: "",
    license: "Apache-2.0",
  },
  {
    id: "qwen3-asr-1.7b",
    label: "Qwen3-ASR 1.7B (Q8_0)",
    backend: "transcribe",
    fileName: "Qwen3-ASR-1.7B-Q8_0.gguf",
    url: `${TRANSCRIBE_REPOSITORY}/Qwen3-ASR-1.7B-gguf/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf`,
    sizeBytes: 2_185_030_624,
    sha256: "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7",
    xetEtag: "",
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
