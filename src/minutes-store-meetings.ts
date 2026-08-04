import { Database } from "bun:sqlite";
import { MINUTES_SCHEMA } from "./minutes-store-schema.ts";
import type { AttendeeInput } from "./minutes-store-types.ts";
import { nonBlank, validHash } from "./minutes-store-utils.ts";

export class MeetingStore {
  protected readonly db: Database;
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
    this.db.run(MINUTES_SCHEMA);
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

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }
}
