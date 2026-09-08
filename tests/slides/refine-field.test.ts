import { describe, expect, test } from "bun:test";

import {
  REFINE_FIELD_SYSTEM_PROMPT,
  RefineFieldError,
  refineSlideField,
} from "../../src/slides/planning/refine-field.ts";
import type { SlidePlan } from "../../src/slides/model/plan.ts";

const SHA = "a".repeat(64);

function plan(): SlidePlan {
  const source = {
    transcriptVersionId: "transcript-v1",
    startSeq: 1,
    endSeq: 1,
    evidenceQuote: "The beta launches Friday.",
  };
  return {
    schemaVersion: 1,
    planId: "plan:launch",
    revision: 4,
    snapshot: { meetingId: 7, transcriptVersionId: "transcript-v1", contentSha256: SHA, lineCount: 1 },
    title: "Launch review",
    theme: {
      id: "meeting-paper-v1",
      canvas: { width: 1280, height: 720 },
      font: { family: "Pretendard", localPath: "fonts/Pretendard.woff2", sha256: SHA },
      colors: {
        paper: "F6F1E8", raised: "FFFDF8", ink: "14213D", muted: "5B6475",
        rule: "D9D2C4", coral: "AD4B2F", blue: "335C81", focus: "1E5AA8",
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
    claims: [{
      id: "claim-launch", kind: "decision", text: "The beta launches Friday.",
      method: "reviewed", sources: [source],
    }],
    assets: [],
    slides: [{
      id: "opening", layout: "hero", storyRole: "opening",
      title: "Launch review",
      payload: { variant: "cover", statement: "The beta launches Friday." },
      bindings: { title: ["claim-launch"], statement: ["claim-launch"] },
      editorialPaths: [], assetIds: [],
    }],
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:05:00.000Z",
  };
}

describe("refineSlideField", () => {
  test("Given a bound title and a shorten instruction, When the model returns JSON, Then only that field is proposed", async () => {
    const source = plan();
    const chat = {
      chat: async (prompt: string, options: { system?: string }) => {
        expect(options.system).toBe(REFINE_FIELD_SYSTEM_PROMPT);
        expect(prompt).toContain("Launch review");
        expect(prompt).toContain("더 짧게");
        expect(prompt).toContain("[claim-launch] The beta launches Friday.");
        return 'prefix {"text":"Launch Friday"} suffix';
      },
    };
    const proposal = await refineSlideField({
      plan: source,
      slideId: "opening",
      path: "title",
      text: "Launch review",
      instruction: "더 짧게",
      claimIds: ["claim-launch"],
    }, chat);
    expect(proposal).toEqual({
      slideId: "opening",
      path: "title",
      before: "Launch review",
      after: "Launch Friday",
      claimIds: ["claim-launch"],
      instruction: "더 짧게",
    });
    expect(source.slides[0]?.title).toBe("Launch review");
  });

  test("Given an unknown claim id, When refine is requested, Then it is rejected without calling the model", async () => {
    let called = false;
    await expect(refineSlideField({
      plan: plan(),
      slideId: "opening",
      path: "title",
      text: "Launch review",
      instruction: "더 짧게",
      claimIds: ["claim-missing"],
    }, { chat: async () => { called = true; return '{"text":"no"}'; } })).rejects.toBeInstanceOf(RefineFieldError);
    expect(called).toBe(false);
  });

  test("Given extra model keys, When the proposal is parsed, Then it is rejected", async () => {
    await expect(refineSlideField({
      plan: plan(),
      slideId: "opening",
      path: "title",
      text: "Launch review",
      instruction: "더 짧게",
      claimIds: ["claim-launch"],
    }, { chat: async () => '{"text":"Launch Friday","html":"<h1>x</h1>"}' })).rejects.toMatchObject({
      code: "INVALID_MODEL_OUTPUT",
      path: "html",
    });
  });

  test("Given a dirty local title, When refine runs, Then the client text is the before value", async () => {
    const proposal = await refineSlideField({
      plan: plan(),
      slideId: "opening",
      path: "title",
      text: "  Local title  ",
      instruction: "결정 문장으로",
      claimIds: ["claim-launch"],
    }, { chat: async (prompt) => {
      expect(prompt).toContain("Local title");
      return '{"text":"Ship Friday"}';
    } });
    expect(proposal.before).toBe("Local title");
    expect(proposal.after).toBe("Ship Friday");
  });
});
