import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { exportBundle, type ExportBundleResult } from "../src/bundle.ts";
import { concludeMeeting } from "../src/conclusion.ts";
import { MinutesStore } from "../src/minutes-store.ts";
import { MeetingStore } from "../src/store.ts";
import { transcriptContentSha256 } from "../src/transcript-versioning.ts";

const root = join(import.meta.dir, "..");
const targetCommit = "0123456789abcdef0123456789abcdef01234567";
const fakePdf = new TextEncoder().encode("%PDF-1.7\nT14 deterministic PDF\n%%EOF\n");
const temporaryRoots: string[] = [];

type Fixture = ReturnType<typeof fixture>;

function fixture(reviewState: "confirmed" | "candidate" = "confirmed") {
  const directory = mkdtempSync(join(tmpdir(), "meeting-conclusion-t14-"));
  temporaryRoots.push(directory);
  const legacy = new MeetingStore(join(directory, "meetings.db"));
  const store = new MinutesStore(legacy.databaseHandle());
  const meetingId = legacy.startMeeting("cli:test");
  store.registerCapturingMeeting(meetingId);
  store.endMeeting(meetingId);
  store.addAttendees(meetingId, [{ attendeeId: "alice", displayName: "Alice" }]);
  const version = store.addTranscriptVersion(meetingId, {
    transcriptVersionId: "conclusion-v1",
    sourceKind: "import",
  });
  store.addTranscriptVersionLines(version.transcriptVersionId, [
    { seq: 1, capturedAtMs: 1000, text: "Alice will publish by 2026-08-07." },
  ]);
  store.finalizeTranscriptVersion(
    version.transcriptVersionId,
    transcriptContentSha256(store, version.transcriptVersionId),
  );
  store.setCanonical(meetingId, version.transcriptVersionId);
  legacy.addSlide({ idx: 1, title: "Publish", bullets: ["Publish the bundle"], startedAt: 1000 });
  const reviewId = store.saveCandidates({
    meetingId,
    transcriptVersionId: version.transcriptVersionId,
    reviewId: "conclusion-review-v1",
    actionItems: [{
      id: "action-1",
      description: "Publish",
      source: { transcriptVersionId: version.transcriptVersionId, startSeq: 1, endSeq: 1 },
      assigneeAttendeeId: reviewState === "confirmed" ? "alice" : null,
      attributedAttendeeId: reviewState === "confirmed" ? "alice" : null,
      deadline: reviewState === "confirmed" ? "2026-08-07" : null,
      reviewState,
    }],
  });
  return { directory, outputRoot: join(directory, "exports"), legacy, store, meetingId, reviewId, version };
}

function options(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    store: fx.store,
    outputRoot: fx.outputRoot,
    projectRoot: root,
    targetCommit,
    renderPdf: async () => fakePdf,
    ...overrides,
  };
}

function counts(store: MinutesStore) {
  const db = store.databaseHandle();
  return {
    reviews: db.query("SELECT status, confirmed_at FROM meeting_reviews").all(),
    bundles: db.query("SELECT COUNT(*) count FROM artifact_bundles").get(),
    artifacts: db.query("SELECT COUNT(*) count FROM artifacts").get(),
    conclusions: db.query("SELECT COUNT(*) count FROM meeting_conclusions").get(),
  };
}

function outputNames(fx: Fixture): string[] {
  return existsSync(fx.outputRoot) ? readdirSync(fx.outputRoot).sort() : [];
}

function waitFor<T>(subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    subscribe((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, fragment: string): Promise<void> {
  return waitFor<void>((resolve, reject) => {
    let output = "";
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(fragment)) {
        child.stdout.off("data", receive);
        child.stderr.off("data", receive);
        resolve();
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited before ready (${code}): ${output}`)));
  });
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("meeting-conclusion transaction", () => {
  test("confirmReview publishes a complete version-linked manifest and only then closes the meeting", async () => {
    const fx = fixture();
    const result = await concludeMeeting(fx.reviewId, options(fx));
    const manifestBytes = readFileSync(join(result.bundlePath, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ExportBundleResult["manifest"];

    expect(result).toMatchObject({
      type: "meetingConcluded", concluded: true, meetingId: fx.meetingId, reviewId: fx.reviewId,
      transcriptVersionId: fx.version.transcriptVersionId,
      manifest: { targetCommit, sha256: createHash("sha256").update(manifestBytes).digest("hex") },
    });
    expect(manifest.entries.some((entry) => entry.path === "minutes.pdf")).toBe(true);
    expect(manifest.entries.some((entry) => entry.path === "minutes.json")).toBe(true);
    expect(manifest.entries.some((entry) => entry.path === "transcript.v1.jsonl")).toBe(true);
    expect(manifest.entries.some((entry) => entry.path === "deck/index.html")).toBe(true);
    expect(manifest.entries.every((entry) => entry.version.transcript_version_id === fx.version.transcriptVersionId)).toBe(true);
    expect(fx.store.review(fx.reviewId)?.status).toBe("confirmed");
    expect(counts(fx.store)).toMatchObject({ bundles: { count: 1 }, artifacts: { count: 4 }, conclusions: { count: 1 } });
    fx.legacy.close();
  });

  test("rejects unresolved, invalid-source, and stale-version reviews before exporting", async () => {
    const pending = fixture("candidate");
    let calls = 0;
    const never = async (..._args: Parameters<typeof exportBundle>): Promise<ExportBundleResult> => {
      calls++;
      throw new Error("export must not run");
    };
    await expect(concludeMeeting(pending.reviewId, options(pending, { exporter: never }))).rejects.toThrow("[PENDING_REVIEW_ITEMS]");
    expect(pending.store.review(pending.reviewId)?.status).toBe("draft");
    pending.legacy.close();

    const invalid = fixture();
    const invalidDb = invalid.store.databaseHandle();
    invalidDb.run("PRAGMA foreign_keys = OFF");
    invalidDb.run("UPDATE action_items SET source_end_seq = 2 WHERE review_id = ?", [invalid.reviewId]);
    invalidDb.run("PRAGMA foreign_keys = ON");
    await expect(concludeMeeting(invalid.reviewId, options(invalid, { exporter: never }))).rejects.toThrow("[INVALID_SOURCE_SEGMENT]");
    expect(invalid.store.review(invalid.reviewId)?.status).toBe("draft");
    invalid.legacy.close();

    const stale = fixture();
    const v2 = stale.store.addTranscriptVersion(stale.meetingId, { transcriptVersionId: "conclusion-v2", sourceKind: "retranscription" });
    stale.store.addTranscriptVersionLines(v2.transcriptVersionId, [{ seq: 1, text: "Replacement canonical text." }]);
    stale.store.finalizeTranscriptVersion(v2.transcriptVersionId, transcriptContentSha256(stale.store, v2.transcriptVersionId));
    stale.store.setCanonical(stale.meetingId, v2.transcriptVersionId);
    await expect(concludeMeeting(stale.reviewId, options(stale, { exporter: never }))).rejects.toThrow("[STALE_TRANSCRIPT_VERSION]");
    expect(stale.store.review(stale.reviewId)?.status).toBe("draft");
    expect(calls).toBe(0);
    stale.legacy.close();
  });

  test("PDF failure rolls back review, complete rows, conclusion, and all artifacts, and retry succeeds", async () => {
    const fx = fixture();
    await expect(concludeMeeting(fx.reviewId, options(fx, {
      renderPdf: async () => { throw new Error("[PDF_RENDER_FAILED] induced"); },
    }))).rejects.toThrow("[PDF_RENDER_FAILED]");
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");
    expect(counts(fx.store)).toMatchObject({ bundles: { count: 0 }, artifacts: { count: 0 }, conclusions: { count: 0 } });
    expect(outputNames(fx)).toEqual([]);

    const retried = await concludeMeeting(fx.reviewId, options(fx));
    expect(retried.concluded).toBe(true);
    expect(outputNames(fx)).toEqual([basename(retried.bundlePath)]);
    fx.legacy.close();
  });

  test("post-export hash failure rolls back and removes the atomically published bundle", async () => {
    const fx = fixture();
    const corruptingExporter = async (...args: Parameters<typeof exportBundle>) => {
      const result = await exportBundle(...args);
      writeFileSync(join(result.bundlePath, "minutes.pdf"), "%PDF-corrupted-after-export");
      return result;
    };
    await expect(concludeMeeting(fx.reviewId, options(fx, { exporter: corruptingExporter }))).rejects.toThrow("[BUNDLE_HASH_MISMATCH]");
    expect(fx.store.review(fx.reviewId)?.status).toBe("draft");
    expect(counts(fx.store)).toMatchObject({ bundles: { count: 0 }, artifacts: { count: 0 }, conclusions: { count: 0 } });
    expect(outputNames(fx)).toEqual([]);
    fx.legacy.close();
  });

  test("repeated and concurrent conclusion shares one export and never duplicates bundle state", async () => {
    const fx = fixture();
    let calls = 0;
    const exporter = async (...args: Parameters<typeof exportBundle>) => {
      calls++;
      return exportBundle(...args);
    };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => concludeMeeting(fx.reviewId, options(fx, { exporter }))));
    const repeated = await concludeMeeting(fx.reviewId, options(fx, { exporter }));
    expect(concurrent.every((value) => JSON.stringify(value) === JSON.stringify(concurrent[0]))).toBe(true);
    expect(repeated).toEqual(concurrent[0]);
    expect(calls).toBe(1);
    expect(counts(fx.store)).toMatchObject({ bundles: { count: 1 }, artifacts: { count: 4 }, conclusions: { count: 1 } });
    expect(outputNames(fx)).toHaveLength(1);
    fx.legacy.close();
  });

  test("real WS confirmReview reaches SQLite, bundle publication, and MeetingConcluded", async () => {
    const fx = fixture();
    fx.legacy.close();
    const fakeCli = join(fx.directory, "fake-cli");
    const fakeWhisper = join(fx.directory, "fake-whisper");
    writeFileSync(fakeCli, "#!/bin/sh\necho fake-cli-1.0\n");
    writeFileSync(fakeWhisper, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do read line || sleep 1; done\n");
    chmodSync(fakeCli, 0o755);
    chmodSync(fakeWhisper, 0o755);
    const port = 21_000 + (process.pid % 1000);
    const child = spawn(process.execPath, ["server.ts"], {
      cwd: root,
      env: {
        ...process.env,
        MEETINGS_DB_PATH: join(fx.directory, "meetings.db"),
        MEETING_BUNDLE_OUTPUT_ROOT: fx.outputRoot,
        MEETING_BUNDLE_TARGET_COMMIT: targetCommit,
        HTTP_PORT: String(port), OPEN_BROWSER: "false",
        LLM_PROVIDER: "cli", LLM_CLI_BIN: fakeCli, LLM_CLI_PRESET: "claude",
        WHISPER_INPUT_MODE: "mic", WHISPER_STREAM_BIN: fakeWhisper,
        WHISPER_MODEL_PATH: join(fx.directory, "model.bin"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForOutput(child, `HTTP: http://localhost:${port}`);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await waitFor<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
      });
      const concluded = waitFor<Record<string, unknown>>((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "meetingConcluded") resolve(message);
          if (message.type === "status" && String(message.text).includes("[")) reject(new Error(String(message.text)));
        });
      }, 30_000);
      socket.send(JSON.stringify({ action: "confirmReview", reviewId: fx.reviewId }));
      expect(await concluded).toMatchObject({ type: "meetingConcluded", concluded: true, reviewId: fx.reviewId });
      socket.close();

      const db = new Database(join(fx.directory, "meetings.db"), { readonly: true });
      expect(db.query("SELECT status FROM meeting_reviews WHERE review_id = ?").get(fx.reviewId)).toEqual({ status: "confirmed" });
      expect(db.query("SELECT COUNT(*) count FROM meeting_conclusions").get()).toEqual({ count: 1 });
      expect(db.query("SELECT COUNT(*) count FROM artifact_bundles WHERE status = 'complete'").get()).toEqual({ count: 1 });
      expect(db.query("SELECT COUNT(*) count FROM artifacts").get()).toEqual({ count: 4 });
      db.close();
      expect(outputNames(fx)).toHaveLength(1);
    } finally {
      if (child.exitCode === null) {
        const exited = waitFor<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 40_000);
});
