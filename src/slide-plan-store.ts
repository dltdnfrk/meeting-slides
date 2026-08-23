import type { Database } from "bun:sqlite";

import { parseSlidePlan, type SlidePlan } from "./slides/model/plan-parser.ts";
import {
  pipelineHash,
  stableSlidePlanJson,
} from "./slides/server-pipeline-publication.ts";
import type { PipelineIdentity } from "./slides/server-pipeline-types.ts";

const SHA256 = /^[a-f0-9]{64}$/;

export interface SlidePlanPublicationWrite {
  readonly identity: PipelineIdentity;
  readonly planJson: string;
  readonly planSha256: string;
  readonly manifestJson: string;
  readonly publicationSha256: string;
  readonly directory: string;
}

export interface StoredSlidePlanPublication {
  readonly plan: SlidePlan;
  readonly identity: PipelineIdentity;
  readonly planJson: string;
  readonly planSha256: string;
  readonly publicationSha256: string;
  readonly path: string;
  readonly reviewId?: string;
  readonly reviewedItemIds?: readonly string[];
  readonly publishedAt: number;
}

interface PublicationRow {
  plan_id: string;
  meeting_id: number;
  identity_json: string;
  plan_json: string;
  plan_sha256: string;
  publication_sha256: string;
  publication_path: string;
  review_id: string | null;
  reviewed_item_ids_json: string | null;
  published_at: number;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  let decoded: unknown;
  try { decoded = JSON.parse(value) as unknown; } catch { throw new TypeError(`${label} must be valid JSON`); }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError(`${label} must contain one JSON object`);
  }
  return decoded as Record<string, unknown>;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
}

function assertIdentity(plan: SlidePlan, identity: PipelineIdentity): void {
  if (identity.planId !== plan.planId || !equal(identity.snapshot, plan.snapshot) ||
      !equal(identity.slideIds, plan.slides.map((slide) => slide.id)) ||
      !equal(identity.claimIds, plan.claims.map((claim) => claim.id))) {
    throw new TypeError("publication identity does not match SlidePlan identity");
  }
  if (typeof identity.deckId !== "string" || identity.deckId.length === 0 ||
      !Array.isArray(identity.geometryIds) || identity.geometryIds.length !== plan.slides.length) {
    throw new TypeError("publication identity metadata is invalid");
  }
  const reviewItems = identity.reviewedItemIds;
  if ((identity.reviewId === undefined) !== (reviewItems === undefined) ||
      (identity.reviewId !== undefined && identity.reviewId.length === 0) ||
      (reviewItems !== undefined && reviewItems.some((id) => typeof id !== "string" || id.length === 0))) {
    throw new TypeError("publication review identity is invalid");
  }
}

function decodeIdentity(value: string): PipelineIdentity {
  return parseObject(value, "persisted identity") as unknown as PipelineIdentity;
}

function decodeReviewItems(value: string | null): readonly string[] | undefined {
  if (value === null) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(value) as unknown; } catch { throw new TypeError("persisted review identity must be valid JSON"); }
  if (!Array.isArray(decoded) || decoded.some((item) => typeof item !== "string")) {
    throw new TypeError("persisted review identity must be a string array");
  }
  return decoded;
}

export class SlidePlanStore {
  constructor(private readonly database: Database) {
    database.run(`CREATE TABLE IF NOT EXISTS slide_plan_publications (
      plan_id TEXT PRIMARY KEY,
      meeting_id INTEGER NOT NULL,
      identity_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL,
      publication_sha256 TEXT NOT NULL,
      publication_path TEXT NOT NULL,
      review_id TEXT,
      reviewed_item_ids_json TEXT,
      published_at INTEGER NOT NULL
    )`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_slide_plan_publications_meeting_published
      ON slide_plan_publications(meeting_id, published_at DESC, plan_id)`);
  }

  save(value: SlidePlanPublicationWrite, publishedAt = Date.now()): StoredSlidePlanPublication {
    const plan = parseSlidePlan(value.planJson);
    const canonical = stableSlidePlanJson(plan);
    if (value.planJson !== canonical || pipelineHash(value.planJson) !== value.planSha256) {
      throw new TypeError("SlidePlan canonical bytes do not match plan hash");
    }
    assertHash(value.planSha256, "planSha256");
    assertHash(value.publicationSha256, "publicationSha256");
    assertIdentity(plan, value.identity);
    if (typeof value.directory !== "string" || value.directory.length === 0) throw new TypeError("publication path must not be empty");
    if (!Number.isSafeInteger(publishedAt) || publishedAt < 0) throw new TypeError("publishedAt must be a non-negative integer");

    const manifest = parseObject(value.manifestJson, "publication manifest");
    if (pipelineHash(value.manifestJson) !== value.publicationSha256 ||
        manifest.planSha256 !== value.planSha256 || !equal(manifest.identity, value.identity)) {
      throw new TypeError("publication hash or identity does not match publication manifest");
    }

    const candidate = {
      plan_id: plan.planId,
      meeting_id: plan.snapshot.meetingId,
      identity_json: JSON.stringify(value.identity),
      plan_json: value.planJson,
      plan_sha256: value.planSha256,
      publication_sha256: value.publicationSha256,
      publication_path: value.directory,
      review_id: value.identity.reviewId ?? null,
      reviewed_item_ids_json: value.identity.reviewedItemIds === undefined ? null : JSON.stringify(value.identity.reviewedItemIds),
      published_at: publishedAt,
    };

    return this.database.transaction(() => {
      const existing = this.row(plan.planId);
      if (existing !== null) {
        const immutableKeys = ["meeting_id", "identity_json", "plan_json", "plan_sha256", "publication_sha256", "publication_path", "review_id", "reviewed_item_ids_json"] as const;
        if (immutableKeys.some((key) => existing[key] !== candidate[key])) {
          throw new Error(`conflicting publication for plan ID '${plan.planId}'`);
        }
        return this.hydrate(existing);
      }
      this.database.run(`INSERT INTO slide_plan_publications
        (plan_id, meeting_id, identity_json, plan_json, plan_sha256, publication_sha256,
         publication_path, review_id, reviewed_item_ids_json, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, Object.values(candidate));
      return this.hydrate(candidate);
    })();
  }

  one(planId: string): StoredSlidePlanPublication | null {
    const row = this.row(planId);
    return row === null ? null : this.hydrate(row);
  }

  latest(meetingId?: number): StoredSlidePlanPublication | null {
    const row = (meetingId === undefined
      ? this.database.query("SELECT * FROM slide_plan_publications ORDER BY published_at DESC, plan_id DESC LIMIT 1").get()
      : this.database.query("SELECT * FROM slide_plan_publications WHERE meeting_id = ? ORDER BY published_at DESC, plan_id DESC LIMIT 1").get(meetingId)) as PublicationRow | null;
    return row === null ? null : this.hydrate(row);
  }

  list(meetingId?: number): StoredSlidePlanPublication[] {
    const rows = (meetingId === undefined
      ? this.database.query("SELECT * FROM slide_plan_publications ORDER BY published_at DESC, plan_id DESC").all()
      : this.database.query("SELECT * FROM slide_plan_publications WHERE meeting_id = ? ORDER BY published_at DESC, plan_id DESC").all(meetingId)) as PublicationRow[];
    return rows.map((row) => this.hydrate(row));
  }

  private row(planId: string): PublicationRow | null {
    return this.database.query("SELECT * FROM slide_plan_publications WHERE plan_id = ?").get(planId) as PublicationRow | null;
  }

  private hydrate(row: PublicationRow): StoredSlidePlanPublication {
    const plan = parseSlidePlan(row.plan_json);
    const identity = decodeIdentity(row.identity_json);
    const reviewedItemIds = decodeReviewItems(row.reviewed_item_ids_json);
    if (stableSlidePlanJson(plan) !== row.plan_json || pipelineHash(row.plan_json) !== row.plan_sha256 ||
        row.plan_id !== plan.planId || row.meeting_id !== plan.snapshot.meetingId) {
      throw new TypeError("persisted SlidePlan hash or identity mismatch");
    }
    assertHash(row.plan_sha256, "persisted planSha256");
    assertHash(row.publication_sha256, "persisted publicationSha256");
    assertIdentity(plan, identity);
    if (row.review_id !== (identity.reviewId ?? null) || !equal(reviewedItemIds, identity.reviewedItemIds)) {
      throw new TypeError("persisted review identity mismatch");
    }
    return Object.freeze({ plan, identity, planJson: row.plan_json, planSha256: row.plan_sha256,
      publicationSha256: row.publication_sha256, path: row.publication_path,
      ...(row.review_id === null ? {} : { reviewId: row.review_id }),
      ...(reviewedItemIds === undefined ? {} : { reviewedItemIds }), publishedAt: row.published_at });
  }
}
