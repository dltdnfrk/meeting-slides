import { describe, expect, test } from "bun:test";

import {
  DECK_EDITOR_COMMAND_TYPES,
  applyDeckEditorCommand,
  createDeckEditProtocolPayload,
  createDeckEditorState,
  serializeDeckEditorCommand,
  serializeDeckEditorResult,
} from "../public/deck-editor.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function strictDeck() {
  return {
    schemaVersion: 1,
    planId: "plan-launch-review",
    revision: 7,
    snapshot: {
      meetingId: 42,
      transcriptVersionId: "transcript-v7",
      contentSha256: SHA_A,
      lineCount: 8,
    },
    title: "Launch readiness review",
    theme: {
      id: "meeting-paper-v1",
      canvas: { width: 1280, height: 720 },
      font: { family: "Pretendard", localPath: "fonts/Pretendard.woff2", sha256: SHA_B },
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
    claims: [
      {
        id: "claim-launch", kind: "decision", text: "The beta launches Friday.", method: "reviewed",
        sources: [{
          transcriptVersionId: "transcript-v7", startSeq: 1, endSeq: 2,
          evidenceQuote: "We agreed the beta launches Friday.",
        }],
      },
      {
        id: "claim-retention", kind: "fact", text: "Retention increased by 12%.", method: "extractive",
        sources: [{
          transcriptVersionId: "transcript-v7", startSeq: 3, endSeq: 4,
          evidenceQuote: "Retention increased by twelve percent.",
        }],
      },
    ],
    assets: [
      {
        id: "asset-chart", purpose: "informative", kind: "chart",
        localPath: `assets/${SHA_A}.png`, mediaType: "image/png", width: 1280, height: 720,
        byteLength: 4096, sha256: SHA_A, altDescription: "Retention rose twelve percent.",
        source: { kind: "local", originalPath: "meeting-assets/chart.png" },
        claimIds: ["claim-retention"],
      },
      {
        id: "asset-photo", purpose: "decorative", kind: "image",
        localPath: `assets/${SHA_B}.png`, mediaType: "image/png", width: 1280, height: 720,
        byteLength: 2048, sha256: SHA_B, altDescription: "Abstract blue background.",
        source: { kind: "generated", generator: "fixture-v1" }, claimIds: [],
      },
    ],
    slides: [
      {
        id: "slide-hero", layout: "hero", storyRole: "opening", title: "Launch readiness",
        payload: { variant: "cover", statement: "The beta launches Friday." },
        bindings: { title: ["claim-launch"], statement: ["claim-launch"] },
        editorialPaths: [], assetIds: [], notes: "Open with the release decision.",
      },
      {
        id: "slide-comparison", layout: "comparison", storyRole: "argument", title: "Before and after",
        payload: {
          sides: [
            { label: "Before", items: ["Retention was flat."] },
            { label: "After", items: ["Retention increased by 12%."] },
          ],
        },
        bindings: {
          title: ["claim-retention"], "sides[0].items[0]": ["claim-retention"],
          "sides[1].items[0]": ["claim-retention"],
        },
        editorialPaths: ["sides[0].label", "sides[1].label"], assetIds: ["asset-chart"],
      },
      {
        id: "slide-close", layout: "summary", storyRole: "closing", title: "Next steps",
        payload: { mode: "takeaways", items: ["The beta launches Friday."] },
        bindings: { title: ["claim-launch"], "items[0]": ["claim-launch"] },
        editorialPaths: [], assetIds: [],
      },
    ],
    createdAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:05:00.000Z",
  };
}

type EditorState = ReturnType<typeof createDeckEditorState>;
type EditorResult = ReturnType<typeof applyDeckEditorCommand>;

function apply(state: EditorState, command: Record<string, unknown>): EditorResult {
  return applyDeckEditorCommand(state, command);
}

function next(state: EditorState, command: Record<string, unknown>): EditorState {
  const result = apply(state, command);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`command failed: ${result.error.code}`);
  return result.state;
}

function expectFailure(result: EditorResult, state: EditorState, code: string, path?: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected command failure");
  expect(result.state).toBe(state);
  expect(result.error).toMatchObject({ code, ...(path === undefined ? {} : { path }) });
  expect(Object.isFrozen(result.error)).toBe(true);
}

function insertedSlide() {
  return {
    id: "slide-inserted", layout: "hero", storyRole: "context", title: "Retention",
    payload: { variant: "statement", statement: "Retention increased by 12%." },
    bindings: { title: ["claim-retention"], statement: ["claim-retention"] },
    editorialPaths: [], assetIds: ["asset-chart"],
  };
}

describe("vanilla deck editor state", () => {
  test("creates a detached, deterministic, deeply immutable state from a strict plan-like deck", () => {
    const input = strictDeck();
    const first = createDeckEditorState(input);
    const second = createDeckEditorState(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.deck).not.toBe(input);
    expect(first.deck.slides[0]).not.toBe(input.slides[0]);
    expect(first.revision).toBe(7);
    expect(first.deck.revision).toBe(7);
    expect(first.past).toEqual([]);
    expect(first.future).toEqual([]);
    expect(first.slideHashes).toEqual(second.slideHashes);
    expect(Object.keys(first.slideHashes)).toEqual(["slide-hero", "slide-comparison", "slide-close"]);
    expect(Object.values(first.slideHashes).every((hash: unknown) => /^[0-9a-f]{64}$/.test(String(hash)))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.deck)).toBe(true);
    expect(Object.isFrozen(first.deck.slides)).toBe(true);
    expect(first.deck.slides.every(Object.isFrozen)).toBe(true);

    input.slides[0]!.title = "mutated input";
    expect(first.deck.slides[0]!.title).toBe("Launch readiness");
  });

  test("rejects a non-strict deck instead of normalizing away unknown input", () => {
    const invalid = { ...strictDeck(), unexpected: true };
    expect(() => createDeckEditorState(invalid)).toThrow(/unexpected/i);
  });
});

describe("direct slide commands", () => {
  test("setText edits factual text only with explicit known claim IDs", () => {
    const initial = createDeckEditorState(strictDeck());
    const edited = next(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero",
      path: "payload.statement", text: "The reviewed beta launches this Friday.", claimIds: ["claim-launch"],
    });

    expect(edited.revision).toBe(8);
    expect(edited.deck.revision).toBe(8);
    expect(edited.deck.slides[0]!.payload.statement).toBe("The reviewed beta launches this Friday.");
    expect(edited.deck.slides[0]!.bindings.statement).toEqual(["claim-launch"]);
    expect(initial.deck.slides[0]!.payload.statement).toBe("The beta launches Friday.");

    expectFailure(apply(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero",
      path: "payload.statement", text: "Unsupported factual rewrite",
    }), initial, "CLAIM_IDS_REQUIRED", "payload.statement");
    expectFailure(apply(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero",
      path: "payload.statement", text: "Unknown evidence", claimIds: ["claim-missing"],
    }), initial, "UNKNOWN_CLAIM_ID", "claimIds[0]");
  });

  test("setText permits a declared editorial path to remain unbound", () => {
    const initial = createDeckEditorState(strictDeck());
    const edited = next(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-comparison",
      path: "payload.sides[0].label", text: "Previously",
    });

    expect(edited.deck.slides[1]!.payload.sides[0].label).toBe("Previously");
    expect(edited.deck.slides[1]!.bindings).not.toHaveProperty("sides[0].label");
  });

  test("setText rejects an empty title without creating a schema-invalid plan", () => {
    const initial = createDeckEditorState(strictDeck());
    const result = apply(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero",
      path: "title", text: "", claimIds: ["claim-launch"],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_COMMAND" } });
    expect(result.state).toBe(initial);
  });

  test("chooseLayout, replaceAsset, reorderSlide, insertSlide, and deleteSlide are revisioned immutable edits", () => {
    const initial = createDeckEditorState(strictDeck());
    const chosen = next(initial, {
      type: "chooseLayout", expectedRevision: 7, slideId: "slide-hero", layout: "summary",
    });
    expect(chosen.deck.slides[0]!.layout).toBe("summary");
    expect(chosen.deck.slides[0]!.payload).toEqual({ mode: "takeaways", items: ["The beta launches Friday."] });
    expect(() => createDeckEditorState(chosen.deck)).not.toThrow();

    const replaced = next(chosen, {
      type: "replaceAsset", expectedRevision: 8, slideId: "slide-comparison",
      assetId: "asset-chart", replacementAssetId: "asset-photo",
    });
    expect(replaced.deck.slides[1]!.assetIds).toEqual(["asset-photo"]);

    const reordered = next(replaced, {
      type: "reorderSlide", expectedRevision: 9, slideId: "slide-close", toIndex: 0,
    });
    expect(reordered.deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
      "slide-close", "slide-hero", "slide-comparison",
    ]);

    const inserted = next(reordered, {
      type: "insertSlide", expectedRevision: 10, index: 2, slide: insertedSlide(),
    });
    expect(inserted.deck.slides[2]).toMatchObject({ id: "slide-inserted", title: "Retention" });

    const deleted = next(inserted, {
      type: "deleteSlide", expectedRevision: 11, slideId: "slide-hero",
    });
    expect(deleted.deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
      "slide-close", "slide-inserted", "slide-comparison",
    ]);
    expect(initial.deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
      "slide-hero", "slide-comparison", "slide-close",
    ]);
  });

  test("regenerateSlide keeps the stable target ID and required preserved claims", () => {
    const initial = createDeckEditorState(strictDeck());
    const regenerated = next(initial, {
      type: "regenerateSlide", expectedRevision: 7, slideId: "slide-hero",
      preserveClaimIds: ["claim-launch"],
      replacement: {
        id: "model-generated-id-must-not-escape", layout: "decision", storyRole: "decision",
        title: "Ship on Friday",
        payload: { decision: "The beta launches Friday.", rationale: ["Release readiness was reviewed."] },
        bindings: {
          title: ["claim-launch"], decision: ["claim-launch"], "rationale[0]": ["claim-launch"],
        },
        editorialPaths: [], assetIds: [],
      },
    });

    const slide = regenerated.deck.slides[0]!;
    expect(slide.id).toBe("slide-hero");
    expect(slide.layout).toBe("decision");
    expect(new Set(Object.values(slide.bindings).flat())).toContain("claim-launch");
    expect(regenerated.deck.claims.find((claim: { id: string }) => claim.id === "claim-launch"))
      .toBe(initial.deck.claims[0]);

    expectFailure(apply(initial, {
      type: "regenerateSlide", expectedRevision: 7, slideId: "slide-hero",
      preserveClaimIds: ["claim-launch"], replacement: {
        ...insertedSlide(), bindings: { title: ["claim-retention"], statement: ["claim-retention"] },
      },
    }), initial, "PRESERVED_CLAIM_MISSING", "preserveClaimIds[0]");
  });

  test("edits retain untouched slide identity and hashes while changing only affected hashes", () => {
    const initial = createDeckEditorState(strictDeck());
    const edited = next(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero", path: "title",
      text: "Launch decision", claimIds: ["claim-launch"],
    });

    expect(edited.deck.slides[0]).not.toBe(initial.deck.slides[0]);
    expect(edited.deck.slides[1]).toBe(initial.deck.slides[1]);
    expect(edited.deck.slides[2]).toBe(initial.deck.slides[2]);
    expect(edited.slideHashes["slide-hero"]).not.toBe(initial.slideHashes["slide-hero"]);
    expect(edited.slideHashes["slide-comparison"]).toBe(initial.slideHashes["slide-comparison"]);
    expect(edited.slideHashes["slide-close"]).toBe(initial.slideHashes["slide-close"]);
  });

  test("all commands require the current expectedRevision and stale failures are typed and mutation-free", () => {
    const initial = createDeckEditorState(strictDeck());
    const commands = [
      { type: "setText", slideId: "slide-hero", path: "title", text: "Stale", claimIds: ["claim-launch"] },
      { type: "chooseLayout", slideId: "slide-hero", layout: "summary" },
      { type: "replaceAsset", slideId: "slide-comparison", assetId: "asset-chart", replacementAssetId: "asset-photo" },
      { type: "reorderSlide", slideId: "slide-close", toIndex: 0 },
      { type: "insertSlide", index: 1, slide: insertedSlide() },
      { type: "deleteSlide", slideId: "slide-close" },
      { type: "regenerateSlide", slideId: "slide-hero", preserveClaimIds: ["claim-launch"], replacement: insertedSlide() },
      { type: "undo" },
      { type: "redo" },
    ];

    for (const command of commands) {
      const result = apply(initial, { ...command, expectedRevision: 6 });
      expectFailure(result, initial, "STALE_REVISION");
      if (!result.ok) {
        expect(result.error).toEqual({ code: "STALE_REVISION", expectedRevision: 6, actualRevision: 7 });
      }
    }
    expect(initial).toEqual(createDeckEditorState(strictDeck()));
  });
});

describe("immutable undo and redo", () => {
  test("undo and redo traverse snapshots as new monotonic revisions without mutating prior states", () => {
    const initial = createDeckEditorState(strictDeck());
    const first = next(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero", path: "title",
      text: "First title", claimIds: ["claim-launch"],
    });
    const second = next(first, {
      type: "setText", expectedRevision: 8, slideId: "slide-hero", path: "title",
      text: "Second title", claimIds: ["claim-launch"],
    });
    const undone = next(second, { type: "undo", expectedRevision: 9 });
    const undoneAgain = next(undone, { type: "undo", expectedRevision: 10 });
    const redone = next(undoneAgain, { type: "redo", expectedRevision: 11 });

    expect([initial, first, second, undone, undoneAgain, redone].map((state) => state.revision))
      .toEqual([7, 8, 9, 10, 11, 12]);
    expect(undone.deck.slides[0]!.title).toBe("First title");
    expect(undoneAgain.deck.slides[0]!.title).toBe("Launch readiness");
    expect(redone.deck.slides[0]!.title).toBe("First title");
    expect(second.deck.slides[0]!.title).toBe("Second title");
    expect(Object.isFrozen(undone.past)).toBe(true);
    expect(Object.isFrozen(undone.future)).toBe(true);
  });

  test("a divergent edit clears redo, and empty undo/redo history is an identity no-op", () => {
    const initial = createDeckEditorState(strictDeck());
    expect(next(initial, { type: "undo", expectedRevision: 7 })).toBe(initial);
    expect(next(initial, { type: "redo", expectedRevision: 7 })).toBe(initial);

    const edited = next(initial, {
      type: "setText", expectedRevision: 7, slideId: "slide-hero", path: "title",
      text: "Edited", claimIds: ["claim-launch"],
    });
    const undone = next(edited, { type: "undo", expectedRevision: 8 });
    expect(undone.future).toHaveLength(1);
    const divergent = next(undone, {
      type: "setText", expectedRevision: 9, slideId: "slide-close", path: "title",
      text: "Divergent close", claimIds: ["claim-launch"],
    });
    expect(divergent.future).toEqual([]);
    expect(next(divergent, { type: "redo", expectedRevision: 10 })).toBe(divergent);
  });
});

describe("command safety and persistence protocol", () => {
  test("rejects unknown, inherited, and prototype-polluting command paths without mutation", () => {
    const initial = createDeckEditorState(strictDeck());
    for (const path of [
      "payload.missing", "payload.__proto__.polluted", "payload.constructor.prototype.polluted",
      "payload.sides[-1].label", "payload.sides[99].label",
    ]) {
      expectFailure(apply(initial, {
        type: "setText", expectedRevision: 7, slideId: "slide-comparison",
        path, text: "unsafe", claimIds: ["claim-retention"],
      }), initial, "INVALID_PATH", path);
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("exposes only semantic commands: no freeform drag, move, resize, or geometry command exists", () => {
    expect(DECK_EDITOR_COMMAND_TYPES).toEqual([
      "setText", "chooseLayout", "replaceAsset", "reorderSlide", "insertSlide",
      "deleteSlide", "regenerateSlide", "undo", "redo",
    ]);
    const initial = createDeckEditorState(strictDeck());
    for (const type of ["drag", "moveElement", "resize", "setGeometry"]) {
      expectFailure(apply(initial, { type, expectedRevision: 7, slideId: "slide-hero" }), initial, "UNKNOWN_COMMAND");
    }
  });

  test("serializes equivalent commands and results deterministically", () => {
    const initial = createDeckEditorState(strictDeck());
    const ordered = {
      type: "setText", expectedRevision: 7, slideId: "slide-hero",
      path: "payload.statement", text: "Ship Friday.", claimIds: ["claim-launch"],
    };
    const reordered = {
      claimIds: ["claim-launch"], text: "Ship Friday.", path: "payload.statement",
      slideId: "slide-hero", expectedRevision: 7, type: "setText",
    };
    expect(serializeDeckEditorCommand(ordered)).toBe(serializeDeckEditorCommand(reordered));
    expect(serializeDeckEditorCommand(ordered)).toBe(
      '{"claimIds":["claim-launch"],"expectedRevision":7,"path":"payload.statement","slideId":"slide-hero","text":"Ship Friday.","type":"setText"}',
    );

    const firstResult = apply(initial, ordered);
    const secondResult = apply(createDeckEditorState(strictDeck()), reordered);
    expect(serializeDeckEditorResult(firstResult)).toBe(serializeDeckEditorResult(secondResult));
    expect(serializeDeckEditorResult(firstResult)).toBe(serializeDeckEditorResult(firstResult));
  });

  test("emits the exact command envelope intended for later server persistence", () => {
    const initial = createDeckEditorState(strictDeck());
    const command = {
      type: "setText", expectedRevision: 7, slideId: "slide-hero",
      path: "payload.statement", text: "Ship Friday.", claimIds: ["claim-launch"],
    };

    const payload = createDeckEditProtocolPayload(initial, command);
    expect(payload).toEqual({
      action: "editDeck",
      planId: "plan-launch-review",
      expectedRevision: 7,
      command: {
        type: "setText", expectedRevision: 7, slideId: "slide-hero",
        path: "payload.statement", text: "Ship Friday.", claimIds: ["claim-launch"],
      },
    });
    expect(Object.keys(payload)).toEqual(["action", "planId", "expectedRevision", "command"]);
    expect(Object.keys(payload.command)).toEqual([
      "type", "expectedRevision", "slideId", "path", "text", "claimIds",
    ]);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.command)).toBe(true);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
