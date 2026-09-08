import type { Database } from "bun:sqlite";

import {
  assertHash,
  assertIdentity,
  decodeIdentity,
  decodeReceipt,
  decodeStringArray,
  deriveFinalityReceipt,
  equal,
  SlidePlanFinalityError,
  stableFinalityReceiptJson,
} from "./slide-plan-finality.ts";
import {
  insertPublicationCandidate,
  migrateSlidePlanStore,
  type MigrationCandidate,
  type PublicationRow,
  type StoreMigrationOptions,
} from "./slide-plan-store-migration.ts";
import { parseSlidePlan, type SlidePlan } from "./slides/model/plan-parser.ts";
import {
  decodePublicationManifest,
  pipelineHash,
  stableSlidePlanJson,
} from "./slides/server-pipeline-publication.ts";
import type {
  PipelineIdentity,
  SlidePlanFinalityReceipt,
  SlidePlanPublicationStatus,
} from "./slides/server-pipeline-types.ts";

export type SlidePlanPublicationWrite = {
  readonly identity: PipelineIdentity;
  readonly planJson: string;
  readonly planSha256: string;
  readonly manifestJson: string;
  readonly publicationSha256: string;
  readonly directory: string;
};

export type StoredSlidePlanPublication = {
  readonly publicationSeq: number;
  readonly publicationId: string;
  readonly revision: number;
  readonly plan: SlidePlan;
  readonly identity: PipelineIdentity;
  readonly planJson: string;
  readonly planSha256: string;
  readonly publicationSha256: string;
  readonly publicationStatus: SlidePlanPublicationStatus;
  readonly path: string;
  readonly reviewId?: string;
  readonly reviewedItemIds?: readonly string[];
  readonly finalityReceipt?: SlidePlanFinalityReceipt;
  readonly publishedAt: number;
};

export class SlidePlanStoreError extends Error {
  readonly name = "SlidePlanStoreError";

  constructor(readonly reason: string) {
    super(reason);
  }
}

function publicationIdFor(plan: SlidePlan, planSha256: string): string {
  return pipelineHash(`${plan.planId}\n${plan.revision}\n${planSha256}\n`);
}

function candidateForWrite(database: Database, value: SlidePlanPublicationWrite, publishedAt: number): MigrationCandidate {
  const plan = parseSlidePlan(value.planJson);
  if (stableSlidePlanJson(plan) !== value.planJson || pipelineHash(value.planJson) !== value.planSha256) {
    throw new TypeError("SlidePlan canonical bytes do not match plan hash");
  }
  assertHash(value.planSha256, "planSha256");
  assertHash(value.publicationSha256, "publicationSha256");
  assertIdentity(plan, value.identity);
  if (value.directory.length === 0) throw new TypeError("publication path must not be empty");
  if (!Number.isSafeInteger(publishedAt) || publishedAt < 0) throw new TypeError("publishedAt must be a non-negative integer");
  if (pipelineHash(value.manifestJson) !== value.publicationSha256) {
    throw new TypeError("publication manifest hash mismatch");
  }
  const manifest = decodePublicationManifest(JSON.parse(value.manifestJson) as unknown);
  if (manifest.schemaVersion !== 2) throw new TypeError("new publication writes require manifest schema v2");
  if (manifest.planSha256 !== value.planSha256 || !equal(manifest.identity, value.identity)) {
    throw new TypeError("publication identity does not match publication manifest");
  }
  let receipt: SlidePlanFinalityReceipt | undefined;
  if (manifest.publicationStatus === "final") {
    receipt = deriveFinalityReceipt(database, value.identity);
    if (manifest.schemaVersion !== 2 || !equal(manifest.finalityReceipt, receipt)) {
      throw new SlidePlanFinalityError("publication receipt no longer matches same-database evidence");
    }
  }
  const receiptJson = receipt === undefined ? null : stableFinalityReceiptJson(receipt);
  return {
    publication_id: publicationIdFor(plan, value.planSha256),
    plan_id: plan.planId,
    revision: plan.revision,
    meeting_id: plan.snapshot.meetingId,
    identity_json: JSON.stringify(value.identity),
    plan_json: value.planJson,
    plan_sha256: value.planSha256,
    manifest_json: value.manifestJson,
    publication_sha256: value.publicationSha256,
    publication_status: manifest.publicationStatus,
    publication_path: value.directory,
    review_id: value.identity.reviewId ?? null,
    reviewed_item_ids_json: value.identity.reviewedItemIds === undefined ? null : JSON.stringify(value.identity.reviewedItemIds),
    finality_receipt_json: receiptJson,
    finality_receipt_sha256: receiptJson === null ? null : pipelineHash(receiptJson),
    published_at: publishedAt,
  };
}

export class SlidePlanStore {
  constructor(private readonly database: Database, options: StoreMigrationOptions = {}) {
    migrateSlidePlanStore(database, options);
  }

  save(value: SlidePlanPublicationWrite, publishedAt = Date.now()): StoredSlidePlanPublication {
    return this.database.transaction(() => {
      const candidate = candidateForWrite(this.database, value, publishedAt);
      const existing = this.revisionRow(candidate.plan_id, candidate.revision);
      if (existing !== null) {
        const immutableKeys = [
          "publication_id", "meeting_id", "identity_json", "plan_json", "plan_sha256", "manifest_json",
          "publication_sha256", "publication_status", "publication_path", "review_id",
          "reviewed_item_ids_json", "finality_receipt_json", "finality_receipt_sha256",
        ] as const;
        if (immutableKeys.some((key) => existing[key] !== candidate[key])) {
          throw new SlidePlanStoreError(`conflicting publication for plan ID '${candidate.plan_id}' revision ${candidate.revision}`);
        }
        return this.hydrate(existing);
      }
      const sequenceRow = this.database.query("SELECT coalesce(MAX(publication_seq), 0) + 1 AS sequence FROM slide_plan_publications").get() as { readonly sequence: number };
      insertPublicationCandidate(this.database, {
        table: "slide_plan_publications",
        sequence: sequenceRow.sequence,
        candidate,
      });
      const inserted = this.database.query("SELECT * FROM slide_plan_publications WHERE publication_seq = ?").get(sequenceRow.sequence) as PublicationRow;
      return this.hydrate(inserted);
    })();
  }

  one(planId: string): StoredSlidePlanPublication | null {
    const row = this.database.query(`SELECT * FROM slide_plan_publications
      WHERE plan_id = ? ORDER BY publication_seq DESC LIMIT 1`).get(planId) as PublicationRow | null;
    return row === null ? null : this.hydrate(row);
  }

  latest(meetingId?: number): StoredSlidePlanPublication | null {
    const row = (meetingId === undefined
      ? this.database.query("SELECT * FROM slide_plan_publications ORDER BY publication_seq DESC LIMIT 1").get()
      : this.database.query("SELECT * FROM slide_plan_publications WHERE meeting_id = ? ORDER BY publication_seq DESC LIMIT 1").get(meetingId)) as PublicationRow | null;
    return row === null ? null : this.hydrate(row);
  }

  list(meetingId?: number): StoredSlidePlanPublication[] {
    const rows = (meetingId === undefined
      ? this.database.query("SELECT * FROM slide_plan_publications ORDER BY publication_seq DESC").all()
      : this.database.query("SELECT * FROM slide_plan_publications WHERE meeting_id = ? ORDER BY publication_seq DESC").all(meetingId)) as PublicationRow[];
    return rows.map((row) => this.hydrate(row));
  }

  private revisionRow(planId: string, revision: number): PublicationRow | null {
    return this.database.query("SELECT * FROM slide_plan_publications WHERE plan_id = ? AND revision = ? LIMIT 1").get(planId, revision) as PublicationRow | null;
  }

  private hydrate(row: PublicationRow): StoredSlidePlanPublication {
    const plan = parseSlidePlan(row.plan_json);
    const identity = decodeIdentity(row.identity_json);
    const reviewedItemIds = decodeStringArray(row.reviewed_item_ids_json);
    const receipt = decodeReceipt(row.finality_receipt_json);
    if (stableSlidePlanJson(plan) !== row.plan_json || pipelineHash(row.plan_json) !== row.plan_sha256 ||
        row.publication_id !== publicationIdFor(plan, row.plan_sha256) || row.plan_id !== plan.planId ||
        row.revision !== plan.revision || row.meeting_id !== plan.snapshot.meetingId ||
        !Number.isSafeInteger(row.publication_seq) || row.publication_seq <= 0) {
      throw new TypeError("persisted SlidePlan hash or identity mismatch");
    }
    assertHash(row.plan_sha256, "persisted planSha256");
    assertHash(row.publication_sha256, "persisted publicationSha256");
    assertIdentity(plan, identity);
    if (row.review_id !== (identity.reviewId ?? null) || !equal(reviewedItemIds, identity.reviewedItemIds)) {
      throw new TypeError("persisted review identity mismatch");
    }
    const expectedStatus = identity.reviewId === undefined ? "draft" : "final";
    if (row.publication_status !== expectedStatus) throw new TypeError("persisted publication status mismatch");
    if (row.manifest_json !== null) {
      if (pipelineHash(row.manifest_json) !== row.publication_sha256) throw new TypeError("persisted publication manifest hash mismatch");
      const manifest = decodePublicationManifest(JSON.parse(row.manifest_json) as unknown);
      if (manifest.publicationStatus !== row.publication_status || manifest.planSha256 !== row.plan_sha256 || !equal(manifest.identity, identity)) {
        throw new TypeError("persisted publication manifest identity mismatch");
      }
      if (manifest.publicationStatus === "final" && (manifest.schemaVersion !== 2 || !equal(manifest.finalityReceipt, receipt))) {
        throw new TypeError("persisted publication manifest receipt mismatch");
      }
    }
    if (row.publication_status === "final") {
      const derived = deriveFinalityReceipt(this.database, identity);
      const receiptJson = receipt === undefined ? null : stableFinalityReceiptJson(receipt);
      if (!equal(receipt, derived) || receiptJson === null || row.finality_receipt_json !== receiptJson ||
          pipelineHash(row.finality_receipt_json) !== row.finality_receipt_sha256) {
        throw new TypeError("persisted finality receipt bytes, hash, or same-database evidence mismatch");
      }
    } else if (receipt !== undefined || row.finality_receipt_sha256 !== null) {
      throw new TypeError("draft publication carries a finality receipt");
    }
    return Object.freeze({
      publicationSeq: row.publication_seq,
      publicationId: row.publication_id,
      revision: row.revision,
      plan,
      identity,
      planJson: row.plan_json,
      planSha256: row.plan_sha256,
      publicationSha256: row.publication_sha256,
      publicationStatus: row.publication_status,
      path: row.publication_path,
      ...(row.review_id === null ? {} : { reviewId: row.review_id }),
      ...(reviewedItemIds === undefined ? {} : { reviewedItemIds }),
      ...(receipt === undefined ? {} : { finalityReceipt: receipt }),
      publishedAt: row.published_at,
    });
  }
}
