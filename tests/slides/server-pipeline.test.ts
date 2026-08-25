import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSlidePlanPipeline, type PipelineArtifactPublisher, type PipelineAssetPolicy, type PipelineIdentity } from "../../src/slides/server-pipeline.ts";
import type { TextMeasurer } from "../../src/slides/geometry/contract.ts";
import type { PlanAsset, PlanSlide, SlidePlan, Theme } from "../../src/slides/model/plan.ts";
import type { TranscriptSnapshot } from "../../src/slides/planning/planner.ts";

const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const theme: Theme = { id: "pipeline-theme", canvas: { width: 1280, height: 720 }, font: { family: "Fixture", localPath: "fonts/fixture.woff2", sha256: "f".repeat(64) }, colors: { paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475", rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8" }, spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 }, typography: { display: { size: 64, lineHeight: 68, weight: 700 }, heading: { size: 36, lineHeight: 42, weight: 700 }, body: { size: 22, lineHeight: 30, weight: 400 }, label: { size: 16, lineHeight: 20, weight: 600 } }, stroke: { thin: 1, strong: 3 }, radius: { small: 8, large: 24 } };
const review = { reviewId: "review-v17", transcriptVersionId: "transcript-v17", items: [{ id: "claim-launch", kind: "decision", description: "The beta launches Friday.", source: { transcriptVersionId: "transcript-v17", startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }, reviewState: "confirmed" }] } as const;
const snapshot = (state: "live" | "finalized", withReview = false): TranscriptSnapshot => ({ state, meetingId: 17, transcriptVersionId: "transcript-v17", contentSha256: "a".repeat(64), lines: [{ seq: 1, speaker: "Mina", text: "The beta launches Friday and Mina owns the release notes." }], ...(withReview ? { confirmedReview: review } : {}) });
const claim = { id: "claim-launch", kind: "decision" as const, text: "The beta launches Friday.", sources: [{ transcriptVersionId: "transcript-v17", startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }], method: "reviewed" as const };

function slide(layout: PlanSlide["layout"], index: number): PlanSlide {
  const base = { id: `slide-${layout}`, layout, storyRole: index === 0 ? "opening" as const : "argument" as const, title: `Launch evidence ${index + 1}`, editorialPaths: [] as string[], assetIds: [] as string[] };
  const bind = ["claim-launch"];
  switch (layout) {
    case "hero": return { ...base, layout, payload: { variant: "cover", statement: "Friday launch" }, bindings: { title: bind, statement: bind } };
    case "summary": return { ...base, layout, payload: { mode: "overview", items: ["Friday launch"] }, bindings: { title: bind, "items[0]": bind } };
    case "decision": return { ...base, layout, payload: { decision: "Launch Friday", rationale: ["Evidence supports launch"] }, bindings: { title: bind, decision: bind, "rationale[0]": bind } };
    case "comparison": return { ...base, layout, payload: { sides: [{ label: "Before", items: ["Unowned"] }, { label: "After", items: ["Owned"] }] }, bindings: { title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind }, editorialPaths: ["sides[0].label", "sides[1].label"] };
    case "timeline": return { ...base, layout, payload: { mode: "process", events: [{ label: "Launch", text: "Launch Friday" }] }, bindings: { title: bind, "events[0].text": bind }, editorialPaths: ["events[0].label"] };
    case "metrics": return { ...base, layout, payload: { mode: "cards", metrics: [{ label: "Date", value: "Friday", detail: "Launch" }] }, bindings: { title: bind, "metrics[0].label": bind, "metrics[0].value": bind, "metrics[0].detail": bind } };
    case "actions": return { ...base, layout, payload: { items: [{ task: "Publish notes", owner: "Mina", due: "Friday" }] }, bindings: { title: bind, "items[0].task": bind, "items[0].owner": bind, "items[0].due": bind } };
  }
}

function modelContent(asset?: PlanAsset): Omit<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt"> {
  const slides = (["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"] as const).map(slide);
  if (asset !== undefined) slides[0] = { ...slides[0]!, assetIds: [asset.id] } as PlanSlide;
  return { schemaVersion: 1, revision: 0, title: "Launch plan", theme, claims: [claim], assets: asset === undefined ? [] : [asset], slides };
}

class Measurer implements TextMeasurer { measure(input: { text: string; fontSize: number }) { return { width: input.text.length * input.fontSize * 0.25, height: input.fontSize }; } }
let roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function fixture(state: "live" | "finalized", content = modelContent(), withReview = false) {
  const root = mkdtempSync(join(tmpdir(), "slide-pipeline-")); roots.push(root);
  const progress: unknown[] = [];
  const seen: PipelineIdentity[] = [];
  const publisher = (format: "standalone-html" | "editable-pptx" | "raster-png-pdf"): PipelineArtifactPublisher => async (request) => {
    seen.push(request.identity);
    return { format, identity: request.identity, files: [{ relativePath: `${format}/artifact.bin`, bytes: new TextEncoder().encode(format) }] };
  };
  return { root, progress, seen, input: { snapshot: snapshot(state, withReview), planner: { complete: async () => JSON.stringify(content), createId: () => "plan-pipeline", now: () => "2026-08-15T10:00:00.000Z" }, theme, managedAssetRoot: join(root, "managed"), assetPolicy: { resolve: async () => undefined, fallback: async () => { throw new Error("unexpected fallback"); } }, textMeasurer: new Measurer(), textPolicies: { title: { mode: "shrink" as const, wordBreak: "normal" as const, overflowWrap: "break-word" as const, fontFloor: 12 }, statement: { mode: "shrink" as const, wordBreak: "normal" as const, overflowWrap: "break-word" as const, fontFloor: 12 } }, preflight: {}, stagingDirectory: join(root, "stage"), finalDirectory: join(root, "published"), publishers: { standalone: publisher("standalone-html"), pptx: publisher("editable-pptx"), raster: publisher("raster-png-pdf") }, onProgress: (event: unknown) => progress.push(event) } };
}

const expectedProgress = ["planning", "assets", "layouts", "geometry", "standalone", "pptx", "raster", "publication"].map((phase, index) => ({ phase, completed: index + 1, total: 8 }));

describe("server SlidePlan orchestration pipeline", () => {
  test("publishes a live snapshot once with exact progress and identity on all artifacts", async () => {
    const run = fixture("live"); const result = await runSlidePlanPipeline(run.input);
    expect(run.progress).toEqual(expectedProgress); expect(run.seen).toHaveLength(3);
    expect(run.seen.every((identity) => identity === run.seen[0])).toBe(true);
    expect(result.identity.slideIds).toHaveLength(7); expect(result.identity.claimIds).toEqual(["claim-launch"]);
    expect(result.identity.snapshot).toEqual({ meetingId: 17, transcriptVersionId: "transcript-v17", contentSha256: "a".repeat(64), lineCount: 1 });
    expect(result.planSha256).toBe(sha(result.planJson));
    expect(readFileSync(join(result.directory, "slide-plan.json"), "utf8")).toBe(result.planJson);
    const publication = JSON.parse(readFileSync(join(result.directory, "publication.json"), "utf8")) as { planSha256: string };
    expect(publication.planSha256).toBe(result.planSha256);
    expect(result.publicationSha256).toBe(sha(result.manifestJson)); expect(readdirSync(run.input.finalDirectory)).toContain("publication.json");
  });

  test("binds confirmed Review identity to every publisher and publication.json while legacy identity stays unchanged", async () => {
    const run = fixture("finalized", modelContent(), true);
    const result = await runSlidePlanPipeline(run.input);
    expect(result.identity).toMatchObject({ reviewId: review.reviewId, reviewedItemIds: ["claim-launch"] });
    expect(run.seen).toHaveLength(3);
    expect(run.seen.every((identity) => identity.reviewId === review.reviewId && identity.reviewedItemIds?.[0] === "claim-launch")).toBe(true);
    const publication = JSON.parse(readFileSync(join(result.directory, "publication.json"), "utf8")) as { identity: PipelineIdentity };
    expect(publication.identity).toEqual(result.identity);

    const legacy = fixture("finalized");
    const legacyResult = await runSlidePlanPipeline(legacy.input);
    expect(legacyResult.identity).not.toHaveProperty("reviewId");
    expect(legacyResult.identity).not.toHaveProperty("reviewedItemIds");
  });

  test("provider omission of confirmed Review evidence publishes nothing", async () => {
    const omitted = modelContent();
    omitted.claims = [];
    const run = fixture("finalized", omitted, true);
    await expect(runSlidePlanPipeline(run.input)).rejects.toMatchObject({ code: "model-output-invalid", attempts: 2 });
    expect(run.seen).toHaveLength(0);
    expect(existsSync(run.input.finalDirectory)).toBe(false);
    expect(existsSync(run.input.stagingDirectory)).toBe(false);
  });

  test("accepts an immutable finalized snapshot without mutating it", async () => {
    const run = fixture("finalized"); const before = structuredClone(run.input.snapshot);
    const result = await runSlidePlanPipeline(run.input);
    expect(run.input.snapshot).toEqual(before); expect(result.identity.planId).toBe("plan-pipeline"); expect(existsSync(run.input.stagingDirectory)).toBe(false);
  });

  test("rejects malformed and noisy input before any partial publication", async () => {
    const malformed = fixture("live");
    await expect(runSlidePlanPipeline({ ...malformed.input, planner: { ...malformed.input.planner, complete: async () => "noise```json" } })).rejects.toThrow(); expect(existsSync(malformed.input.finalDirectory)).toBe(false); expect(existsSync(malformed.input.stagingDirectory)).toBe(false);
    const noisy = fixture("live");
    await expect(runSlidePlanPipeline({ ...noisy.input, snapshot: { ...noisy.input.snapshot, lines: [{ seq: 1, speaker: null, text: "um... thanks" }] } })).rejects.toThrow("no substantive"); expect(noisy.seen).toHaveLength(0);
  });

  test("rejects a persisted plan from a stale transcript snapshot", async () => {
    const source = fixture("finalized");
    const published = await runSlidePlanPipeline(source.input);
    const stale = fixture("finalized");
    await expect(runSlidePlanPipeline({
      ...stale.input,
      snapshot: { ...stale.input.snapshot, contentSha256: "b".repeat(64) },
      existingPlan: JSON.parse(published.planJson),
    })).rejects.toThrow("exact transcript snapshot");
    expect(stale.seen).toHaveLength(0);
  });

  test("allows a valid human revision to change the generated seven-layout mix", async () => {
    const source = fixture("finalized");
    const published = await runSlidePlanPipeline(source.input);
    const revised = JSON.parse(published.planJson);
    revised.slides = revised.slides.slice(0, -1);
    const run = fixture("finalized");
    const result = await runSlidePlanPipeline({ ...run.input, existingPlan: revised });
    expect(JSON.parse(result.planJson).slides).toHaveLength(6);
    expect(result.identity.slideIds).toEqual(revised.slides.map((entry: PlanSlide) => entry.id));
  });

  test("uses a deterministic managed fallback for a missing informative asset", async () => {
    const missing: PlanAsset = { id: "asset-hero", purpose: "informative", kind: "image", localPath: `assets/${"b".repeat(64)}.png`, mediaType: "image/png", width: 20, height: 20, byteLength: 99, sha256: "b".repeat(64), altDescription: "Launch evidence", source: { kind: "local", originalPath: "missing.png" }, claimIds: ["claim-launch"] };
    const run = fixture("finalized", modelContent(missing)); let calls = 0;
    const fallback: PipelineAssetPolicy["fallback"] = async (asset, context) => {
      calls += 1; const bytes = new TextEncoder().encode("deterministic fallback"); const digest = sha(bytes);
      mkdirSync(join(context.managedAssetRoot, "assets"), { recursive: true }); writeFileSync(join(context.managedAssetRoot, "assets", `${digest}.svg`), bytes);
      return { ...asset, localPath: `assets/${digest}.svg`, mediaType: "image/svg+xml", byteLength: bytes.length, sha256: digest, source: { kind: "generated", generator: "fallback-v1" } };
    };
    const result = await runSlidePlanPipeline({ ...run.input, assetPolicy: { ...run.input.assetPolicy, fallback } }); expect(calls).toBe(1); expect(result.assetManifest.assets[0]?.source).toEqual({ kind: "generated", generator: "fallback-v1" });
  });

  test("cleans staging and preserves an existing-free final boundary on injected export failure", async () => {
    const run = fixture("live"); const pptx: PipelineArtifactPublisher = async (request) => { mkdirSync(request.outputDirectory, { recursive: true }); writeFileSync(join(request.outputDirectory, "partial.pptx"), "partial"); throw new Error("pptx exploded"); };
    await expect(runSlidePlanPipeline({ ...run.input, publishers: { ...run.input.publishers, pptx } })).rejects.toThrow("pptx exploded"); expect(existsSync(run.input.stagingDirectory)).toBe(false); expect(existsSync(run.input.finalDirectory)).toBe(false); expect(run.progress).toEqual(expectedProgress.slice(0, 5));
  });
});
