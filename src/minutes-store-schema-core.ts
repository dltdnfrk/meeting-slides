export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_meta (
  meeting_id INTEGER PRIMARY KEY,
  purpose TEXT,
  phase TEXT NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared','capturing','ended')),
  prepared_at INTEGER NOT NULL,
  activated_at INTEGER,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendees (
  meeting_id INTEGER NOT NULL,
  attendee_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (trim(display_name) <> ''),
  crm_person_entity_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, attendee_id),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_meeting_crm
  ON attendees(meeting_id, crm_person_entity_id) WHERE crm_person_entity_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS meeting_audio_sources (
  meeting_id INTEGER PRIMARY KEY,
  original_audio_sha256 TEXT NOT NULL UNIQUE CHECK (length(original_audio_sha256) = 64),
  original_audio_path TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS transcript_versions (
  transcript_version_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('live_capture','file_transcription','retranscription','import')),
  engine TEXT,
  engine_model TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  UNIQUE (meeting_id, version_no),
  UNIQUE (meeting_id, transcript_version_id),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CHECK (finalized_at IS NULL OR content_sha256 IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS transcript_version_lines (
  meeting_id INTEGER NOT NULL,
  transcript_version_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  captured_at_ms INTEGER,
  audio_start_ms INTEGER,
  audio_end_ms INTEGER,
  speaker_turn INTEGER CHECK (speaker_turn IS NULL OR speaker_turn > 0),
  text TEXT NOT NULL CHECK (trim(text) <> ''),
  PRIMARY KEY (transcript_version_id, seq),
  UNIQUE (meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, transcript_version_id)
    REFERENCES transcript_versions(meeting_id, transcript_version_id) ON DELETE CASCADE,
  CHECK (audio_end_ms IS NULL OR (audio_start_ms IS NOT NULL AND audio_end_ms >= audio_start_ms))
);
CREATE TRIGGER IF NOT EXISTS trg_finalized_transcript_lines_no_update
BEFORE UPDATE ON transcript_version_lines
WHEN EXISTS (
  SELECT 1 FROM transcript_versions
  WHERE transcript_version_id = OLD.transcript_version_id AND finalized_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'finalized transcript lines are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_finalized_transcript_lines_no_delete
BEFORE DELETE ON transcript_version_lines
WHEN EXISTS (
  SELECT 1 FROM transcript_versions
  WHERE transcript_version_id = OLD.transcript_version_id AND finalized_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'finalized transcript lines are immutable');
END;
CREATE TABLE IF NOT EXISTS meeting_transcript_state (
  meeting_id INTEGER PRIMARY KEY,
  canonical_transcript_version_id TEXT NOT NULL,
  canonical_selected_at INTEGER NOT NULL,
  FOREIGN KEY (meeting_id, canonical_transcript_version_id)
    REFERENCES transcript_versions(meeting_id, transcript_version_id)
);
CREATE TABLE IF NOT EXISTS transcript_line_attributions (
  meeting_id INTEGER NOT NULL,
  transcript_version_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  attendee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, transcript_version_id, seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, attendee_id) REFERENCES attendees(meeting_id, attendee_id)
);
`;
