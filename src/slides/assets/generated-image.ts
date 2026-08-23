import {
  acquisitionError,
  persistVerified,
  prepareStaging,
  requireDimension,
  requireHttpsUrl,
  requireStableId,
  requireText,
  requireTimestamp,
  validateRequest,
  type AcquisitionReceiptBase,
  type AcquisitionRequest,
  type AcquisitionResult,
  type ByteRetriever,
  type VerifiedImage,
} from "./acquisition.ts";
import { AssetContractError, type AssetMediaType } from "./contract.ts";
import type { AssetRegistry } from "./registry.ts";

export interface ImageGenerationProviderRequest {
  readonly requestId: string;
  readonly prompt: string;
}

export interface ImageGenerationProviderResult {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly sourceUrl: string;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
}

export interface ImageGenerationProvider {
  generate(request: ImageGenerationProviderRequest): Promise<ImageGenerationProviderResult>;
}

export interface GeneratedImageAcquisitionRequest extends AcquisitionRequest {
  readonly prompt: string;
}

export interface GeneratedImageAcquisitionReceipt extends AcquisitionReceiptBase {
  readonly kind: "generated-image";
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
}

export interface GeneratedImageAcquisitionOptions {
  readonly request: GeneratedImageAcquisitionRequest;
  readonly provider: ImageGenerationProvider;
  readonly retrieveBytes: ByteRetriever;
  readonly registry: AssetRegistry;
  readonly stagingRoot: string;
  readonly now: () => string;
}

function mediaType(value: unknown): AssetMediaType {
  if (value !== "image/png" && value !== "image/jpeg" && value !== "image/webp") {
    throw acquisitionError("providerResult.mediaType", "must be image/png, image/jpeg, or image/webp");
  }
  return value;
}

export async function acquireGeneratedImage(options: GeneratedImageAcquisitionOptions): Promise<AcquisitionResult<GeneratedImageAcquisitionReceipt>> {
  const stagingRoot = await prepareStaging(options.stagingRoot);
  validateRequest(options.request);
  const prompt = requireText(options.request.prompt, "request.prompt");
  let raw: ImageGenerationProviderResult;
  try {
    raw = await options.provider.generate(Object.freeze({ requestId: options.request.requestId, prompt }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "image generation provider failed";
    throw new AssetContractError("ASSET_PROVIDER_ERROR", "provider", detail);
  }
  const requestId = requireStableId(raw?.requestId, "providerResult.requestId");
  if (requestId !== options.request.requestId) throw acquisitionError("providerResult.requestId", "must match request.requestId");
  const returnedPrompt = requireText(raw.prompt, "providerResult.prompt");
  if (returnedPrompt !== prompt) throw acquisitionError("providerResult.prompt", "must exactly match request.prompt");
  const image: VerifiedImage = {
    sourceUrl: requireHttpsUrl(raw.sourceUrl, "providerResult.sourceUrl"),
    mediaType: mediaType(raw.mediaType),
    width: requireDimension(raw.width, "providerResult.width"),
    height: requireDimension(raw.height, "providerResult.height"),
  };
  const provider = requireText(raw.provider, "providerResult.provider");
  const model = requireText(raw.model, "providerResult.model");
  const acquiredAt = requireTimestamp(options.now(), "now");
  return persistVerified<GeneratedImageAcquisitionReceipt>({
    request: options.request, image, retrieveBytes: options.retrieveBytes, registry: options.registry, stagingRoot,
    source: { kind: "generated", generator: `${provider}/${model}` },
    receipt: {
      kind: "generated-image", requestId, provider, model, prompt, sourceUrl: image.sourceUrl,
      mediaType: image.mediaType, width: image.width, height: image.height, acquiredAt,
    },
  });
}
