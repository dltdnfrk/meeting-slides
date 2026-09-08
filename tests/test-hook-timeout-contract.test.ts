import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const CONTRACTS = [
  { file: "tests/public-fresh-workspace.test.ts", hookTimeoutMs: 20_000 },
  { file: "tests/public-live-kind.test.ts", hookTimeoutMs: 60_000 },
  { file: "tests/start-review-action.test.ts", hookTimeoutMs: 20_000 },
  { file: "tests/server-ask-dispatch.test.ts", hookTimeoutMs: 30_000 },
] as const;

describe("full-suite hook timeout contracts", () => {
  for (const contract of CONTRACTS) {
    test(`${contract.file} gives setup and teardown their declared event budget`, () => {
      const source = readFileSync(join(ROOT, contract.file), "utf8");
      const timeoutLiteral = contract.hookTimeoutMs.toLocaleString("en-US").replace(/,/g, "_");
      expect(source).toContain(`const hookTimeoutMs = ${timeoutLiteral};`);
      expect(source.match(/(?:beforeAll|afterAll)\([\s\S]*?\}, hookTimeoutMs\);/g)).toHaveLength(2);
    });
  }
});
