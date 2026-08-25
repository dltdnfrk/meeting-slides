import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ChatTransport } from "../../src/llm.ts";
import type { CompileJobId, CompileUpdate } from "../../src/session.ts";
import { MEETING_PAPER_STYLE_PROFILE } from "../../src/slides/theme/meeting-paper.ts";
import {
  runSlidePlanServerAction,
  type SlidePlanTranscriptInput,
} from "../../src/slides/server-action.ts";

const FONT = resolve(import.meta.dir, "../../public/fonts/pretendard-variable.woff2");
const BROWSERS = resolve(import.meta.dir, "../../vendor/ms-playwright");
const SLIDES_GRAB = resolve(import.meta.dir, "../../node_modules/.bin/slides-grab");
const SANDBOX = "(version 1)(allow default)(deny network*)";
const lines = [{ seq: 1, speaker: "Mina", text: "The beta launches Friday and Mina owns the release notes." }] as const;
const confirmedReview = { reviewId: "review-v41", transcriptVersionId: "final-v41", items: [{ id: "claim-launch", kind: "decision", description: "The beta launches Friday.", source: { transcriptVersionId: "final-v41", startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }, reviewState: "confirmed" }] } as const;
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
let roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function snapshotFromPrompt(prompt: string): { transcriptVersionId: string } {
  const match = prompt.match(/<transcript-snapshot>([^<]+)<\/transcript-snapshot>/);
  if (match === null) throw new Error("missing transcript snapshot");
  return JSON.parse(match[1]!) as { transcriptVersionId: string };
}

function modelOutput(transcriptVersionId: string, withMissingAsset = false): string {
  const bind = ["claim-launch"];
  const base = (id: string, layout: string, title: string) => ({ id, layout, storyRole: "argument", title, editorialPaths: [], assetIds: [] });
  const claim = { id: "claim-launch", kind: "decision", text: "The beta launches Friday.", sources: [{ transcriptVersionId, startSeq: 1, endSeq: 1, evidenceQuote: "The beta launches Friday" }], method: "reviewed" };
  const missingHash = "b".repeat(64);
  const asset = { id: "asset-proof", purpose: "informative", kind: "image", localPath: `assets/${missingHash}.png`, mediaType: "image/png", width: 320, height: 180, byteLength: 99, sha256: missingHash, altDescription: "Launch proof", source: { kind: "local", originalPath: "missing.png" }, claimIds: bind };
  const slides = [
    { ...base("slide-hero", "hero", "The beta launches Friday"), storyRole: "opening", payload: { variant: "cover", statement: "Friday launch" }, bindings: { title: bind, statement: bind }, assetIds: withMissingAsset ? [asset.id] : [] },
    { ...base("slide-summary", "summary", "The launch has a clear owner"), payload: { mode: "overview", items: ["Mina owns release notes"] }, bindings: { title: bind, "items[0]": bind } },
    { ...base("slide-decision", "decision", "Friday is the committed launch date"), storyRole: "decision", payload: { decision: "Launch Friday", rationale: ["The team committed to Friday"] }, bindings: { title: bind, decision: bind, "rationale[0]": bind } },
    { ...base("slide-comparison", "comparison", "Ownership removes the release gap"), payload: { sides: [{ label: "Before", items: ["No owner"] }, { label: "After", items: ["Mina owns notes"] }] }, bindings: { title: bind, "sides[0].items[0]": bind, "sides[1].items[0]": bind }, editorialPaths: ["sides[0].label", "sides[1].label"] },
    { ...base("slide-timeline", "timeline", "The release moves toward Friday"), payload: { mode: "process", events: [{ label: "Friday", text: "Beta launches" }] }, bindings: { title: bind, "events[0].text": bind }, editorialPaths: ["events[0].label"] },
    { ...base("slide-metrics", "metrics", "One date focuses the launch"), payload: { mode: "cards", metrics: [{ label: "Launch", value: "Friday", detail: "Beta release" }] }, bindings: { title: bind, "metrics[0].label": bind, "metrics[0].value": bind, "metrics[0].detail": bind } },
    { ...base("slide-actions", "actions", "Mina closes the release loop"), storyRole: "commitment", payload: { items: [{ task: "Publish release notes", owner: "Mina", due: "Friday" }] }, bindings: { title: bind, "items[0].task": bind, "items[0].owner": bind, "items[0].due": bind } },
  ];
  return JSON.stringify({ schemaVersion: 1, revision: 0, title: "Friday beta launch", theme: MEETING_PAPER_STYLE_PROFILE, claims: [claim], assets: withMissingAsset ? [asset] : [], slides });
}

function fixture(transcript: SlidePlanTranscriptInput, withMissingAsset = false, transport?: ChatTransport) {
  const root = mkdtempSync(join(tmpdir(), "slide-server-action-")); roots.push(root);
  const events: CompileUpdate[] = [];
  const model: ChatTransport = transport ?? { chat: async (prompt) => modelOutput(snapshotFromPrompt(prompt).transcriptVersionId, withMissingAsset) };
  return { root, events, input: { jobId: "compile-slide-plan-test" as CompileJobId, meetingId: 41, transcript, transport: model, outputRoot: join(root, "output"), cacheRoot: join(root, "cache"), fontSourcePath: FONT, tools: { slidesGrabPath: SLIDES_GRAB, playwrightBrowsersPath: BROWSERS, sandboxExecutable: "/usr/bin/sandbox-exec", sandboxProfile: SANDBOX, timeoutMs: 120_000 }, createId: () => "plan-server-action", now: () => "2026-08-15T10:00:00.000Z", send: (event: CompileUpdate) => events.push(event) } };
}

function artifactNames(directory: string): string[] {
  const walk = (path: string, prefix = ""): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
  return walk(directory).sort();
}

describe("production SlidePlan server action", () => {
  test("publishes a real four-format deck with immutable confirmed Review identity and deterministic fallback", async () => {
    const run = fixture({ state: "finalized", lines, transcriptVersionId: "final-v41", contentSha256: "c".repeat(64), confirmedReview }, true);
    const result = await runSlidePlanServerAction(run.input);
    expect(run.events.slice(0, 8).map((event) => event.completed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(run.events[run.events.length - 1]).toMatchObject({ type: "compile", status: "success", jobId: run.input.jobId, meetingId: 41, path: result.directory });
    expect(run.events.filter((event) => event.status === "success" || event.status === "error")).toHaveLength(1);
    expect(result.identity.snapshot.transcriptVersionId).toBe("final-v41");
    expect(result.identity).toMatchObject({ reviewId: "review-v41", reviewedItemIds: ["claim-launch"] });
    const publication = JSON.parse(readFileSync(join(result.directory, "publication.json"), "utf8")) as { identity: { reviewId: string; reviewedItemIds: string[] } };
    expect(publication.identity).toMatchObject({ reviewId: "review-v41", reviewedItemIds: ["claim-launch"] });
    expect(result.assetManifest.assets[0]?.source).toEqual({ kind: "generated", generator: "meeting-asset-fallback-svg-v1" });
    const names = artifactNames(result.directory);
    expect(names).toContain("slide-plan.json");
    expect(names).toContain("standalone/index.html");
    expect(names.filter((name) => name.startsWith("standalone/slides/") && name.endsWith(".html"))).toHaveLength(7);
    expect(names).toEqual(expect.arrayContaining(["editable/deck.pptx", "editable/manifest.json", "editable/receipt.json", "raster/deck.pdf", "raster/manifest.json", "raster/receipt.json"]));
    expect(names.filter((name) => name.startsWith("raster/png/") && name.endsWith(".png"))).toHaveLength(7);
    expect(readFileSync(join(result.directory, "editable/deck.pptx")).subarray(0, 2).toString()).toBe("PK");
    expect(readFileSync(join(result.directory, "raster/deck.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha(readFileSync(join(run.input.cacheRoot, MEETING_PAPER_STYLE_PROFILE.font.localPath)))).toBe(MEETING_PAPER_STYLE_PROFILE.font.sha256);
  }, 120_000);

  test("preserves an explicit finalized transcript identity", async () => {
    const identity = { transcriptVersionId: "final-v41", contentSha256: "c".repeat(64) };
    const run = fixture({ state: "finalized", lines, ...identity });
    const result = await runSlidePlanServerAction(run.input);
    expect(result.identity.snapshot).toEqual({ meetingId: 41, ...identity, lineCount: 1 });
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
  test("emits success only after durable commit and removes an orphan when commit fails", async () => {
    const run = fixture({ state: "live", lines });
    const expectedDirectory = join(run.input.outputRoot, `meeting-41-${sha(JSON.stringify(lines.map(({ seq, speaker, text }) => ({ seq, speaker, text }))))}-${sha("plan-server-action").slice(0, 12)}`);
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

  test("broadcasts one error and leaves no partial publication when the provider fails", async () => {
    const run = fixture({ state: "live", lines }, false, { chat: async () => { throw new Error("provider unavailable"); } });
    await expect(runSlidePlanServerAction(run.input)).rejects.toThrow("Model output did not satisfy");
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toMatchObject({ type: "compile", status: "error", jobId: run.input.jobId, meetingId: 41 });
    expect(existsSync(run.input.outputRoot) ? readdirSync(run.input.outputRoot) : []).toEqual([]);
  });
});
