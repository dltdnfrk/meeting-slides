import type { SQLQueryBindings } from "bun:sqlite";
import { ReviewPersistenceStore } from "./minutes-store-review-persistence.ts";
import type { ReviewState } from "./minutes-store-types.ts";
import { nonBlank, reviewError, transcriptLinesHash } from "./minutes-store-utils.ts";

export class ReviewMutationStore extends ReviewPersistenceStore {
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
        const attendeeColumns = table === "action_items"
          ? "attributed_attendee_id, assignee_attendee_id"
          : table === "decisions" || table === "open_items"
            ? "attributed_attendee_id, NULL AS assignee_attendee_id"
            : "NULL AS attributed_attendee_id, NULL AS assignee_attendee_id";
        const confirmed = this.db.query(`
          SELECT source_transcript_version_id, source_start_seq, source_end_seq, ${attendeeColumns}
          FROM ${table} WHERE review_id = ? AND review_state = 'confirmed'
        `).all(reviewId) as Array<{
          source_transcript_version_id: string | null; source_start_seq: number | null; source_end_seq: number | null;
          attributed_attendee_id: string | null; assignee_attendee_id: string | null;
        }>;
        for (const item of confirmed) {
          if (item.source_transcript_version_id !== null) this.validateSource(review.meeting_id, review.transcript_version_id, {
            transcriptVersionId: item.source_transcript_version_id,
            startSeq: item.source_start_seq!,
            endSeq: item.source_end_seq!,
          });
          for (const attendeeId of [item.attributed_attendee_id, item.assignee_attendee_id]) {
            if (attendeeId !== null) this.validateAttendee(review.meeting_id, attendeeId);
          }
        }
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
    if (transcriptLinesHash(lines) !== canonical.content_sha256) {
      throw reviewError("TRANSCRIPT_INTEGRITY_FAILED", `canonical transcript ${canonical.transcript_version_id} content hash changed`);
    }
  }

}
