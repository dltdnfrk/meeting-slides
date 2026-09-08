import { describe, expect, test } from "bun:test";

import {
  SlidePlannerError,
  planTranscriptToSlides,
  type SlidePlannerCompletion,
  type SlidePlannerCompletionRequest,
  type TranscriptSnapshot,
} from "../../src/slides/planning/planner.ts";
import type { SlidePlan } from "../../src/slides/model/plan.ts";

const SNAPSHOT_SHA = "a".repeat(64);
const FONT_SHA = "b".repeat(64);
const ASSET_SHA = "c".repeat(64);
const CREATED_AT = "2026-08-14T10:00:00.000Z";
const UPDATED_AT = "2026-08-14T10:05:00.000Z";

const snapshot: TranscriptSnapshot = {
  state: "finalized",
  meetingId: 42,
  transcriptVersionId: "transcript-v7",
  contentSha256: SNAPSHOT_SHA,
  lines: [
    { seq: 1, speaker: "Mina", text: "Retention increased by twelve percent after the cohort change." },
    { seq: 2, speaker: "Owen", text: "Quality is the release gate, so QA finishes before publication." },
    { seq: 3, speaker: "Mina", text: "We agreed the beta launches Friday." },
    { seq: 4, speaker: "Owen", text: "Mina will publish the release notes by Thursday." },
  ],
};

const confirmedReview = {
  reviewId: "review-v7",
  transcriptVersionId: snapshot.transcriptVersionId,
  items: [
    { id: "claim-launch", kind: "decision", description: "The beta launches Friday.", source: { transcriptVersionId: snapshot.transcriptVersionId, startSeq: 3, endSeq: 3, evidenceQuote: snapshot.lines[2]!.text }, reviewState: "confirmed", attributedAttendeeId: "att-mina" },
    { id: "claim-action", kind: "action_item", description: "Mina publishes the release notes Thursday.", source: { transcriptVersionId: snapshot.transcriptVersionId, startSeq: 4, endSeq: 4, evidenceQuote: snapshot.lines[3]!.text }, reviewState: "confirmed", assigneeAttendeeId: "att-mina", deadline: "2026-08-20", deadlineText: "Thursday", attributedAttendeeId: "att-owen" },
    { id: "claim-gate", kind: "open_item", description: "Quality remains the release gate.", source: { transcriptVersionId: snapshot.transcriptVersionId, startSeq: 2, endSeq: 2, evidenceQuote: "Quality is the release gate" }, reviewState: "confirmed", attributedAttendeeId: null },
  ],
  attendees: [
    { attendeeId: "att-mina", displayName: "Mina" },
    { attendeeId: "att-owen", displayName: "Owen" },
  ],
} as const;

const reviewedSnapshot: TranscriptSnapshot = { ...snapshot, confirmedReview };

type ModelPlanContent = Omit<SlidePlan, "planId" | "snapshot" | "createdAt" | "updatedAt">;

function validModelPlan(): ModelPlanContent {
  return {
    schemaVersion: 1,
    revision: 0,
    title: "Evidence to launch",
    theme: {
      id: "meeting-paper-v1",
      canvas: { width: 1280, height: 720 },
      font: {
        family: "Pretendard",
        localPath: "fonts/Pretendard-Regular.woff2",
        sha256: FONT_SHA,
      },
      colors: {
        paper: "F6F1E8",
        raised: "FFFDF8",
        ink: "14213D",
        muted: "5B6475",
        rule: "D9D2C4",
        coral: "AD4B2F",
        blue: "335C81",
        focus: "1E5AA8",
      },
      spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
      typography: {
        display: { size: 64, lineHeight: 68, weight: 700 },
        heading: { size: 36, lineHeight: 42, weight: 700 },
        body: { size: 22, lineHeight: 30, weight: 400 },
        label: { size: 16, lineHeight: 20, weight: 600 },
      },
      stroke: { thin: 1, strong: 3 },
      radius: { small: 8, large: 24 },
    },
    claims: [
      {
        id: "claim-retention",
        kind: "fact",
        text: "Retention increased by 12%.",
        sources: [{
          transcriptVersionId: snapshot.transcriptVersionId,
          startSeq: 1,
          endSeq: 1,
          evidenceQuote: snapshot.lines[0]!.text,
        }],
        method: "extractive",
      },
      {
        id: "claim-gate",
        kind: "decision",
        text: "Quality remains the release gate.",
        sources: [{
          transcriptVersionId: snapshot.transcriptVersionId,
          startSeq: 2,
          endSeq: 2,
          evidenceQuote: "Quality is the release gate",
        }],
        method: "reviewed",
      },
      {
        id: "claim-launch",
        kind: "decision",
        text: "The beta launches Friday.",
        sources: [{
          transcriptVersionId: snapshot.transcriptVersionId,
          startSeq: 3,
          endSeq: 3,
          evidenceQuote: snapshot.lines[2]!.text,
        }],
        method: "reviewed",
      },
      {
        id: "claim-action",
        kind: "action",
        text: "Mina publishes the release notes Thursday.",
        sources: [{
          transcriptVersionId: snapshot.transcriptVersionId,
          startSeq: 4,
          endSeq: 4,
          evidenceQuote: snapshot.lines[3]!.text,
        }],
        method: "reviewed",
      },
    ],
    assets: [{
      id: "asset-retention-chart",
      purpose: "informative",
      kind: "chart",
      localPath: `assets/${ASSET_SHA}.png`,
      mediaType: "image/png",
      width: 1280,
      height: 720,
      byteLength: 4096,
      sha256: ASSET_SHA,
      altDescription: "A chart showing retention up twelve percent.",
      source: { kind: "generated", generator: "retention-series-v1" },
      claimIds: ["claim-retention"],
    }],
    slides: [
      {
        id: "slide-opening",
        layout: "hero",
        storyRole: "opening",
        title: "Evidence changed the launch decision",
        payload: { variant: "cover", statement: "The beta launches Friday." },
        bindings: { title: ["claim-launch"], statement: ["claim-launch"] },
        editorialPaths: [],
        assetIds: [],
      },
      {
        id: "slide-signal",
        layout: "metrics",
        storyRole: "argument",
        title: "Retention rose while the quality gate remains unresolved",
        payload: {
          mode: "chart",
          metrics: [{ label: "Retention", value: "+12%", detail: "After the cohort change" }],
        },
        bindings: {
          title: ["claim-retention", "claim-gate"],
          "metrics[0].label": ["claim-retention"],
          "metrics[0].value": ["claim-retention"],
          "metrics[0].detail": ["claim-retention"],
        },
        editorialPaths: [],
        assetIds: ["asset-retention-chart"],
      },
      {
        id: "slide-commitment",
        layout: "actions",
        storyRole: "commitment",
        title: "Friday launch has a Thursday owner",
        payload: {
          items: [{ task: "Publish the release notes", owner: "Mina", due: "Thursday" }],
        },
        bindings: {
          title: ["claim-launch", "claim-action"],
          "items[0].task": ["claim-action"],
          "items[0].owner": ["claim-action"],
          "items[0].due": ["claim-action"],
        },
        editorialPaths: [],
        assetIds: [],
      },
      {
        id: "slide-overview",
        layout: "summary",
        storyRole: "context",
        title: "Quality gate confirmation remains open",
        payload: { mode: "overview", items: ["Quality gate needs confirmation."] },
        bindings: { title: ["claim-gate"], "items[0]": ["claim-gate"] },
        editorialPaths: [],
        assetIds: [],
      },
      {
        id: "slide-call",
        layout: "decision",
        storyRole: "decision",
        title: "Friday is the launch date",
        payload: { decision: "The beta launches Friday.", rationale: ["Quality gate needs confirmation."] },
        bindings: { title: ["claim-launch"], decision: ["claim-launch"], "rationale[0]": ["claim-gate"] },
        editorialPaths: [],
        assetIds: [],
      },
      {
        id: "slide-compare",
        layout: "comparison",
        storyRole: "argument",
        title: "Retention versus the unresolved quality gate",
        payload: {
          sides: [
            { label: "Signal", items: ["Retention increased by 12%."] },
            { label: "Gate", items: ["Quality gate needs confirmation."] },
          ],
        },
        bindings: {
          title: ["claim-retention", "claim-gate"],
          "sides[0].items[0]": ["claim-retention"],
          "sides[1].items[0]": ["claim-gate"],
        },
        editorialPaths: ["sides[0].label", "sides[1].label"],
        assetIds: [],
      },
      {
        id: "slide-path",
        layout: "timeline",
        storyRole: "commitment",
        title: "Notes go out Thursday",
        payload: {
          mode: "process",
          events: [{ label: "Notes", text: "Mina publishes the release notes Thursday." }],
        },
        bindings: { title: ["claim-action"], "events[0].text": ["claim-action"] },
        editorialPaths: ["events[0].label"],
        assetIds: [],
      },
    ],
  };
}

function completionSequence(outputs: readonly string[]): {
  complete: SlidePlannerCompletion;
  calls: SlidePlannerCompletionRequest[];
} {
  const calls: SlidePlannerCompletionRequest[] = [];
  const complete: SlidePlannerCompletion = async (request: SlidePlannerCompletionRequest) => {
    calls.push(request);
    const output = outputs[calls.length - 1];
    if (output === undefined) throw new Error(`unexpected completion call ${calls.length}`);
    return output;
  };
  return { complete, calls };
}

function plannerOptions(complete: SlidePlannerCompletion, planId = "plan-fixed", now = CREATED_AT) {
  let timestampCall = 0;
  return {
    complete,
    createId: () => planId,
    now: () => timestampCall++ === 0 ? now : UPDATED_AT,
  } as const;
}

function contractFrom(systemPrompt: string): Record<string, unknown> {
  const match = systemPrompt.match(/<slide-plan-contract>([\s\S]+)<\/slide-plan-contract>/u);
  expect(match, "system prompt must carry a machine-readable slide-plan contract").not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

async function capturedError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("expected action to reject");
}

function withoutInjectedMetadata(plan: SlidePlan): unknown {
  const copy = structuredClone(plan) as Partial<SlidePlan>;
  delete copy.planId;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

describe("transcript-to-SlidePlan planner", () => {
  test("sends Claude a machine-readable narrative, layout, rendering, token, citation, and asset contract", async () => {
    const model = completionSequence([JSON.stringify(validModelPlan())]);

    await planTranscriptToSlides(snapshot, plannerOptions(model.complete));

    expect(model.calls).toHaveLength(1);
    const request = model.calls[0]!;
    expect(request.attempt).toBe("initial");
    expect(request.responseFormat).toBe("json");
    expect(contractFrom(request.systemPrompt)).toMatchObject({
      narrative: {
        workflow: "coherent-title-only-story-first",
        titlesFormNarrative: true,
      },
      primaryLayouts: ["hero", "summary", "decision", "comparison", "timeline", "metrics", "actions"],
      layoutCoverage: {
        slideCount: 7,
        minimumDistinctFamilies: 4,
        reuseAllowed: true,
        chooseByEvidence: true,
        unsupportedFamilyCanBeOmitted: true,
      },
      modelOutput: { format: "strict-json", htmlAllowed: false },
      rendering: {
        canvas: { width: 1280, height: 720 },
        projectionSafe: true,
        density: { maxBodyItemsPerSlide: 6, minimumBodyFontSize: 22 },
      },
      designTokens: ["colors", "spacing", "typography", "stroke", "radius"],
      evidence: {
        citationsRequired: true,
        sourceRangesRequired: true,
        quotesMustMatchTranscript: true,
        confirmedReview: {
          ownerDueSource: "confirmedReview",
          ownerField: "assigneeAttendeeId",
          dueFields: ["deadlineText", "deadline"],
          attendeeDisplayNameField: "displayName",
        },
      },
      assets: {
        manifestOnly: true,
        provenanceRequired: true,
        informativeAssetsRequireClaimIds: true,
        remoteHotlinksAllowed: false,
      },
    });
  });

  test("parses strict model content and binds it to one exact, detached immutable snapshot", async () => {
    const model = completionSequence([JSON.stringify(validModelPlan())]);

    const plan = await planTranscriptToSlides(snapshot, plannerOptions(model.complete));

    expect(plan.snapshot).toEqual({
      meetingId: snapshot.meetingId,
      transcriptVersionId: snapshot.transcriptVersionId,
      contentSha256: snapshot.contentSha256,
      lineCount: snapshot.lines.length,
    });
    expect(plan.planId).toBe("plan-fixed");
    expect(plan.createdAt).toBe(CREATED_AT);
    expect(plan.updatedAt).toBe(UPDATED_AT);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.snapshot)).toBe(true);

    const suppliedSnapshot = model.calls[0]!.snapshot;
    expect(suppliedSnapshot).toEqual(snapshot);
    expect(suppliedSnapshot).not.toBe(snapshot);
    expect(Object.isFrozen(suppliedSnapshot)).toBe(true);
    expect(Object.isFrozen(suppliedSnapshot.lines)).toBe(true);
    expect(Object.isFrozen(suppliedSnapshot.lines[0]!)).toBe(true);
  });

  test("accepts an explicitly live immutable capture and preserves its exact source identity", async () => {
    const liveSnapshot: TranscriptSnapshot = { ...snapshot, state: "live" };
    const model = completionSequence([JSON.stringify(validModelPlan())]);

    const plan = await planTranscriptToSlides(liveSnapshot, plannerOptions(model.complete));

    expect(model.calls[0]!.snapshot.state).toBe("live");
    expect(plan.snapshot).toEqual({
      meetingId: 42,
      transcriptVersionId: "transcript-v7",
      contentSha256: SNAPSHOT_SHA,
      lineCount: 4,
    });
  });

  test("exposes immutable confirmed Review evidence as machine-readable guidance and retains every item exactly", async () => {
    const content = validModelPlan();
    content.claims[1]!.kind = "fact";
    const model = completionSequence([JSON.stringify(content)]);

    const plan = await planTranscriptToSlides(reviewedSnapshot, plannerOptions(model.complete));

    const prompt = model.calls[0]!.userPrompt;
    const match = prompt.match(/<confirmed-review>([^<]+)<\/confirmed-review>/u);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(confirmedReview);
    expect(model.calls[0]!.snapshot.confirmedReview).toEqual(confirmedReview);
    expect(Object.isFrozen(model.calls[0]!.snapshot.confirmedReview)).toBe(true);
    expect(Object.isFrozen(model.calls[0]!.snapshot.confirmedReview!.items)).toBe(true);
    expect(Object.isFrozen(model.calls[0]!.snapshot.confirmedReview!.items[0]!.source)).toBe(true);
    expect(plan.claims.filter((claim) => claim.method === "reviewed").map(({ id, kind, text, sources }) => ({ id, kind, text, sources }))).toEqual([
      { id: "claim-gate", kind: "fact", text: "Quality remains the release gate.", sources: [confirmedReview.items[2]!.source] },
      { id: "claim-launch", kind: "decision", text: "The beta launches Friday.", sources: [confirmedReview.items[0]!.source] },
      { id: "claim-action", kind: "action", text: "Mina publishes the release notes Thursday.", sources: [confirmedReview.items[1]!.source] },
    ]);
  });

  test.each([
    ["malformed claim", (plan: ModelPlanContent) => { Object.assign(plan.claims[2]!, { method: "candidate" }); }],
    ["changed text", (plan: ModelPlanContent) => { plan.claims[2]!.text = "The beta launches Saturday."; }],
    ["changed source", (plan: ModelPlanContent) => { plan.claims[3]!.sources[0]!.evidenceQuote = "publish the release notes"; }],
    ["omitted item", (plan: ModelPlanContent) => { plan.claims = plan.claims.filter((claim) => claim.id !== "claim-action"); }],
    ["invented reviewed claim", (plan: ModelPlanContent) => { plan.claims[0]!.method = "reviewed"; }],
    ["wrong kind", (plan: ModelPlanContent) => { plan.claims[2]!.kind = "fact"; }],
    ["wrong method", (plan: ModelPlanContent) => { plan.claims[2]!.method = "extractive"; }],
    ["wrong version", (plan: ModelPlanContent) => { plan.claims[2]!.sources[0]!.transcriptVersionId = "transcript-v8"; }],
    ["invented owner", (plan: ModelPlanContent) => {
      const actions = plan.slides.find((slide) => slide.layout === "actions");
      if (actions?.layout === "actions") actions.payload.items[0]!.owner = "Nobody";
    }],
    ["invented due", (plan: ModelPlanContent) => {
      const actions = plan.slides.find((slide) => slide.layout === "actions");
      if (actions?.layout === "actions") actions.payload.items[0]!.due = "Never";
    }],
  ])("repairs then returns a typed failure for %s in confirmed Review claims", async (_label, mutate) => {
    const invalid = validModelPlan();
    invalid.claims[1]!.kind = "fact";
    mutate(invalid);
    const model = completionSequence([JSON.stringify(invalid), JSON.stringify(invalid)]);

    const error = await capturedError(planTranscriptToSlides(reviewedSnapshot, plannerOptions(model.complete)));

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.validationFailure).toBeDefined();
    expect(error).toMatchObject({ code: "model-output-invalid", attempts: 2 });
  });

  test("rejects action owner and due fields rebound away from their reviewed action", async () => {
    const invalid = validModelPlan();
    invalid.claims[1]!.kind = "fact";
    const actions = invalid.slides.find((slide) => slide.layout === "actions");
    if (actions?.layout !== "actions") throw new Error("expected actions slide");
    actions.payload.items[0]!.due = "Friday";
    actions.bindings["items[0].owner"] = ["claim-launch"];
    actions.bindings["items[0].due"] = ["claim-launch"];
    const model = completionSequence([JSON.stringify(invalid), JSON.stringify(invalid)]);

    const error = await capturedError(
      planTranscriptToSlides(reviewedSnapshot, plannerOptions(model.complete)),
    );

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.validationFailure).toMatchObject({ kind: "evidence-mismatch" });
    expect(error).toMatchObject({ code: "model-output-invalid", attempts: 2 });
  });

  test("repairs evidence whose quote or seq range does not match the bound transcript", async () => {
    const wrongEvidence = validModelPlan();
    wrongEvidence.claims[0]!.sources[0] = {
      transcriptVersionId: snapshot.transcriptVersionId,
      startSeq: 2,
      endSeq: 2,
      evidenceQuote: "Retention increased by twelve percent after the cohort change.",
    };
    const model = completionSequence([
      JSON.stringify(wrongEvidence),
      JSON.stringify(validModelPlan()),
    ]);

    const plan = await planTranscriptToSlides(snapshot, plannerOptions(model.complete));

    expect(plan.claims[0]!.sources[0]).toEqual({
      transcriptVersionId: "transcript-v7",
      startSeq: 1,
      endSeq: 1,
      evidenceQuote: snapshot.lines[0]!.text,
    });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.attempt).toBe("repair");
    expect(model.calls[1]!.validationFailure).toMatchObject({ kind: "evidence-mismatch" });
  });

  test("makes exactly one bounded repair attempt before returning a typed model-output failure", async () => {
    const model = completionSequence([
      "not JSON",
      JSON.stringify({ schemaVersion: 1, title: "still incomplete" }),
    ]);

    const error = await capturedError(
      planTranscriptToSlides(snapshot, plannerOptions(model.complete)),
    );

    expect(model.calls).toHaveLength(2);
    expect(model.calls.map((call) => call.attempt)).toEqual(["initial", "repair"]);
    expect(error).toBeInstanceOf(SlidePlannerError);
    expect(error).toMatchObject({ code: "model-output-invalid", attempts: 2 });
  });

  test.each([
    ["empty", []],
    ["noise only", [
      { seq: 1, speaker: null, text: "um" },
      { seq: 2, speaker: "A", text: "okay" },
      { seq: 3, speaker: "B", text: "thank you" },
    ]],
  ])("rejects an %s transcript before calling the model", async (_label, lines) => {
    const unusable: TranscriptSnapshot = { ...snapshot, lines };
    const model = completionSequence([]);

    const error = await capturedError(
      planTranscriptToSlides(unusable, plannerOptions(model.complete)),
    );

    expect(model.calls).toHaveLength(0);
    expect(error).toBeInstanceOf(SlidePlannerError);
    expect(error).toMatchObject({ code: "insufficient-transcript", attempts: 0 });
  });

  test("is deterministic for identical snapshots and model content apart from injected IDs and timestamps", async () => {
    const output = JSON.stringify(validModelPlan());
    const firstModel = completionSequence([output]);
    const secondModel = completionSequence([output]);

    const first = await planTranscriptToSlides(
      snapshot,
      plannerOptions(firstModel.complete, "plan-first", "2026-08-14T08:00:00.000Z"),
    );
    const second = await planTranscriptToSlides(
      snapshot,
      plannerOptions(secondModel.complete, "plan-second", "2026-08-15T08:00:00.000Z"),
    );

    expect(first.planId).toBe("plan-first");
    expect(second.planId).toBe("plan-second");
    expect(withoutInjectedMetadata(first)).toEqual(withoutInjectedMetadata(second));
  });

  test("includes the confirmed review overview and topic titles in the planner prompt when a summary is present", async () => {
    const summary = {
      overview: "Quality stays the gate and the beta launches Friday.",
      topics: [
        {
          title: "Quality gate",
          summary: "Quality remains the release gate.",
          source: {
            transcriptVersionId: snapshot.transcriptVersionId,
            startSeq: 2,
            endSeq: 2,
          },
        },
        {
          title: "Friday launch",
          summary: "The beta launches Friday.",
          source: {
            transcriptVersionId: snapshot.transcriptVersionId,
            startSeq: 3,
            endSeq: 3,
          },
        },
      ],
    } as const;
    const content = validModelPlan();
    content.claims[1]!.kind = "fact";
    const model = completionSequence([JSON.stringify(content)]);

    await planTranscriptToSlides(
      { ...reviewedSnapshot, confirmedReview: { ...confirmedReview, summary } },
      plannerOptions(model.complete),
    );

    const prompt = model.calls[0]!.userPrompt;
    const match = prompt.match(/<review-summary>([^<]+)<\/review-summary>/u);
    expect(match).not.toBeNull();
    expect(match![1]!).toContain(summary.overview);
    expect(match![1]!).toContain("Quality gate");
    expect(match![1]!).toContain("Friday launch");
    expect(model.calls[0]!.snapshot.confirmedReview?.summary).toEqual(summary);
  });

  test("omits the review-summary prompt section when confirmed review has no summary", async () => {
    const content = validModelPlan();
    content.claims[1]!.kind = "fact";
    const model = completionSequence([JSON.stringify(content)]);

    await planTranscriptToSlides(reviewedSnapshot, plannerOptions(model.complete));

    expect(model.calls[0]!.userPrompt).not.toContain("<review-summary>");
  });
});

describe("server-owned theme", () => {
  test("the supplied theme is authoritative: model output that omits theme parses into it", async () => {
    const content = validModelPlan() as Partial<ModelPlanContent>;
    const theme = structuredClone(content.theme!);
    delete content.theme;
    const model = completionSequence([JSON.stringify(content)]);
    const plan = await planTranscriptToSlides(snapshot, { ...plannerOptions(model.complete), theme });
    expect(plan.theme).toEqual(theme);
    expect(model.calls).toHaveLength(1);
  });

  test("a model-emitted theme never overrides the supplied theme", async () => {
    const content = validModelPlan();
    const theme = structuredClone(content.theme);
    content.theme = { ...content.theme, font: { family: "system-ui", localPath: "", sha256: "" } };
    const model = completionSequence([JSON.stringify(content)]);
    const plan = await planTranscriptToSlides(snapshot, { ...plannerOptions(model.complete), theme });
    expect(plan.theme).toEqual(theme);
  });

  test("the contract tells the model to omit theme", async () => {
    const model = completionSequence([JSON.stringify(validModelPlan())]);
    await planTranscriptToSlides(snapshot, plannerOptions(model.complete));
    const contract = contractFrom(model.calls[0]!.systemPrompt) as { modelOutput: { omitAuthoritativeFields: string[]; requiredFields: string[] } };
    expect(contract.modelOutput.omitAuthoritativeFields).toContain("theme");
    expect(contract.modelOutput.requiredFields).not.toContain("theme");
  });
});

describe("binding contract", () => {
  test("the contract spells out binding keys, factual paths and editorial paths per layout", async () => {
    const model = completionSequence([JSON.stringify(validModelPlan())]);
    await planTranscriptToSlides(snapshot, plannerOptions(model.complete));
    const contract = contractFrom(model.calls[0]!.systemPrompt) as {
      bindings: {
        keyFormat: string;
        titleKey: string;
        factualPaths: Record<string, string[]>;
        editorialPaths: Record<string, string[]>;
        example: Record<string, string[]>;
      };
    };
    expect(contract.bindings.titleKey).toBe("title");
    expect(contract.bindings.keyFormat).toContain("without");
    expect(contract.bindings.factualPaths).toEqual({
      hero: ["statement"],
      summary: ["items[i]"],
      decision: ["decision", "rationale[i]"],
      comparison: ["sides[i].items[j]"],
      timeline: ["events[i].text"],
      metrics: ["metrics[i].label", "metrics[i].value", "metrics[i].detail"],
      actions: ["items[i].task", "items[i].owner", "items[i].due"],
    });
    expect(contract.bindings.editorialPaths).toEqual({
      comparison: ["sides[i].label"],
      timeline: ["events[i].label"],
    });
    expect(Object.keys(contract.bindings.example)).toEqual(["title", "statement"]);
  });

  test("normalizes payload-prefixed binding keys before parse", async () => {
    const content = validModelPlan();
    const hero = content.slides[0]!;
    hero.bindings = { title: ["claim-launch"], "payload.statement": ["claim-launch"] };
    const model = completionSequence([JSON.stringify(content)]);
    const plan = await planTranscriptToSlides(snapshot, plannerOptions(model.complete));
    expect(plan.slides[0]!.bindings).toEqual({
      title: ["claim-launch"],
      statement: ["claim-launch"],
    });
  });

  test("moves comparison and timeline label bindings into editorialPaths", async () => {
    const content = validModelPlan();
    content.slides = content.slides.filter((slide) => slide.layout !== "comparison" && slide.layout !== "timeline");
    content.slides.push({
      id: "slide-compare",
      layout: "comparison",
      storyRole: "argument",
      title: "Quality stays the gate while retention rose",
      payload: {
        sides: [
          { label: "Signal", items: ["Retention increased by 12%."] },
          { label: "Gate", items: ["Quality remains the release gate."] },
        ],
      },
      bindings: {
        title: ["claim-retention", "claim-gate"],
        "payload.sides[0].label": ["claim-retention"],
        "payload.sides[0].items[0]": ["claim-retention"],
        "payload.sides[1].label": ["claim-gate"],
        "payload.sides[1].items[0]": ["claim-gate"],
      },
      editorialPaths: [],
      assetIds: [],
    }, {
      id: "slide-timeline",
      layout: "timeline",
      storyRole: "commitment",
      title: "Launch follows the Thursday note",
      payload: {
        mode: "process",
        events: [{ label: "Notes", text: "Mina publishes the release notes Thursday." }],
      },
      bindings: {
        title: ["claim-action"],
        "payload.events[0].label": ["claim-action"],
        "payload.events[0].text": ["claim-action"],
      },
      editorialPaths: [],
      assetIds: [],
    });
    const model = completionSequence([JSON.stringify(content)]);
    const plan = await planTranscriptToSlides(snapshot, plannerOptions(model.complete));
    const compare = plan.slides.find((slide) => slide.id === "slide-compare")!;
    const timeline = plan.slides.find((slide) => slide.id === "slide-timeline")!;
    expect(compare.editorialPaths).toEqual(["sides[0].label", "sides[1].label"]);
    expect(compare.bindings).toEqual({
      title: ["claim-retention", "claim-gate"],
      "sides[0].items[0]": ["claim-retention"],
      "sides[1].items[0]": ["claim-gate"],
    });
    expect(timeline.editorialPaths).toEqual(["events[0].label"]);
    expect(timeline.bindings).toEqual({
      title: ["claim-action"],
      "events[0].text": ["claim-action"],
    });
  });

  test("coerces unknown storyRole to the layout default so parse can proceed", async () => {
    const content = validModelPlan();
    content.slides[1]!.storyRole = "guardrails" as typeof content.slides[1]["storyRole"];
    content.slides[2]!.storyRole = "next-steps" as typeof content.slides[2]["storyRole"];
    const model = completionSequence([JSON.stringify(content)]);
    const plan = await planTranscriptToSlides(snapshot, plannerOptions(model.complete));
    expect(plan.slides[1]!.storyRole).toBe("argument");
    expect(plan.slides[2]!.storyRole).toBe("commitment");
  });

  test("rejects a plan that does not contain exactly seven slides", async () => {
    const content = validModelPlan();
    content.slides = content.slides.filter((slide) => slide.layout !== "actions");
    const omitted = JSON.stringify(content);
    const model = completionSequence([omitted, omitted]);
    const error = await capturedError(planTranscriptToSlides(snapshot, plannerOptions(model.complete)));
    expect(error).toBeInstanceOf(SlidePlannerError);
    expect((error as SlidePlannerError).validationFailure).toMatchObject({
      kind: "contract-invalid",
      path: "slides",
    });
  });
});
