import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

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
const runs = new WeakMap<MinutesStore, Map<string, Promise<ConclusionState>>>();

export interface ConclusionState {
  type: "meetingConcluded";
  concluded: true;
  meetingId: number;
  reviewId: string;
  transcriptVersionId: string;
  bundleId: string;
  bundlePath: string;
  manifest: { sha256: string; targetCommit: string };
  concludedAt: number;
}

export interface ConcludeMeetingOptions extends ExportBundleOptions {
  exporter?: typeof exportBundle;
}

export class MeetingConclusionError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`[${code}] ${message}`, options);
    this.name = "MeetingConclusionError";
  }
}

type ConclusionRow = {
  meeting_id: number; review_id: string; transcript_version_id: string;
  bundle_id: string; bundle_path: string; manifest_sha256: string;
  target_commit: string; concluded_at: number;
};

type ArtifactRow = {
  artifact_type: string; relative_path: string; media_type: string;
  sha256: string; byte_length: number;
};

function failure(code: string, message: string, cause?: unknown): MeetingConclusionError {
  return new MeetingConclusionError(code, message, cause === undefined ? undefined : { cause });
}

function typed(error: unknown): Error {
  if (error instanceof Error && /^\[[A-Z0-9_]+\]/.test(error.message)) return error;
  return failure("BUNDLE_EXPORT_FAILED", error instanceof Error ? error.message : String(error), error);
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

function conclusionFor(store: MinutesStore, reviewId: string): ConclusionRow | null {
  return store.databaseHandle().query("SELECT * FROM meeting_conclusions WHERE review_id = ?")
    .get(reviewId) as ConclusionRow | null;
}

function safePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.includes("\\") &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

async function validateResult(
  result: ExportBundleResult,
  meetingId: number,
  reviewId: string,
  transcriptVersionId: string,
  targetCommit: string,
): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(result.bundlePath, "manifest.json"));
  } catch (error) {
    throw failure("BUNDLE_INCOMPLETE", "published manifest is missing", error);
  }
  let disk: ExportBundleResult["manifest"];
  try {
    disk = JSON.parse(bytes.toString("utf8")) as ExportBundleResult["manifest"];
  } catch (error) {
    throw failure("BUNDLE_MANIFEST_INVALID", "published manifest is not valid JSON", error);
  }
  const expectedCommit = targetCommit.toLowerCase();
  for (const manifest of [result.manifest, disk]) {
    if (manifest.bundle_id !== result.bundleId || manifest.meeting_id !== meetingId ||
        manifest.review_id !== reviewId || manifest.target_commit !== expectedCommit) {
      throw failure("CONCLUSION_IDENTITY_MISMATCH", "manifest does not identify the confirmed meeting, review, and commit");
    }
    if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.artifacts) ||
        JSON.stringify(manifest.entries) !== JSON.stringify(manifest.artifacts)) {
      throw failure("BUNDLE_MANIFEST_MISMATCH", "manifest artifact indexes differ");
    }
  }
  if (JSON.stringify(result.manifest) !== JSON.stringify(disk)) {
    throw failure("CONCLUSION_IDENTITY_MISMATCH", "returned manifest differs from the published manifest");
  }
  if (!disk.entries.length || !disk.entries.every((entry) =>
    entry.version.transcript_version_id === transcriptVersionId && safePath(entry.path))) {
    throw failure("CONCLUSION_IDENTITY_MISMATCH", "manifest entries do not identify the confirmed transcript version");
  }
  for (const entry of disk.entries) {
    let artifact: Buffer;
    try {
      artifact = await readFile(join(result.bundlePath, entry.path));
    } catch (error) {
      throw failure("BUNDLE_INCOMPLETE", `missing ${entry.path}`, error);
    }
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (artifact.byteLength !== entry.byte_size || entry.byte_length !== entry.byte_size || digest !== entry.sha256) {
      throw failure("BUNDLE_HASH_MISMATCH", entry.path);
    }
  }
  if (!(await readFile(join(result.bundlePath, "minutes.pdf"))).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw failure("INVALID_MINUTES_PDF", "PDF signature missing");
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
    throw failure("CONCLUSION_IDENTITY_MISMATCH", "complete bundle row differs from the published bundle");
  }
  const rows = db.query(`
    SELECT artifact_type, relative_path, media_type, sha256, byte_length
    FROM artifacts WHERE bundle_id = ?
  `).all(result.bundleId) as ArtifactRow[];
  if (rows.length !== Object.keys(REQUIRED_ARTIFACTS).length) {
    throw failure("BUNDLE_INCOMPLETE", "required artifact row count differs");
  }
  const byType = new Map(rows.map((row) => [row.artifact_type, row]));
  for (const [artifactType, fixedPath] of Object.entries(REQUIRED_ARTIFACTS)) {
    const expectedPath = fixedPath ?? result.manifest.entries.find(
      (entry) => entry.content_type === "application/x-ndjson",
    )?.path;
    const artifact = byType.get(artifactType);
    const entry = result.manifest.entries.find((candidate) => candidate.path === expectedPath);
    if (!artifact || !entry || artifact.relative_path !== expectedPath ||
        artifact.media_type !== entry.content_type || artifact.sha256 !== entry.sha256 ||
        artifact.byte_length !== entry.byte_size) {
      throw failure("CONCLUSION_IDENTITY_MISMATCH", `artifact link ${artifactType} differs from the manifest`);
    }
  }
}

async function runConclusion(reviewId: string, options: ConcludeMeetingOptions): Promise<ConclusionState> {
  const existing = conclusionFor(options.store, reviewId);
  if (existing) return state(existing);
  const db = options.store.databaseHandle();
  let transactionOpen = false;
  let publishedPath: string | null = null;
  try {
    db.run("BEGIN IMMEDIATE");
    transactionOpen = true;
    const raced = conclusionFor(options.store, reviewId);
    if (raced) {
      db.run("COMMIT");
      transactionOpen = false;
      return state(raced);
    }
    const initial = options.store.review(reviewId);
    if (!initial || initial.status === "draft") options.store.confirmReview(reviewId);
    const review = options.store.review(reviewId);
    if (!review || review.status !== "confirmed" || review.confirmedAt === null) {
      throw failure("REVIEW_NOT_CONFIRMED", `review ${reviewId} is not confirmed`);
    }
    const { exporter = exportBundle, ...bundleOptions } = options;
    const result = await exporter(review.meetingId, reviewId, bundleOptions);
    publishedPath = result.bundlePath;
    const manifestSha256 = await validateResult(
      result, review.meetingId, reviewId, review.transcriptVersionId, options.targetCommit,
    );
    validateArtifactLinks(options.store, result, review.meetingId, reviewId, review.transcriptVersionId);
    const concludedAt = Date.now();
    db.run(`
      INSERT INTO meeting_conclusions
        (meeting_id, review_id, transcript_version_id, bundle_id, bundle_path,
         manifest_sha256, target_commit, concluded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [review.meetingId, reviewId, review.transcriptVersionId, result.bundleId,
      result.bundlePath, manifestSha256, options.targetCommit.toLowerCase(), concludedAt]);
    const persisted = conclusionFor(options.store, reviewId);
    if (!persisted) throw failure("CONCLUSION_PERSIST_FAILED", "closed state was not persisted");
    db.run("COMMIT");
    transactionOpen = false;
    return state(persisted);
  } catch (error) {
    if (transactionOpen) {
      try { db.run("ROLLBACK"); } catch {}
    }
    if (publishedPath) await rm(publishedPath, { recursive: true, force: true });
    throw typed(error);
  }
}

/** Confirm, export, validate, and close one review as an idempotent transaction. */
export function concludeMeeting(reviewId: string, options: ConcludeMeetingOptions): Promise<ConclusionState> {
  const normalized = reviewId.trim();
  if (!normalized) return Promise.reject(failure("INVALID_REVIEW_REQUEST", "reviewId must not be blank"));
  if (!/^[0-9a-f]{40}$/i.test(options.targetCommit)) {
    return Promise.reject(failure("INVALID_TARGET_COMMIT", "targetCommit must be a 40-character git commit"));
  }
  let storeRuns = runs.get(options.store);
  if (!storeRuns) {
    storeRuns = new Map();
    runs.set(options.store, storeRuns);
  }
  const active = storeRuns.get(normalized);
  if (active) return active;
  const run = runConclusion(normalized, options);
  storeRuns.set(normalized, run);
  void run.finally(() => {
    if (storeRuns?.get(normalized) === run) storeRuns.delete(normalized);
  }).catch(() => {});
  return run;
}
