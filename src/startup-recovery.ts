import { MinutesStore } from "./minutes-store.ts";
import { snapshotLegacyTranscript, transcriptContentSha256 } from "./transcript-versioning.ts";

/** Finalize durable transcript truth before converting crash-left `open` meetings to ended. */
export function reconcileInterruptedMeetings(store: MinutesStore, endedAt = Date.now()): number[] {
  const db = store.databaseHandle();
  const recover = db.transaction(() => {
    const rows = db.query("SELECT id FROM meetings WHERE ended_at IS NULL ORDER BY id").all() as Array<{ id: number }>;
    for (const { id } of rows) {
      const latest = store.latestVersion(id);
      if (!latest) {
        snapshotLegacyTranscript(store, id);
      } else {
        if (latest.finalizedAt === null) {
          store.finalizeTranscriptVersion(latest.transcriptVersionId, transcriptContentSha256(store, latest.transcriptVersionId));
        }
        store.setCanonical(id, latest.transcriptVersionId);
      }
      db.run("UPDATE meetings SET ended_at = ? WHERE id = ? AND ended_at IS NULL", [endedAt, id]);
    }
    return rows.map(({ id }) => id);
  });
  return recover.immediate();
}
