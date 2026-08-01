import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export type TranscriptSourceKind = "live_capture" | "file_transcription" | "retranscription" | "import";
export type ReviewState = "candidate" | "confirmed" | "rejected";
export type CandidateOrigin = "llm" | "local_rule" | "manual";

export interface AttendeeInput {
  attendeeId: string;
  displayName: string;
  crmPersonEntityId?: string | null;
  sortOrder?: number;
}

export interface SourceRange {
  transcriptVersionId: string;
  startSeq: number;
  endSeq: number;
}

interface CandidateBase {
  id?: string;
  description: string;
  source: SourceRange;
  attributedAttendeeId?: string | null;
  origin?: CandidateOrigin;
  reviewState?: ReviewState;
}

export interface DecisionCandidate extends CandidateBase {}
export interface ActionItemCandidate extends CandidateBase {
  assigneeAttendeeId?: string | null;
  deadline?: string | null;
  deadlineText?: string | null;
}
export interface OpenItemCandidate extends CandidateBase {}

export interface ReferencedMaterialCandidate {
  id?: string;
  materialType: "document" | "figure" | "link" | "data" | "other";
  title?: string | null;
  uri?: string | null;
  notes?: string | null;
  source?: SourceRange | null;
  reviewState?: ReviewState;
}

export interface SaveCandidatesInput {
  meetingId: number;
  transcriptVersionId: string;
  reviewId?: string;
  decisions?: DecisionCandidate[];
  actionItems?: ActionItemCandidate[];
  openItems?: OpenItemCandidate[];
  referencedMaterials?: ReferencedMaterialCandidate[];
}

export interface TranscriptLineInput {
  seq: number;
  capturedAtMs?: number | null;
  audioStartMs?: number | null;
  audioEndMs?: number | null;
  speakerTurn?: number | null;
  text: string;
}

const SCHEMA = `
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
`;

function nonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be blank`);
  return trimmed;
}

function validHash(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("sha256 must be a 64-character hexadecimal value");
  return value.toLowerCase();
}

export type ReviewMutationErrorCode =
  | "REVIEW_NOT_DRAFT"
  | "UNKNOWN_REVIEW_ITEM"
  | "INVALID_REVIEW_PATCH"
  | "ATTENDEE_NOT_IN_MEETING"
  | "INCOMPLETE_REVIEW_ITEM"
  | "PENDING_REVIEW_ITEMS"
  | "STALE_TRANSCRIPT_VERSION"
  | "TRANSCRIPT_INTEGRITY_FAILED"
  | "INVALID_SOURCE_SEGMENT";

function reviewError(code: ReviewMutationErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function canonicalLineJson(line: {
  seq: number; captured_at_ms: number | null; audio_start_ms: number | null;
  audio_end_ms: number | null; speaker_turn: number | null; text: string;
}): string {
  return JSON.stringify({
    seq: line.seq,
    captured_at_ms: line.captured_at_ms,
    audio_start_ms: line.audio_start_ms,
    audio_end_ms: line.audio_end_ms,
    speaker_turn: line.speaker_turn,
    text: line.text,
  });
}

export class MinutesStore {
  private readonly db: Database;
  private readonly ownsDatabase: boolean;

  constructor(database: Database | string = "meetings.db") {
    this.ownsDatabase = typeof database === "string";
    this.db = typeof database === "string" ? new Database(database) : database;
    this.db.run("PRAGMA foreign_keys = ON");
    if (this.ownsDatabase) {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA synchronous = NORMAL");
    }
    this.db.run(SCHEMA);
  }

  databaseHandle(): Database {
    return this.db;
  }

  ensurePreparedMeeting(provider: string, purpose: string | null): number {
    return this.db.transaction(() => {
      const existing = this.db.query(`
        SELECT m.id FROM meetings m
        JOIN meeting_meta mm ON mm.meeting_id = m.id
        WHERE mm.phase = 'prepared' AND m.provider = ?
        ORDER BY m.id DESC LIMIT 1
      `).get(provider) as { id: number } | null;
      if (existing) {
        this.db.run("UPDATE meeting_meta SET purpose = ? WHERE meeting_id = ?", [purpose, existing.id]);
        return existing.id;
      }
      const now = Date.now();
      const inserted = this.db.run("INSERT INTO meetings (started_at, provider) VALUES (?, ?)", [now, provider]);
      const meetingId = Number(inserted.lastInsertRowid);
      this.db.run(
        "INSERT INTO meeting_meta (meeting_id, purpose, phase, prepared_at) VALUES (?, ?, 'prepared', ?)",
        [meetingId, purpose, now],
      );
      return meetingId;
    })();
  }

  activatePreparedMeeting(meetingId: number): void {
    this.db.transaction(() => {
      const now = Date.now();
      const activated = this.db.run(
        "UPDATE meeting_meta SET phase = 'capturing', activated_at = ? WHERE meeting_id = ? AND phase = 'prepared'",
        [now, meetingId],
      );
      if (Number(activated.changes) !== 1) throw new Error(`meeting ${meetingId} is not prepared`);
      this.db.run("UPDATE meetings SET started_at = ? WHERE id = ?", [now, meetingId]);
    })();
  }

  registerCapturingMeeting(meetingId: number): void {
    const now = Date.now();
    this.db.run(`
      INSERT INTO meeting_meta (meeting_id, purpose, phase, prepared_at, activated_at)
      VALUES (?, NULL, 'capturing', ?, ?)
    `, [meetingId, now, now]);
  }

  endMeeting(meetingId: number): void {
    const result = this.db.run(
      "UPDATE meeting_meta SET phase = 'ended' WHERE meeting_id = ? AND phase IN ('prepared', 'capturing')",
      [meetingId],
    );
    if (Number(result.changes) !== 1) throw new Error(`meeting ${meetingId} cannot transition to ended`);
  }

  setMeetingPurpose(meetingId: number, purpose: string | null): void {
    const normalized = purpose === null ? null : nonBlank(purpose, "purpose");
    const result = this.db.run("UPDATE meeting_meta SET purpose = ? WHERE meeting_id = ?", [normalized, meetingId]);
    if (Number(result.changes) !== 1) throw new Error(`unknown meeting ${meetingId}`);
  }

  meetingMeta(meetingId: number): {
    meetingId: number; purpose: string | null; phase: "prepared" | "capturing" | "ended";
    preparedAt: number; activatedAt: number | null;
  } | null {
    const row = this.db.query(`
      SELECT meeting_id, purpose, phase, prepared_at, activated_at FROM meeting_meta WHERE meeting_id = ?
    `).get(meetingId) as {
      meeting_id: number; purpose: string | null; phase: "prepared" | "capturing" | "ended";
      prepared_at: number; activated_at: number | null;
    } | null;
    return row && {
      meetingId: row.meeting_id, purpose: row.purpose, phase: row.phase,
      preparedAt: row.prepared_at, activatedAt: row.activated_at,
    };
  }

  addAttendees(meetingId: number, attendees: AttendeeInput[]): void {
    this.db.transaction(() => {
      const now = Date.now();
      for (const attendee of attendees) this.upsertAttendee(meetingId, attendee, now);
    })();
  }

  replaceAttendees(meetingId: number, attendees: AttendeeInput[]): void {
    this.db.transaction(() => {
      const meta = this.meetingMeta(meetingId);
      if (!meta) throw new Error(`unknown meeting ${meetingId}`);
      const confirmed = this.db.query(
        "SELECT 1 FROM meeting_reviews WHERE meeting_id = ? AND status = 'confirmed' LIMIT 1",
      ).get(meetingId);
      if (confirmed) throw new Error(`meeting ${meetingId} attendees are locked after review confirmation`);
      const now = Date.now();
      for (const attendee of attendees) this.upsertAttendee(meetingId, attendee, now);
      const placeholders = attendees.map(() => "?").join(", ");
      this.db.run(
        `DELETE FROM attendees WHERE meeting_id = ? AND attendee_id NOT IN (${placeholders})`,
        [meetingId, ...attendees.map((attendee) => attendee.attendeeId)],
      );
    })();
  }

  private upsertAttendee(meetingId: number, attendee: AttendeeInput, now: number): void {
    this.db.run(`
      INSERT INTO attendees (meeting_id, attendee_id, display_name, crm_person_entity_id, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id, attendee_id) DO UPDATE SET
        display_name = excluded.display_name,
        crm_person_entity_id = excluded.crm_person_entity_id,
        sort_order = excluded.sort_order
    `, [meetingId, nonBlank(attendee.attendeeId, "attendeeId"), nonBlank(attendee.displayName, "displayName"),
      attendee.crmPersonEntityId ?? null, attendee.sortOrder ?? 0, now]);
  }

  attendeesFor(meetingId: number): Array<{
    attendeeId: string; displayName: string; crmPersonEntityId: string | null; sortOrder: number;
  }> {
    const rows = this.db.query(`
      SELECT attendee_id, display_name, crm_person_entity_id, sort_order
      FROM attendees WHERE meeting_id = ? ORDER BY sort_order, created_at, attendee_id
    `).all(meetingId) as Array<{
      attendee_id: string; display_name: string; crm_person_entity_id: string | null; sort_order: number;
    }>;
    return rows.map((row) => ({
      attendeeId: row.attendee_id, displayName: row.display_name,
      crmPersonEntityId: row.crm_person_entity_id, sortOrder: row.sort_order,
    }));
  }

  addTranscriptVersion(meetingId: number, input: {
    transcriptVersionId?: string; sourceKind: TranscriptSourceKind; engine?: string | null; engineModel?: string | null;
  }): { transcriptVersionId: string; versionNo: number } {
    return this.db.transaction(() => {
      const latest = this.db.query(
        "SELECT coalesce(MAX(version_no), 0) AS version_no FROM transcript_versions WHERE meeting_id = ?",
      ).get(meetingId) as { version_no: number };
      const versionNo = latest.version_no + 1;
      const transcriptVersionId = input.transcriptVersionId ?? randomUUID();
      this.db.run(`
        INSERT INTO transcript_versions
          (transcript_version_id, meeting_id, version_no, source_kind, engine, engine_model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [transcriptVersionId, meetingId, versionNo, input.sourceKind, input.engine ?? null,
        input.engineModel ?? null, Date.now()]);
      return { transcriptVersionId, versionNo };
    })();
  }

  addTranscriptVersionLines(transcriptVersionId: string, lines: TranscriptLineInput[]): void {
    this.db.transaction(() => {
      const version = this.db.query(
        "SELECT meeting_id, finalized_at FROM transcript_versions WHERE transcript_version_id = ?",
      ).get(transcriptVersionId) as { meeting_id: number; finalized_at: number | null } | null;
      if (!version) throw new Error(`unknown transcript version ${transcriptVersionId}`);
      if (version.finalized_at !== null) throw new Error(`transcript version ${transcriptVersionId} is finalized`);
      for (const line of lines) {
        this.db.run(`
          INSERT INTO transcript_version_lines
            (meeting_id, transcript_version_id, seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [version.meeting_id, transcriptVersionId, line.seq, line.capturedAtMs ?? null,
          line.audioStartMs ?? null, line.audioEndMs ?? null, line.speakerTurn ?? null,
          nonBlank(line.text, "transcript text")]);
      }
    })();
  }

  appendTranscriptLine(transcriptVersionId: string, line: Omit<TranscriptLineInput, "seq">, dualWriteLegacy: boolean): number {
    return this.db.transaction(() => {
      const version = this.db.query(
        "SELECT meeting_id, finalized_at FROM transcript_versions WHERE transcript_version_id = ?",
      ).get(transcriptVersionId) as { meeting_id: number; finalized_at: number | null } | null;
      if (!version) throw new Error(`unknown transcript version ${transcriptVersionId}`);
      if (version.finalized_at !== null) throw new Error(`transcript version ${transcriptVersionId} is finalized`);
      const latest = this.db.query(
        "SELECT coalesce(MAX(seq), 0) AS seq FROM transcript_version_lines WHERE transcript_version_id = ?",
      ).get(transcriptVersionId) as { seq: number };
      const seq = latest.seq + 1;
      const text = nonBlank(line.text, "transcript text");
      this.db.run(`
        INSERT INTO transcript_version_lines
          (meeting_id, transcript_version_id, seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [version.meeting_id, transcriptVersionId, seq, line.capturedAtMs ?? null,
        line.audioStartMs ?? null, line.audioEndMs ?? null, line.speakerTurn ?? null, text]);
      if (dualWriteLegacy) {
        this.db.run(
          "INSERT INTO transcript_lines (meeting_id, seq, ts, speaker, text) VALUES (?, ?, ?, ?, ?)",
          [version.meeting_id, seq, line.capturedAtMs ?? Date.now(), line.speakerTurn ?? null, text],
        );
      }
      return seq;
    })();
  }

  transcriptVersionLines(transcriptVersionId: string): Array<{
    seq: number; capturedAtMs: number | null; audioStartMs: number | null; audioEndMs: number | null;
    speakerTurn: number | null; text: string;
  }> {
    const rows = this.db.query(`
      SELECT seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text
      FROM transcript_version_lines WHERE transcript_version_id = ? ORDER BY seq
    `).all(transcriptVersionId) as Array<{
      seq: number; captured_at_ms: number | null; audio_start_ms: number | null;
      audio_end_ms: number | null; speaker_turn: number | null; text: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq, capturedAtMs: row.captured_at_ms, audioStartMs: row.audio_start_ms,
      audioEndMs: row.audio_end_ms, speakerTurn: row.speaker_turn, text: row.text,
    }));
  }

  finalizeTranscriptVersion(transcriptVersionId: string, contentSha256: string): void {
    const result = this.db.run(`
      UPDATE transcript_versions SET content_sha256 = ?, finalized_at = ?
      WHERE transcript_version_id = ? AND finalized_at IS NULL
    `, [validHash(contentSha256), Date.now(), transcriptVersionId]);
    if (Number(result.changes) !== 1) throw new Error(`unknown or finalized transcript version ${transcriptVersionId}`);
  }

  setCanonical(meetingId: number, transcriptVersionId: string): void {
    const version = this.db.query(`
      SELECT finalized_at FROM transcript_versions WHERE meeting_id = ? AND transcript_version_id = ?
    `).get(meetingId, transcriptVersionId) as { finalized_at: number | null } | null;
    if (!version?.finalized_at) throw new Error("canonical transcript version must be finalized");
    this.db.run(`
      INSERT INTO meeting_transcript_state (meeting_id, canonical_transcript_version_id, canonical_selected_at)
      VALUES (?, ?, ?)
      ON CONFLICT(meeting_id) DO UPDATE SET
        canonical_transcript_version_id = excluded.canonical_transcript_version_id,
        canonical_selected_at = excluded.canonical_selected_at
    `, [meetingId, transcriptVersionId, Date.now()]);
  }

  latestVersion(meetingId: number): ReturnType<MinutesStore["versionRow"]> {
    const row = this.db.query(`
      SELECT * FROM transcript_versions WHERE meeting_id = ? ORDER BY version_no DESC LIMIT 1
    `).get(meetingId) as Record<string, unknown> | null;
    return this.versionRow(row);
  }

  canonicalVersion(meetingId: number): ReturnType<MinutesStore["versionRow"]> {
    const row = this.db.query(`
      SELECT tv.* FROM meeting_transcript_state mts
      JOIN transcript_versions tv ON tv.transcript_version_id = mts.canonical_transcript_version_id
      WHERE mts.meeting_id = ?
    `).get(meetingId) as Record<string, unknown> | null;
    return this.versionRow(row);
  }

  private versionRow(row: Record<string, unknown> | null): {
    transcriptVersionId: string; meetingId: number; versionNo: number; sourceKind: TranscriptSourceKind;
    engine: string | null; engineModel: string | null; finalizedAt: number | null; contentSha256: string | null;
  } | null {
    if (!row) return null;
    return {
      transcriptVersionId: row.transcript_version_id as string, meetingId: row.meeting_id as number,
      versionNo: row.version_no as number, sourceKind: row.source_kind as TranscriptSourceKind,
      engine: row.engine as string | null, engineModel: row.engine_model as string | null,
      finalizedAt: row.finalized_at as number | null, contentSha256: row.content_sha256 as string | null,
    };
  }

  saveCandidates(input: SaveCandidatesInput): string {
    return this.db.transaction(() => {
      const reviewId = input.reviewId ?? randomUUID();
      const now = Date.now();
      this.db.run(`
        INSERT INTO meeting_reviews
          (review_id, meeting_id, transcript_version_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'draft', ?, ?)
      `, [reviewId, input.meetingId, input.transcriptVersionId, now, now]);

      for (const item of input.decisions ?? []) {
        this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, nonBlank(item.description, "description"),
          item.source.transcriptVersionId, item.source.startSeq, item.source.endSeq,
          item.attributedAttendeeId ?? null, item.origin ?? "manual", item.reviewState ?? "candidate", now, now]);
      }
      for (const item of input.actionItems ?? []) {
        this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO action_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, nonBlank(item.description, "description"),
          item.source.transcriptVersionId, item.source.startSeq, item.source.endSeq,
          item.assigneeAttendeeId ?? null, item.attributedAttendeeId ?? null, item.deadline ?? null,
          item.deadlineText ?? null, item.origin ?? "manual", item.reviewState ?? "candidate", now, now]);
      }
      for (const item of input.openItems ?? []) {
        this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO open_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, nonBlank(item.description, "description"),
          item.source.transcriptVersionId, item.source.startSeq, item.source.endSeq,
          item.attributedAttendeeId ?? null, item.origin ?? "manual", item.reviewState ?? "candidate", now, now]);
      }
      for (const item of input.referencedMaterials ?? []) {
        if (item.source) this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO referenced_materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, item.materialType, item.title ?? null,
          item.uri ?? null, item.notes ?? null, item.source?.transcriptVersionId ?? null,
          item.source?.startSeq ?? null, item.source?.endSeq ?? null, item.reviewState ?? "candidate", now, now]);
      }
      return reviewId;
    })();
  }

  itemsForReview(reviewId: string): Array<Record<string, unknown> & { kind: string; description: string }> {
    const specs = [
      ["decision", "decisions", "decision_id"],
      ["action_item", "action_items", "action_item_id"],
      ["open_item", "open_items", "open_item_id"],
    ] as const;
    return specs.flatMap(([kind, table, idColumn]) => {
      const rows = this.db.query(
        `SELECT * FROM ${table} WHERE review_id = ? ORDER BY created_at, ${idColumn}`,
      ).all(reviewId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        kind, id: row[idColumn], description: row.description as string,
        source: {
          transcriptVersionId: row.source_transcript_version_id,
          startSeq: row.source_start_seq,
          endSeq: row.source_end_seq,
        },
        reviewState: row.review_state,
        attributedAttendeeId: row.attributed_attendee_id,
        ...(kind === "action_item" ? {
          assigneeAttendeeId: row.assignee_attendee_id,
          deadline: row.deadline,
          deadlineText: row.deadline_text,
        } : {}),
      }));
    });
  }

  review(reviewId: string): {
    reviewId: string; meetingId: number; transcriptVersionId: string; status: "draft" | "confirmed";
    confirmedAt: number | null; confirmedBy: string | null;
  } | null {
    const row = this.db.query("SELECT * FROM meeting_reviews WHERE review_id = ?").get(reviewId) as
      Record<string, unknown> | null;
    return row && {
      reviewId: row.review_id as string, meetingId: row.meeting_id as number,
      transcriptVersionId: row.transcript_version_id as string, status: row.status as "draft" | "confirmed",
      confirmedAt: row.confirmed_at as number | null, confirmedBy: row.confirmed_by as string | null,
    };
  }

  updateItem(reviewId: string, kind: "decision" | "action_item" | "open_item", itemId: string, patch: {
    description?: string; assigneeAttendeeId?: string | null; attributedAttendeeId?: string | null;
    deadline?: string | null; deadlineText?: string | null; reviewState?: ReviewState;
  }): void {
    this.db.transaction(() => {
      const review = this.draftReview(reviewId);
      this.validateCanonicalReview(review);
      const config = {
        decision: ["decisions", "decision_id"], action_item: ["action_items", "action_item_id"],
        open_item: ["open_items", "open_item_id"],
      } as const;
      const [table, idColumn] = config[kind];
      const item = this.db.query(
        `SELECT * FROM ${table} WHERE review_id = ? AND ${idColumn} = ?`,
      ).get(reviewId, itemId) as Record<string, unknown> | null;
      if (!item) throw reviewError("UNKNOWN_REVIEW_ITEM", `${kind} ${itemId} does not belong to review ${reviewId}`);
      this.validateSource(review.meeting_id, review.transcript_version_id, {
        transcriptVersionId: item.source_transcript_version_id as string,
        startSeq: item.source_start_seq as number,
        endSeq: item.source_end_seq as number,
      });
      if (kind !== "action_item" && (patch.assigneeAttendeeId !== undefined || patch.deadline !== undefined ||
          patch.deadlineText !== undefined)) {
        throw reviewError("INVALID_REVIEW_PATCH", `${kind} does not accept action-item fields`);
      }
      for (const attendeeId of [patch.assigneeAttendeeId, patch.attributedAttendeeId]) {
        if (attendeeId !== undefined && attendeeId !== null) this.validateAttendee(review.meeting_id, attendeeId);
      }

      const columns: string[] = [];
      const values: SQLQueryBindings[] = [];
      const add = (column: string, value: SQLQueryBindings): void => { columns.push(`${column} = ?`); values.push(value); };
      if (patch.description !== undefined) add("description", nonBlank(patch.description, "description"));
      if (patch.attributedAttendeeId !== undefined) add("attributed_attendee_id", patch.attributedAttendeeId);
      if (kind === "action_item") {
        if (patch.assigneeAttendeeId !== undefined) add("assignee_attendee_id", patch.assigneeAttendeeId);
        if (patch.deadline !== undefined) add("deadline", patch.deadline);
        if (patch.deadlineText !== undefined) add("deadline_text", patch.deadlineText);
      }
      if (patch.reviewState !== undefined) add("review_state", patch.reviewState);
      if (!columns.length) throw reviewError("INVALID_REVIEW_PATCH", "patch must change at least one supported field");

      const nextState = patch.reviewState ?? item.review_state;
      if (nextState === "confirmed") {
        const attributed = patch.attributedAttendeeId !== undefined ? patch.attributedAttendeeId : item.attributed_attendee_id;
        const assignee = patch.assigneeAttendeeId !== undefined ? patch.assigneeAttendeeId : item.assignee_attendee_id;
        const deadline = patch.deadline !== undefined ? patch.deadline : item.deadline;
        if (attributed === null || attributed === undefined ||
            (kind === "action_item" && (assignee === null || assignee === undefined || deadline === null || deadline === undefined))) {
          throw reviewError("INCOMPLETE_REVIEW_ITEM", `confirmed ${kind} ${itemId} is missing required attendee or deadline fields`);
        }
      }
      add("updated_at", Date.now());
      values.push(reviewId, itemId);
      this.db.run(`UPDATE ${table} SET ${columns.join(", ")} WHERE review_id = ? AND ${idColumn} = ?`, values);
    })();
  }

  confirmReview(reviewId: string, confirmedBy: string | null = null): void {
    this.db.transaction(() => {
      const review = this.draftReview(reviewId);
      this.validateCanonicalReview(review);
      for (const table of ["decisions", "action_items", "open_items", "referenced_materials"] as const) {
        const pending = this.db.query(
          `SELECT COUNT(*) AS count FROM ${table} WHERE review_id = ? AND review_state = 'candidate'`,
        ).get(reviewId) as { count: number };
        if (pending.count > 0) {
          throw reviewError("PENDING_REVIEW_ITEMS", "all review items must be confirmed or rejected");
        }
        const sourced = this.db.query(`
          SELECT source_transcript_version_id, source_start_seq, source_end_seq FROM ${table}
          WHERE review_id = ? AND review_state = 'confirmed' AND source_transcript_version_id IS NOT NULL
        `).all(reviewId) as Array<{
          source_transcript_version_id: string; source_start_seq: number; source_end_seq: number;
        }>;
        for (const source of sourced) this.validateSource(review.meeting_id, review.transcript_version_id, {
          transcriptVersionId: source.source_transcript_version_id,
          startSeq: source.source_start_seq,
          endSeq: source.source_end_seq,
        });
      }
      const now = Date.now();
      this.db.run(`
        UPDATE meeting_reviews SET status = 'confirmed', updated_at = ?, confirmed_at = ?, confirmed_by = ?
        WHERE review_id = ?
      `, [now, now, confirmedBy, reviewId]);
    })();
  }

  private draftReview(reviewId: string): {
    meeting_id: number; transcript_version_id: string; status: string;
  } {
    const review = this.db.query(
      "SELECT meeting_id, transcript_version_id, status FROM meeting_reviews WHERE review_id = ?",
    ).get(reviewId) as { meeting_id: number; transcript_version_id: string; status: string } | null;
    if (!review || review.status !== "draft") {
      throw reviewError("REVIEW_NOT_DRAFT", `review ${reviewId} is missing or not draft`);
    }
    return review;
  }

  private validateAttendee(meetingId: number, attendeeId: string): void {
    if (!attendeeId.trim() || !this.db.query(
      "SELECT 1 FROM attendees WHERE meeting_id = ? AND attendee_id = ?",
    ).get(meetingId, attendeeId)) {
      throw reviewError("ATTENDEE_NOT_IN_MEETING", `attendee ${attendeeId || "<blank>"} is not registered for meeting ${meetingId}`);
    }
  }

  private validateCanonicalReview(review: { meeting_id: number; transcript_version_id: string }): void {
    const canonical = this.db.query(`
      SELECT tv.transcript_version_id, tv.content_sha256, tv.finalized_at
      FROM meeting_transcript_state mts
      JOIN transcript_versions tv ON tv.transcript_version_id = mts.canonical_transcript_version_id
      WHERE mts.meeting_id = ?
    `).get(review.meeting_id) as {
      transcript_version_id: string; content_sha256: string | null; finalized_at: number | null;
    } | null;
    if (!canonical || canonical.transcript_version_id !== review.transcript_version_id) {
      throw reviewError("STALE_TRANSCRIPT_VERSION", `review transcript ${review.transcript_version_id} is not canonical`);
    }
    if (canonical.finalized_at === null || canonical.content_sha256 === null) {
      throw reviewError("TRANSCRIPT_INTEGRITY_FAILED", `canonical transcript ${canonical.transcript_version_id} is not finalized`);
    }
    const lines = this.db.query(`
      SELECT seq, captured_at_ms, audio_start_ms, audio_end_ms, speaker_turn, text
      FROM transcript_version_lines WHERE meeting_id = ? AND transcript_version_id = ? ORDER BY seq
    `).all(review.meeting_id, review.transcript_version_id) as Array<{
      seq: number; captured_at_ms: number | null; audio_start_ms: number | null;
      audio_end_ms: number | null; speaker_turn: number | null; text: string;
    }>;
    const hash = createHash("sha256");
    for (const line of lines) {
      hash.update(canonicalLineJson(line));
      hash.update("\n");
    }
    if (hash.digest("hex") !== canonical.content_sha256) {
      throw reviewError("TRANSCRIPT_INTEGRITY_FAILED", `canonical transcript ${canonical.transcript_version_id} content hash changed`);
    }
  }

  addAudioSource(meetingId: number, input: {
    originalAudioSha256: string; originalAudioPath?: string | null; byteLength?: number | null;
  }): void {
    this.db.run(`
      INSERT INTO meeting_audio_sources
        (meeting_id, original_audio_sha256, original_audio_path, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [meetingId, validHash(input.originalAudioSha256), input.originalAudioPath ?? null,
      input.byteLength ?? null, Date.now()]);
  }

  findMeetingByAudioHash(originalAudioSha256: string): number | null {
    const row = this.db.query(
      "SELECT meeting_id FROM meeting_audio_sources WHERE original_audio_sha256 = ?",
    ).get(validHash(originalAudioSha256)) as { meeting_id: number } | null;
    return row?.meeting_id ?? null;
  }

  private validateSource(meetingId: number, reviewTranscriptVersionId: string, source: SourceRange): void {
    if (!source || source.transcriptVersionId !== reviewTranscriptVersionId) {
      throw reviewError("INVALID_SOURCE_SEGMENT", "source transcript version must match the review transcript version");
    }
    if (!Number.isInteger(source.startSeq) || !Number.isInteger(source.endSeq) ||
        source.startSeq < 1 || source.endSeq < source.startSeq) {
      throw reviewError("INVALID_SOURCE_SEGMENT", "source range must contain positive ordered integer seq values");
    }
    const summary = this.db.query(`
      SELECT COUNT(*) AS count,
        (SELECT MAX(seq) FROM transcript_version_lines WHERE meeting_id = ? AND transcript_version_id = ?) AS max_seq
      FROM transcript_version_lines
      WHERE meeting_id = ? AND transcript_version_id = ? AND seq BETWEEN ? AND ?
    `).get(meetingId, source.transcriptVersionId, meetingId, source.transcriptVersionId,
      source.startSeq, source.endSeq) as { count: number; max_seq: number | null };
    const expected = source.endSeq - source.startSeq + 1;
    if (summary.max_seq === null || source.endSeq > summary.max_seq || summary.count !== expected) {
      throw reviewError("INVALID_SOURCE_SEGMENT", "source range must be within the transcript and contain every contiguous seq");
    }
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}
