import { describe, expect, test } from "bun:test";

import {
  parseSlidePlan,
  type SlidePlan,
} from "../../src/slides/model/plan-parser.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const validPlan: SlidePlan = {
  schemaVersion: 1,
  planId: "plan-launch-review",
  revision: 3,
  snapshot: {
    meetingId: 42,
    transcriptVersionId: "transcript-v7",
    contentSha256: SHA_A,
    lineCount: 14,
  },
  title: "Launch readiness review",
  theme: {
    id: "meeting-paper-v1",
    canvas: { width: 1280, height: 720 },
    font: {
      family: "Pretendard",
      localPath: "fonts/Pretendard-Regular.woff2",
      sha256: SHA_B,
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
      id: "claim-launch",
      kind: "decision",
      text: "The beta launches Friday.",
      sources: [{
        transcriptVersionId: "transcript-v7",
        startSeq: 1,
        endSeq: 2,
        evidenceQuote: "We agreed the beta launches Friday.",
      }],
      method: "reviewed",
    },
    {
      id: "claim-retention",
      kind: "fact",
      text: "Retention increased by 12%.",
      sources: [{
        transcriptVersionId: "transcript-v7",
        startSeq: 3,
        endSeq: 4,
        evidenceQuote: "Retention increased by twelve percent.",
      }],
      method: "extractive",
    },
    {
      id: "claim-quote",
      kind: "quote",
      text: "Quality is the release gate.",
      sources: [{
        transcriptVersionId: "transcript-v7",
        startSeq: 5,
        endSeq: 5,
        evidenceQuote: "Quality is the release gate.",
      }],
      method: "verbatim",
    },
    {
      id: "claim-action",
      kind: "action",
      text: "Mina publishes the release notes Thursday.",
      sources: [{
        transcriptVersionId: "transcript-v7",
        startSeq: 6,
        endSeq: 7,
        evidenceQuote: "Mina will publish the release notes by Thursday.",
      }],
      method: "reviewed",
    },
    {
      id: "claim-process",
      kind: "fact",
      text: "QA precedes beta publication.",
      sources: [
        {
          transcriptVersionId: "transcript-v7",
          startSeq: 8,
          endSeq: 9,
          evidenceQuote: "QA finishes first.",
        },
        {
          transcriptVersionId: "transcript-v7",
          startSeq: 10,
          endSeq: 11,
          evidenceQuote: "Then we publish the beta.",
        },
      ],
      method: "extractive",
    },
  ],
  assets: [{
    id: "asset-retention-chart",
    purpose: "informative",
    kind: "diagram",
    localPath: `assets/${SHA_B}.png`,
    mediaType: "image/png",
    width: 1280,
    height: 720,
    byteLength: 4096,
    sha256: SHA_B,
    altDescription: "Retention rose twelve percent after the beta cohort change.",
    source: {
      kind: "local",
      originalPath: "meeting-assets/retention-chart.png",
    },
    claimIds: ["claim-retention"],
  }],
  slides: [
    {
      id: "slide-hero",
      layout: "hero",
      storyRole: "opening",
      title: "Launch readiness",
      payload: { variant: "cover", statement: "The beta launches Friday." },
      bindings: { title: ["claim-launch"], statement: ["claim-launch"] },
      editorialPaths: [],
      assetIds: [],
      notes: "Open with the reviewed release decision.",
    },
    {
      id: "slide-summary",
      layout: "summary",
      storyRole: "context",
      title: "What changed",
      payload: {
        mode: "overview",
        items: ["The beta launches Friday.", "Retention increased by 12%."],
      },
      bindings: {
        title: ["claim-launch", "claim-retention"],
        "items[0]": ["claim-launch"],
        "items[1]": ["claim-retention"],
      },
      editorialPaths: [],
      assetIds: [],
    },
    {
      id: "slide-decision",
      layout: "decision",
      storyRole: "decision",
      title: "Release decision",
      payload: {
        decision: "The beta launches Friday.",
        rationale: ["Quality remains the release gate."],
      },
      bindings: {
        title: ["claim-launch"],
        decision: ["claim-launch"],
        "rationale[0]": ["claim-quote"],
      },
      editorialPaths: [],
      assetIds: [],
    },
    {
      id: "slide-comparison",
      layout: "comparison",
      storyRole: "argument",
      title: "Before and after",
      payload: {
        sides: [
          { label: "Before", items: ["Release timing was undecided."] },
          { label: "After", items: ["The beta launches Friday."] },
        ],
      },
      bindings: {
        title: ["claim-launch"],
        "sides[0].items[0]": ["claim-launch"],
        "sides[1].items[0]": ["claim-launch"],
      },
      editorialPaths: ["sides[0].label", "sides[1].label"],
      assetIds: [],
    },
    {
      id: "slide-timeline",
      layout: "timeline",
      storyRole: "argument",
      title: "Path to beta",
      payload: {
        mode: "process",
        events: [
          { label: "QA", text: "QA finishes first." },
          { label: "Publish", text: "Then we publish the beta." },
        ],
      },
      bindings: {
        title: ["claim-process"],
        "events[0].text": ["claim-process"],
        "events[1].text": ["claim-process"],
      },
      editorialPaths: ["events[0].label", "events[1].label"],
      assetIds: [],
    },
    {
      id: "slide-metrics",
      layout: "metrics",
      storyRole: "argument",
      title: "Retention signal",
      payload: {
        mode: "chart",
        metrics: [{ label: "Retention", value: "+12%", detail: "After the cohort change" }],
      },
      bindings: {
        title: ["claim-retention"],
        "metrics[0].label": ["claim-retention"],
        "metrics[0].value": ["claim-retention"],
        "metrics[0].detail": ["claim-retention"],
      },
      editorialPaths: [],
      assetIds: ["asset-retention-chart"],
    },
    {
      id: "slide-actions",
      layout: "actions",
      storyRole: "commitment",
      title: "Owners and dates",
      payload: {
        items: [{ task: "Publish the release notes", owner: "Mina", due: "Thursday" }],
      },
      bindings: {
        title: ["claim-action"],
        "items[0].task": ["claim-action"],
        "items[0].owner": ["claim-action"],
        "items[0].due": ["claim-action"],
      },
      editorialPaths: [],
      assetIds: [],
    },
  ],
  createdAt: "2026-08-14T10:00:00.000Z",
  updatedAt: "2026-08-14T10:05:00.000Z",
};

function clonePlan(): SlidePlan {
  return structuredClone(validPlan);
}

function expectContractError(value: unknown, pattern: RegExp): void {
  expect(() => parseSlidePlan(value)).toThrow(pattern);
}

describe("parseSlidePlan source-bound contract", () => {
  test("accepts one complete source-bound plan containing every primary layout family", () => {
    const parsed = parseSlidePlan(JSON.stringify(validPlan));

    expect(parsed).toEqual(validPlan);
    expect(parsed.slides.map((slide) => slide.layout)).toEqual([
      "hero",
      "summary",
      "decision",
      "comparison",
      "timeline",
      "metrics",
      "actions",
    ]);
  });

  test("rejects unknown keys at plan, slide, and payload boundaries", () => {
    const planKey = { ...clonePlan(), unexpected: true };
    expectContractError(planKey, /plan\.unexpected.*not allowed/i);

    const slideKey = clonePlan();
    Object.assign(slideKey.slides[0]!, { html: "<b>unchecked</b>" });
    expectContractError(slideKey, /slides\[0\]\.html.*not allowed/i);

    const payloadKey = clonePlan();
    Object.assign(payloadKey.slides[0]!.payload, { rawColor: "#fff" });
    expectContractError(payloadKey, /slides\[0\]\.payload\.rawColor.*not allowed/i);
  });

  test("accepts a box override that stays on the 1280x720 canvas and rejects one that does not", () => {
    const ok = clonePlan();
    ok.slides[0]!.boxOverrides = [
      { elementId: "slide-hero:title", box: { x: 120, y: 96, width: 500, height: 180 } },
    ];
    expect(parseSlidePlan(ok).slides[0]?.boxOverrides?.[0]?.box).toEqual({
      x: 120, y: 96, width: 500, height: 180,
    });

    const overflow = clonePlan();
    overflow.slides[0]!.boxOverrides = [
      { elementId: "slide-hero:title", box: { x: 1200, y: 0, width: 200, height: 40 } },
    ];
    expectContractError(overflow, /boxOverrides/i);
  });

  test("rejects unsupported schema versions", () => {
    const plan = clonePlan();
    (plan as { schemaVersion: number }).schemaVersion = 2;
    expectContractError(plan, /schemaVersion.*(?:must be|unsupported).*1/i);
  });

  test("rejects malformed snapshot identity and SHA-256 metadata", () => {
    const cases: Array<[string, (plan: SlidePlan) => void, RegExp]> = [
      ["meeting id", (plan) => { plan.snapshot.meetingId = 0; }, /snapshot\.meetingId.*positive/i],
      ["version", (plan) => { plan.snapshot.transcriptVersionId = ""; }, /snapshot\.transcriptVersionId.*empty/i],
      ["hash length", (plan) => { plan.snapshot.contentSha256 = "abc"; }, /snapshot\.contentSha256.*sha-?256/i],
      ["hash alphabet", (plan) => { plan.snapshot.contentSha256 = "g".repeat(64); }, /snapshot\.contentSha256.*sha-?256/i],
      ["line count", (plan) => { plan.snapshot.lineCount = -1; }, /snapshot\.lineCount.*non-negative/i],
    ];

    for (const [label, mutate, pattern] of cases) {
      const plan = clonePlan();
      mutate(plan);
      expect(() => parseSlidePlan(plan), label).toThrow(pattern);
    }
  });

  test("rejects invalid, out-of-snapshot, and non-contiguous source ranges", () => {
    const reversed = clonePlan();
    reversed.claims[0]!.sources[0]!.startSeq = 2;
    reversed.claims[0]!.sources[0]!.endSeq = 1;
    expectContractError(reversed, /claims\[0\]\.sources\[0\].*(?:range|startSeq|endSeq).*invalid/i);

    const outside = clonePlan();
    outside.claims[0]!.sources[0]!.endSeq = 15;
    expectContractError(outside, /claims\[0\]\.sources\[0\]\.endSeq.*lineCount/i);

    const wrongSnapshot = clonePlan();
    wrongSnapshot.claims[0]!.sources[0]!.transcriptVersionId = "transcript-v6";
    expectContractError(wrongSnapshot, /claims\[0\]\.sources\[0\]\.transcriptVersionId.*snapshot/i);

    const gap = clonePlan();
    gap.claims[4]!.sources[1]!.startSeq = 11;
    gap.claims[4]!.sources[1]!.endSeq = 12;
    expectContractError(gap, /claims\[4\]\.sources.*non-contiguous/i);
  });

  test("requires stable unique claim IDs and rejects mismatched bindings", () => {
    const missing = clonePlan();
    missing.claims[0]!.id = "";
    expectContractError(missing, /claims\[0\]\.id.*empty/i);

    const duplicate = clonePlan();
    duplicate.claims[1]!.id = "claim-launch";
    expectContractError(duplicate, /claims\[1\]\.id.*duplicate/i);

    const unknownBinding = clonePlan();
    unknownBinding.slides[0]!.bindings.statement = ["claim-does-not-exist"];
    expectContractError(unknownBinding, /slides\[0\]\.bindings\.statement.*unknown claim/i);
  });

  test("rejects factual payload fields without claim bindings", () => {
    const plan = clonePlan();
    delete plan.slides[2]!.bindings.decision;
    expectContractError(plan, /slides\[2\]\.payload\.decision.*unbound fact/i);
  });

  test("requires editorial payload fields to be declared explicitly", () => {
    const plan = clonePlan();
    plan.slides[3]!.editorialPaths = ["sides[1].label"];
    expectContractError(plan, /slides\[3\]\.payload\.sides\[0\]\.label.*editorialPaths/i);
  });

  test("rejects malformed asset provenance, managed paths, hashes, and bindings", () => {
    const cases: Array<[string, (plan: SlidePlan) => void, RegExp]> = [
      [
        "hotlink",
        (plan) => { plan.assets[0]!.localPath = "https://example.com/chart.png"; },
        /assets\[0\]\.localPath.*(?:managed|hotlink|local)/i,
      ],
      [
        "traversal",
        (plan) => { plan.assets[0]!.localPath = "assets/../../private/chart.png"; },
        /assets\[0\]\.localPath.*managed/i,
      ],
      [
        "hash",
        (plan) => { plan.assets[0]!.sha256 = "not-a-hash"; },
        /assets\[0\]\.sha256.*sha-?256/i,
      ],
      [
        "path/hash mismatch",
        (plan) => { plan.assets[0]!.localPath = `assets/${SHA_A}.png`; },
        /assets\[0\]\.localPath.*hash/i,
      ],
      [
        "missing provenance",
        (plan) => { (plan.assets[0] as { source?: unknown }).source = undefined; },
        /assets\[0\]\.source.*(?:required|object)/i,
      ],
      [
        "unknown provenance kind",
        (plan) => { (plan.assets[0] as { source: { kind: string } }).source = { kind: "remote" }; },
        /assets\[0\]\.source\.kind.*(?:local|generated|retrieved)/i,
      ],
      [
        "informative asset claim",
        (plan) => { plan.assets[0]!.claimIds = []; },
        /assets\[0\]\.claimIds.*informative/i,
      ],
      [
        "asset claim mismatch",
        (plan) => { plan.assets[0]!.claimIds = ["claim-missing"]; },
        /assets\[0\]\.claimIds\[0\].*unknown claim/i,
      ],
      [
        "slide asset mismatch",
        (plan) => { plan.slides[5]!.assetIds = ["asset-missing"]; },
        /slides\[5\]\.assetIds\[0\].*unknown asset/i,
      ],
    ];

    for (const [label, mutate, pattern] of cases) {
      const plan = clonePlan();
      mutate(plan);
      expect(() => parseSlidePlan(plan), label).toThrow(pattern);
    }
  });
});
