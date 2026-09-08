import { describe, expect, test } from "bun:test";

import { SLIDE_PLANNER_SYSTEM_PROMPT } from "../../src/slides/planning/prompt.ts";

const LAYOUTS = [
  "hero",
  "summary",
  "decision",
  "comparison",
  "timeline",
  "metrics",
  "actions",
] as const;

const KINDS = ["image", "icon", "diagram", "chart"] as const;

/** Matches placementSpec in src/slides/assets/integration.ts (not exported). */
const PLACEABLE_PAIRS = [
  { layout: "hero", kind: "image" },
  { layout: "summary", kind: "icon" },
  { layout: "summary", kind: "diagram" },
  { layout: "metrics", kind: "chart" },
] as const;

function pairToken(layout: string, kind: string): string {
  return `(${layout}, ${kind})`;
}

function namedPairs(prompt: string): ReadonlySet<string> {
  const named = new Set<string>();
  for (const layout of LAYOUTS) {
    for (const kind of KINDS) {
      const token = pairToken(layout, kind);
      if (prompt.includes(token)) named.add(token);
    }
  }
  return named;
}

describe("SlidePlan planner asset placement prompt", () => {
  test("names exactly the placeable (layout, kind) pairs and no unsupported pair", () => {
    const expected = new Set(
      PLACEABLE_PAIRS.map(({ layout, kind }) => pairToken(layout, kind)),
    );

    const named = namedPairs(SLIDE_PLANNER_SYSTEM_PROMPT);

    expect(named).toEqual(expected);
  });
});
