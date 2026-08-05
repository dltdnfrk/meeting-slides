import type { Database } from "bun:sqlite";

export function deleteMeetingHistory(database: Database, meetingId: number): boolean {
  return database.transaction(() => {
    const existing = database.query("SELECT 1 FROM meetings WHERE id = ?").get(meetingId);
    if (existing === null) return false;

    database.run("DELETE FROM meeting_conclusions WHERE meeting_id = ?", [meetingId]);
    database.run(
      "DELETE FROM artifacts WHERE bundle_id IN (SELECT bundle_id FROM artifact_bundles WHERE meeting_id = ?)",
      [meetingId],
    );
    database.run("DELETE FROM artifact_bundles WHERE meeting_id = ?", [meetingId]);
    for (const table of ["decisions", "action_items", "open_items", "referenced_materials"]) {
      database.run(`DELETE FROM ${table} WHERE meeting_id = ?`, [meetingId]);
    }
    database.run("DELETE FROM meeting_reviews WHERE meeting_id = ?", [meetingId]);
    database.run("DELETE FROM meeting_transcript_state WHERE meeting_id = ?", [meetingId]);
    database.run("DELETE FROM transcript_line_attributions WHERE meeting_id = ?", [meetingId]);
    database.run("DELETE FROM transcript_version_lines WHERE meeting_id = ?", [meetingId]);
    database.run("DELETE FROM transcript_versions WHERE meeting_id = ?", [meetingId]);
    for (const table of [
      "meeting_audio_sources",
      "attendees",
      "meeting_meta",
      "deck_slide_specs",
      "deck_outlines",
      "slides",
      "transcript_lines",
    ]) {
      database.run(`DELETE FROM ${table} WHERE meeting_id = ?`, [meetingId]);
    }
    const result = database.run("DELETE FROM meetings WHERE id = ?", [meetingId]);
    return Number(result.changes) === 1;
  })();
}
