import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  exportBundle,
  type ExportBundleOptions,
  type ExportBundleResult,
} from "./bundle.ts";
import type { MinutesStore } from "./minutes-store.ts";

const REQUIRED_ARTIFACTS = {
  minutes_pdf: "minutes.pdf",
  minutes_json: "minutes.json",
  canonical_transcript: null,
  slide_deck: "deck/index.html",
} as const;

export interface ConclusionState {
  type: "meetingConcluded";
  concluded: true;
  meetingId: number;
  reviewId: string;
  transcriptVersionId: string;
  bundleId: string;
  bundlePath: string;
  manifest: {
    sha256: string;
    targetCommit: string;
  };
  concludedAt: number;
}

export interface ConcludeMeetingOptions extends ExportBundleOptions {
  exporter?: typeof exportBundle;
}

type ConclusionRow = {
  meeting_id: number;
  review_id: string;
  transcript_version_id: string;
  bundle_id: string;
  bundle_path: string;
  manifest_sha256: string;
  target_commit: string;
  concluded_at: number;
};

function identityError(message: string): Error {
  return new Error(`[CONCLUSION_IDENTITY_MISMATCH] ${message}`);
}

function state(row: ConclusionRow): ConclusionState {
  return {
    type: "meetingConcluded",
    concluded: true,
    meetingId: row.meeting_id,
    reviewId: row.review_id,
    transcriptVersionId: row.transcript_version_id,
    bundleId: row.bundle_id,
    bundlePath: row.bundle_path,
    manifest: { sha256: row.manifest_sha256, targetCommit: row.target_commit },
    concludedAt: row.concluded_at,
  };
}

async function validateResult(
  result: ExportBundleResult,
  meetingId: number,
  reviewId: string,
  transcriptVersionId: string,
  targetCommit: string,
): Promise<string> {
  const manifestPath = join(result.bundlePath, "manifest.json");
  const bytes = await readFile(manifestPath);
  const diskManifest = JSON.parse(bytes.toString("utf8")) as ExportBundleResult["manifest"];
  const expectedCommit = targetCommit.toLowerCase();
  for (const manifest of [result.manifest, diskManifest]) {
    if (manifest.bundle_id !== result.bundleId || manifest.meeting_id !== meetingId ||
        manifest.review_id !== reviewId || manifest.target_commit !== expectedCommit) {
      throw identityError("bundle manifest does not identify the confirmed meeting, review, and target commit");
    }
  }
  if (JSON.stringify(result.manifest) !== JSON.stringify(diskManifest)) {
    throw identityError("returned manifest differs from the atomically published manifest");
  }
  if (!diskManifest.entries.every((entry) => entry.version.transcript_version_id === transcriptVersionId)) {
    throw identityError("manifest entries do not identify the confirmed transcript version");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function validateArtifactLinks(
  store: MinutesStore,
  result: ExportBundleResult,
  meetingId: number,
  reviewId: string,
  transcriptVersionId: string,
): void {
  const db = store.databaseHandle();
  const bundle = db.query(`
    SELECT meeting_id, review_id, transcript_version_id, bundle_path, status
    FROM artifact_bundles WHERE bundle_id = ?
  `).get(result.bundleId) as {
    meeting_id: number; review_id: string; transcript_version_id: string;
    bundle_path: string; status: string;
  } | null;
  if (!bundle || bundle.status !== "complete" || bundle.meeting_id !== meetingId ||
      bundle.review_id !== reviewId || bundle.transcript_version_id !== transcriptVersionId ||
      bundle.bundle_path !== result.bundlePath) {
    throw identityError("complete artifact bundle row does not match the published bundle");
  }
  const rows = db.query(`
    SELECT artifact_type, relative_path, media_type, sha256, byte_length
    FROM artifacts WHERE bundle_id = ?
  `).all(result.bundleId) as Array<{
    artifact_type: string; relative_path: string; media_type: string; sha256: string; byte_length: number;
  }>;
  const byType = new Map(rows.map((row) => [row.artifact_type, row]));
  for (const [artifactType, fixedPath] of Object.entries(REQUIRED_ARTIFACTS)) {
    const artifact = byType.get(artifactType);
    const expectedPath = fixedPath ?? result.manifest.entries.find(
      (entry) => entry.content_type === "application/x-ndjson",
    )?.path;
    const entry = result.manifest.entries.find((candidate) => candidate.path === expectedPath);
    if (!artifact || !entry || artifact.relative_path !== expectedPath ||
        artifact.media_type !== entry.content_type || artifact.sha256 !== entry.sha256 ||
        artifact.byte_length !== entry.byte_size) {
      throw identityError(`bundle artifact link ${artifactType} does not match the published manifest`);
    }
  }
}

/** Confirm a review and conclude its meeting only after an atomic, identity-checked bundle succeeds. */
export async function concludeMeeting(reviewId: string, options: ConcludeMeetingOptions): Promise<ConclusionState> {
  const normalizedReviewId = reviewId.trim();
  if (!normalizedReviewId) throw new TypeError("reviewId must not be blank");
  if (!/^[0-9a-f]{40}$/i.test(options.targetCommit)) {
    throw new Error("targetCommit must be a 40-character git commit");
  }
  const initial = options.store.review(normalizedReviewId);
  if (!initial) options.store.confirmReview(normalizedReviewId);
  else if (initial.status === "draft") options.store.confirmReview(normalizedReviewId);

  const review = options.store.review(normalizedReviewId);
  if (!review || review.status !== "confirmed" || review.confirmedAt === null) {
    throw new Error(`[REVIEW_NOT_CONFIRMED] review ${normalizedReviewId} is not confirmed`);
  }

  const { exporter = exportBundle, ...bundleOptions } = options;
  const result = await exporter(review.meetingId, normalizedReviewId, bundleOptions);
  const manifestSha256 = await validateResult(
    result,
    review.meetingId,
    normalizedReviewId,
    review.transcriptVersionId,
    options.targetCommit,
  );
  validateArtifactLinks(
    options.store,
    result,
    review.meetingId,
    normalizedReviewId,
    review.transcriptVersionId,
  );

  const db = options.store.databaseHandle();
  const concludedAt = Date.now();
  db.transaction(() => {
    db.run(`
      INSERT OR IGNORE INTO meeting_conclusions
        (meeting_id, review_id, transcript_version_id, bundle_id, bundle_path,
         manifest_sha256, target_commit, concluded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [review.meetingId, normalizedReviewId, review.transcriptVersionId, result.bundleId,
      result.bundlePath, manifestSha256, options.targetCommit.toLowerCase(), concludedAt]);
  })();
  const persisted = db.query("SELECT * FROM meeting_conclusions WHERE meeting_id = ?")
    .get(review.meetingId) as ConclusionRow | null;
  if (!persisted || persisted.review_id !== normalizedReviewId ||
      persisted.transcript_version_id !== review.transcriptVersionId ||
      persisted.bundle_id !== result.bundleId || persisted.bundle_path !== result.bundlePath ||
      persisted.manifest_sha256 !== manifestSha256 ||
      persisted.target_commit !== options.targetCommit.toLowerCase()) {
    throw identityError("persisted conclusion conflicts with the published bundle identity");
  }
  return state(persisted);
}
