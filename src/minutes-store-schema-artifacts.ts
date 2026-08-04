export const ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_bundles (
  bundle_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  transcript_version_id TEXT NOT NULL,
  bundle_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging','complete','failed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (meeting_id, review_id, transcript_version_id)
    REFERENCES meeting_reviews(meeting_id, review_id, transcript_version_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('minutes_pdf','minutes_json','canonical_transcript','slide_deck','original_audio')),
  relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (bundle_id, artifact_type),
  FOREIGN KEY (bundle_id) REFERENCES artifact_bundles(bundle_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS meeting_conclusions (
  meeting_id INTEGER PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE,
  transcript_version_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL UNIQUE,
  bundle_path TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  target_commit TEXT NOT NULL CHECK (length(target_commit) = 40),
  concluded_at INTEGER NOT NULL,
  FOREIGN KEY (meeting_id, review_id, transcript_version_id)
    REFERENCES meeting_reviews(meeting_id, review_id, transcript_version_id),
  FOREIGN KEY (bundle_id) REFERENCES artifact_bundles(bundle_id)
);
`;
