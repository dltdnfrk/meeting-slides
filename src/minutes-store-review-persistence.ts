import { randomUUID } from "node:crypto";
import { TranscriptStore } from "./minutes-store-transcripts.ts";
import type { ReviewSummary, SaveCandidatesInput, SourceRange } from "./minutes-store-types.ts";
import { nonBlank, reviewError } from "./minutes-store-utils.ts";

export class ReviewPersistenceStore extends TranscriptStore {
  private evidenceQuote(meetingId: number, source: SourceRange, supplied?: string): string {
    if (supplied?.trim()) return supplied.trim();
    const rows = this.db.query(`
      SELECT text FROM transcript_version_lines
      WHERE meeting_id = ? AND transcript_version_id = ? AND seq BETWEEN ? AND ? ORDER BY seq
    `).all(meetingId, source.transcriptVersionId, source.startSeq, source.endSeq) as Array<{ text: string }>;
    return nonBlank(rows.map((row) => row.text).join("\n"), "evidenceQuote");
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
          INSERT INTO decisions
            (decision_id, meeting_id, review_id, description, evidence_quote,
             source_transcript_version_id, source_start_seq, source_end_seq,
             attributed_attendee_id, origin, review_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, nonBlank(item.description, "description"),
          this.evidenceQuote(input.meetingId, item.source, item.evidenceQuote),
          item.source.transcriptVersionId, item.source.startSeq, item.source.endSeq,
          item.attributedAttendeeId ?? null, item.origin ?? "manual", item.reviewState ?? "candidate", now, now]);
      }
      for (const item of input.actionItems ?? []) {
        this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO action_items
            (action_item_id, meeting_id, review_id, description, evidence_quote,
             source_transcript_version_id, source_start_seq, source_end_seq,
             assignee_attendee_id, attributed_attendee_id, deadline, deadline_text,
             origin, review_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, nonBlank(item.description, "description"),
          this.evidenceQuote(input.meetingId, item.source, item.evidenceQuote),
          item.source.transcriptVersionId, item.source.startSeq, item.source.endSeq,
          item.assigneeAttendeeId ?? null, item.attributedAttendeeId ?? null, item.deadline ?? null,
          item.deadlineText ?? null, item.origin ?? "manual", item.reviewState ?? "candidate", now, now]);
      }
      for (const item of input.openItems ?? []) {
        this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO open_items
            (open_item_id, meeting_id, review_id, description, evidence_quote,
             source_transcript_version_id, source_start_seq, source_end_seq,
             attributed_attendee_id, origin, review_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, nonBlank(item.description, "description"),
          this.evidenceQuote(input.meetingId, item.source, item.evidenceQuote),
          item.source.transcriptVersionId, item.source.startSeq, item.source.endSeq,
          item.attributedAttendeeId ?? null, item.origin ?? "manual", item.reviewState ?? "candidate", now, now]);
      }
      for (const item of input.referencedMaterials ?? []) {
        if (item.source) this.validateSource(input.meetingId, input.transcriptVersionId, item.source);
        this.db.run(`
          INSERT INTO referenced_materials
            (material_id, meeting_id, review_id, material_type, title, uri, notes,
             source_transcript_version_id, source_start_seq, source_end_seq,
             review_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [item.id ?? randomUUID(), input.meetingId, reviewId, item.materialType, item.title ?? null,
          item.uri ?? null, item.notes ?? null, item.source?.transcriptVersionId ?? null,
          item.source?.startSeq ?? null, item.source?.endSeq ?? null, item.reviewState ?? "candidate", now, now]);
      }
      if (input.summary) {
        for (const topic of input.summary.topics) {
          this.validateSource(input.meetingId, input.transcriptVersionId, {
            transcriptVersionId: topic.source.transcript_version_id,
            startSeq: topic.source.start_seq,
            endSeq: topic.source.end_seq,
          });
        }
        this.db.run(`
          INSERT INTO review_summaries (review_id, overview, topics_json, created_at)
          VALUES (?, ?, ?, ?)
        `, [reviewId, input.summary.overview, JSON.stringify(input.summary.topics), now]);
      }
      return reviewId;
    })();
  }

  replaceDraft(input: SaveCandidatesInput): string {
    return this.db.transaction(() => {
      const existing = this.reviewForMeeting(input.meetingId, input.transcriptVersionId);
      if (existing?.status === "confirmed") {
        throw reviewError("REVIEW_NOT_DRAFT", `review ${existing.reviewId} is missing or not draft`);
      }
      if (existing !== null) {
        this.db.run(
          "DELETE FROM meeting_reviews WHERE review_id = ? AND status = 'draft'",
          [existing.reviewId],
        );
      }
      return this.saveCandidates({
        ...input,
        reviewId: existing?.reviewId ?? input.reviewId,
      });
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
        evidenceQuote: row.evidence_quote as string,
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
    confirmedAt: number | null; confirmedBy: string | null; summary: ReviewSummary | null;
  } | null {
    const row = this.db.query("SELECT * FROM meeting_reviews WHERE review_id = ?").get(reviewId) as
      Record<string, unknown> | null;
    return row && {
      reviewId: row.review_id as string, meetingId: row.meeting_id as number,
      transcriptVersionId: row.transcript_version_id as string, status: row.status as "draft" | "confirmed",
      confirmedAt: row.confirmed_at as number | null, confirmedBy: row.confirmed_by as string | null,
      summary: this.summaryFor(reviewId),
    };
  }

  private summaryFor(reviewId: string): ReviewSummary | null {
    const row = this.db.query(
      "SELECT overview, topics_json FROM review_summaries WHERE review_id = ?",
    ).get(reviewId) as { overview: string; topics_json: string } | null;
    if (!row) return null;
    const topics: unknown = JSON.parse(row.topics_json);
    return { overview: row.overview, topics: Array.isArray(topics) ? topics as ReviewSummary["topics"] : [] };
  }

  reviewForMeeting(meetingId: number, transcriptVersionId?: string): ReturnType<ReviewPersistenceStore["review"]> {
    const row = (transcriptVersionId === undefined
      ? this.db.query(`SELECT review_id FROM meeting_reviews WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1`).get(meetingId)
      : this.db.query(`SELECT review_id FROM meeting_reviews WHERE meeting_id = ? AND transcript_version_id = ? ORDER BY created_at DESC LIMIT 1`).get(meetingId, transcriptVersionId)) as
      { review_id: string } | null;
    return row ? this.review(row.review_id) : null;
  }

  protected validateSource(meetingId: number, reviewTranscriptVersionId: string, source: SourceRange): void {
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
}
