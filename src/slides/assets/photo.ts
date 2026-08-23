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

export interface PhotoProviderRequest {
  readonly requestId: string;
  readonly query: string;
}

export interface PhotoProviderResult {
  readonly requestId: string;
  readonly provider: string;
  readonly providerAssetId: string;
  readonly sourceUrl: string;
  readonly mediaType: AssetMediaType;
  readonly width: number;
  readonly height: number;
  readonly license: string;
  readonly attribution: string;
}

export interface PhotoProvider {
  find(request: PhotoProviderRequest): Promise<PhotoProviderResult>;
}

export interface PhotoAcquisitionRequest extends AcquisitionRequest {
  readonly query: string;
}

export interface PhotoAcquisitionReceipt extends AcquisitionReceiptBase {
  readonly kind: "photo";
  readonly provider: string;
  readonly providerAssetId: string;
  readonly license: string;
  readonly attribution: string;
  readonly query: string;
}

export interface PhotoAcquisitionOptions {
  readonly request: PhotoAcquisitionRequest;
  readonly provider: PhotoProvider;
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

export async function acquirePhoto(options: PhotoAcquisitionOptions): Promise<AcquisitionResult<PhotoAcquisitionReceipt>> {
  const stagingRoot = await prepareStaging(options.stagingRoot);
  validateRequest(options.request);
  const query = requireText(options.request.query, "request.query");
  let raw: PhotoProviderResult;
  try {
    raw = await options.provider.find(Object.freeze({ requestId: options.request.requestId, query }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "photo provider failed";
    throw new AssetContractError("ASSET_PROVIDER_ERROR", "provider", detail);
  }
  const requestId = requireStableId(raw?.requestId, "providerResult.requestId");
  if (requestId !== options.request.requestId) throw acquisitionError("providerResult.requestId", "must match request.requestId");
  const image: VerifiedImage = {
    sourceUrl: requireHttpsUrl(raw.sourceUrl, "providerResult.sourceUrl"),
    mediaType: mediaType(raw.mediaType),
    width: requireDimension(raw.width, "providerResult.width"),
    height: requireDimension(raw.height, "providerResult.height"),
  };
  const provider = requireText(raw.provider, "providerResult.provider");
  const providerAssetId = requireStableId(raw.providerAssetId, "providerResult.providerAssetId");
  const license = requireText(raw.license, "providerResult.license");
  const attribution = requireText(raw.attribution, "providerResult.attribution");
  const acquiredAt = requireTimestamp(options.now(), "now");
  return persistVerified<PhotoAcquisitionReceipt>({
    request: options.request, image, retrieveBytes: options.retrieveBytes, registry: options.registry, stagingRoot,
    source: { kind: "retrieved", url: image.sourceUrl, retrievedAt: acquiredAt },
    receipt: {
      kind: "photo", requestId, provider, providerAssetId, license, attribution, query,
      sourceUrl: image.sourceUrl, mediaType: image.mediaType, width: image.width, height: image.height, acquiredAt,
    },
  });
}
