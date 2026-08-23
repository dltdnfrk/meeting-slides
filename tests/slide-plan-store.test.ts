import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveScenePublication, scenePublication } from "../src/scene-store.ts";
import { SlidePlanStore } from "../src/slide-plan-store.ts";
import type { PipelineIdentity } from "../src/slides/server-pipeline.ts";
import type { PlanSlide, SlidePlan, Theme } from "../src/slides/model/plan.ts";
import { MeetingStore } from "../src/store.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const theme: Theme = { id: "store-theme", canvas: { width: 1280, height: 720 }, font: { family: "Fixture", localPath: "fonts/fixture.woff2", sha256: "f".repeat(64) }, colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" }, spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 }, typography: { display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 }, body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 } }, stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 } };
const claim = { id: "claim-launch", kind: "decision" as const, text: "Launch Friday.", sources: [{ transcriptVersionId: "transcript-v1", startSeq: 1, endSeq: 1, evidenceQuote: "Launch Friday" }], method: "reviewed" as const };

function slide(layout: PlanSlide["layout"], index: number): PlanSlide {
  const base = { id: `slide-${layout}`, layout, storyRole: index === 0 ? "opening" as const : "argument" as const, title: `Slide ${index}`, editorialPaths: [] as string[], assetIds: [] as string[] };
  const binding = [claim.id];
  switch (layout) {
    case "hero": return { ...base, layout, payload: { variant: "cover", statement: "Launch Friday" }, bindings: { title: binding, statement: binding } };
    case "summary": return { ...base, layout, payload: { mode: "overview", items: ["Launch Friday"] }, bindings: { title: binding, "items[0]": binding } };
    case "decision": return { ...base, layout, payload: { decision: "Launch Friday", rationale: ["Agreed"] }, bindings: { title: binding, decision: binding, "rationale[0]": binding } };
    case "comparison": return { ...base, layout, payload: { sides: [{ label: "Before", items: ["Open"] }, { label: "After", items: ["Agreed"] }] }, bindings: { title: binding, "sides[0].items[0]": binding, "sides[1].items[0]": binding }, editorialPaths: ["sides[0].label", "sides[1].label"] };
    case "timeline": return { ...base, layout, payload: { mode: "process", events: [{ label: "Friday", text: "Launch" }] }, bindings: { title: binding, "events[0].text": binding }, editorialPaths: ["events[0].label"] };
    case "metrics": return { ...base, layout, payload: { mode: "cards", metrics: [{ label: "Date", value: "Friday", detail: "Launch" }] }, bindings: { title: binding, "metrics[0].label": binding, "metrics[0].value": binding, "metrics[0].detail": binding } };
    case "actions": return { ...base, layout, payload: { items: [{ task: "Launch", owner: "Mina", due: "Friday" }] }, bindings: { title: binding, "items[0].task": binding, "items[0].owner": binding, "items[0].due": binding } };
  }
}

function plan(planId = "plan-store"): SlidePlan {
  return { schemaVersion: 1, planId, revision: 0, snapshot: { meetingId: 1, transcriptVersionId: "transcript-v1", contentSha256: "a".repeat(64), lineCount: 1 }, title: "Launch", theme, claims: [claim], assets: [], slides: (["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"] as const).map(slide), createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:00:00.000Z" };
}

function publication(value = plan()) {
  const planJson = `${JSON.stringify(value)}\n`;
  const identity: PipelineIdentity = { planId: value.planId, deckId: `${value.planId}:deck`, snapshot: value.snapshot, slideIds: value.slides.map((entry) => entry.id), geometryIds: value.slides.map((entry) => `geometry-${entry.id}`), claimIds: value.claims.map((entry) => entry.id), reviewId: "review-v1", reviewedItemIds: [claim.id] };
  const manifestJson = `${JSON.stringify({ schemaVersion: 1, identity, planSha256: hash(planJson), assetManifestSha256: "b".repeat(64), artifacts: [] })}\n`;
  return { identity, planJson, planSha256: hash(planJson), manifestJson, publicationSha256: hash(manifestJson), directory: "/published/plan-store" };
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function legacyRows(db: Database): Record<string, unknown[]> {
  return Object.fromEntries(["meetings", "transcript_lines", "slides", "deck_outlines", "deck_slide_specs", "scene_publications"].map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("SlidePlanStore additive persistence migration", () => {
  test("round-trips an immutable publication without changing legacy slide, deck, or scene data across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "slide-plan-store-")); roots.push(root);
    const path = join(root, "meetings.db");
    const legacy = new MeetingStore(path);
    const meetingId = legacy.startMeeting("fixture");
    legacy.addLine({ ts: 10, speaker: 1, text: "Launch Friday" });
    legacy.addSlide({ idx: 1, title: "Legacy title", bullets: ["Legacy bullet"], startedAt: 10 });
    legacy.saveDeckOutline({ meetingId, title: "Legacy deck", style: "paper", slides: [{ kind: "cover", title: "Legacy cover" }, { kind: "summary", title: "Legacy summary", bullets: ["Keep me"] }] });
    saveScenePublication(legacy.databaseHandle(), { meetingId, narrative: { meetingId, title: "Legacy scene", slides: [{ intent: "cover", title: "Legacy scene" }] }, scene: { meetingId, title: "Legacy scene", width: 100, height: 56.25, slides: [{ id: "scene-1", intent: "cover", background: "FFFFFF", elements: [] }] }, directory: "/legacy/scene", pptxPath: "/legacy/scene/deck.pptx", publishedAt: 123 });
    const beforeRows = legacyRows(legacy.databaseHandle());
    const beforeApis = { slides: legacy.slides(meetingId), outline: legacy.deckOutline(meetingId), detail: legacy.meetingDetail(meetingId), scene: scenePublication(legacy.databaseHandle(), meetingId) };

    const store = new SlidePlanStore(legacy.databaseHandle());
    const saved = store.save(publication(), 456);
    expect(saved.plan).toEqual(plan());
    expect(saved).toMatchObject({ planSha256: hash(publication().planJson), publicationSha256: publication().publicationSha256, path: "/published/plan-store", reviewId: "review-v1", reviewedItemIds: [claim.id], publishedAt: 456 });
    expect(store.one("plan-store")).toEqual(saved);
    expect(store.latest(meetingId)).toEqual(saved);
    expect(store.list(meetingId)).toEqual([saved]);
    expect(legacyRows(legacy.databaseHandle())).toEqual(beforeRows);
    expect({ slides: legacy.slides(meetingId), outline: legacy.deckOutline(meetingId), detail: legacy.meetingDetail(meetingId), scene: scenePublication(legacy.databaseHandle(), meetingId) }).toEqual(beforeApis);
    legacy.close();

    const reopenedLegacy = new MeetingStore(path);
    const reopened = new SlidePlanStore(reopenedLegacy.databaseHandle());
    expect(reopened.one("plan-store")).toEqual(saved);
    expect(legacyRows(reopenedLegacy.databaseHandle())).toEqual(beforeRows);
    expect({ slides: reopenedLegacy.slides(meetingId), outline: reopenedLegacy.deckOutline(meetingId), detail: reopenedLegacy.meetingDetail(meetingId), scene: scenePublication(reopenedLegacy.databaseHandle(), meetingId) }).toEqual(beforeApis);
    reopenedLegacy.close();
  });

  test("rejects hash and identity mismatches and conflicting duplicate plan IDs", () => {
    const db = new Database(":memory:");
    const store = new SlidePlanStore(db);
    const value = publication();
    expect(() => store.save({ ...value, planSha256: "c".repeat(64) }, 1)).toThrow(/plan.*hash/i);
    expect(() => store.save({ ...value, identity: { ...value.identity, planId: "other-plan" } }, 1)).toThrow(/identity/i);
    const saved = store.save(value, 1);
    expect(store.save(value, 999)).toEqual(saved);
    expect(() => store.save({ ...value, directory: "/conflict" }, 2)).toThrow(/conflicting.*plan/i);
    db.close();
  });

  test("parses every persisted read and rejects malformed stored plan JSON", () => {
    const db = new Database(":memory:");
    const store = new SlidePlanStore(db);
    store.save(publication(), 1);
    db.run("UPDATE slide_plan_publications SET plan_json = ? WHERE plan_id = ?", ["{malformed", "plan-store"]);
    expect(() => store.one("plan-store")).toThrow(/valid JSON/i);
    expect(() => store.latest(1)).toThrow(/valid JSON/i);
    expect(() => store.list(1)).toThrow(/valid JSON/i);
    db.close();
  });
});
