// allow: SIZE_OK — Todo 3 must reuse this production-publisher integration fixture; adding another test file is out of scope.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ChatTransport } from "../../src/llm.ts";
import { deleteMeetingHistory } from "../../src/meeting-deletion.ts";
import { MinutesStore } from "../../src/minutes-store.ts";
import { SlidePlanFinalityError } from "../../src/slide-plan-finality.ts";
import { SlidePlanStore } from "../../src/slide-plan-store.ts";
import type { CompileJobId, CompileUpdate } from "../../src/session.ts";
import { MeetingStore } from "../../src/store.ts";
import { parseSlidePlan } from "../../src/slides/model/plan-parser.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import {
  deleteMeetingForJobState,
  runSlidePlanServerAction,
  type RunSlidePlanServerActionInput,
  type SlidePlanTranscriptInput,
} from "../../src/slides/server-action.ts";

const FONT = resolve(import.meta.dir, "../../public/fonts/pretendard-variable.woff2");
const BROWSERS = resolve(import.meta.dir, "../../vendor/ms-playwright");
const SLIDES_GRAB = resolve(import.meta.dir, "../../node_modules/.bin/slides-grab");
const SANDBOX = "(version 1)(allow default)(deny network*)";
const lines = [{ seq: 1, speaker: "Mina", text: "The beta launches Friday and Mina owns the release notes." }] as const;
const CONFIRMED_AT = 1_787_048_400_000;
const confirmedReview = Object.defineProperty({ reviewId: "review-v41", transcriptVersionId: "final-v41", items: [{ id: "claim-launch", kind: "decision", description: "The beta launches Friday.", source: { transcriptVersionId: "final-v41", startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }, reviewState: "confirmed" }] } as const, "confirmedAt", { value: CONFIRMED_AT });
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const compileUpdateCode = (update: CompileUpdate): "stale-review-lineage" | undefined => update.code;
let roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function snapshotFromPrompt(prompt: string): { transcriptVersionId: string } {
  const match = prompt.match(/<transcript-snapshot>([^<]+)<\/transcript-snapshot>/);
  if (match === null) throw new Error("missing transcript snapshot");
  return JSON.parse(match[1]!) as { transcriptVersionId: string };
}

function modelOutput(transcriptVersionId: string, withMissingAsset = false, revision = 0): string {
  const bind = ["claim-launch"];
  const base = (id: string, layout: string, title: string) => ({ id, layout, storyRole: "argument", title, editorialPaths: [], assetIds: [] });
  const claim = { id: "claim-launch", kind: "decision", text: "The beta launches Friday.", sources: [{ transcriptVersionId, startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }], method: "reviewed" };
  const missingHash = "b".repeat(64);
  const asset = { id: "asset-proof", purpose: "informative", kind: "image", localPath: `assets/${missingHash}.png`, mediaType: "image/png", width: 320, height: 180, byteLength: 99, sha256: missingHash, altDescription: "Launch proof", source: { kind: "local", originalPath: "missing.png" }, claimIds: bind };
  const slides = [
    { ...base("opening", "hero", "The beta launches Friday"), storyRole: "opening", payload: { variant: "cover", statement: "Friday launch" }, bindings: { title: bind, statement: bind }, assetIds: withMissingAsset ? [asset.id] : [] },
    { ...base("slide-summary", "summary", "The launch has a clear owner"), payload: { mode: "overview", items: ["Mina owns release notes"] }, bindings: { title: bind, "items[0]": bind } },
    { ...base("slide-decision", "decision", "Friday is the committed launch date"), storyRole: "decision", payload: { decision: "Launch Friday", rationale: ["The team committed to Friday"] }, bindings: { title: bind, decision: bind, "rationale[0]": bind } },
    { ...base("slide-comparison", "comparison", "Ownership removes the release gap"), payload: { sides: [{ label: "Before", items: ["No owner"] }, { label: "After", items: ["Mina owns notes"] }] }, bindings: { title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind }, editorialPaths: ["sides[0].label", "sides[1].label"] },
    { ...base("slide-timeline", "timeline", "The release moves toward Friday"), payload: { mode: "process", events: [{ label: "Friday", text: "Beta launches" }] }, bindings: { title: bind, "events[0].text": bind }, editorialPaths: ["events[0].label"] },
    { ...base("slide-metrics", "metrics", "One date focuses the launch"), payload: { mode: "cards", metrics: [{ label: "Launch", value: "Friday", detail: "Beta release" }] }, bindings: { title: bind, "metrics[0].label": bind, "metrics[0].value": bind, "metrics[0].detail": bind } },
    { ...base("slide-actions", "actions", "Mina closes the release loop"), storyRole: "commitment", payload: { items: [{ task: "Publish release notes", owner: "Mina", due: "Friday" }] }, bindings: { title: bind, "items[0].task": bind, "items[0].owner": bind, "items[0].due": bind } },
  ];
  return JSON.stringify({ schemaVersion: 1, revision, title: "Friday beta launch", theme: MEETING_PAPER_STYLE_PROFILE, claims: [claim], assets: withMissingAsset ? [asset] : [], slides });
}

function fixture(transcript: SlidePlanTranscriptInput, withMissingAsset = false, transport?: ChatTransport) {
  const root = mkdtempSync(join(tmpdir(), "slide-server-action-")); roots.push(root);
  const events: CompileUpdate[] = [];
  const model: ChatTransport = transport ?? { chat: async (prompt) => modelOutput(snapshotFromPrompt(prompt).transcriptVersionId, withMissingAsset) };
  const input: RunSlidePlanServerActionInput = { jobId: "compile-slide-plan-test" as CompileJobId, meetingId: 41, transcript, transport: model, outputRoot: join(root, "output"), cacheRoot: join(root, "cache"), fontSourcePath: FONT, tools: { slidesGrabPath: SLIDES_GRAB, playwrightBrowsersPath: BROWSERS, sandboxExecutable: "/usr/bin/sandbox-exec", sandboxProfile: SANDBOX, timeoutMs: 120_000 }, createId: () => "plan-server-action", now: () => "2026-08-15T10:00:00.000Z", send: (event: CompileUpdate) => { events.push(event); } };
  return { root, events, input };
}

function artifactNames(directory: string): string[] {
  const walk = (path: string, prefix = ""): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
  return walk(directory).sort();
}

type CommitDomain = Readonly<{
  database: Database;
  databasePath: string;
  meetingStore: MeetingStore;
  slidePlanStore: SlidePlanStore;
  transcript: SlidePlanTranscriptInput;
}>;

function commitDomain(): CommitDomain {
  const root = mkdtempSync(join(tmpdir(), "slide-commit-domain-"));
  roots.push(root);
  const databasePath = join(root, "meetings.db");
  const meetingStore = new MeetingStore(databasePath);
  const database = meetingStore.databaseHandle();
  new MinutesStore(database);
  const contentSha256 = sha(`${JSON.stringify({
    seq: 1,
    ts: 10,
    speaker_turn: 1,
    text: lines[0].text,
  })}\n`);
  database.run("INSERT INTO meetings (id, started_at, ended_at, provider) VALUES (41, 1, 2, 'test')");
  database.run(`INSERT INTO attendees
    (meeting_id, attendee_id, display_name, sort_order, created_at)
    VALUES (41, 'attendee-1', 'Mina', 0, 1)`);
  database.run(`INSERT INTO transcript_versions
    (transcript_version_id, meeting_id, version_no, source_kind, created_at, finalized_at, content_sha256)
    VALUES ('final-v41', 41, 1, 'import', 1, 2, ?)`, [contentSha256]);
  database.run(`INSERT INTO transcript_version_lines
    (meeting_id, transcript_version_id, seq, captured_at_ms, speaker_turn, text)
    VALUES (41, 'final-v41', 1, 10, 1, ?)`, [lines[0].text]);
  database.run(`INSERT INTO meeting_transcript_state
    (meeting_id, canonical_transcript_version_id, canonical_selected_at)
    VALUES (41, 'final-v41', 2)`);
  database.run(`INSERT INTO meeting_reviews
    (review_id, meeting_id, transcript_version_id, status, created_at, updated_at, confirmed_at)
    VALUES ('review-v41', 41, 'final-v41', 'confirmed', 1, 2, ?)`, [CONFIRMED_AT]);
  database.run(`INSERT INTO decisions
    (decision_id, meeting_id, review_id, description, evidence_quote, source_transcript_version_id,
     source_start_seq, source_end_seq, attributed_attendee_id, origin, review_state, created_at, updated_at)
    VALUES ('claim-launch', 41, 'review-v41', 'The beta launches Friday.', 'The beta launches Friday',
      'final-v41', 1, 1, 'attendee-1', 'manual', 'confirmed', 1, 2)`);
  return {
    database,
    databasePath,
    meetingStore,
    slidePlanStore: new SlidePlanStore(database),
    transcript: { state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256, confirmedReview },
  };
}

describe("production SlidePlan server action", () => {
  test("shared CompileUpdate exposes only the stable stale lineage code", () => {
    // Given: a shared compile update without an error code.
    const update: CompileUpdate = {
      type: "compile",
      status: "error",
      jobId: "compile-type-probe" as CompileJobId,
      error: "typed probe",
    };

    // When/Then: a strict consumer reads the shared optional literal union.
    expect(compileUpdateCode(update)).toBeUndefined();
  });

  test("publishes a real four-format deck with immutable confirmed Review identity and deterministic fallback", async () => {
    const run = fixture({ state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview }, true);
    const result = await runSlidePlanServerAction(run.input);
    expect(run.events.slice(0, 8).map((event) => event.completed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(run.events[run.events.length - 1]).toMatchObject({ type: "compile", status: "success", jobId: run.input.jobId, meetingId: 41, path: result.directory });
    expect(run.events.filter((event) => event.status === "success" || event.status === "error")).toHaveLength(1);
    expect(result.identity.snapshot.transcriptVersionId).toBe("final-v41");
    expect(result.schemaVersion).toBe(2);
    expect(result.identity).toMatchObject({ reviewId: "review-v41", reviewedItemIds: ["claim-launch"] });
    expect(result.finalityReceipt).toEqual({
      reviewId: "review-v41",
      confirmedAt: CONFIRMED_AT,
      transcriptVersionId: "final-v41",
      contentSha256: "c".repeat(64),
      reviewedItemIds: ["claim-launch"],
    });
    expect(result.publicationStatus).toBe("final");
    expect(result.directory).toContain("-final");
    const publication = JSON.parse(readFileSync(join(result.directory, "publication.json"), "utf8")) as {
      schemaVersion: number;
      publicationStatus: string;
      identity: { reviewId: string; reviewedItemIds: string[] };
      finalityReceipt: unknown;
    };
    expect(publication.schemaVersion).toBe(2);
    expect(publication.publicationStatus).toBe("final");
    expect(publication.identity).toMatchObject({ reviewId: "review-v41", reviewedItemIds: ["claim-launch"] });
    expect(publication.finalityReceipt).toEqual(result.finalityReceipt);
    expect(result.assetManifest.assets[0]?.source).toEqual({ kind: "generated", generator: "meeting-asset-fallback-svg-v1" });
    const names = artifactNames(result.directory);
    expect(names).toContain("slide-plan.json");
    expect(names).toContain("standalone/index.html");
    const standaloneSlides = names.filter((name) => name.startsWith("standalone/slides/") && name.endsWith(".html"));
    expect(standaloneSlides).toHaveLength(7);
    expect(readFileSync(join(result.directory, "standalone/index.html"), "utf8"))
      .toStartWith("<!doctype html>\n<html lang=\"ko-KR\"");
    for (const path of standaloneSlides) {
      expect(readFileSync(join(result.directory, path), "utf8"))
        .toStartWith("<!doctype html>\n<html lang=\"ko-KR\"");
    }
    expect(names).toEqual(expect.arrayContaining(["editable/deck.pptx", "editable/manifest.json", "editable/receipt.json", "raster/deck.pdf", "raster/manifest.json", "raster/receipt.json"]));
    expect(names.filter((name) => name.startsWith("raster/png/") && name.endsWith(".png"))).toEqual([
      "raster/png/slide-01.png",
      "raster/png/slide-02.png",
      "raster/png/slide-03.png",
      "raster/png/slide-04.png",
      "raster/png/slide-05.png",
      "raster/png/slide-06.png",
      "raster/png/slide-07.png",
    ]);
    expect(readFileSync(join(result.directory, "editable/deck.pptx")).subarray(0, 2).toString()).toBe("PK");
    expect(readFileSync(join(result.directory, "raster/deck.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha(readFileSync(join(run.input.cacheRoot, MEETING_PAPER_STYLE_PROFILE.font.localPath)))).toBe(MEETING_PAPER_STYLE_PROFILE.font.sha256);
  }, 120_000);

  test("preserves an explicit finalized transcript identity", async () => {
    const identity = { transcriptVersionId: "final-v41", contentSha256: "c".repeat(64) };
    const run = fixture({ state: "finalized", lines, ...identity });
    const result = await runSlidePlanServerAction(run.input);
    expect(result.identity.snapshot).toEqual({ meetingId: 41, ...identity, lineCount: 1 });
    expect(result.publicationStatus).toBe("draft");
    expect(result.directory).toContain("-draft");
  }, 120_000);

  test("can publish two plans from the same transcript without replacing either result", async () => {
    const run = fixture({ state: "live", lines });
    let sequence = 0;
    const input = { ...run.input, createId: () => `plan-server-action-${++sequence}` };
    const first = await runSlidePlanServerAction(input);
    const second = await runSlidePlanServerAction(input);
    expect(first.directory).not.toBe(second.directory);
    expect(existsSync(first.directory)).toBe(true);
    expect(existsSync(second.directory)).toBe(true);
  }, 120_000);


  test("re-publishes an edited plan in the same production root with stable plan identity", async () => {
    const first = fixture({ state: "live", lines });
    const published = await runSlidePlanServerAction(first.input);
    const edited = structuredClone(JSON.parse(published.planJson));
    edited.slides[0].title = "Edited Friday launch";
    edited.revision += 1;
    const planner = { chat: async () => { throw new Error("planner must not run"); } };
    const second = fixture({ state: "live", lines }, false, planner);
    second.input = {
      ...second.input,
      outputRoot: first.input.outputRoot,
      cacheRoot: first.input.cacheRoot,
      persistPlan: edited,
      createId: () => "plan-server-action-revision-2",
    };
    const result = await runSlidePlanServerAction(second.input);
    const revisedPlan = JSON.parse(result.planJson);
    expect(revisedPlan.planId).toBe(edited.planId);
    expect(revisedPlan.revision).toBe(1);
    expect(revisedPlan.slides[0].title).toBe("Edited Friday launch");
    expect(result.directory).not.toBe(published.directory);
    expect(existsSync(published.directory)).toBe(true);
    expect(existsSync(result.directory)).toBe(true);
  }, 20_000);
  test("confirmed compile creates one sibling final identity at revision zero", async () => {
    // Given: a retained draft identity and a confirmed Review compile.
    const run = fixture({ state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview });
    let createCalls = 0;

    // When: identity creation accidentally proposes the retained draft ID.
    const pending = runSlidePlanServerAction({
      ...run.input,
      retainedDraftPlanId: "retained-draft-plan",
      createId: () => { createCalls += 1; return "retained-draft-plan"; },
    });

    // Then: reuse is rejected after exactly one ID allocation and no success.
    await expect(pending).rejects.toThrow(/retained draft/i);
    expect(createCalls).toBe(1);
    expect(run.events.filter((event) => event.status === "success")).toEqual([]);

    // When: the allocator returns one fresh sibling identity.
    const sibling = fixture({ state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview });
    let siblingCreateCalls = 0;
    const result = await runSlidePlanServerAction({
      ...sibling.input,
      retainedDraftPlanId: "retained-draft-plan",
      createId: () => { siblingCreateCalls += 1; return "fresh-final-plan"; },
    });
    const finalPlan = JSON.parse(result.planJson) as { readonly planId: string; readonly revision: number };

    // Then: the final is a revision-zero sibling and the draft identity remains distinct.
    expect(siblingCreateCalls).toBe(1);
    expect(finalPlan).toMatchObject({ planId: "fresh-final-plan", revision: 0 });
    expect(finalPlan.planId).not.toBe("retained-draft-plan");
  }, 20_000);

  test("confirmed compile forces adversarial model revision seven to durable revision zero", async () => {
    // Given: a real confirmed domain and a model that supplies revision 7.
    const domain = commitDomain();
    let createCalls = 0;
    const run = fixture(domain.transcript, false, {
      chat: async (prompt) => modelOutput(snapshotFromPrompt(prompt).transcriptVersionId, false, 7),
    });

    // When: the confirmed final crosses the real durable store boundary.
    const result = await runSlidePlanServerAction({
      ...run.input,
      retainedDraftPlanId: "retained-draft-plan",
      createId: () => { createCalls += 1; return "fresh-adversarial-final"; },
      commit: (publication) => { domain.slidePlanStore.save(publication); },
    });
    const resultPlan = parseSlidePlan(result.planJson);
    const durable = domain.database.query(`SELECT plan_id, revision, publication_status
      FROM slide_plan_publications WHERE publication_status = 'final'`).get();

    // Then: server authority forces a fresh revision-zero sibling exactly once.
    expect(createCalls).toBe(1);
    expect(resultPlan).toEqual(expect.objectContaining({ planId: "fresh-adversarial-final", revision: 0 }));
    expect(resultPlan.planId).not.toBe("retained-draft-plan");
    expect(durable).toEqual({ plan_id: "fresh-adversarial-final", revision: 0, publication_status: "final" });
    domain.meetingStore.close();
  }, 20_000);

  test("commit-time second-handle ten-case revalidation rejects every staged provenance drift", async () => {
    // Given: one immutable draft publication seeds every fresh file-backed domain.
    const draftRun = fixture({ state: "live", lines });
    const draftPublication = await runSlidePlanServerAction({
      ...draftRun.input,
      createId: () => "retained-draft-plan",
    });
    const variants = [
      ["meeting deletion", (database: Database): void => { database.run("DELETE FROM meetings WHERE id = 41"); }],
      ["canonical pointer deletion", (database: Database): void => { database.run("DELETE FROM meeting_transcript_state WHERE meeting_id = 41"); }],
      ["canonical stored hash drift", (database: Database): void => {
        database.run("UPDATE transcript_versions SET content_sha256 = ? WHERE transcript_version_id = 'final-v41'", ["b".repeat(64)]);
      }],
      ["canonical actual text drift", (database: Database): void => {
        database.run("DROP TRIGGER trg_finalized_transcript_lines_no_update");
        database.run("UPDATE transcript_version_lines SET text = 'drifted text' WHERE meeting_id = 41 AND transcript_version_id = 'final-v41'");
      }],
      ["Review status drift", (database: Database): void => {
        database.run("UPDATE meeting_reviews SET status = 'draft', confirmed_at = NULL WHERE review_id = 'review-v41'");
      }],
      ["Review confirmedAt drift", (database: Database): void => {
        database.run("UPDATE meeting_reviews SET confirmed_at = confirmed_at + 1 WHERE review_id = 'review-v41'");
      }],
      ["confirmed decision removal", (database: Database): void => { database.run("DELETE FROM decisions WHERE decision_id = 'claim-launch'"); }],
      ["confirmed decision rejection", (database: Database): void => {
        database.run("UPDATE decisions SET review_state = 'rejected' WHERE decision_id = 'claim-launch'");
      }],
      ["confirmed action addition", (database: Database): void => {
        database.run(`INSERT INTO action_items
          (action_item_id, meeting_id, review_id, description, evidence_quote, source_transcript_version_id,
           source_start_seq, source_end_seq, assignee_attendee_id, attributed_attendee_id, deadline,
           origin, review_state, created_at, updated_at)
          VALUES ('action-extra', 41, 'review-v41', 'Extra action', 'The beta launches Friday', 'final-v41',
            1, 1, 'attendee-1', 'attendee-1', '2026-09-01', 'manual', 'confirmed', 1, 2)`);
      }],
      ["confirmed open-item addition", (database: Database): void => {
        database.run(`INSERT INTO open_items
          (open_item_id, meeting_id, review_id, description, evidence_quote, source_transcript_version_id,
           source_start_seq, source_end_seq, attributed_attendee_id, origin, review_state, created_at, updated_at)
          VALUES ('open-extra', 41, 'review-v41', 'Extra question', 'The beta launches Friday', 'final-v41',
            1, 1, 'attendee-1', 'manual', 'confirmed', 1, 2)`);
      }],
    ] as const;
    type DriftReceipt = Readonly<{
      name: string;
      errorName: string;
      code: "stale-review-lineage" | null;
      finalRows: number;
      retainedDraftRows: number;
      successFrames: number;
      errorFrames: number;
      directoryEntries: readonly string[];
      retainedDraftHashUnchanged: boolean;
      chronology: readonly string[];
    }>;
    const receipts: DriftReceipt[] = [];
    for (const [name, mutate] of variants) {
      const domain = commitDomain();
      const run = fixture(domain.transcript);
      const retainedDirectory = join(run.input.outputRoot, "retained-draft");
      const retainedMarker = join(retainedDirectory, "draft.txt");
      mkdirSync(retainedDirectory, { recursive: true });
      writeFileSync(retainedMarker, "retained draft\n");
      const retainedHash = sha(readFileSync(retainedMarker));
      domain.slidePlanStore.save({ ...draftPublication, directory: retainedDirectory }, 1);
      let enterCommit: (() => void) | undefined;
      const commitEntered = new Promise<void>((resolveEntered) => { enterCommit = resolveEntered; });
      let releaseCommit: (() => void) | undefined;
      const release = new Promise<void>((resolveRelease) => { releaseCommit = resolveRelease; });
      const chronology: string[] = [];
      const pending = runSlidePlanServerAction({
        ...run.input,
        createId: () => `final-${name.replace(/ /g, "-")}`,
        commit: async (result) => {
          chronology.push("commit-entered");
          enterCommit?.();
          await release;
          chronology.push("commit-released");
          domain.slidePlanStore.save(result, 2);
        },
      });
      await commitEntered;

      const activeDeletion = deleteMeetingForJobState({
        meetingId: 41,
        activeJob: { meetingId: 41, action: "compileSlidePlan" },
        deleteHistory: (meetingId) => deleteMeetingHistory(domain.database, meetingId),
      });
      chronology.push("active-delete-blocked");
      expect(activeDeletion).toEqual({ kind: "blocked", message: "슬라이드 작업 중인 회의는 삭제할 수 없습니다" });
      expect(domain.database.query("SELECT id FROM meetings WHERE id = 41").get()).toEqual({ id: 41 });
      expect(domain.database.query("SELECT review_id FROM meeting_reviews WHERE review_id = 'review-v41'").get())
        .toEqual({ review_id: "review-v41" });

      chronology.push(`${name}-mutated`);
      const secondHandle = new Database(domain.databasePath);
      secondHandle.run("PRAGMA busy_timeout = 5000");
      mutate(secondHandle);
      secondHandle.close();
      releaseCommit?.();
      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      const errorFrames = run.events.filter((event) => event.status === "error");
      const errorFrame = errorFrames[0];
      const finalRows = domain.database.query(
        "SELECT count(*) FROM slide_plan_publications WHERE publication_status = 'final'",
      ).values()[0]?.[0];
      const retainedDraftRows = domain.database.query(
        "SELECT count(*) FROM slide_plan_publications WHERE publication_status = 'draft'",
      ).values()[0]?.[0];
      receipts.push({
        name,
        errorName: caught instanceof Error ? caught.name : typeof caught,
        code: errorFrame === undefined ? null : compileUpdateCode(errorFrame) ?? null,
        finalRows: typeof finalRows === "number" ? finalRows : -1,
        retainedDraftRows: typeof retainedDraftRows === "number" ? retainedDraftRows : -1,
        successFrames: run.events.filter((event) => event.status === "success").length,
        errorFrames: errorFrames.length,
        directoryEntries: readdirSync(run.input.outputRoot),
        retainedDraftHashUnchanged: sha(readFileSync(retainedMarker)) === retainedHash,
        chronology,
      });
      domain.meetingStore.close();
    }

    // Then: every external drift loses atomically with one coded terminal error.
    expect(receipts.map(({ name, errorName, code }) => ({ name, errorName, code }))).toEqual(
      variants.map(([name]) => ({ name, errorName: "SlidePlanFinalityError", code: "stale-review-lineage" })),
    );
    expect(receipts.every((receipt) => receipt.finalRows === 0 && receipt.retainedDraftRows === 1)).toBe(true);
    expect(receipts.every((receipt) => receipt.successFrames === 0 && receipt.errorFrames === 1)).toBe(true);
    expect(receipts.every((receipt) => JSON.stringify(receipt.directoryEntries) === JSON.stringify(["retained-draft"]))).toBe(true);
    expect(receipts.every((receipt) => receipt.retainedDraftHashUnchanged === true)).toBe(true);
    expect(receipts.every((receipt) => receipt.chronology[0] === "commit-entered"
      && receipt.chronology[receipt.chronology.length - 1] === "commit-released")).toBe(true);
  }, 120_000);

  test("commit barrier preserves stale lineage code and cleans only the staged final directory", async () => {
    // Given: commit entry and release signals are subscribed before publication starts.
    const run = fixture({ state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview });
    let enterCommit: (() => void) | undefined;
    const commitEntered = new Promise<void>((resolveEntered) => { enterCommit = resolveEntered; });
    let releaseCommit: (() => void) | undefined;
    const release = new Promise<void>((resolveRelease) => { releaseCommit = resolveRelease; });
    const chronology: string[] = [];
    const retainedDirectory = join(run.input.outputRoot, "retained-draft");
    mkdirSync(retainedDirectory, { recursive: true });

    // When: publication reaches commit, lineage changes, and the barrier releases.
    const pending = runSlidePlanServerAction({
      ...run.input,
      commit: async () => {
        chronology.push("commit-entered");
        enterCommit?.();
        await release;
        chronology.push("commit-released");
        throw new SlidePlanFinalityError("Review status drifted");
      },
    });
    await commitEntered;
    chronology.push("lineage-mutated");
    releaseCommit?.();

    // Then: one coded error, no success, and no final publication directory remain.
    await expect(pending).rejects.toBeInstanceOf(SlidePlanFinalityError);
    expect(chronology).toEqual(["commit-entered", "lineage-mutated", "commit-released"]);
    expect(run.events.filter((event) => event.status === "success")).toEqual([]);
    expect(run.events.filter((event) => event.status === "error")).toEqual([
      expect.objectContaining({ code: "stale-review-lineage" }),
    ]);
    expect(readdirSync(run.input.outputRoot)).toEqual(["retained-draft"]);
    expect(existsSync(retainedDirectory)).toBe(true);
  }, 20_000);

  test("emits success only after durable commit and removes an orphan when commit fails", async () => {
    const run = fixture({ state: "live", lines });
    const expectedDirectory = join(run.input.outputRoot, `meeting-41-${sha(JSON.stringify(lines.map(({ seq, speaker, text }) => ({ seq, speaker, text }))))}-${sha("plan-server-action").slice(0, 12)}-draft`);
    await expect(runSlidePlanServerAction({
      ...run.input,
      commit: () => { throw new Error("database commit failed"); },
    })).rejects.toThrow("database commit failed");
    expect(run.events.filter((event) => event.status === "success")).toEqual([]);
    expect(run.events.filter((event) => event.status === "error")).toHaveLength(1);
    expect(existsSync(expectedDirectory)).toBe(false);
  }, 20_000);

  test("broadcasts one error and publishes nothing when the provider omits confirmed Review evidence", async () => {
    const transcript = { state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview } as const;
    const run = fixture(transcript, false, { chat: async (prompt) => {
      const output = JSON.parse(modelOutput(snapshotFromPrompt(prompt).transcriptVersionId)) as { claims: Array<{ id: string }> };
      output.claims = [];
      return JSON.stringify(output);
    } });
    await expect(runSlidePlanServerAction(run.input)).rejects.toMatchObject({ code: "model-output-invalid", attempts: 2 });
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({ type: "compile", status: "error" });
    expect(existsSync(run.input.outputRoot) ? readdirSync(run.input.outputRoot) : []).toEqual([]);
  });

  test("planner completions request a planning-scale transport timeout", async () => {
    const seen: Array<{ timeoutMs?: number }> = [];
    const run = fixture({ state: "live", lines }, false, { chat: async (prompt, options) => {
      seen.push({ timeoutMs: options?.timeoutMs });
      return modelOutput(snapshotFromPrompt(prompt).transcriptVersionId);
    } });
    await runSlidePlanServerAction(run.input);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.timeoutMs).toBeGreaterThanOrEqual(600_000);
  }, 20_000);

  test("the terminal error frame carries the planner validation detail, not only the generic message", async () => {
    const transcript = { state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview } as const;
    const run = fixture(transcript, false, { chat: async (prompt) => {
      const output = JSON.parse(modelOutput(snapshotFromPrompt(prompt).transcriptVersionId)) as { claims: Array<{ id: string }> };
      output.claims = [];
      return JSON.stringify(output);
    } });
    await expect(runSlidePlanServerAction(run.input)).rejects.toMatchObject({ code: "model-output-invalid" });
    const error = run.events[0] as { status: string; error?: string };
    expect(error.status).toBe("error");
    expect(error.error).toMatch(/\[(contract-invalid|evidence-mismatch|completion-failed)\] .+/);
    expect(error.error).not.toBe("Model output did not satisfy the SlidePlan contract after one repair attempt.");
  });

  test("broadcasts one error and leaves no partial publication when the provider fails", async () => {
    const run = fixture({ state: "live", lines }, false, { chat: async () => { throw new Error("provider unavailable"); } });
    await expect(runSlidePlanServerAction(run.input)).rejects.toThrow("Model output did not satisfy");
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({ type: "compile", status: "error", jobId: run.input.jobId, meetingId: 41 });
    expect(existsSync(run.input.outputRoot) ? readdirSync(run.input.outputRoot) : []).toEqual([]);
  });
});

describe("server-owned theme in production", () => {
  test("publishes when the model omits theme, using the server style profile", async () => {
    const run = fixture({ state: "live", lines }, false, { chat: async (prompt) => {
      const output = JSON.parse(modelOutput(snapshotFromPrompt(prompt).transcriptVersionId)) as Record<string, unknown>;
      delete output.theme;
      return JSON.stringify(output);
    } });
    const result = await runSlidePlanServerAction(run.input);
    const published = JSON.parse(readFileSync(join(result.directory, "slide-plan.json"), "utf8")) as { theme: unknown };
    expect(published.theme).toEqual(MEETING_PAPER_STYLE_PROFILE);
    expect(run.events[run.events.length - 1]).toMatchObject({ type: "compile", status: "success" });
  }, 20_000);
});
