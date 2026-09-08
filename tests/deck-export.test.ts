import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareExportDeck } from "../src/deck-export.ts";
import { resolveSlidePlanArtifact, SlidePlanArtifactError } from "../src/slide-plan-artifacts.ts";
import { CORE_SCHEMA } from "../src/minutes-store-schema-core.ts";
import { REVIEW_SCHEMA } from "../src/minutes-store-schema-review.ts";
import { SlidePlanStore, type SlidePlanPublicationWrite } from "../src/slide-plan-store.ts";
import type { PipelineIdentity } from "../src/slides/server-pipeline.ts";
import type { PlanSlide, SlidePlan, Theme } from "../src/slides/model/plan.ts";
import type { DeckOutline } from "../src/slide-spec.ts";
import { transcriptLinesHash } from "../src/minutes-store-utils.ts";
import { MeetingStore } from "../src/store.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const transcriptHash = transcriptLinesHash([{
  seq: 1,
  captured_at_ms: 10,
  speaker_turn: 1,
  text: "Launch Friday",
}]);

const temporaryDirectories: string[] = [];
afterEach(() => {
  if (process.env.PUBLICATION_TEST_RETAIN_FIXTURES === "1") return;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const theme: Theme = { id: "dock-theme", canvas: { width: 1280, height: 720 }, font: { family: "Fixture", localPath: "fonts/fixture.woff2", sha256: "f".repeat(64) }, colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" }, spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 }, typography: { display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 }, body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 } }, stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 } };
const claim = { id: "claim-dock", kind: "decision" as const, text: "Launch Friday.", sources: [{ transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Launch Friday" }], method: "reviewed" as const };

function dockPlan(meetingId: number, planId = "plan-dock", title = "도크 내보내기 덱"): SlidePlan {
  const slides: PlanSlide[] = [
    { id: "slide-hero", layout: "hero", storyRole: "opening", title: "출시 회의", payload: { variant: "cover", statement: "Launch Friday" }, bindings: { title: [claim.id], statement: [claim.id] }, editorialPaths: [], assetIds: [] },
    { id: "slide-decision", layout: "decision", storyRole: "argument", title: "출시일 확정", payload: { decision: "Launch Friday", rationale: ["Agreed"] }, bindings: { title: [claim.id], decision: [claim.id], "rationale[0]": [claim.id] }, editorialPaths: [], assetIds: [] },
  ];
  return { schemaVersion: 1, planId, revision: 0, snapshot: { meetingId, transcriptVersionId: "transcript-v1", contentSha256: transcriptHash, lineCount: 1 }, title, theme, claims: [claim], assets: [], slides, createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z" };
}

function dockPublication(plan: SlidePlan, directory: string, status: "draft" | "final" = "draft"): SlidePlanPublicationWrite {
  const planJson = `${JSON.stringify(plan)}\n`;
  const reviewedItemIds = [claim.id];
  const identity: PipelineIdentity = {
    planId: plan.planId,
    deckId: `${plan.planId}:deck`,
    snapshot: plan.snapshot,
    slideIds: plan.slides.map((slide) => slide.id),
    geometryIds: plan.slides.map((slide) => `geometry-${slide.id}`),
    claimIds: plan.claims.map((entry) => entry.id),
    ...(status === "final" ? { reviewId: "review-export", reviewedItemIds } : {}),
  };
  const manifestJson = `${JSON.stringify({
    schemaVersion: 2,
    publicationStatus: status,
    identity,
    ...(status === "final" ? {
      finalityReceipt: {
        reviewId: "review-export",
        confirmedAt: 300,
        transcriptVersionId: "transcript-v1",
        contentSha256: transcriptHash,
        reviewedItemIds,
      },
    } : {}),
    planSha256: hash(planJson),
    assetManifestSha256: hash("{}\n"),
    artifacts: [{
      format: "standalone-html",
      files: ["standalone/index.html", ...plan.slides.map((slide) => `standalone/slides/${slide.id}.html`)].map((relativePath) => {
        const bytes = readFileSync(join(directory, relativePath));
        return { relativePath, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
      }),
    }],
  })}\n`;
  writeFileSync(join(directory, "slide-plan.json"), planJson);
  writeFileSync(join(directory, "asset-manifest.json"), "{}\n");
  writeFileSync(join(directory, "publication.json"), `${JSON.stringify({
    ...JSON.parse(manifestJson), publicationSha256: hash(manifestJson),
  })}\n`);
  return { identity, planJson, planSha256: hash(planJson), manifestJson, publicationSha256: hash(manifestJson), directory };
}

function addFinalityEvidence(store: MeetingStore, meetingId: number): void {
  const database = store.databaseHandle();
  database.run(CORE_SCHEMA);
  database.run(REVIEW_SCHEMA);
  database.run(`INSERT INTO transcript_versions
    (transcript_version_id, meeting_id, version_no, source_kind, created_at, finalized_at, content_sha256)
    VALUES ('transcript-v1', ?, 1, 'import', 1, 200, ?)`, [meetingId, transcriptHash]);
  database.run(`INSERT INTO transcript_version_lines
    (meeting_id, transcript_version_id, seq, captured_at_ms, speaker_turn, text)
    VALUES (?, 'transcript-v1', 1, 10, 1, 'Launch Friday')`, [meetingId]);
  database.run(`INSERT INTO meeting_transcript_state
    (meeting_id, canonical_transcript_version_id, canonical_selected_at)
    VALUES (?, 'transcript-v1', 200)`, [meetingId]);
  database.run("INSERT INTO attendees (meeting_id, attendee_id, display_name, created_at) VALUES (?, 'attendee-export', 'Mina', 1)", [meetingId]);
  database.run(`INSERT INTO meeting_reviews
    (review_id, meeting_id, transcript_version_id, status, created_at, updated_at, confirmed_at)
    VALUES ('review-export', ?, 'transcript-v1', 'confirmed', 1, 300, 300)`, [meetingId]);
  database.run(`INSERT INTO decisions
    (decision_id, meeting_id, review_id, description, evidence_quote, source_transcript_version_id,
      source_start_seq, source_end_seq, attributed_attendee_id, origin, review_state, created_at, updated_at)
    VALUES (?, ?, 'review-export', 'Launch', 'Launch Friday', 'transcript-v1', 1, 1,
      'attendee-export', 'manual', 'confirmed', 1, 1)`, [claim.id, meetingId]);
}

function writeStandaloneDeck(root: string, plan: SlidePlan): string[] {
  mkdirSync(join(root, "standalone", "slides"), { recursive: true });
  writeFileSync(join(root, "standalone", "index.html"), `<!doctype html><title>${plan.title}</title>`, "utf-8");
  return plan.slides.map((slide, index) => {
    const html = `<!doctype html><html lang="und"><body data-slides-grab>${plan.planId}-${index}-${slide.id}</body></html>`;
    writeFileSync(join(root, "standalone", "slides", `${slide.id}.html`), html, "utf-8");
    return html;
  });
}

function fixture(): { store: MeetingStore; meetingId: number; outline: DeckOutline } {
  const store = new MeetingStore(":memory:");
  const meetingId = store.startMeeting("fake");
  store.addLine({ ts: 1000, text: "금요일에 배포합니다." });
  store.addSlide({ idx: 1, title: "라이브 출시", bullets: ["초안 일정"], startedAt: 900 });
  return {
    store,
    meetingId,
    outline: {
      meetingId,
      title: "컴파일된 출시 덱",
      style: "clear-editorial",
      slides: [
        { kind: "cover", title: "컴파일된 출시 덱", subtitle: "최종본" },
        { kind: "decision", title: "결정", decision: "금요일 배포", rationale: ["QA 완료"] },
        { kind: "actions", title: "후속 작업", actions: [{ text: "릴리스 노트", owner: "민지" }] },
        { kind: "closing", title: "마무리", bullets: ["월요일 지표 확인"] },
      ],
    },
  };
}

describe("export deck source preference", () => {
  for (const relativePath of ["standalone/index.html", "standalone/slides/slide-decision.html"]) {
    for (const mutation of ["same-length bytes", "truncated bytes", "missing manifest", "escaping file", "escaping manifest"] as const) {
      test(`Given ${mutation} at ${relativePath}, When publication consumers read, Then both reject before rendering`, async () => {
        const { store, meetingId, outline } = fixture();
        try {
          store.saveDeckOutline(outline);
          store.markDeckPublished(meetingId, 10);
          const root = mkdtempSync(join(tmpdir(), "publication-integrity-"));
          temporaryDirectories.push(root);
          const plan = dockPlan(meetingId);
          writeStandaloneDeck(root, plan);
          const publications = new SlidePlanStore(store.databaseHandle());
          publications.save(dockPublication(plan, root), 20);
          expect(prepareExportDeck(store, meetingId, { requireSlidePlan: true }).source).toBe("slideplan");
          const route = `/slide-plan-artifacts/${plan.planId}/${relativePath}`;
          await expect(resolveSlidePlanArtifact(route, publications)).resolves.toMatchObject({ contentType: "text/html; charset=utf-8" });

          const path = join(root, relativePath);
          let status: 403 | 404 | 409;
          switch (mutation) {
            case "same-length bytes": {
              const bytes = readFileSync(path);
              bytes[0] = 33;
              writeFileSync(path, bytes);
              status = 409;
              break;
            }
            case "truncated bytes":
              writeFileSync(path, "changed");
              status = 409;
              break;
            case "missing manifest":
              renameSync(join(root, "publication.json"), join(root, "retained-publication.json"));
              status = 404;
              break;
            case "escaping file":
            case "escaping manifest": {
              const outside = mkdtempSync(join(tmpdir(), "publication-outside-"));
              temporaryDirectories.push(outside);
              const target = mutation === "escaping file" ? path : join(root, "publication.json");
              const retained = join(outside, "original");
              renameSync(target, retained);
              symlinkSync(retained, target);
              status = 403;
              break;
            }
          }

          await expect(resolveSlidePlanArtifact(route, publications)).rejects.toMatchObject({ status });
          expect(() => prepareExportDeck(store, meetingId, { requireSlidePlan: true }))
            .toThrow(SlidePlanArtifactError);
          try {
            prepareExportDeck(store, meetingId);
            throw new Error("Invalid publication fell back to a compiled or legacy deck");
          } catch (error) {
            expect(error).toMatchObject({ status });
          }
        } finally {
          store.close();
        }
      });
    }
  }

  test("SlidePlan-only mode rejects both live-history and compiled fallback", () => {
    const { store, meetingId, outline } = fixture();

    expect(() => prepareExportDeck(store, meetingId, { requireSlidePlan: true }))
      .toThrow("SlidePlan");
    store.saveDeckOutline(outline);
    store.markDeckPublished(meetingId, 1_700_000_000_000);
    expect(() => prepareExportDeck(store, meetingId, { requireSlidePlan: true }))
      .toThrow("SlidePlan");
    store.close();
  });

  test("without a successful compile it explicitly exports legacy live history", () => {
    const { store, meetingId, outline } = fixture();

    expect(prepareExportDeck(store, meetingId)).toMatchObject({ source: "legacy", slideCount: 3 });
    // A planner result alone is not a successful disk compile and must not displace the safe fallback.
    store.saveDeckOutline(outline);
    const unpublished = prepareExportDeck(store, meetingId);
    expect(unpublished.source).toBe("legacy");
    expect(unpublished.indexHtml).toContain("라이브 출시");
    store.close();
  });

  test("prefers the latest SlidePlan standalone deck over a published compile", () => {
    const { store, meetingId, outline } = fixture();
    store.saveDeckOutline(outline);
    store.markDeckPublished(meetingId, 1_700_000_000_000);
    // 컴파일 발행만 있을 때는 기존 순서 그대로 컴파일 덱을 고른다.
    expect(prepareExportDeck(store, meetingId).source).toBe("compiled");

    const root = mkdtempSync(join(tmpdir(), "deck-export-slideplan-"));
    temporaryDirectories.push(root);
    const plan = dockPlan(meetingId);
    const slideHtml = writeStandaloneDeck(root, plan);
    const indexHtml = readFileSync(join(root, "standalone", "index.html"), "utf8");
    new SlidePlanStore(store.databaseHandle()).save(dockPublication(plan, root), 1_700_000_000_001);

    const material = prepareExportDeck(store, meetingId);

    expect(material.source).toBe("slideplan");
    expect(material.title).toBe(plan.title);
    expect(material.files.map(({ filename }) => filename)).toEqual(["slide-hero.html", "slide-decision.html"]);
    expect(material.files.map(({ html }) => html)).toEqual(slideHtml);
    expect(material.indexHtml).toBe(indexHtml);
    expect(material.slideCount).toBe(2);
    expect(material.lineCount).toBe(1);
    store.close();
  });

  test("uses publication sequence for the latest final when the wall clock moves backward", () => {
    // Given: a draft is inserted first at audit time 200 and a final second at audit time 100.
    const { store, meetingId } = fixture();
    addFinalityEvidence(store, meetingId);
    const draftRoot = mkdtempSync(join(tmpdir(), "deck-export-draft-"));
    const finalRoot = mkdtempSync(join(tmpdir(), "deck-export-final-"));
    temporaryDirectories.push(draftRoot, finalRoot);
    const draft = dockPlan(meetingId, "plan-draft", "Draft by audit clock");
    const final = dockPlan(meetingId, "plan-final", "Final by publication sequence");
    writeStandaloneDeck(draftRoot, draft);
    const finalSlides = writeStandaloneDeck(finalRoot, final);
    const publications = new SlidePlanStore(store.databaseHandle());
    publications.save(dockPublication(draft, draftRoot), 200);
    publications.save(dockPublication(final, finalRoot, "final"), 100);

    // When: deck preparation resolves the meeting publication.
    const material = prepareExportDeck(store, meetingId, { requireSlidePlan: true });

    // Then: PDF/PNG preparation and deck export share the sequence-backed final.
    expect(publications.list(meetingId).map(({ plan, publicationSeq, publicationStatus }) => ({
      planId: plan.planId,
      publicationSeq,
      publicationStatus,
    }))).toEqual([
      { planId: "plan-final", publicationSeq: 2, publicationStatus: "final" },
      { planId: "plan-draft", publicationSeq: 1, publicationStatus: "draft" },
    ]);
    expect(material).toMatchObject({ source: "slideplan", title: "Final by publication sequence" });
    expect(material.files.map(({ html }) => html)).toEqual(finalSlides);
    const evidenceDirectory = process.env.TASK5_EVIDENCE_DIR;
    if (evidenceDirectory !== undefined) {
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(join(evidenceDirectory, "preparation.json"), `${JSON.stringify({
        source: material.source,
        planId: final.planId,
        publicationSeq: 2,
        publicationStatus: "final",
        publishedAt: 100,
        consumers: ["prepareExportDeck", "exportPdf", "exportPng"],
      }, null, 2)}\n`);
    }
    store.close();
  });

  test("after successful publish export lists registry-rendered compiled kinds", () => {
    const { store, meetingId, outline } = fixture();
    store.saveDeckOutline(outline);
    store.markDeckPublished(meetingId, 1_700_000_000_000);

    const material = prepareExportDeck(store, meetingId);

    expect(material.source).toBe("compiled");
    expect(material.title).toBe("컴파일된 출시 덱");
    expect(material.files.map(({ filename }) => filename)).toEqual([
      "slide-00.html", "slide-01.html", "slide-02.html", "slide-03.html",
    ]);
    expect(material.files[1]?.html).toContain('class="slide-page is-decision"');
    expect(material.files[2]?.html).toContain('class="slide-page is-actions"');
    expect(material.indexHtml).toContain('data-kind="decision"');
    expect(material.indexHtml).toContain('./slides/slide-03.html');
    expect(material.slideCount).toBe(4);
    expect(material.lineCount).toBe(1);
    store.close();
  });
});
