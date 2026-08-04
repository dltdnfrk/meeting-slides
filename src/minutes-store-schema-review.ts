export const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_reviews (
  review_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  transcript_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by TEXT,
  UNIQUE (meeting_id, transcript_version_id),
  UNIQUE (meeting_id, review_id),
  UNIQUE (meeting_id, review_id, transcript_version_id),
  FOREIGN KEY (meeting_id, transcript_version_id)
    REFERENCES transcript_versions(meeting_id, transcript_version_id),
  CHECK ((status = 'draft' AND confirmed_at IS NULL) OR (status = 'confirmed' AND confirmed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK (trim(description) <> ''),
  source_transcript_version_id TEXT NOT NULL,
  source_start_seq INTEGER NOT NULL,
  source_end_seq INTEGER NOT NULL CHECK (source_start_seq <= source_end_seq),
  attributed_attendee_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('llm','local_rule','manual')),
  review_state TEXT NOT NULL DEFAULT 'candidate' CHECK (review_state IN ('candidate','confirmed','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (review_state <> 'confirmed' OR attributed_attendee_id IS NOT NULL),
  FOREIGN KEY (meeting_id, review_id, source_transcript_version_id)
    REFERENCES meeting_reviews(meeting_id, review_id, transcript_version_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_start_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_end_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, attributed_attendee_id) REFERENCES attendees(meeting_id, attendee_id)
);
CREATE TABLE IF NOT EXISTS action_items (
  action_item_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK (trim(description) <> ''),
  source_transcript_version_id TEXT NOT NULL,
  source_start_seq INTEGER NOT NULL,
  source_end_seq INTEGER NOT NULL CHECK (source_start_seq <= source_end_seq),
  assignee_attendee_id TEXT,
  attributed_attendee_id TEXT,
  deadline TEXT,
  deadline_text TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('llm','local_rule','manual')),
  review_state TEXT NOT NULL DEFAULT 'candidate' CHECK (review_state IN ('candidate','confirmed','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (review_state <> 'confirmed' OR (assignee_attendee_id IS NOT NULL AND attributed_attendee_id IS NOT NULL AND deadline IS NOT NULL)),
  FOREIGN KEY (meeting_id, review_id, source_transcript_version_id)
    REFERENCES meeting_reviews(meeting_id, review_id, transcript_version_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_start_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_end_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, assignee_attendee_id) REFERENCES attendees(meeting_id, attendee_id),
  FOREIGN KEY (meeting_id, attributed_attendee_id) REFERENCES attendees(meeting_id, attendee_id)
);
CREATE TABLE IF NOT EXISTS open_items (
  open_item_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK (trim(description) <> ''),
  source_transcript_version_id TEXT NOT NULL,
  source_start_seq INTEGER NOT NULL,
  source_end_seq INTEGER NOT NULL CHECK (source_start_seq <= source_end_seq),
  attributed_attendee_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('llm','local_rule','manual')),
  review_state TEXT NOT NULL DEFAULT 'candidate' CHECK (review_state IN ('candidate','confirmed','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (review_state <> 'confirmed' OR attributed_attendee_id IS NOT NULL),
  FOREIGN KEY (meeting_id, review_id, source_transcript_version_id)
    REFERENCES meeting_reviews(meeting_id, review_id, transcript_version_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_start_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_end_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, attributed_attendee_id) REFERENCES attendees(meeting_id, attendee_id)
);
CREATE TABLE IF NOT EXISTS referenced_materials (
  material_id TEXT PRIMARY KEY,
  meeting_id INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  material_type TEXT NOT NULL CHECK (material_type IN ('document','figure','link','data','other')),
  title TEXT,
  uri TEXT,
  notes TEXT,
  source_transcript_version_id TEXT,
  source_start_seq INTEGER,
  source_end_seq INTEGER,
  review_state TEXT NOT NULL DEFAULT 'candidate' CHECK (review_state IN ('candidate','confirmed','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (coalesce(trim(title), '') <> '' OR coalesce(trim(uri), '') <> ''),
  CHECK ((source_transcript_version_id IS NULL AND source_start_seq IS NULL AND source_end_seq IS NULL) OR
         (source_transcript_version_id IS NOT NULL AND source_start_seq IS NOT NULL AND source_end_seq IS NOT NULL AND source_start_seq <= source_end_seq)),
  FOREIGN KEY (meeting_id, review_id)
    REFERENCES meeting_reviews(meeting_id, review_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, review_id, source_transcript_version_id)
    REFERENCES meeting_reviews(meeting_id, review_id, transcript_version_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_start_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq),
  FOREIGN KEY (meeting_id, source_transcript_version_id, source_end_seq)
    REFERENCES transcript_version_lines(meeting_id, transcript_version_id, seq)
);
`;
